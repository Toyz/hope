// Package system exposes the SystemRouter: daemon-wide info and disk usage.
// Wire name: "System".
package system

import (
	"context"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
)

// SystemRouter surfaces daemon-level diagnostics.
type SystemRouter struct {
	docker *docker.Client
}

// NewSystemRouter wires the router to the docker client.
func NewSystemRouter(d *docker.Client) *SystemRouter {
	return &SystemRouter{docker: d}
}

// Info returns daemon info (version, counts, resources).
func (r *SystemRouter) Info(ctx *rpc.Context) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	info, err := r.docker.Info(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return info, nil
}

// UpdatesResult is the cluster-wide image-freshness report for the dashboard.
type UpdatesResult struct {
	Updates   []docker.ClusterUpdate `json:"updates"`
	Outdated  int                    `json:"outdated"`
	CheckedAt string                 `json:"checked_at"`
}

// Updates returns the cached cluster-wide image-freshness report (filled by the
// background crawler) so the dashboard can flag containers running stale images.
func (r *SystemRouter) Updates(ctx *rpc.Context) (*UpdatesResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return r.collectUpdates(cctx)
}

// RefreshUpdates runs an immediate cluster-wide crawl (user-triggered from the
// dashboard "updates" refresh) then returns the fresh report.
func (r *SystemRouter) RefreshUpdates(ctx *rpc.Context) (*UpdatesResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	r.docker.RefreshUpdates(cctx)
	return r.collectUpdates(cctx)
}

func (r *SystemRouter) collectUpdates(ctx context.Context) (*UpdatesResult, error) {
	updates, at, err := r.docker.AllUpdates(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	outdated := 0
	for _, u := range updates {
		if u.Status == "outdated" {
			outdated++
		}
	}
	return &UpdatesResult{Updates: updates, Outdated: outdated, CheckedAt: stamp(at)}, nil
}

// Images lists the local images for the images page.
func (r *SystemRouter) Images(ctx *rpc.Context) ([]docker.ImageInfo, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	imgs, err := r.docker.Images(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return imgs, nil
}

// ImageRemoveParams targets one image for deletion.
type ImageRemoveParams struct {
	ID    string `sov:"id,0,required" json:"id"`
	Force bool   `sov:"force,1" json:"force"`
}

// RemoveImage deletes a single local image.
func (r *SystemRouter) RemoveImage(ctx *rpc.Context, p *ImageRemoveParams) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := r.docker.RemoveImage(cctx, p.ID, p.Force); err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return map[string]bool{"ok": true}, nil
}

// PruneParams selects the prune scope.
type PruneParams struct {
	All bool `sov:"all,0" json:"all"` // true = all unused images, false = dangling only
}

// PruneImages removes unused images (dangling-only, or all unused).
func (r *SystemRouter) PruneImages(ctx *rpc.Context, p *PruneParams) (*docker.PruneResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	res, err := r.docker.PruneImages(cctx, p.All)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return &res, nil
}

// DiskResult wraps a disk-usage snapshot with the time it was taken.
type DiskResult struct {
	Usage     any    `json:"usage"`
	CheckedAt string `json:"checked_at"`
}

// DiskUsage returns the cached disk-usage snapshot (crawled hourly — df is too
// expensive to run on every dashboard load).
func (r *SystemRouter) DiskUsage(ctx *rpc.Context) (*DiskResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	du, at := r.docker.DiskUsageCached()
	return &DiskResult{Usage: du, CheckedAt: stamp(at)}, nil
}

// RefreshDiskUsage runs a live df (user-triggered) and updates the cache.
func (r *SystemRouter) RefreshDiskUsage(ctx *rpc.Context) (*DiskResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	du, at, err := r.docker.RefreshDiskUsage(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return &DiskResult{Usage: du, CheckedAt: stamp(at)}, nil
}

func stamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
