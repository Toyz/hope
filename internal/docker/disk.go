package docker

import (
	"context"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/build"
)

// StartDiskCrawler computes docker disk usage on boot, then every `every`.
// `docker system df` is expensive on big hosts, so the UI reads the cache.
func (c *Client) StartDiskCrawler(ctx context.Context, every time.Duration) {
	go func() {
		c.crawlDisk(ctx)
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.crawlDisk(ctx)
			}
		}
	}()
}

func (c *Client) crawlDisk(ctx context.Context) {
	du, err := c.sdk().DiskUsage(ctx, types.DiskUsageOptions{})
	if err != nil {
		return
	}
	c.duMu.Lock()
	c.duCache = du
	c.duAt = time.Now()
	c.duMu.Unlock()
}

// PruneBuildCache clears the builder cache (the layer/step cache from image
// builds — often the biggest reclaimable chunk, and invisible to image prune).
// Returns bytes reclaimed.
func (c *Client) PruneBuildCache(ctx context.Context) (uint64, error) {
	rep, err := c.sdk().BuildCachePrune(ctx, build.CachePruneOptions{All: true})
	if err != nil {
		return 0, err
	}
	if rep == nil {
		return 0, nil
	}
	return rep.SpaceReclaimed, nil
}

// DiskUsageCached returns the last crawled disk usage and when it was taken.
func (c *Client) DiskUsageCached() (any, time.Time) {
	c.duMu.RLock()
	defer c.duMu.RUnlock()
	return c.duCache, c.duAt
}

// RefreshDiskUsage runs a live df, updates the cache, and returns it — for the
// user-triggered "refresh" button.
func (c *Client) RefreshDiskUsage(ctx context.Context) (any, time.Time, error) {
	du, err := c.sdk().DiskUsage(ctx, types.DiskUsageOptions{})
	if err != nil {
		return nil, time.Time{}, err
	}
	c.duMu.Lock()
	c.duCache = du
	c.duAt = time.Now()
	at := c.duAt
	c.duMu.Unlock()
	return du, at, nil
}
