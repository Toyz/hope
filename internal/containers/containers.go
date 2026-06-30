// Package containers exposes the ContainersRouter: per-container inspect and
// lifecycle control. Wire name: "Containers".
package containers

import (
	"context"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
)

// ContainersRouter handles single-container operations.
type ContainersRouter struct {
	docker *docker.Client
}

// NewContainersRouter wires the router to the docker client.
func NewContainersRouter(d *docker.Client) *ContainersRouter {
	return &ContainersRouter{docker: d}
}

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
	info, err := r.docker.Inspect(ctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	return info, nil
}

// Start starts a stopped container.
func (r *ContainersRouter) Start(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.docker.Start)
}

// Stop stops a running container.
func (r *ContainersRouter) Stop(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.docker.Stop)
}

// Restart restarts a container.
func (r *ContainersRouter) Restart(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.docker.Restart)
}

// Kill sends SIGKILL to a container.
func (r *ContainersRouter) Kill(ctx *rpc.Context, p *IDParams) (*OpResult, error) {
	return r.act(ctx, p, r.docker.Kill)
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
