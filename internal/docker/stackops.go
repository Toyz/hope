package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
)

// Stack-level operations driven entirely through the Docker API using compose
// labels — NO compose files required. This is what makes restart/pull/redeploy
// work over a remote tcp:// daemon or socket proxy, and inside a container that
// has not mounted the host's compose project directories.

// ContainerRef is a minimal container identity for multiplexed log streaming.
type ContainerRef struct {
	ID      string
	Name    string
	Service string
}

// ProjectContainers returns refs for a project, optionally filtered to a single
// compose service. Ordered by service then container-number.
func (c *Client) ProjectContainers(ctx context.Context, project, service string) ([]ContainerRef, error) {
	args := filters.NewArgs(filters.Arg("label", labelProject+"="+project))
	if service != "" {
		args.Add("label", labelService+"="+service)
	}
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true, Filters: args})
	if err != nil {
		return nil, fmt.Errorf("list project %q: %w", project, err)
	}
	sort.Slice(list, func(i, j int) bool {
		si, sj := list[i].Labels[labelService], list[j].Labels[labelService]
		if si != sj {
			return si < sj
		}
		ni, _ := strconv.Atoi(list[i].Labels[labelNumber])
		nj, _ := strconv.Atoi(list[j].Labels[labelNumber])
		return ni < nj
	})
	refs := make([]ContainerRef, 0, len(list))
	for _, ct := range list {
		name := ct.ID[:12]
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		refs = append(refs, ContainerRef{ID: ct.ID, Name: name, Service: ct.Labels[labelService]})
	}
	return refs, nil
}

// ProjectContainerIDs returns the container ids of a compose project, ordered
// by service then container-number for stable operation order.
func (c *Client) ProjectContainerIDs(ctx context.Context, project string) ([]string, error) {
	f := filters.NewArgs(filters.Arg("label", labelProject+"="+project))
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, fmt.Errorf("list project %q: %w", project, err)
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("no containers for project %q", project)
	}
	sort.Slice(list, func(i, j int) bool {
		si, sj := list[i].Labels[labelService], list[j].Labels[labelService]
		if si != sj {
			return si < sj
		}
		ni, _ := strconv.Atoi(list[i].Labels[labelNumber])
		nj, _ := strconv.Atoi(list[j].Labels[labelNumber])
		return ni < nj
	})
	ids := make([]string, len(list))
	for i, ct := range list {
		ids[i] = ct.ID
	}
	return ids, nil
}

// PullImage pulls ref and consumes the progress stream, surfacing any error the
// registry reports MID-STREAM (rate limits, auth failures). The daemon returns
// those as JSON `error` lines, not as a transport error — so draining blindly
// would make a throttled pull look successful and a redeploy keep the old image.
func (c *Client) PullImage(ctx context.Context, ref string) error {
	rc, err := c.sdk().ImagePull(ctx, ref, image.PullOptions{RegistryAuth: c.registryAuth(ref)})
	if err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	defer rc.Close()

	dec := json.NewDecoder(rc)
	for {
		var msg struct {
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := dec.Decode(&msg); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("pull %s: %w", ref, err)
		}
		if msg.Error != "" {
			detail := msg.Error
			if msg.ErrorDetail.Message != "" {
				detail = msg.ErrorDetail.Message
			}
			return fmt.Errorf("pull %s: %s", ref, detail)
		}
	}
}

// PullImageStream pulls ref and forwards human-readable progress to emit, one
// line per layer status change (chatty per-chunk progress is deduped). Returns
// the registry's error on failure, like PullImage.
func (c *Client) PullImageStream(ctx context.Context, ref string, emit func(string)) error {
	rc, err := c.sdk().ImagePull(ctx, ref, image.PullOptions{RegistryAuth: c.registryAuth(ref)})
	if err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	defer rc.Close()

	dec := json.NewDecoder(rc)
	last := map[string]string{}
	for {
		var m struct {
			Status      string `json:"status"`
			ID          string `json:"id"`
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := dec.Decode(&m); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("pull %s: %w", ref, err)
		}
		if m.Error != "" {
			d := m.Error
			if m.ErrorDetail.Message != "" {
				d = m.ErrorDetail.Message
			}
			return fmt.Errorf("pull %s: %s", ref, d)
		}
		if m.Status == "" {
			continue
		}
		if m.ID != "" {
			if last[m.ID] == m.Status {
				continue // same layer phase — skip the progress spam
			}
			last[m.ID] = m.Status
			emit(m.ID + ": " + m.Status)
		} else {
			emit(m.Status)
		}
	}
}

// RedeployContainer pulls a container's image (streaming progress to emit) then
// recreates it, emitting step lines. The terminal "done" frame is the caller's.
func (c *Client) RedeployContainer(ctx context.Context, id string, pull, force bool, emit func(string)) error {
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", id, err)
	}
	img := info.Config.Image
	name := strings.TrimPrefix(info.Name, "/")
	if pull {
		emit("pull " + img)
		if err := c.PullImageStream(ctx, img, emit); err != nil {
			return err
		}
	}
	if !force && c.onCurrentImage(ctx, info.Image, img) {
		emit("skip " + name + " — already on the current image")
		return nil
	}
	emit("recreate " + name)
	if err := c.RecreateManaged(ctx, id); err != nil {
		return err
	}
	c.RefreshImageStatus(ctx, img)
	return nil
}

// RedeployProject pulls every image in a project then recreates each container,
// streaming progress to emit. With pull off it skips the pull; with force off it
// leaves containers already running the current image untouched.
func (c *Client) RedeployProject(ctx context.Context, project string, pull, force bool, emit func(string)) error {
	if pull {
		imgs, err := c.ImagesForProject(ctx, project)
		if err != nil {
			return err
		}
		for _, img := range imgs {
			emit("pull " + img)
			if err := c.PullImageStream(ctx, img, emit); err != nil {
				return err
			}
		}
	}
	ids, err := c.ProjectContainerIDs(ctx, project)
	if err != nil {
		return err
	}
	for _, id := range ids {
		short := id
		if len(short) > 12 {
			short = short[:12]
		}
		if !force {
			if info, e := c.sdk().ContainerInspect(ctx, id); e == nil && c.onCurrentImage(ctx, info.Image, info.Config.Image) {
				emit("skip " + short + " — already on the current image")
				continue
			}
		}
		emit("recreate " + short)
		if err := c.RecreateManaged(ctx, id); err != nil {
			return fmt.Errorf("recreate %s: %w", short, err)
		}
	}
	c.RefreshProjectStatus(ctx, project)
	return nil
}

// PullContainers pulls the images backing the given containers (deduped),
// streaming progress to emit. It does not recreate anything.
func (c *Client) PullContainers(ctx context.Context, ids []string, emit func(string)) error {
	seen := map[string]bool{}
	for _, id := range ids {
		info, err := c.sdk().ContainerInspect(ctx, id)
		if err != nil {
			emit("skip " + id + " — " + err.Error())
			continue
		}
		img := info.Config.Image
		if img == "" || seen[img] {
			continue
		}
		seen[img] = true
		emit("pull " + img)
		if err := c.PullImageStream(ctx, img, emit); err != nil {
			return err
		}
		c.RefreshImageStatus(ctx, img)
	}
	return nil
}

// onCurrentImage reports whether a container's running image id already matches
// the local image the ref now resolves to (so a redeploy would be a no-op).
func (c *Client) onCurrentImage(ctx context.Context, runningImageID, ref string) bool {
	if runningImageID == "" || ref == "" {
		return false
	}
	insp, _, err := c.sdk().ImageInspectWithRaw(ctx, ref)
	if err != nil {
		return false
	}
	return insp.ID == runningImageID
}

// ContainerImage returns the image reference a container was created from.
func (c *Client) ContainerImage(ctx context.Context, id string) (string, error) {
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return "", fmt.Errorf("inspect %s: %w", id, err)
	}
	return info.Config.Image, nil
}

// Recreate rebuilds a container in place so it picks up a freshly pulled image,
// preserving its config, host config, name, labels (so it stays grouped in its
// compose project), and network attachments. This is the API-only equivalent of
// `docker compose up -d --force-recreate` for one container.
func (c *Client) Recreate(ctx context.Context, id string) error {
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", id, err)
	}
	name := info.Name
	if len(name) > 0 && name[0] == '/' {
		name = name[1:]
	}

	// Networks to reattach. Create with the first; connect the rest after.
	type netAttach struct {
		name string
		ep   *network.EndpointSettings
	}
	var nets []netAttach
	if info.NetworkSettings != nil {
		names := make([]string, 0, len(info.NetworkSettings.Networks))
		for n := range info.NetworkSettings.Networks {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			src := info.NetworkSettings.Networks[n]
			// Keep only portable fields; live values (assigned IP, MAC) would
			// conflict on recreate.
			nets = append(nets, netAttach{name: n, ep: &network.EndpointSettings{
				Aliases:   src.Aliases,
				NetworkID: src.NetworkID,
			}})
		}
	}

	netConfig := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{}}
	if len(nets) > 0 {
		netConfig.EndpointsConfig[nets[0].name] = nets[0].ep
	}

	if err := c.sdk().ContainerStop(ctx, id, container.StopOptions{}); err != nil {
		return fmt.Errorf("stop %s: %w", name, err)
	}
	if err := c.sdk().ContainerRemove(ctx, id, container.RemoveOptions{}); err != nil {
		return fmt.Errorf("remove %s: %w", name, err)
	}

	created, err := c.sdk().ContainerCreate(ctx, info.Config, info.HostConfig, netConfig, nil, name)
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	// Connect remaining networks before start.
	for _, n := range nets[1:] {
		if err := c.sdk().NetworkConnect(ctx, n.name, created.ID, n.ep); err != nil {
			return fmt.Errorf("connect %s to %s: %w", name, n.name, err)
		}
	}
	if err := c.sdk().ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("start %s: %w", name, err)
	}
	return nil
}

// selfID returns this client's own container id. For the local daemon that's
// hope's hostname (= its short container id); for an agent client it's the id
// the remote agent reported for its own container.
func (c *Client) selfID() string {
	if c.selfHint != "" {
		return c.selfHint
	}
	h, _ := os.Hostname()
	return h
}

// SetSelfID records the container id this client runs as (used by agent clients
// so self-recreate detection works across the tunnel).
func (c *Client) SetSelfID(id string) { c.selfHint = id }

// isSelf reports whether id refers to hope's own container.
func (c *Client) isSelf(id string) bool {
	s := c.selfID()
	if s == "" || id == "" {
		return false
	}
	return strings.HasPrefix(id, s) || strings.HasPrefix(s, id)
}

// RecreateManaged recreates a container, but if it's a hope-image container
// (hope itself, or a hope-agent — anything carrying HOPE_MANAGED=1) it hands the
// job to a detached helper. Recreating such a container directly would stop it
// mid-request over the very connection it provides (hope's process, or the agent
// tunnel), severing that connection before the recreate completes — the EOF.
// Keyed on the image marker, not os.Hostname()-based self detection (which is
// unreliable when the container runs with a custom --hostname or host network).
func (c *Client) RecreateManaged(ctx context.Context, id string) error {
	if c.isSelf(id) || c.isHopeManaged(ctx, id) {
		return c.recreateDetached(ctx, id)
	}
	return c.Recreate(ctx, id)
}

// isHopeManaged reports whether a container was built from the hope image (it
// carries the HOPE_MANAGED=1 env baked into that image). Such a container also
// carries hope-boot, so the detached helper it spawns can do the recreate.
func (c *Client) isHopeManaged(ctx context.Context, id string) bool {
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil || info.Config == nil {
		return false
	}
	for _, e := range info.Config.Env {
		if e == "HOPE_MANAGED=1" {
			return true
		}
	}
	return false
}

// recreateDetached launches a throwaway container from hope's (freshly pulled)
// image that runs `hope self-recreate <id>` with the docker socket mounted. It
// outlives the old hope, so it can stop/remove/recreate it cleanly.
func (c *Client) recreateDetached(ctx context.Context, id string) error {
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", id, err)
	}
	helper := &container.Config{
		Image:      info.Config.Image,
		Entrypoint: []string{"hope-boot", "recreate", id},
		Labels:     map[string]string{"ink.hope.self-updater": "1"},
	}
	host := &container.HostConfig{
		AutoRemove: true,
		Binds:      []string{"/var/run/docker.sock:/var/run/docker.sock"},
	}
	created, err := c.sdk().ContainerCreate(ctx, helper, host, nil, nil, "")
	if err != nil {
		return fmt.Errorf("create self-updater: %w", err)
	}
	if err := c.sdk().ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("start self-updater: %w", err)
	}
	return nil
}

// ImagesForProject returns the unique image references used by a project's
// containers, for a stack-wide pull.
func (c *Client) ImagesForProject(ctx context.Context, project string) ([]string, error) {
	f := filters.NewArgs(filters.Arg("label", labelProject+"="+project))
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, fmt.Errorf("list project %q: %w", project, err)
	}
	seen := map[string]struct{}{}
	var out []string
	for _, ct := range list {
		img := ct.Image
		if img == "" {
			continue
		}
		if _, dup := seen[img]; dup {
			continue
		}
		seen[img] = struct{}{}
		out = append(out, img)
	}
	sort.Strings(out)
	return out, nil
}
