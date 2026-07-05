package pluginhost

import (
	"context"
	"encoding/json"
	"strings"
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
	dialer  ContainerDialer // agent hub for remote container dialing; nil if no hub
	enabled bool            // [plugins] enabled capability gate

	mu       sync.Mutex
	cache    []Discovered
	cachedAt time.Time
}

// NewPluginsRouter wires the router to the host set + state store + the agent hub
// (for remote dialing; pass nil when no hub). enabled is the [plugins] config gate;
// when false every method reports the feature is off. sov derives the wire name
// "Plugins" by stripping the required "Router" suffix.
func NewPluginsRouter(hs *hosts.Set, st *store.Store, dialer ContainerDialer, enabled bool) *PluginsRouter {
	return &PluginsRouter{hosts: hs, store: st, dialer: dialer, enabled: enabled}
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

// PluginManifest is what the UI needs to render an enabled plugin: its capability
// schema (incl. settings), its UI layout (contributions), and the operator's
// current setting values. Schema/Layout are passed through as raw JSON so hope
// never has to model the plugin's own shapes.
type PluginManifest struct {
	Schema   json.RawMessage   `json:"schema"`
	Layout   json.RawMessage   `json:"layout"`
	Settings map[string]string `json:"settings"`
}

// enabledEndpoint resolves + dials an enabled plugin, returning its endpoint and
// the representative container. Errors clearly if disabled or unreachable.
func (r *PluginsRouter) enabledEndpoint(ctx *rpc.Context, key string) (*endpoint, *store.PluginRecord, error) {
	rec, err := r.store.Plugin(key)
	if err != nil {
		return nil, nil, rpc.Internal("read approval: %v", err)
	}
	if rec == nil || !rec.Enabled {
		return nil, nil, rpc.BadRequest("plugin is not enabled")
	}
	ep, err := r.tryDial(ctx, key, rec.Token, false)
	if err != nil {
		return nil, nil, err
	}
	return ep, rec, nil
}

// tryDial resolves a plugin's container and dials it, retrying once with a fresh
// fleet scan if the first attempt fails — so a redeploy (new container id, stale
// discovery cache) self-heals instead of erroring until the cache expires.
func (r *PluginsRouter) tryDial(ctx context.Context, key, token string, streaming bool) (*endpoint, error) {
	if members, host, ok := r.group(ctx, key); ok {
		if ep, err := r.dial(ctx, host, representative(members), token, streaming); err == nil {
			return ep, nil
		}
	}
	r.scan(ctx, true) // bust the cache and rescan (container may have been redeployed)
	members, host, ok := r.group(ctx, key)
	if !ok {
		return nil, rpc.BadRequest("plugin container not found (not running?)")
	}
	ep, err := r.dial(ctx, host, representative(members), token, streaming)
	if err != nil {
		return nil, rpc.Internal("dial plugin: %v", err)
	}
	return ep, nil
}

// Manifest dials an enabled plugin for its schema + layout and returns them with
// the stored setting values. Used by the container inspector (layout) and the
// plugin inspector (schema.settings + values).
func (r *PluginsRouter) Manifest(ctx *rpc.Context, p *TargetParams) (*PluginManifest, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key is required")
	}
	ep, rec, err := r.enabledEndpoint(ctx, p.Key)
	if err != nil {
		return nil, err
	}
	schema, err := ep.callRPC(ctx, "hope.schema", nil)
	if err != nil {
		return nil, rpc.Internal("plugin schema: %v", err)
	}
	layout, err := ep.callRPC(ctx, "hope.layout", nil)
	if err != nil {
		return nil, rpc.Internal("plugin layout: %v", err)
	}
	return &PluginManifest{Schema: schema, Layout: layout, Settings: rec.Settings}, nil
}

// CallParams proxies one call to an enabled plugin's own method.
type CallParams struct {
	Key    string          `json:"key"`
	Method string          `json:"method"`
	Args   json.RawMessage `json:"args"`
}

// Call proxies a unary call to an enabled plugin's view/action method and returns
// its raw result. Reserved hope.* methods can't be proxied (the protocol owns them).
func (r *PluginsRouter) Call(ctx *rpc.Context, p *CallParams) (json.RawMessage, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if p == nil || p.Key == "" || p.Method == "" {
		return nil, rpc.BadRequest("key and method are required")
	}
	if strings.HasPrefix(p.Method, "hope.") {
		return nil, rpc.BadRequest("hope.* methods are reserved and cannot be proxied")
	}
	ep, _, err := r.enabledEndpoint(ctx, p.Key)
	if err != nil {
		return nil, err
	}
	var args any
	if len(p.Args) > 0 {
		args = p.Args
	}
	res, err := ep.callRPC(ctx, p.Method, args)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return res, nil
}

// SetSettingsParams sets operator-managed setting values for a plugin.
type SetSettingsParams struct {
	Key    string            `json:"key"`
	Values map[string]string `json:"values"`
}

// SetSettings persists the operator's setting values (encrypted with the record)
// and pushes them to the plugin via hope.settings. Persist always; the push is
// best-effort (a stopped plugin gets them on the next SetSettings once running).
func (r *PluginsRouter) SetSettings(ctx *rpc.Context, p *SetSettingsParams) (any, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if p == nil || p.Key == "" {
		return nil, rpc.BadRequest("key is required")
	}
	if !r.store.Enabled() {
		return nil, rpc.BadRequest("saving settings needs the state store mounted ([store] path)")
	}
	rec, err := r.store.Plugin(p.Key)
	if err != nil {
		return nil, rpc.Internal("read approval: %v", err)
	}
	if rec == nil || !rec.Enabled {
		return nil, rpc.BadRequest("plugin is not enabled")
	}
	rec.Settings = p.Values
	if err := r.store.PutPlugin(*rec); err != nil {
		return nil, rpc.Internal("persist settings: %v", err)
	}
	// Best-effort push to the running plugin.
	pushed := false
	if members, host, ok := r.group(ctx, p.Key); ok {
		if ep, derr := r.dial(ctx, host, representative(members), rec.Token, false); derr == nil {
			if _, cerr := ep.callRPC(ctx, "hope.settings", map[string]any{"values": p.Values}); cerr == nil {
				pushed = true
			}
		}
	}
	return map[string]any{"ok": true, "pushed": pushed}, nil
}
