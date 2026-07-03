// Package containers exposes the ContainersRouter: per-container inspect and
// lifecycle control. Wire name: "Containers".
package containers

import (
	"context"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
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
func (r *ContainersRouter) dock(ctx context.Context) *docker.Client { return r.hosts.ActiveFor(ctx) }

// IDParams targets a container by id or name.
type IDParams struct {
	ID string `sov:"id,0,required" json:"id"`
}

// CtrResult is the outcome of a container action.
type CtrResult struct {
	OK bool `json:"ok"`
}

// Inspect returns the full raw docker inspect JSON for a container.
func (r *ContainersRouter) Inspect(ctx *rpc.Context, p *IDParams) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	info, err := r.dock(ctx).Inspect(ctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	return info, nil
}

// Top returns the container's live process list (docker top) for the processes
// view. Only valid for a running container; a stopped one errors.
func (r *ContainersRouter) Top(ctx *rpc.Context, p *IDParams) (*docker.TopResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	top, err := r.dock(cctx).Top(cctx, p.ID)
	if err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return &top, nil
}

// Spec reconstructs a container's editable settings (image, ports, env, mounts,
// networks, labels…) from its live inspect — the seed for the edit form.
func (r *ContainersRouter) Spec(ctx *rpc.Context, p *IDParams) (*stackspec.ContainerSpec, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	spec, err := r.dock(ctx).ContainerSpecOf(ctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	return spec, nil
}

// Start starts a stopped container.
func (r *ContainersRouter) Start(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, r.dock(ctx).Start)
}

// Stop stops a running container.
func (r *ContainersRouter) Stop(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, r.dock(ctx).Stop)
}

// Restart restarts a container.
func (r *ContainersRouter) Restart(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, r.dock(ctx).Restart)
}

// Kill sends SIGKILL to a container.
func (r *ContainersRouter) Kill(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, r.dock(ctx).Kill)
}

// Remove stops and deletes a container (for loose/ungrouped containers compose
// can't manage).
func (r *ContainersRouter) Remove(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, r.dock(ctx).Remove)
}

// Pull pulls the latest image for this one container (not the whole stack).
func (r *ContainersRouter) Pull(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, rpc.BadRequest("id required")
	}
	cctx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	img, err := r.dock(ctx).ContainerImage(cctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	if err := r.dock(ctx).PullImage(cctx, img); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	r.dock(ctx).RefreshImageStatus(cctx, img) // keep the update cache fresh
	return &CtrResult{OK: true}, nil
}

// Redeploy pulls this container's image then recreates it on the new image,
// preserving its config/networks/labels.
func (r *ContainersRouter) Redeploy(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, rpc.BadRequest("id required")
	}
	cctx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	img, err := r.dock(ctx).ContainerImage(cctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	if err := r.dock(ctx).PullImage(cctx, img); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	if err := r.dock(ctx).RecreateManaged(cctx, p.ID); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	r.dock(ctx).RefreshImageStatus(cctx, img) // image is now current — refresh the cache
	return &CtrResult{OK: true}, nil
}

func (r *ContainersRouter) act(ctx *rpc.Context, p *IDParams, fn func(context.Context, string) error) (*CtrResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, rpc.BadRequest("id required")
	}
	if err := fn(ctx, p.ID); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return &CtrResult{OK: true}, nil
}
