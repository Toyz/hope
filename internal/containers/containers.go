// Package containers exposes the ContainersRouter: per-container inspect and
// lifecycle control. Wire name: "Containers".
package containers

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/audit"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
)

// pullTimeout caps a single-container image pull.
const pullTimeout = 15 * time.Minute

// ContainersRouter handles single-container operations.
type ContainersRouter struct {
	hosts *hosts.Set
	bus   *events.Bus    // nil-safe: publishes lifecycle events to the global feed
	audit *audit.Auditor // nil-safe: records lifecycle mutations to the fleet audit log
}

// NewContainersRouter wires the router to the host set (active-host aware), the event
// bus (live UI updates on lifecycle), and the audit engine (records who did what).
func NewContainersRouter(hs *hosts.Set, bus *events.Bus, aud *audit.Auditor) *ContainersRouter {
	return &ContainersRouter{hosts: hs, bus: bus, audit: aud}
}

// dock is the docker client for the currently-active host.
func (r *ContainersRouter) dock(ctx context.Context) docker.API { return r.hosts.ActiveFor(ctx) }

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
	info, err := r.dock(ctx).Inspect(ctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	return info, nil
}

// Top returns the container's live process list (docker top) for the processes
// view. Only valid for a running container; a stopped one errors.
func (r *ContainersRouter) Top(ctx *rpc.Context, p *IDParams) (*docker.TopResult, error) {
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
	spec, err := r.dock(ctx).ContainerSpecOf(ctx, p.ID)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	return spec, nil
}

// Start starts a stopped container.
func (r *ContainersRouter) Start(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, events.KindContainerState, "started", r.dock(ctx).Start)
}

// Stop stops a running container.
func (r *ContainersRouter) Stop(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, events.KindContainerState, "stopped", r.dock(ctx).Stop)
}

// Restart restarts a container.
func (r *ContainersRouter) Restart(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, events.KindContainerState, "restarted", r.dock(ctx).Restart)
}

// Kill sends SIGKILL to a container.
func (r *ContainersRouter) Kill(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, events.KindContainerState, "killed", r.dock(ctx).Kill)
}

// Remove stops and deletes a container (for loose/ungrouped containers compose
// can't manage).
func (r *ContainersRouter) Remove(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
	return r.act(ctx, p, events.KindContainerRemoved, "removed", r.dock(ctx).Remove)
}

// Pull pulls the latest image for this one container (not the whole stack).
func (r *ContainersRouter) Pull(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
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
	pname, pproj := r.nameAndProject(ctx, p.ID)
	r.audit.Record(ctx, audit.Entry{Category: audit.CatContainer, Action: "pulled", Host: r.hosts.ActiveIDFor(ctx), Project: pproj, Target: pname, Detail: img, OK: true})
	r.bus.Publish(events.Event{Kind: events.KindImageCurrent, Host: r.hosts.ActiveIDFor(ctx), IDs: []string{p.ID}})
	return &CtrResult{OK: true}, nil
}

// nameAndProject resolves a container's display name and its compose project (stack).
// Both are recorded on the audit entry — the stack is mission-critical provenance
// (where an action came from), so it's always captured, not best-effort UI sugar.
func (r *ContainersRouter) nameAndProject(ctx context.Context, id string) (name, project string) {
	name = shortID(id)
	if n, err := r.dock(ctx).ContainerName(ctx, id); err == nil && n != "" {
		name = n
	}
	if _, labels, err := r.dock(ctx).ContainerMatchInfo(ctx, id); err == nil {
		project = labels[docker.LabelProject]
	}
	return
}

// Redeploy pulls this container's image then recreates it on the new image,
// preserving its config/networks/labels.
func (r *ContainersRouter) Redeploy(ctx *rpc.Context, p *IDParams) (*CtrResult, error) {
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
	rname, rproj := r.nameAndProject(ctx, p.ID)
	r.audit.Record(ctx, audit.Entry{Category: audit.CatContainer, Action: "redeployed", Host: r.hosts.ActiveIDFor(ctx), Project: rproj, Target: rname, Detail: img, OK: true})
	r.bus.Publish(events.Event{Kind: events.KindImageCurrent, Host: r.hosts.ActiveIDFor(ctx), IDs: []string{p.ID}})
	return &CtrResult{OK: true}, nil
}

func (r *ContainersRouter) act(ctx *rpc.Context, p *IDParams, kind events.Kind, action string, fn func(context.Context, string) error) (*CtrResult, error) {
	if p.ID == "" {
		return nil, rpc.BadRequest("id required")
	}
	// Resolve name + stack BEFORE the op (a removed container can't be named after) —
	// used for the completion notice and the audit entry's provenance.
	name, project := r.nameAndProject(ctx, p.ID)
	start := time.Now()
	err := fn(ctx, p.ID)
	r.audit.Record(ctx, audit.Entry{
		Category: audit.CatContainer, Action: action, Host: r.hosts.ActiveIDFor(ctx), Project: project, Target: name,
		Danger: kind == events.KindContainerRemoved || action == "killed",
		OK:     err == nil, Err: audit.ErrStr(err), Millis: time.Since(start).Milliseconds(),
	})
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	r.bus.Publish(events.Event{Kind: kind, Host: r.hosts.ActiveIDFor(ctx), IDs: []string{p.ID}, Data: ctrActionData(action, name)})
	return &CtrResult{OK: true}, nil
}

// ctrActionData is the container.state/removed payload the UI turns into a
// completion toast: what happened ("restarted") to which container ("web").
func ctrActionData(action, name string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"action": action, "name": name})
	return b
}

// shortID trims a container id to the 12-char form docker shows.
func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
