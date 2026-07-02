package deploy

import (
	"context"
	"fmt"
	"maps"
	"sort"
	"strings"

	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
)

// Engine runs deploys against the active host. It holds the host set (resolved
// per call, so a deploy targets whichever host is active) and the spec store.
type Engine struct {
	hosts *hosts.Set
	store *Store
}

// NewEngine wires the deploy engine to the host set + spec store.
func NewEngine(hs *hosts.Set, store *Store) *Engine { return &Engine{hosts: hs, store: store} }

func (e *Engine) dock(ctx context.Context) *docker.Client { return e.hosts.ActiveFor(ctx) }
func (e *Engine) hostID() string                          { return e.hosts.ActiveID() }

// Store exposes the spec store for the router's read paths.
func (e *Engine) Store() *Store { return e.store }

// ApplyStack deploys or updates a stack, streaming progress to emit. It creates
// declared networks/volumes, then diffs the desired services against the live
// stack — creating added services, recreating changed ones, removing gone ones,
// and leaving unchanged ones. On success the authored spec is saved so the stack
// can be reopened in the editor. Tunnel routes ride on the spec as data and are
// applied by the caller (the Tunnels RPC), not here.
func (e *Engine) ApplyStack(ctx context.Context, spec *stackspec.StackSpec, emit func(string)) error {
	if emit == nil {
		emit = func(string) {}
	}
	if err := spec.Validate(); err != nil {
		return err
	}
	project := strings.TrimSpace(spec.Name)
	if project == "" {
		return fmt.Errorf("stack name is required")
	}
	dock := e.dock(ctx)

	// 1) Networks + volumes. Map declared short names -> actual docker names
	//    (compose-style "<project>_<name>"; external keeps its name).
	netName := map[string]string{}
	for _, n := range spec.Networks {
		actual := n.Name
		if !n.External {
			actual = project + "_" + n.Name
		}
		netName[n.Name] = actual
		if n.External {
			continue
		}
		exists, err := dock.NetworkExists(ctx, actual)
		if err != nil {
			return err
		}
		if exists {
			emit("network " + actual + " — exists")
			continue
		}
		nn := n
		nn.Name = actual
		nn.Labels = withProject(nn.Labels, project)
		if _, err := dock.CreateNetwork(ctx, nn); err != nil {
			return err
		}
		emit("network " + actual + " — created")
	}
	volName := map[string]string{}
	for _, v := range spec.Volumes {
		actual := v.Name
		if !v.External {
			actual = project + "_" + v.Name
		}
		volName[v.Name] = actual
		if v.External {
			continue
		}
		exists, err := dock.VolumeExists(ctx, actual)
		if err != nil {
			return err
		}
		if exists {
			emit("volume " + actual + " — exists")
			continue
		}
		vv := v
		vv.Name = actual
		vv.Labels = withProject(vv.Labels, project)
		if _, err := dock.CreateVolume(ctx, vv); err != nil {
			return err
		}
		emit("volume " + actual + " — created")
	}

	// 2) Diff services against the live stack. The hash ignores hope/compose-
	//    injected labels, so an untouched service (whose live spec was
	//    reconstructed without those labels) matches and is LEFT ALONE — we never
	//    recreate or re-network a service that didn't change.
	defaultNet := project + "_default"
	defaultReady := false
	ensureDefault := func() error {
		if defaultReady {
			return nil
		}
		exists, err := dock.NetworkExists(ctx, defaultNet)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := dock.CreateNetwork(ctx, stackspec.NetworkSpec{Name: defaultNet, Labels: withProject(nil, project)}); err != nil {
				return err
			}
			emit("network " + defaultNet + " — created (default)")
		}
		defaultReady = true
		return nil
	}

	live := map[string]stackspec.ContainerSpec{}
	if cur, err := dock.ProjectSpec(ctx, project); err == nil {
		for _, s := range cur.Services {
			live[s.Name] = s
		}
	}
	desired := map[string]bool{}

	for _, svc := range spec.TopoSort() {
		if svc.Name == "" {
			svc.Name = "app"
		}
		desired[svc.Name] = true
		resolved := e.resolveService(svc, project, netName, volName)
		cur, exists := live[svc.Name]

		if exists {
			if stackspec.Hash(resolved) == stackspec.Hash(cur) {
				emit("skip " + svc.Name + " — unchanged")
				continue
			}
			// Changed: recreate, but keep the service on the networks it already
			// has when the edit didn't specify any (never silently re-network a
			// running service — that is what dropped tunnels before).
			if len(resolved.Networks) == 0 {
				resolved.Networks = cur.Networks
			}
			emit("recreate " + svc.Name)
			if err := e.removeService(ctx, project, svc.Name, emit); err != nil {
				return err
			}
		} else {
			// New service with no networks joins the compose-style default bridge.
			if len(resolved.Networks) == 0 {
				if err := ensureDefault(); err != nil {
					return err
				}
				resolved.Networks = []string{defaultNet}
			}
			emit("create " + svc.Name)
		}
		name := containerName(project, svc.Name)
		if _, err := dock.CreateContainer(ctx, name, resolved, true, emit); err != nil {
			return fmt.Errorf("service %s: %w", svc.Name, err)
		}
	}

	// 3) Remove services no longer desired.
	for name := range live {
		if desired[name] {
			continue
		}
		emit("remove " + name + " — no longer in stack")
		if err := e.removeService(ctx, project, name, emit); err != nil {
			return err
		}
	}

	if err := e.store.Save(e.hostID(), project, spec); err != nil {
		emit("warning: could not persist stack spec: " + err.Error())
	}
	emit("stack " + project + " applied")
	return nil
}

// DeployContainer creates a single one-off container from spec (no project
// grouping, no stored spec). Networks/volumes are used as-is (must pre-exist).
func (e *Engine) DeployContainer(ctx context.Context, spec stackspec.ContainerSpec, emit func(string)) error {
	if emit == nil {
		emit = func(string) {}
	}
	if strings.TrimSpace(spec.Image) == "" {
		return fmt.Errorf("image is required")
	}
	name := sanitizeName(spec.Name)
	spec.Labels = docker.WithManaged(spec.Labels)
	if name != "" {
		spec.Name = "" // no service alias for a bare container
	}
	if _, err := e.dock(ctx).CreateContainer(ctx, name, spec, true, emit); err != nil {
		return err
	}
	return nil
}

// Destroy tears a stack down: removes its containers and, when prune is set, the
// hope-managed networks/volumes it created. The stored spec is deleted too.
func (e *Engine) Destroy(ctx context.Context, project string, prune bool, emit func(string)) error {
	if emit == nil {
		emit = func(string) {}
	}
	dock := e.dock(ctx)
	ids, err := dock.ProjectContainerIDs(ctx, project)
	if err != nil {
		return err
	}
	for _, id := range ids {
		short := id
		if len(short) > 12 {
			short = short[:12]
		}
		emit("remove " + short)
		if err := dock.Remove(ctx, id); err != nil {
			return fmt.Errorf("remove %s: %w", short, err)
		}
	}
	if prune {
		if n, err := dock.RemoveManagedResources(ctx, project, emit); err != nil {
			return err
		} else if n > 0 {
			emit(fmt.Sprintf("pruned %d managed resource(s)", n))
		}
	}
	if err := e.store.Delete(e.hostID(), project); err != nil {
		emit("warning: could not delete stored spec: " + err.Error())
	}
	emit("stack " + project + " destroyed")
	return nil
}

// resolveService returns a copy of svc with network/volume references mapped to
// their actual docker names and compose/managed labels stamped, ready to create.
func (e *Engine) resolveService(svc stackspec.ContainerSpec, project string, netName, volName map[string]string) stackspec.ContainerSpec {
	out := svc
	if len(svc.Networks) > 0 {
		nets := make([]string, 0, len(svc.Networks))
		remap := func(n string) string {
			if a, ok := netName[n]; ok {
				return a
			}
			return n // reference to a pre-existing network
		}
		for _, n := range svc.Networks {
			nets = append(nets, remap(n))
		}
		sort.Strings(nets)
		out.Networks = nets
		// Re-key aliases from the declared short names to the actual network names.
		if len(svc.Aliases) > 0 {
			al := make(map[string][]string, len(svc.Aliases))
			for n, a := range svc.Aliases {
				al[remap(n)] = a
			}
			out.Aliases = al
		}
	}
	if len(svc.Mounts) > 0 {
		mounts := make([]stackspec.MountSpec, len(svc.Mounts))
		for i, m := range svc.Mounts {
			if m.Type == "volume" {
				if a, ok := volName[m.Source]; ok {
					m.Source = a
				}
			}
			mounts[i] = m
		}
		out.Mounts = mounts
	}
	out.Labels = composeLabels(svc.Labels, project, svc.Name)
	return out
}

// removeService removes every container of a service in a project.
func (e *Engine) removeService(ctx context.Context, project, service string, emit func(string)) error {
	refs, err := e.dock(ctx).ProjectContainers(ctx, project, service)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if err := e.dock(ctx).Remove(ctx, ref.ID); err != nil {
			return fmt.Errorf("remove %s: %w", ref.Name, err)
		}
	}
	return nil
}

// ── label helpers ───────────────────────────────────────────────────────────
// Compose/hope label keys are the exported source of truth in internal/docker.

func composeLabels(user map[string]string, project, service string) map[string]string {
	out := map[string]string{
		docker.LabelProject: project,
		docker.LabelService: service,
		docker.LabelNumber:  "1",
		docker.LabelManaged: "1",
	}
	maps.Copy(out, user)
	return out
}

func withProject(user map[string]string, project string) map[string]string {
	out := map[string]string{docker.LabelProject: project, docker.LabelManaged: "1"}
	maps.Copy(out, user)
	return out
}

// containerName is the docker name for a service's (single) container.
func containerName(project, service string) string {
	return sanitizeName(project + "-" + service + "-1")
}

// sanitizeName makes a docker-safe container name (letters, digits, -, _, .).
func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}
