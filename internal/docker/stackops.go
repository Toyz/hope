package docker

import (
	"context"
	"fmt"
	"io"
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
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: args})
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
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
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

// PullImage pulls ref and drains the progress stream. Best-effort for private
// registries (no auth wired) — public images and anything the daemon already
// has credentials for will pull.
func (c *Client) PullImage(ctx context.Context, ref string) error {
	rc, err := c.cli.ImagePull(ctx, ref, image.PullOptions{RegistryAuth: c.registryAuth(ref)})
	if err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	defer rc.Close()
	_, err = io.Copy(io.Discard, rc)
	return err
}

// Recreate rebuilds a container in place so it picks up a freshly pulled image,
// preserving its config, host config, name, labels (so it stays grouped in its
// compose project), and network attachments. This is the API-only equivalent of
// `docker compose up -d --force-recreate` for one container.
func (c *Client) Recreate(ctx context.Context, id string) error {
	info, err := c.cli.ContainerInspect(ctx, id)
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

	if err := c.cli.ContainerStop(ctx, id, container.StopOptions{}); err != nil {
		return fmt.Errorf("stop %s: %w", name, err)
	}
	if err := c.cli.ContainerRemove(ctx, id, container.RemoveOptions{}); err != nil {
		return fmt.Errorf("remove %s: %w", name, err)
	}

	created, err := c.cli.ContainerCreate(ctx, info.Config, info.HostConfig, netConfig, nil, name)
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	// Connect remaining networks before start.
	for _, n := range nets[1:] {
		if err := c.cli.NetworkConnect(ctx, n.name, created.ID, n.ep); err != nil {
			return fmt.Errorf("connect %s to %s: %w", name, n.name, err)
		}
	}
	if err := c.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("start %s: %w", name, err)
	}
	return nil
}

// ImagesForProject returns the unique image references used by a project's
// containers, for a stack-wide pull.
func (c *Client) ImagesForProject(ctx context.Context, project string) ([]string, error) {
	f := filters.NewArgs(filters.Arg("label", labelProject+"="+project))
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
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
