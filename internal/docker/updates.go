package docker

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

// ImageUpdate reports whether a container's image is current with its registry.
// Status is one of: "current", "outdated", "unknown".
type ImageUpdate struct {
	ID     string `json:"id"`
	Image  string `json:"image"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// refStatus is the cached freshness verdict for one image ref.
type refStatus struct {
	status string
	detail string
}

// ClusterUpdate is a per-container freshness row spanning all projects, for the
// dashboard. Carries enough identity to render and link the container.
type ClusterUpdate struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	Service string `json:"service"`
	Name    string `json:"name"`
	Image   string `json:"image"`
	Status  string `json:"status"`
	Detail  string `json:"detail,omitempty"`
}

// imageStatus compares the locally-pulled digest of a ref against the registry's
// current digest. It uses DistributionInspect (a manifest lookup, NOT a pull) so
// it never downloads layers.
func (c *Client) imageStatus(ctx context.Context, ref string) (string, string) {
	insp, _, err := c.cli.ImageInspectWithRaw(ctx, ref)
	if err != nil {
		return "unknown", "image not found locally"
	}
	if len(insp.RepoDigests) == 0 {
		return "unknown", "no registry digest (local build?)"
	}
	dist, err := c.cli.DistributionInspect(ctx, ref, c.registryAuth(ref))
	if err != nil {
		return "unknown", "registry unreachable"
	}
	remote := dist.Descriptor.Digest.String()
	for _, rd := range insp.RepoDigests {
		if i := strings.LastIndex(rd, "@"); i >= 0 && rd[i+1:] == remote {
			return "current", ""
		}
	}
	return "outdated", "a newer image is available"
}

// ProjectUpdates checks every container in a project against its registry. The
// registry lookup is done once per distinct image ref (deduped), concurrently.
func (c *Client) ProjectUpdates(ctx context.Context, project string) ([]ImageUpdate, error) {
	f := filters.NewArgs(filters.Arg("label", labelProject+"="+project))
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, err
	}

	// Distinct image refs -> status (one registry call each).
	refs := map[string]struct{}{}
	for _, ct := range list {
		if ct.Image != "" {
			refs[ct.Image] = struct{}{}
		}
	}

	type res struct{ status, detail string }
	var (
		mu    sync.Mutex
		byRef = make(map[string]res, len(refs))
		wg    sync.WaitGroup
		sem   = make(chan struct{}, 8)
	)
	for ref := range refs {
		wg.Add(1)
		sem <- struct{}{}
		go func(ref string) {
			defer wg.Done()
			defer func() { <-sem }()
			st, detail := c.imageStatus(ctx, ref)
			mu.Lock()
			byRef[ref] = res{st, detail}
			mu.Unlock()
		}(ref)
	}
	wg.Wait()

	out := make([]ImageUpdate, 0, len(list))
	for _, ct := range list {
		r := byRef[ct.Image]
		if r.status == "" {
			r.status = "unknown"
		}
		out = append(out, ImageUpdate{ID: ct.ID, Image: ct.Image, Status: r.status, Detail: r.detail})
	}
	return out, nil
}

// StartUpdateCrawler runs an immediate crawl, then re-crawls every `every` to
// keep the cluster-wide freshness cache warm. It returns when ctx is cancelled.
func (c *Client) StartUpdateCrawler(ctx context.Context, every time.Duration) {
	go func() {
		c.crawlUpdates(ctx)
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.crawlUpdates(ctx)
			}
		}
	}()
}

// crawlUpdates checks every distinct image ref across all containers and stores
// the verdicts in the cache.
func (c *Client) crawlUpdates(ctx context.Context) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return
	}
	refs := map[string]struct{}{}
	for _, ct := range list {
		if ct.Image != "" {
			refs[ct.Image] = struct{}{}
		}
	}

	var (
		mu  sync.Mutex
		acc = make(map[string]refStatus, len(refs))
		wg  sync.WaitGroup
		sem = make(chan struct{}, 6)
	)
	for ref := range refs {
		wg.Add(1)
		sem <- struct{}{}
		go func(ref string) {
			defer wg.Done()
			defer func() { <-sem }()
			st, detail := c.imageStatus(ctx, ref)
			mu.Lock()
			acc[ref] = refStatus{st, detail}
			mu.Unlock()
		}(ref)
	}
	wg.Wait()

	c.updMu.Lock()
	c.updByRef = acc
	c.updAt = time.Now()
	c.updMu.Unlock()
}

// AllUpdates maps the running containers to the cached freshness verdicts and
// returns them with the time of the last crawl. Containers whose ref hasn't
// been crawled yet read as "unknown".
func (c *Client) AllUpdates(ctx context.Context) ([]ClusterUpdate, time.Time, error) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, time.Time{}, err
	}
	c.updMu.RLock()
	byRef := c.updByRef
	at := c.updAt
	c.updMu.RUnlock()

	out := make([]ClusterUpdate, 0, len(list))
	for _, ct := range list {
		r, ok := byRef[ct.Image]
		if !ok || r.status == "" {
			r = refStatus{status: "unknown"}
		}
		name := ""
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		out = append(out, ClusterUpdate{
			ID:      ct.ID,
			Project: ct.Labels[labelProject],
			Service: ct.Labels[labelService],
			Name:    name,
			Image:   ct.Image,
			Status:  r.status,
			Detail:  r.detail,
		})
	}
	return out, at, nil
}
