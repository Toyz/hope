package docker

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
)

// ImageLayer is one entry of an image's build history (`docker history`): the
// instruction that created the layer, its size, and age. Layers are returned
// newest-first (as the daemon reports them).
type ImageLayer struct {
	ID        string   `json:"id"`         // layer image id, or "<missing>" for squashed base layers
	Created   int64    `json:"created"`    // unix seconds
	CreatedBy string   `json:"created_by"` // the Dockerfile instruction that built it
	Size      int64    `json:"size"`       // bytes this layer adds
	Comment   string   `json:"comment"`
	Tags      []string `json:"tags"`
	Empty     bool     `json:"empty"` // a metadata-only layer (0 bytes, e.g. ENV/LABEL/CMD)
}

// History returns an image's layer history (`docker history`) — how it was built,
// layer by layer, with per-layer size. Newest layer first.
func (c *Client) History(ctx context.Context, id string) ([]ImageLayer, error) {
	hist, err := c.sdk().ImageHistory(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]ImageLayer, 0, len(hist))
	for _, h := range hist {
		// Docker reports "<missing>" as the id for every layer that doesn't carry its
		// own image id (all layers of a pulled image, plus intermediate build layers).
		// Blank it so the UI shows an id only when there's a real one to show.
		id := h.ID
		if id == "<missing>" {
			id = ""
		}
		out = append(out, ImageLayer{
			ID:        id,
			Created:   h.Created,
			CreatedBy: h.CreatedBy,
			Size:      h.Size,
			Comment:   h.Comment,
			Tags:      h.Tags,
			Empty:     h.Size == 0,
		})
	}
	return out, nil
}

// TopResult is a container's live process list (the `docker top` equivalent):
// the ps column titles and one row of cells per process.
type TopResult struct {
	Titles    []string   `json:"titles"`
	Processes [][]string `json:"processes"`
}

// ImageUser identifies a container (and its stack) that references an image.
type ImageUser struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Service string `json:"service"`
	Project string `json:"project"`
}

// ImageInfo is a clean, frontend-facing view of a local image.
type ImageInfo struct {
	ID       string      `json:"id"`
	Tags     []string    `json:"tags"`
	Size     int64       `json:"size"`
	Created  int64       `json:"created"` // unix seconds
	Dangling bool        `json:"dangling"`
	InUse    bool        `json:"in_use"`
	UsedBy   []ImageUser `json:"used_by"`           // containers referencing this image
	Registry string      `json:"registry"`          // where it came from: registry host (docker.io, ghcr.io, ...)
	Digests  []string    `json:"digests,omitempty"` // repo@sha256 refs (the pulled-from source)
}

// Images lists local top-level images, tagging each with whether a container
// uses it and whether it's dangling (untagged). Sorted largest first.
func (c *Client) Images(ctx context.Context) ([]ImageInfo, error) {
	imgs, err := c.sdk().ImageList(ctx, image.ListOptions{})
	if err != nil {
		return nil, err
	}

	// Which containers reference each image (running or not).
	usedBy := map[string][]ImageUser{}
	if conts, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true}); err == nil {
		for _, ct := range conts {
			name := ""
			if len(ct.Names) > 0 {
				name = strings.TrimPrefix(ct.Names[0], "/")
			}
			usedBy[ct.ImageID] = append(usedBy[ct.ImageID], ImageUser{
				ID:      ct.ID,
				Name:    name,
				Service: serviceLabel(ct.Labels),
				Project: projectLabel(ct.Labels),
			})
		}
	}

	out := make([]ImageInfo, 0, len(imgs))
	for _, im := range imgs {
		tags := im.RepoTags
		dangling := len(tags) == 0 || (len(tags) == 1 && tags[0] == "<none>:<none>")
		if dangling {
			tags = []string{} // never nil -> serializes as [] not null
		}
		users := usedBy[im.ID]
		if users == nil {
			users = []ImageUser{}
		}
		out = append(out, ImageInfo{
			ID:       im.ID,
			Tags:     tags,
			Size:     im.Size,
			Created:  im.Created,
			Dangling: dangling,
			InUse:    len(users) > 0,
			UsedBy:   users,
			Registry: imageRegistry(tags, im.RepoDigests),
			Digests:  im.RepoDigests,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Size > out[j].Size })
	return out, nil
}

// imageRegistry reports where an image came from — the registry host — derived
// from its primary tag, else its first repo digest. Empty for a dangling image
// with no digest (nothing to point at).
func imageRegistry(tags, digests []string) string {
	if len(tags) > 0 {
		return registryHostFromImage(tags[0])
	}
	if len(digests) > 0 {
		return registryHostFromImage(digests[0])
	}
	return ""
}

// ImageByRef finds a single local image by id (full or short), an exact tag, or a
// repo digest — for the shared image-detail modal opened from anywhere a
// container's image is shown. Returns (nil, nil) when nothing matches.
func (c *Client) ImageByRef(ctx context.Context, ref string) (*ImageInfo, error) {
	imgs, err := c.Images(ctx)
	if err != nil {
		return nil, err
	}
	short := shortImageID(ref)
	for i := range imgs {
		im := &imgs[i]
		if im.ID == ref || shortImageID(im.ID) == short || strings.HasPrefix(strings.TrimPrefix(im.ID, "sha256:"), strings.TrimPrefix(ref, "sha256:")) {
			return im, nil
		}
		for _, t := range im.Tags {
			if t == ref {
				return im, nil
			}
		}
		for _, d := range im.Digests {
			if d == ref {
				return im, nil
			}
		}
	}
	return nil, nil
}

// Top returns a container's running processes (the `docker top` equivalent):
// the daemon runs ps in the container's PID namespace and returns the columns +
// rows. Works over the agent tunnel like every other call.
func (c *Client) Top(ctx context.Context, id string) (TopResult, error) {
	body, err := c.sdk().ContainerTop(ctx, id, nil)
	if err != nil {
		return TopResult{}, err
	}
	return TopResult{Titles: body.Titles, Processes: body.Processes}, nil
}

// PruneResult reports the outcome of an image prune.
type PruneResult struct {
	Deleted   int    `json:"deleted"`
	Reclaimed uint64 `json:"reclaimed"`
}

// RemoveImage deletes a single image (force allows removing a tagged image even
// if it has stopped containers / multiple tags).
func (c *Client) RemoveImage(ctx context.Context, id string, force bool) error {
	_, err := c.sdk().ImageRemove(ctx, id, image.RemoveOptions{Force: force, PruneChildren: true})
	return err
}

// ImageInUse reports whether any container (running or stopped) references the
// image, and by whom. Used to refuse a (force-)remove of an in-use image at the
// RPC layer — the UI hides that action, but the guard must live on the server.
func (c *Client) ImageInUse(ctx context.Context, id string) (bool, []ImageUser, error) {
	conts, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return false, nil, err
	}
	var users []ImageUser
	for _, ct := range conts {
		if ct.ImageID != id {
			continue
		}
		name := ""
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		users = append(users, ImageUser{ID: ct.ID, Name: name, Service: serviceLabel(ct.Labels), Project: projectLabel(ct.Labels)})
	}
	return len(users) > 0, users, nil
}

// PruneImagesStream removes unused images one at a time, emitting a line per
// image (removed / skipped + reason) so the UI can show live progress and the
// exact reason an image can't be deleted.
func (c *Client) PruneImagesStream(ctx context.Context, all bool, emit func(string)) error {
	imgs, err := c.Images(ctx)
	if err != nil {
		return err
	}
	var deleted int
	var reclaimed int64
	for _, im := range imgs {
		if all {
			if im.InUse {
				continue
			}
		} else if !im.Dangling {
			continue
		}
		label := shortImageID(im.ID)
		if len(im.Tags) > 0 {
			label = im.Tags[0]
		}
		if err := c.RemoveImage(ctx, im.ID, false); err != nil {
			emit("skip " + label + " — " + cleanDaemonErr(err))
			continue
		}
		deleted++
		reclaimed += im.Size
		emit("removed " + label)
	}
	emit(fmt.Sprintf("done — removed %d image(s), reclaimed ~%s", deleted, humanBytes(reclaimed)))
	return nil
}

func shortImageID(id string) string {
	id = strings.TrimPrefix(id, "sha256:")
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func cleanDaemonErr(err error) string {
	return strings.TrimPrefix(err.Error(), "Error response from daemon: ")
}

func humanBytes(b int64) string {
	if b <= 0 {
		return "0 B"
	}
	const u = 1024
	if b < u*u {
		return fmt.Sprintf("%d MB", b/(u*u))
	}
	return fmt.Sprintf("%.2f GB", float64(b)/float64(u*u*u))
}

// PruneImages removes unreferenced images: dangling-only by default, or every
// unused image when all is true. Returns how many were deleted and bytes freed.
func (c *Client) PruneImages(ctx context.Context, all bool) (PruneResult, error) {
	f := filters.NewArgs()
	// dangling=false tells the daemon to prune ALL unused images, not just the
	// untagged ones; dangling=true (the default) prunes only dangling.
	f.Add("dangling", map[bool]string{true: "false", false: "true"}[all])
	rep, err := c.sdk().ImagesPrune(ctx, f)
	if err != nil {
		return PruneResult{}, err
	}
	return PruneResult{Deleted: len(rep.ImagesDeleted), Reclaimed: rep.SpaceReclaimed}, nil
}
