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

// DiskUsage returns the daemon's disk-usage breakdown.
func (r *SystemRouter) DiskUsage(ctx *rpc.Context) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	du, err := r.docker.DiskUsage(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return du, nil
}
