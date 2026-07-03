package deploy

import (
	"context"
	"strings"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
)

// DeployRouter exposes the non-streaming half of the deploy surface: parse an
// imported compose file, export/reopen a stack's spec, and create standalone
// networks/volumes. The long-running, log-streaming operations (applyStack,
// deployContainer, destroyStack) ride the "Stream" NDJSON transport in the
// logstream plugin instead. Wire name: "Deploy".
type DeployRouter struct {
	hosts *hosts.Set
	store *Store
}

// NewDeployRouter wires the router to the host set + spec store.
func NewDeployRouter(hs *hosts.Set, store *Store) *DeployRouter {
	return &DeployRouter{hosts: hs, store: store}
}

func (r *DeployRouter) dock(ctx context.Context) *docker.Client { return r.hosts.ActiveFor(ctx) }
func (r *DeployRouter) hostID() string                          { return r.hosts.ActiveID() }

// ── import / export / edit ──────────────────────────────────────────────────

// ImportComposeParams carries a pasted compose file (+ optional .env) to parse.
type ImportComposeParams struct {
	Project string `sov:"project,0" json:"project"`
	Compose string `sov:"compose,1,required" json:"compose"`
	Env     string `sov:"env,2" json:"env"`
}

// ImportResult is a parsed spec plus any non-fatal warnings (unsupported keys).
type ImportResult struct {
	Spec     *stackspec.StackSpec `json:"spec"`
	Warnings []stackspec.Warning  `json:"warnings"`
}

// ImportCompose parses a compose file into a StackSpec so the builder can
// prefill from it. Pure: it creates nothing.
func (r *DeployRouter) ImportCompose(ctx *rpc.Context, p *ImportComposeParams) (*ImportResult, error) {
	if strings.TrimSpace(p.Compose) == "" {
		return nil, rpc.BadRequest("compose text is required")
	}
	project := strings.TrimSpace(p.Project)
	if project == "" {
		project = "stack"
	}
	spec, warns, err := stackspec.FromCompose(project, p.Compose, p.Env, nil)
	if err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return &ImportResult{Spec: spec, Warnings: warns}, nil
}

// ProjectParams targets a stack by project name.
type ProjectParams struct {
	Project string `sov:"project,0,required" json:"project"`
}

// EditSpec returns the editable spec for a stack: the stored authored spec when
// hope deployed it, otherwise one reconstructed from the live containers (so any
// stack can be adopted and edited).
func (r *DeployRouter) EditSpec(ctx *rpc.Context, p *ProjectParams) (*stackspec.StackSpec, error) {
	if p.Project == "" {
		return nil, rpc.BadRequest("project required")
	}
	if spec, err := r.store.Load(r.hostID(), p.Project); err == nil && spec != nil {
		return spec, nil
	}
	spec, err := r.dock(ctx).ProjectSpec(ctx, p.Project)
	if err != nil {
		return nil, rpc.NotFound("%v", err)
	}
	return spec, nil
}

// ExportResult carries a rendered compose document.
type ExportResult struct {
	Project string `json:"project"`
	Content string `json:"content"`
}

// ExportCompose renders a stack's spec (stored or reconstructed) to compose YAML.
func (r *DeployRouter) ExportCompose(ctx *rpc.Context, p *ProjectParams) (*ExportResult, error) {
	if p.Project == "" {
		return nil, rpc.BadRequest("project required")
	}
	spec, err := r.store.Load(r.hostID(), p.Project)
	if err != nil || spec == nil {
		spec, err = r.dock(ctx).ProjectSpec(ctx, p.Project)
		if err != nil {
			return nil, rpc.NotFound("%v", err)
		}
	}
	yaml, err := stackspec.ToCompose(spec)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return &ExportResult{Project: p.Project, Content: yaml}, nil
}

// ── resource creation ───────────────────────────────────────────────────────

// CreateNetworkParams describes a network to create. Options/Labels are raw
// "KEY=VALUE" lines (one per line) — driver options (--opt: parent, mtu,
// encrypted…) and labels — parsed server-side.
type CreateNetworkParams struct {
	Name       string `sov:"name,0,required" json:"name"`
	Driver     string `sov:"driver,1" json:"driver"`
	Subnet     string `sov:"subnet,2" json:"subnet"`
	Gateway    string `sov:"gateway,3" json:"gateway"`
	Internal   bool   `sov:"internal,4" json:"internal"`
	Attachable bool   `sov:"attachable,5" json:"attachable"`
	IPv6       bool   `sov:"ipv6,6" json:"ipv6"`
	Options    string `sov:"options,7" json:"options"`
	Labels     string `sov:"labels,8" json:"labels"`
}

// CreateNetwork creates a standalone network and returns its listing view.
func (r *DeployRouter) CreateNetwork(ctx *rpc.Context, p *CreateNetworkParams) (*docker.NetworkInfo, error) {
	if strings.TrimSpace(p.Name) == "" {
		return nil, rpc.BadRequest("network name is required")
	}
	spec := stackspec.NetworkSpec{
		Name: p.Name, Driver: p.Driver, Subnet: p.Subnet, Gateway: p.Gateway,
		Internal: p.Internal, Attachable: p.Attachable, IPv6: p.IPv6,
		Options: parseKV(p.Options), Labels: parseKV(p.Labels),
	}
	if _, err := r.dock(ctx).CreateNetwork(ctx, spec); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return r.findNetwork(ctx, p.Name), nil
}

// CreateVolumeParams describes a volume to create. Options/Labels are raw
// "KEY=VALUE" lines — driver options (--opt: type=nfs, o=…, device=…) and labels.
type CreateVolumeParams struct {
	Name    string `sov:"name,0,required" json:"name"`
	Driver  string `sov:"driver,1" json:"driver"`
	Options string `sov:"options,2" json:"options"`
	Labels  string `sov:"labels,3" json:"labels"`
}

// CreateVolume creates a standalone named volume and returns its listing view.
func (r *DeployRouter) CreateVolume(ctx *rpc.Context, p *CreateVolumeParams) (*docker.VolumeInfo, error) {
	if strings.TrimSpace(p.Name) == "" {
		return nil, rpc.BadRequest("volume name is required")
	}
	spec := stackspec.VolumeSpec{Name: p.Name, Driver: p.Driver, Options: parseKV(p.Options), Labels: parseKV(p.Labels)}
	if _, err := r.dock(ctx).CreateVolume(ctx, spec); err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return r.findVolume(ctx, p.Name), nil
}

// parseKV turns "KEY=VALUE" lines (one per line, blanks and #comments skipped)
// into a map — for driver options and labels entered as free text. Returns nil
// when empty so an omitted field stays absent in the spec.
func parseKV(s string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if k = strings.TrimSpace(k); k != "" {
			out[k] = strings.TrimSpace(v)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func (r *DeployRouter) findNetwork(ctx *rpc.Context, name string) *docker.NetworkInfo {
	nets, err := r.dock(ctx).Networks(ctx)
	if err != nil {
		return &docker.NetworkInfo{Name: name}
	}
	for i := range nets {
		if nets[i].Name == name {
			return &nets[i]
		}
	}
	return &docker.NetworkInfo{Name: name}
}

func (r *DeployRouter) findVolume(ctx *rpc.Context, name string) *docker.VolumeInfo {
	vols, err := r.dock(ctx).Volumes(ctx)
	if err != nil {
		return &docker.VolumeInfo{Name: name}
	}
	for i := range vols {
		if vols[i].Name == name {
			return &vols[i]
		}
	}
	return &docker.VolumeInfo{Name: name}
}
