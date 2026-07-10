package pluginhost

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/catalog"
	"github.com/toyz/hope/internal/deploy"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/store"
)

// Plugins is the boot-registered router for the container-plugin system. Phase 2
// covers discovery + trust (list / enable / disable / forget); dialing, manifest
// rendering, and streaming arrive in later phases.
type PluginsRouter struct {
	hosts         *hosts.Set
	store         *store.Store
	dialer        ContainerDialer  // agent hub for remote container dialing; nil if no hub
	deploy        *deploy.Engine   // write path for installing plugin containers; nil = install unavailable
	catalog       *catalog.Service // installable-plugin catalog (built-ins + remote); nil = empty
	enabled       bool             // [plugins] enabled capability gate
	autoReapprove bool             // trust schema/image changes (dev): re-record fingerprint instead of disabling
	limits        Limits           // operator-tuned per-plugin safety caps
	bus           *events.Bus      // nil-safe: publishes plugin.changed to the global feed
	callbackURL   string           // hope's base URL reachable by a plugin (reverse channel); empty = off

	mu       sync.Mutex
	cache    []Discovered
	cachedAt time.Time
	scanMu   sync.Mutex // serializes fleet scans so concurrent callers don't stampede

	// missCount tracks consecutive reconcile passes an enabled record's identity was
	// absent on a REACHABLE host, before it's GC'd. Touched only by the single
	// reconcile goroutine, so it needs no lock.
	missCount map[string]int

	limMu    sync.Mutex
	limiters map[string]*pluginLimiter

	metrics metricsRegistry
}

// limiter returns the per-plugin resource limiter, creating it on first use.
func (r *PluginsRouter) limiter(key string) *pluginLimiter {
	r.limMu.Lock()
	defer r.limMu.Unlock()
	if r.limiters == nil {
		r.limiters = map[string]*pluginLimiter{}
	}
	l := r.limiters[key]
	if l == nil {
		l = newPluginLimiter(r.limits)
		r.limiters[key] = l
	}
	return l
}

// NewPluginsRouter wires the router to the host set + state store + the agent hub
// (for remote dialing; pass nil when no hub). enabled is the [plugins] config gate;
// when false every method reports the feature is off. sov derives the wire name
// "Plugins" by stripping the required "Router" suffix.
func NewPluginsRouter(hs *hosts.Set, st *store.Store, dialer ContainerDialer, eng *deploy.Engine, cat *catalog.Service, enabled, autoReapprove bool, limits Limits, bus *events.Bus) *PluginsRouter {
	return &PluginsRouter{hosts: hs, store: st, dialer: dialer, deploy: eng, catalog: cat, enabled: enabled, autoReapprove: autoReapprove, limits: limits.WithDefaults(), bus: bus}
}

// SetCallbackURL sets hope's plugin-reachable base URL, handed to plugins in hope.init
// so they can call back (publish / storage). Empty leaves the reverse channel off. A
// package function, not a method — see the note on StartEventFanout (an exported
// non-RPC method would panic under gw.Register's reflection).
func SetCallbackURL(r *PluginsRouter, u string) { r.callbackURL = u }

// Catalog returns the installable first-party plugins (built-ins merged with any
// remote manifest entries). Empty when no catalog is wired.
func (r *PluginsRouter) Catalog(ctx *rpc.Context) ([]catalog.CatalogEntry, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if r.catalog == nil {
		return []catalog.CatalogEntry{}, nil
	}
	return r.catalog.Entries(), nil
}

// RefreshCatalog forces a remote-manifest re-fetch and returns the merged result.
func (r *PluginsRouter) RefreshCatalog(ctx *rpc.Context) ([]catalog.CatalogEntry, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if r.catalog == nil {
		return []catalog.CatalogEntry{}, nil
	}
	if err := r.catalog.Refresh(ctx); err != nil {
		return nil, rpc.Internal("refresh catalog: %v", err)
	}
	return r.catalog.Entries(), nil
}

// PluginConfig is the env (Configuration) editor's data for a hope-installed plugin:
// the catalog entry's env schema plus the current values from the stored deploy spec
// (secret values are blanked — never returned — so "blank keeps existing" holds).
type PluginConfig struct {
	Fields []catalog.EnvField `json:"fields"`
	Values map[string]string  `json:"values"`
}

// Config returns the env-editor schema + current values for an installed plugin, or an
// empty set for a hand-labeled plugin (no CatalogID / no stored spec) so the inspector
// simply hides the Configuration section.
func (r *PluginsRouter) Config(ctx *rpc.Context, p *TargetParams) (*PluginConfig, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key is required")
	}
	empty := &PluginConfig{Fields: []catalog.EnvField{}, Values: map[string]string{}}
	rec, err := r.store.Plugin(p.Key)
	if err != nil {
		return nil, rpc.Internal("read plugin: %v", err)
	}
	if rec == nil || rec.CatalogID == "" || r.catalog == nil {
		return empty, nil
	}
	entry, ok := r.catalog.Entry(rec.CatalogID)
	if !ok {
		return empty, nil
	}
	// Return the field SCHEMA but NOT the stored values. The stored env holds secrets
	// (DSNs, the bearer token), and the field's secret/non-secret Kind comes from the
	// catalog — a hostile manifest could relabel a secret field as plain to exfiltrate
	// its stored value. The editor pre-fills from field defaults; a blank submission
	// keeps the existing value on reconfigure, so returning nothing is non-destructive.
	return &PluginConfig{Fields: entry.Env, Values: map[string]string{}}, nil
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

	// Permission state (the reverse-capability grants). The inspector renders these
	// so the operator can see what a plugin CAN do and revoke a scope anytime.
	Grants  []string `json:"grants,omitempty"`
	Pending []string `json:"pending,omitempty"`
	Denied  []string `json:"denied,omitempty"`
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
			Grants:      rec.Grants,
			Pending:     rec.Pending,
			Denied:      rec.Denied,
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
			Grants:      rec.Grants,
			Pending:     rec.Pending,
			Denied:      rec.Denied,
		})
	}
	return out, nil
}

// TargetParams identifies a plugin instance by its stable key.
type TargetParams struct {
	Key string `json:"key"`
}

func (p *TargetParams) valid() bool { return p != nil && p.Key != "" }

// pluginChangeData is the optional payload on a plugin.changed event: which plugin
// and what happened. The frontend's PluginsChanged carries no payload (it just
// refetches), so this is only for future/plugin consumers.
func pluginChangeData(key, action string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"key": key, "action": action})
	return b
}

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
	ep, _, rec, err := r.enableRecord(ctx, p.Key, "")
	if err != nil {
		return nil, err
	}
	// Re-run the hope.init handshake on enable — a deliberate operator action — so the
	// plugin (re)receives its settings AND the reverse-channel callback URL even when
	// its container hasn't restarted (the container-id guard alone would skip it, so an
	// enable/disable wouldn't deliver a newly-available callback URL). Best-effort.
	if ep != nil && rec != nil {
		r.initPlugin(ctx, ep, rec, func(string) {})
	}
	r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Data: pluginChangeData(p.Key, "enabled")})
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
	r.detachPluginNet(ctx, p.Key) // stop sharing hope's network
	r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Host: rec.Host, Data: pluginChangeData(p.Key, "disabled")})
	return map[string]any{"ok": true}, nil
}

// detachPluginNet best-effort disconnects a plugin's container(s) from the shared
// ink-plugins network on their daemon — called on disable/forget so a plugin no
// longer shares hope's network once it's no longer trusted.
func (r *PluginsRouter) detachPluginNet(ctx context.Context, key string) {
	members, host, ok := r.group(ctx, key)
	if !ok {
		return
	}
	hc, ok := r.hostClient(host)
	if !ok || hc.Client == nil {
		return
	}
	for _, m := range members {
		_ = hc.Client.DetachNetwork(ctx, m.ContainerID, docker.PluginNetwork)
	}
}

// Forget deletes a plugin's approval record entirely (e.g. its stack is gone).
func (r *PluginsRouter) Forget(ctx *rpc.Context, p *TargetParams) (any, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key is required")
	}
	r.detachPluginNet(ctx, p.Key)
	if err := r.store.DeletePlugin(p.Key); err != nil {
		return nil, rpc.Internal("forget: %v", err)
	}
	_ = r.store.DeletePluginKVAll(p.Key) // wipe the plugin's storage on full removal
	r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Data: pluginChangeData(p.Key, "forgot")})
	return map[string]any{"ok": true}, nil
}

// GrantParams targets a permission scope on a plugin for a consent decision.
type GrantParams struct {
	Key     string `sov:"key,0,required" json:"key"`
	Scope   string `sov:"scope,1,required" json:"scope"`
	DontAsk bool   `sov:"dont_ask,2" json:"dont_ask"` // Deny only: never re-prompt this scope
}

func (p *GrantParams) valid() bool { return p != nil && p.Key != "" && p.Scope != "" }

// Grant records the operator's consent to a plugin's requested scope: it moves the
// scope from pending to granted (clearing any prior denial), so hope's reverse
// capabilities gated on that scope begin working for the plugin.
func (r *PluginsRouter) Grant(ctx *rpc.Context, p *GrantParams) (any, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key and scope are required")
	}
	rec, err := r.store.Plugin(p.Key)
	if err != nil {
		return nil, rpc.Internal("read approval: %v", err)
	}
	if rec == nil {
		return nil, rpc.BadRequest("plugin not found")
	}
	rec.Pending = removeStr(rec.Pending, p.Scope)
	rec.Denied = removeStr(rec.Denied, p.Scope)
	if !slices.Contains(rec.Grants, p.Scope) {
		rec.Grants = append(rec.Grants, p.Scope)
	}
	if err := r.store.PutPlugin(*rec); err != nil {
		return nil, rpc.Internal("persist: %v", err)
	}
	r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Host: rec.Host, Data: pluginChangeData(p.Key, "granted")})
	return map[string]any{"ok": true}, nil
}

// Deny rejects (or revokes) a plugin's scope: it clears the grant and any pending
// prompt. With DontAsk set, the scope is remembered as denied so re-enabling or a
// runtime request never re-prompts. Doubles as the inspector's "revoke".
func (r *PluginsRouter) Deny(ctx *rpc.Context, p *GrantParams) (any, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, rpc.BadRequest("key and scope are required")
	}
	rec, err := r.store.Plugin(p.Key)
	if err != nil {
		return nil, rpc.Internal("read approval: %v", err)
	}
	if rec == nil {
		return map[string]any{"ok": true}, nil // nothing to deny
	}
	rec.Pending = removeStr(rec.Pending, p.Scope)
	rec.Grants = removeStr(rec.Grants, p.Scope) // revoke if it was granted
	if p.DontAsk && !slices.Contains(rec.Denied, p.Scope) {
		rec.Denied = append(rec.Denied, p.Scope)
	}
	if err := r.store.PutPlugin(*rec); err != nil {
		return nil, rpc.Internal("persist: %v", err)
	}
	r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Host: rec.Host, Data: pluginChangeData(p.Key, "denied")})
	return map[string]any{"ok": true}, nil
}

// ConsentPrompt is one pending permission request the UI renders (a plugin wants a
// scope the operator hasn't decided). Reason isn't persisted — the modal shows the
// scope's own label; the live permission.requested event carries the rich reason.
type ConsentPrompt struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Host  string `json:"host"`
	Scope string `json:"scope"`
}

// PendingConsents lists every enabled plugin's undecided permission requests, so the
// UI can render the consent queue on load (the live feed drives new ones after).
func (r *PluginsRouter) PendingConsents(ctx *rpc.Context) ([]ConsentPrompt, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	recs, err := r.store.Plugins()
	if err != nil {
		return nil, rpc.Internal("read approvals: %v", err)
	}
	out := []ConsentPrompt{}
	for _, rec := range recs {
		if !rec.Enabled {
			continue
		}
		for _, sc := range rec.Pending {
			out = append(out, ConsentPrompt{Key: rec.Key, Name: rec.Name, Host: rec.Host, Scope: sc})
		}
	}
	return out, nil
}

// removeStr returns ss without the first occurrence of s (order-preserving).
func removeStr(ss []string, s string) []string {
	for i, x := range ss {
		if x == s {
			return append(ss[:i:i], ss[i+1:]...)
		}
	}
	return ss
}

// PluginManifest is what the UI needs to render an enabled plugin: its capability
// schema (incl. settings), its UI layout (contributions), and the operator's
// current setting values. Schema/Layout are passed through as raw JSON so hope
// never has to model the plugin's own shapes.
type PluginManifest struct {
	Schema   json.RawMessage   `json:"schema"`
	Layout   json.RawMessage   `json:"layout"`
	Settings map[string]string `json:"settings"`
	// Protocol/Compat report the plugin's declared protocol version against hope's.
	// "ok" = same; "plugin_newer"/"plugin_older" = degrade gracefully (hope skips
	// surfaces/kinds it doesn't implement; older plugins keep working).
	Protocol int    `json:"protocol"`
	Compat   string `json:"compat"`
}

// compatOf compares a plugin's declared protocol version to hope's.
func compatOf(pluginProto int) string {
	switch {
	case pluginProto == 0 || pluginProto == ProtocolVersion:
		return "ok"
	case pluginProto > ProtocolVersion:
		return "plugin_newer"
	default:
		return "plugin_older"
	}
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
	// Re-approval gate: if the plugin's live schema no longer matches what was
	// approved (new capabilities the operator never saw), auto-disable and require
	// re-approval — the trust boundary must cover runtime capability changes, not
	// just image swaps. In auto-reapprove mode (dev) hope instead re-records the new
	// fingerprint and keeps it enabled, so iterating on your own plugin doesn't force
	// a manual disable/enable on every redeploy.
	if rec.SchemaHash != "" && hashBytes(schema) != rec.SchemaHash {
		if !r.autoReapprove {
			_ = r.store.DisablePlugin(p.Key) // atomic re-read+write; don't clobber a concurrent update
			return nil, rpc.BadRequest("plugin schema changed since approval — re-enable to approve the new capabilities")
		}
		rec.SchemaHash = hashBytes(schema)
		_ = r.store.PutPlugin(*rec) // silently re-approve the new capabilities (image staleness stays a UI flag)
	}
	layout, err := ep.callRPC(ctx, "hope.layout", nil)
	if err != nil {
		return nil, rpc.Internal("plugin layout: %v", err)
	}
	var pv struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	_ = json.Unmarshal(schema, &pv)
	return &PluginManifest{
		Schema: schema, Layout: layout, Settings: rec.Settings,
		Protocol: pv.ProtocolVersion, Compat: compatOf(pv.ProtocolVersion),
	}, nil
}

// CallParams proxies one call to an enabled plugin's own method.
type CallParams struct {
	Key    string          `json:"key"`
	Method string          `json:"method"`
	Args   json.RawMessage `json:"args"`
	// Audit marks this call an action (mutation) so hope records it in the audit
	// log; reads (view fetches) leave it false to keep the log signal-rich. Danger
	// flags a destructive action for the same entry.
	Audit  bool `json:"audit"`
	Danger bool `json:"danger"`
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
	lim := r.limiter(p.Key)
	if !lim.allowRate() {
		return nil, rpc.BadRequest("rate limit exceeded for this plugin")
	}
	release, ok := lim.acquireCall()
	if !ok {
		return nil, rpc.BadRequest("too many concurrent calls to this plugin")
	}
	defer release()
	ep, rec, err := r.enabledEndpoint(ctx, p.Key)
	if err != nil {
		return nil, err
	}
	var args any
	if len(p.Args) > 0 {
		args = p.Args
	}
	start := time.Now()
	res, err := ep.callRPC(ctx, p.Method, args)
	dur := time.Since(start)
	r.metrics.get(p.Key).record(err == nil, dur)
	if p.Audit {
		r.audit(ctx, rec, p, err, dur)
	}
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return res, nil
}

// audit records an action invocation (best-effort; a failed write must not fail the
// call). Reads pass Audit=false and never reach here.
func (r *PluginsRouter) audit(ctx *rpc.Context, rec *store.PluginRecord, p *CallParams, callErr error, d time.Duration) {
	actor := ""
	if c := ctx.Claims(); c != nil {
		actor = c.Subject
	}
	e := store.AuditEntry{
		Actor: actor, Plugin: p.Key, Method: p.Method, Danger: p.Danger,
		OK: callErr == nil, Millis: d.Milliseconds(),
	}
	if rec != nil {
		e.Host = rec.Host
	}
	if callErr != nil {
		e.Err = callErr.Error()
	}
	_ = r.store.AppendAudit(e)
}

// AuditParams scopes the audit log to one plugin (optional) and caps the count.
type AuditParams struct {
	Key   string `json:"key"`
	Limit int    `json:"limit"`
}

// Audit returns recent audited plugin invocations, newest first — the operator's
// who/what/where/when trail of proxied plugin actions.
func (r *PluginsRouter) Audit(ctx *rpc.Context, p *AuditParams) ([]store.AuditEntry, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	key, limit := "", 0
	if p != nil {
		key, limit = p.Key, p.Limit
	}
	return r.store.AuditLog(key, limit)
}

// Metrics returns per-plugin in-memory observability (call/error counts + latency)
// since hope started — so the operator can spot hot, slow, or failing plugins.
func (r *PluginsRouter) Metrics(ctx *rpc.Context) ([]PluginMetrics, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	return r.metrics.snapshot(), nil
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
