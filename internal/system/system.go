// Package system exposes the SystemRouter: daemon-wide info and disk usage.
// Wire name: "System".
package system

import (
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
