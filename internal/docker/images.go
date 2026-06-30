package docker

import (
	"context"
	"sort"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
)

// ImageInfo is a clean, frontend-facing view of a local image.
type ImageInfo struct {
	ID       string   `json:"id"`
	Tags     []string `json:"tags"`
	Size     int64    `json:"size"`
	Created  int64    `json:"created"` // unix seconds
	Dangling bool     `json:"dangling"`
	InUse    bool     `json:"in_use"`
}

// Images lists local top-level images, tagging each with whether a container
// uses it and whether it's dangling (untagged). Sorted largest first.
func (c *Client) Images(ctx context.Context) ([]ImageInfo, error) {
	imgs, err := c.cli.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return nil, err
	}

	// Which image ids are referenced by a container (running or not).
	used := map[string]bool{}
	if conts, err := c.cli.ContainerList(ctx, container.ListOptions{All: true}); err == nil {
		for _, ct := range conts {
			used[ct.ImageID] = true
		}
	}

	out := make([]ImageInfo, 0, len(imgs))
	for _, im := range imgs {
		tags := im.RepoTags
		dangling := len(tags) == 0 || (len(tags) == 1 && tags[0] == "<none>:<none>")
		if dangling {
			tags = []string{} // never nil -> serializes as [] not null
		}
		out = append(out, ImageInfo{
			ID:       im.ID,
			Tags:     tags,
			Size:     im.Size,
			Created:  im.Created,
			Dangling: dangling,
			InUse:    used[im.ID],
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
	_, err := c.cli.ImageRemove(ctx, id, image.RemoveOptions{Force: force, PruneChildren: true})
	return err
}

// PruneImages removes unreferenced images: dangling-only by default, or every
// unused image when all is true. Returns how many were deleted and bytes freed.
func (c *Client) PruneImages(ctx context.Context, all bool) (PruneResult, error) {
	f := filters.NewArgs()
	// dangling=false tells the daemon to prune ALL unused images, not just the
	// untagged ones; dangling=true (the default) prunes only dangling.
	f.Add("dangling", map[bool]string{true: "false", false: "true"}[all])
	rep, err := c.cli.ImagesPrune(ctx, f)
	if err != nil {
		return PruneResult{}, err
	}
	return PruneResult{Deleted: len(rep.ImagesDeleted), Reclaimed: rep.SpaceReclaimed}, nil
}
