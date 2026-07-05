package pluginhost

import (
	"sync"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/store"
)

// Plugins is the boot-registered router for the container-plugin system. Phase 2
// covers discovery + trust (list / enable / disable / forget); dialing, manifest
// rendering, and streaming arrive in later phases.
type PluginsRouter struct {
	hosts   *hosts.Set
	store   *store.Store
	enabled bool // [plugins] enabled capability gate

	mu       sync.Mutex
	cache    []Discovered
	cachedAt time.Time
}

// NewPluginsRouter wires the router to the host set + state store. enabled is the
// [plugins] config gate; when false every method reports the feature is off. sov
// derives the wire name "Plugins" by stripping the required "Router" suffix.
func NewPluginsRouter(hs *hosts.Set, st *store.Store, enabled bool) *PluginsRouter {
	return &PluginsRouter{hosts: hs, store: st, enabled: enabled}
}

// gate blocks every method when the feature is disabled in config.
func (r *PluginsRouter) gate() error {
	if !r.enabled {
		return rpc.BadRequest("plugins are disabled (set [plugins] enabled = true in config)")
	}
	return nil
}

// PluginView is one plugin INSTANCE (a stable identity, deduplicated across
// replicas) as the management page sees it: where it lives, its pre-manifest
// label hints, and its trust state.
type PluginView struct {
	Key         string `json:"key"` // the stable identity (host + project/service)
	Host        string `json:"host"`
	ContainerID string `json:"container_id"` // representative container hope would dial
	Name        string `json:"name"`         // stored name if trusted, else the title hint
	Title       string `json:"title"`        // pre-manifest label hint
	Icon        string `json:"icon"`         // pre-manifest label hint
	Image       string `json:"image"`
	Project     string `json:"project"`
	Service     string `json:"service"`
	Port        int    `json:"port"`
	Path        string `json:"path"`
	Replicas    int    `json:"replicas"` // containers sharing this identity (>1 = replicated)
	Running     bool   `json:"running"`  // representative running
	Present     bool   `json:"present"`  // still discovered on the fleet
	Trusted     bool   `json:"trusted"`  // has a stored approval record
	Enabled     bool   `json:"enabled"`  // trusted AND currently on
	Stale       bool   `json:"stale"`    // enabled but the image changed since approval
}

// ListParams optionally forces a fresh fleet scan (bypassing the cache) and/or
// scopes the result to a single host (for the per-host resource view).
type ListParams struct {
	Refresh bool   `json:"refresh"`
	Host    string `json:"host"` // "" or "all" => whole fleet
}

// List returns every discovered plugin INSTANCE (grouped by stable identity, so
// replicas collapse and different stacks stay distinct) merged with its stored
// trust state, plus any trusted-but-now-missing plugins so they can be cleaned up.
func (r *PluginsRouter) List(ctx *rpc.Context, p *ListParams) ([]PluginView, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	refresh := p != nil && p.Refresh
	hostFilter := ""
	if p != nil && p.Host != "" && p.Host != "all" {
		hostFilter = p.Host
	}
	discovered := r.scan(ctx, refresh)

	recs, _ := r.store.Plugins()
	byKey := make(map[string]store.PluginRecord, len(recs))
	for _, rec := range recs {
		byKey[rec.Key] = rec
	}

	// Group discovered containers by stable identity (dedup replicas). Preserve
	// first-seen order for a stable list.
	type grp struct {
		host    string
		members []docker.PluginContainer
	}
	groups := map[string]*grp{}
	order := []string{}
	for _, d := range discovered {
		if hostFilter != "" && d.Host != hostFilter {
			continue
		}
		key := pluginIdentity(d.Host, d.PC)
		g := groups[key]
		if g == nil {
			g = &grp{host: d.Host}
			groups[key] = g
			order = append(order, key)
		}
		g.members = append(g.members, d.PC)
	}

	out := make([]PluginView, 0, len(order))
	for _, key := range order {
		g := groups[key]
		rep := representative(g.members)
		rec, trusted := byKey[key]
		name := rep.Title
		if trusted && rec.Name != "" {
			name = rec.Name
		}
		stale := trusted && rec.Enabled && rec.Fingerprint != "" && rec.Fingerprint != fingerprint(rep)
		out = append(out, PluginView{
			Key:         key,
			Host:        g.host,
			ContainerID: rep.ContainerID,
			Name:        name,
			Title:       rep.Title,
			Icon:        rep.Icon,
			Image:       rep.Image,
			Project:     rep.Project,
			Service:     rep.Service,
			Port:        rep.Port,
			Path:        rep.Path,
			Replicas:    len(g.members),
			Running:     rep.Running,
			Present:     true,
			Trusted:     trusted,
			Enabled:     trusted && rec.Enabled,
			Stale:       stale,
		})
	}
	// Trusted plugins whose identity is no longer discovered (stack removed, etc).
	for _, rec := range recs {
		if _, live := groups[rec.Key]; live {
			continue
		}
		if hostFilter != "" && rec.Host != hostFilter {
			continue
		}
		out = append(out, PluginView{
			Key:         rec.Key,
			Host:        rec.Host,
			ContainerID: rec.ContainerID,
			Name:        rec.Name,
			Project:     rec.Project,
			Service:     rec.Service,
			Present:     false,
			Trusted:     true,
			Enabled:     false,
		})
	}
	return out, nil
}

// TargetParams identifies a plugin instance by its stable key.
type TargetParams struct {
	Key string `json:"key"`
}

func (p *TargetParams) valid() bool { return p != nil && p.Key != "" }

// Enable trusts a discovered plugin: it mints a per-plugin bearer token, captures
// the fingerprint of the representative container, and persists the approval keyed
// by the stable identity. Requires the store mounted.
func (r *PluginsRouter) Enable(ctx *rpc.Context, p *TargetParams) (any, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key is required")
	}
	if !r.store.Enabled() {
		return nil, rpc.BadRequest("enabling a plugin needs the state store mounted ([store] path) to persist the approval + token")
	}
	members, host, ok := r.group(ctx, p.Key)
	if !ok {
		return nil, rpc.BadRequest("plugin not found (no matching container on the fleet)")
	}
	rep := representative(members)
	token, err := mintToken()
	if err != nil {
		return nil, rpc.Internal("mint token: %v", err)
	}
	rec := store.PluginRecord{
		Key:         p.Key,
		Host:        host,
		Project:     rep.Project,
		Service:     rep.Service,
		ContainerID: rep.ContainerID,
		Name:        rep.Title,
		Enabled:     true,
		Fingerprint: fingerprint(rep),
		Token:       token,
		EnabledAt:   time.Now(),
	}
	if err := r.store.PutPlugin(rec); err != nil {
		return nil, rpc.Internal("persist approval: %v", err)
	}
	return map[string]any{"ok": true}, nil
}

// Disable turns a trusted plugin off but keeps its record (and token).
func (r *PluginsRouter) Disable(ctx *rpc.Context, p *TargetParams) (any, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key is required")
	}
	rec, err := r.store.Plugin(p.Key)
	if err != nil {
		return nil, rpc.Internal("read approval: %v", err)
	}
	if rec == nil {
		return map[string]any{"ok": true}, nil // nothing to disable
	}
	rec.Enabled = false
	if err := r.store.PutPlugin(*rec); err != nil {
		return nil, rpc.Internal("persist: %v", err)
	}
	return map[string]any{"ok": true}, nil
}

// Forget deletes a plugin's approval record entirely (e.g. its stack is gone).
func (r *PluginsRouter) Forget(ctx *rpc.Context, p *TargetParams) (any, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key is required")
	}
	if err := r.store.DeletePlugin(p.Key); err != nil {
		return nil, rpc.Internal("forget: %v", err)
	}
	return map[string]any{"ok": true}, nil
}
