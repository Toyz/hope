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
	UsedBy   []ImageUser `json:"used_by"` // containers referencing this image
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
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Size > out[j].Size })
	return out, nil
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
