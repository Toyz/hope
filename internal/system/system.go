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
	updates, at, err := r.docker.AllUpdates(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	outdated := 0
	for _, u := range updates {
		if u.Status == "outdated" {
			outdated++
		}
	}
	checkedAt := ""
	if !at.IsZero() {
		checkedAt = at.UTC().Format(time.RFC3339)
	}
	return &UpdatesResult{Updates: updates, Outdated: outdated, CheckedAt: checkedAt}, nil
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
