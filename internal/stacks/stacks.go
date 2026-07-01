// Package stacks exposes the StacksRouter: the dashboard listing plus stack
// lifecycle. Lifecycle is driven through the Docker API using compose labels —
// NO compose files required — so start/stop/restart/pull/redeploy work over a
// remote daemon or socket proxy and without mounting the host's project dirs.
// Viewing the compose file is the one file-dependent feature and is gated on
// whether hope can read it (StackSummary.ComposeAvailable).
package stacks

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/compose"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// opTimeout caps a stack operation (image pulls can be slow).
const opTimeout = 15 * time.Minute

// StacksRouter handles stack listing and lifecycle.
type StacksRouter struct {
	hosts   *hosts.Set
	compose *compose.Manager
}

// NewStacksRouter wires the router to the host set (active-host aware) and the
// (file-based) compose manager used only for the compose-file viewer.
func NewStacksRouter(hs *hosts.Set, c *compose.Manager) *StacksRouter {
	return &StacksRouter{hosts: hs, compose: c}
}

// dock is the docker client for the currently-active host.
func (r *StacksRouter) dock() *docker.Client { return r.hosts.Active() }

// ProjectParams targets a single compose project by name.
type ProjectParams struct {
	Project string `sov:"project,0,required" json:"project"`
}

// StackResult is the outcome of a lifecycle command: OK plus a human-readable log.
type StackResult struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

// ComposeFileResult carries the concatenated compose file text.
type ComposeFileResult struct {
	Project string `json:"project"`
	Content string `json:"content"`
}

// List returns every compose stack grouped from running/stopped containers.
func (r *StacksRouter) List(ctx *rpc.Context) ([]docker.StackSummary, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	return r.dock().Stacks(ctx)
}

// Start starts every container in the project.
func (r *StacksRouter) Start(ctx *rpc.Context, p *ProjectParams) (*StackResult, error) {
	return r.eachContainer(ctx, p, "start", r.dock().Start)
}

// Stop stops every container in the project.
func (r *StacksRouter) Stop(ctx *rpc.Context, p *ProjectParams) (*StackResult, error) {
	return r.eachContainer(ctx, p, "stop", r.dock().Stop)
}

// Restart restarts every container in the project.
func (r *StacksRouter) Restart(ctx *rpc.Context, p *ProjectParams) (*StackResult, error) {
	return r.eachContainer(ctx, p, "restart", r.dock().Restart)
}

// Pull pulls the latest image for each distinct image in the project.
func (r *StacksRouter) Pull(ctx *rpc.Context, p *ProjectParams) (*StackResult, error) {
	if err := r.gate(ctx, p); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	res, err := r.pull(cctx, p.Project)
	if err == nil {
		r.dock().RefreshProjectStatus(cctx, p.Project) // keep update cache fresh
	}
	return res, err
}

// Redeploy pulls images then recreates each container so it runs on the new
// image — the API-only equivalent of `compose up -d --force-recreate`.
func (r *StacksRouter) Redeploy(ctx *rpc.Context, p *ProjectParams) (*StackResult, error) {
	if err := r.gate(ctx, p); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()

	var log strings.Builder
	if res, err := r.pull(cctx, p.Project); err != nil {
		return nil, err
	} else {
		log.WriteString(res.Output)
		if res.Error != "" {
			return &StackResult{OK: false, Output: log.String(), Error: res.Error}, nil
		}
	}
	ids, err := r.dock().ProjectContainerIDs(cctx, p.Project)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	n := 0
	for _, id := range ids {
		if err := r.dock().RecreateManaged(cctx, id); err != nil {
			return &StackResult{OK: false, Output: log.String(), Error: fmt.Sprintf("recreate failed: %v", err)}, nil
		}
		n++
	}
	fmt.Fprintf(&log, "recreated %d container(s)\n", n)
	r.dock().RefreshProjectStatus(cctx, p.Project) // images are current — refresh the cache
	return &StackResult{OK: true, Output: log.String()}, nil
}

// Stats returns a point-in-time CPU/memory snapshot for every running container
// in the project (the stack page's "snapshot" button).
func (r *StacksRouter) Stats(ctx *rpc.Context, p *ProjectParams) ([]docker.ContainerStat, error) {
	if err := r.gate(ctx, p); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	stats, err := r.dock().ProjectStats(cctx, p.Project)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return stats, nil
}

// Updates checks each container's image against its registry (manifest lookup,
// no pull) so the UI can flag containers running an outdated image.
func (r *StacksRouter) Updates(ctx *rpc.Context, p *ProjectParams) ([]docker.ImageUpdate, error) {
	if err := r.gate(ctx, p); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	updates, err := r.dock().ProjectUpdates(cctx, p.Project)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return updates, nil
}

// ComposeFile returns the stack's compose file text — only available when hope
// can read the file (ComposeAvailable). Hidden in the UI otherwise.
func (r *StacksRouter) ComposeFile(ctx *rpc.Context, p *ProjectParams) (*ComposeFileResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	ref, err := r.resolve(ctx, p.Project)
	if err != nil {
		return nil, err
	}
	content, err := r.compose.ComposeFile(ref)
	if err != nil {
		return nil, rpc.BadRequest("compose file unavailable (not mounted/readable): %v", err)
	}
	return &ComposeFileResult{Project: p.Project, Content: content}, nil
}

// eachContainer applies fn to every container in the project via the Docker API.
func (r *StacksRouter) eachContainer(ctx *rpc.Context, p *ProjectParams, verb string, fn func(context.Context, string) error) (*StackResult, error) {
	if err := r.gate(ctx, p); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()

	ids, err := r.dock().ProjectContainerIDs(cctx, p.Project)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	for _, id := range ids {
		if err := fn(cctx, id); err != nil {
			return &StackResult{OK: false, Error: fmt.Sprintf("%s %s: %v", verb, id[:12], err)}, nil
		}
	}
	return &StackResult{OK: true, Output: fmt.Sprintf("%s: %d container(s)", verb, len(ids))}, nil
}

func (r *StacksRouter) pull(ctx context.Context, project string) (*StackResult, error) {
	imgs, err := r.dock().ImagesForProject(ctx, project)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	var log strings.Builder
	for _, img := range imgs {
		fmt.Fprintf(&log, "pull %s\n", img)
		if err := r.dock().PullImage(ctx, img); err != nil {
			return &StackResult{OK: false, Output: log.String(), Error: err.Error()}, nil
		}
	}
	return &StackResult{OK: true, Output: log.String()}, nil
}

// gate enforces auth and a non-empty project name.
func (r *StacksRouter) gate(ctx *rpc.Context, p *ProjectParams) error {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return err
	}
	if p.Project == "" {
		return rpc.BadRequest("project required")
	}
	return nil
}

// resolve builds a compose.StackRef from a project's container labels.
func (r *StacksRouter) resolve(ctx context.Context, project string) (compose.StackRef, error) {
	all, err := r.dock().Stacks(ctx)
	if err != nil {
		return compose.StackRef{}, rpc.Internal("%v", err)
	}
	for _, st := range all {
		if st.Project == project {
			if len(st.ConfigFiles) == 0 {
				return compose.StackRef{}, rpc.BadRequest("stack %q has no compose config files", project)
			}
			return compose.StackRef{Project: st.Project, WorkingDir: st.WorkingDir, ConfigFiles: st.ConfigFiles}, nil
		}
	}
	return compose.StackRef{}, rpc.NotFound("stack %q not found", project)
}
