// Package containers exposes the ContainersRouter: per-container inspect and
// lifecycle control. Wire name: "Containers".
package containers

import (
	"context"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// pullTimeout caps a single-container image pull.
const pullTimeout = 15 * time.Minute

// ContainersRouter handles single-container operations.
type ContainersRouter struct {
	hosts *hosts.Set
}

// NewContainersRouter wires the router to the host set (active-host aware).
func NewContainersRouter(hs *hosts.Set) *ContainersRouter {
	return &ContainersRouter{hosts: hs}
}

// dock is the docker client for the currently-active host.
func (r *ContainersRouter) dock() *docker.Client { return r.hosts.Active() }

// IDParams targets a container by id or name.
type IDParams struct {
	ID string `sov:"id,0,required" json:"id"`
}

// OpResult is the outcome of a container action.
type OpResult struct {
	OK bool `json:"ok"`
}

// Inspect returns the full raw docker inspect JSON for a container.
func (r *ContainersRouter) Inspect(ctx *rpc.Context, p *IDParams) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	info, err := r.dock().Inspect(ctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	return info, nil
}

// Start starts a stopped container.
func (r *ContainersRouter) Start(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.dock().Start)
}

// Stop stops a running container.
func (r *ContainersRouter) Stop(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.dock().Stop)
}

// Restart restarts a container.
func (r *ContainersRouter) Restart(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.dock().Restart)
}

// Kill sends SIGKILL to a container.
func (r *ContainersRouter) Kill(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.dock().Kill)
}

// Pull pulls the latest image for this one container (not the whole stack).
func (r *ContainersRouter) Pull(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, rpc.BadRequest("id required")
	}
	cctx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	img, err := r.dock().ContainerImage(cctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	if err := r.dock().PullImage(cctx, img); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	r.dock().RefreshImageStatus(cctx, img) // keep the update cache fresh
	return &OpResult{OK: true}, nil
}

// Redeploy pulls this container's image then recreates it on the new image,
// preserving its config/networks/labels.
func (r *ContainersRouter) Redeploy(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, rpc.BadRequest("id required")
	}
	cctx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	img, err := r.dock().ContainerImage(cctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	if err := r.dock().PullImage(cctx, img); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	if err := r.dock().RecreateManaged(cctx, p.ID); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	r.dock().RefreshImageStatus(cctx, img) // image is now current — refresh the cache
	return &OpResult{OK: true}, nil
}

func (r *ContainersRouter) act(ctx *rpc.Context, p *IDParams, fn func(context.Context, string) error) (*OpResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, rpc.BadRequest("id required")
	}
	if err := fn(ctx, p.ID); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return &OpResult{OK: true}, nil
}
