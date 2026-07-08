package pluginhost

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/catalog"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/stackspec"
	"github.com/toyz/hope/internal/store"
)

// enableRecord is the shared trust-on-enable path used by both Enable and the
// installer: dial the plugin at key, read hope.schema to pin the change-detection
// hash, and persist an ENABLED record with the deterministic token. catalogID, when
// set, records that hope installed this plugin (so the inspector can offer the env
// editor); an empty catalogID preserves any existing one. Existing settings survive a
// re-enable. Returns the live endpoint + raw schema so the caller can follow up
// (settings validation, hope.init). Errors are rpc-friendly.
func (r *PluginsRouter) enableRecord(ctx context.Context, key, catalogID string) (*endpoint, json.RawMessage, *store.PluginRecord, error) {
	if !r.store.Enabled() {
		return nil, nil, nil, rpc.BadRequest("enabling a plugin needs the state store mounted ([store] path) to persist the approval + token")
	}
	members, host, ok := r.group(ctx, key)
	if !ok {
		return nil, nil, nil, rpc.BadRequest("plugin not found (no matching container on the fleet)")
	}
	rep := representative(members)
	// Deterministic token from hope's secret + the stable identity — stable across
	// disable/enable/forget so the plugin's pin keeps matching (and it equals what the
	// installer injects as HOPE_PLUGIN_TOKEN).
	token := r.store.DeriveToken(key)
	// Require reachability: enabling an unreachable plugin would persist an empty hash,
	// permanently disabling the re-approval gate (and it's unusable anyway).
	ep, derr := r.dial(ctx, host, rep, token, false)
	if derr != nil {
		return nil, nil, nil, rpc.BadRequest("plugin unreachable — start it and try again (needed to pin its schema for change detection)")
	}
	raw, serr := ep.callRPC(ctx, "hope.schema", nil)
	if serr != nil {
		return nil, nil, nil, rpc.BadRequest("plugin did not answer hope.schema — start it and try again")
	}
	rec := store.PluginRecord{
		Key:         key,
		Host:        host,
		Project:     rep.Project,
		Service:     rep.Service,
		ContainerID: rep.ContainerID,
		Name:        rep.Title,
		Enabled:     true,
		Fingerprint: fingerprint(rep),
		SchemaHash:  hashBytes(raw),
		Token:       token,
		EnabledAt:   time.Now(),
		CatalogID:   catalogID,
	}
	// Preserve prior settings + catalog id on a re-enable.
	if existing, _ := r.store.Plugin(key); existing != nil {
		rec.Settings = existing.Settings
		if catalogID == "" {
			rec.CatalogID = existing.CatalogID
		}
	}
	if err := r.store.PutPlugin(rec); err != nil {
		return nil, nil, nil, rpc.Internal("persist approval: %v", err)
	}
	return ep, raw, &rec, nil
}

// InstallParams is one install run: deploy 1..n catalog plugins into a stack on a host,
// wired so hope can reach them, then enable + configure each. Multiple plugins = a new
// plugin stack.
type InstallParams struct {
	Host      string           `json:"host"`      // target fleet host (also X-Hope-Host)
	Project   string           `json:"project"`   // stack/project name (defaults to the sole plugin's name)
	Placement Placement        `json:"placement"` // where it lives on the network
	Plugins   []PluginInstance `json:"plugins"`
}

// PluginInstance is one plugin to install: which catalog entry, its instance name, the
// env-field values, and any initial setting overrides.
type PluginInstance struct {
	CatalogID string            `json:"catalog_id"`
	Name      string            `json:"name"`
	Env       map[string]string `json:"env"`
	Settings  map[string]string `json:"settings"`
}

// Placement decides the plugin's networks. Networks are REAL docker network names the
// frontend resolved (an existing stack's network, or any picked networks). Mode
// new_stack additionally gives the plugins a fresh shared bridge so they can talk to
// each other. ink-plugins is always added so hope can dial them.
type Placement struct {
	Mode     string   `json:"mode"`     // "stack_net" | "networks" | "new_stack"
	Networks []string `json:"networks"` // real docker network names to join (external)
}

// install orchestrates the whole flow, streaming progress via emit. dock is the target
// host's docker client (resolved from X-Hope-Host by the caller); host is its id.
func (r *PluginsRouter) install(ctx context.Context, dock *docker.Client, host string, p InstallParams, emit func(string)) error {
	if r.deploy == nil {
		return fmt.Errorf("install unavailable: the deploy engine is not wired")
	}
	if r.catalog == nil {
		return fmt.Errorf("install unavailable: no catalog configured")
	}
	if !r.store.Enabled() {
		return fmt.Errorf("installing a plugin needs the state store mounted ([store] path) to persist the token + approval")
	}
	if len(p.Plugins) == 0 {
		return fmt.Errorf("no plugins selected")
	}
	project := sanitizeName(p.Project)
	if project == "" {
		project = sanitizeName(p.Plugins[0].Name)
	}
	if project == "" {
		return fmt.Errorf("a stack/instance name is required")
	}

	// ink-plugins must exist (external ref) so hope can dial the new containers.
	if err := dock.EnsurePluginNetwork(ctx); err != nil {
		return fmt.Errorf("ensure plugin network: %w", err)
	}

	// Build one StackSpec with a service per plugin instance.
	spec := &stackspec.StackSpec{Name: project}
	type planned struct {
		inst    PluginInstance
		entry   catalog.CatalogEntry
		service string
		key     string
	}
	var plan []planned
	seenSvc := map[string]bool{}

	// External network refs (ink-plugins + placement nets), declared once.
	externalNets := map[string]bool{docker.PluginNetwork: true}
	for _, n := range p.Placement.Networks {
		if n = strings.TrimSpace(n); n != "" && n != docker.PluginNetwork {
			externalNets[n] = true
		}
	}
	// A new plugin stack gets a fresh shared bridge so its plugins can reach each other.
	sharedBridge := ""
	if p.Placement.Mode == "new_stack" && len(p.Plugins) > 1 {
		sharedBridge = "net" // becomes <project>_net
		spec.Networks = append(spec.Networks, stackspec.NetworkSpec{Name: sharedBridge})
	}

	for _, inst := range p.Plugins {
		entry, ok := r.catalog.Entry(inst.CatalogID)
		if !ok {
			return fmt.Errorf("unknown catalog plugin %q", inst.CatalogID)
		}
		service := sanitizeName(inst.Name)
		if service == "" {
			service = sanitizeName(entry.ID)
		}
		if service == "" || seenSvc[service] {
			return fmt.Errorf("each plugin needs a unique name (got %q)", inst.Name)
		}
		seenSvc[service] = true

		// Validate the env inputs against the entry's schema.
		if err := validateEnv(entry, inst.Env); err != nil {
			return err
		}

		key := host + "|" + project + "/" + service
		token := r.store.DeriveToken(key)

		env := map[string]string{}
		for _, f := range entry.Env {
			if f.Default != "" {
				env[f.Key] = f.Default
			}
		}
		for k, v := range inst.Env {
			if v != "" {
				env[k] = v
			}
		}
		env["HOPE_PLUGIN_TOKEN"] = token

		// Networks: placement + ink-plugins (+ the shared bridge for a multi-plugin stack).
		nets := []string{}
		for n := range externalNets {
			nets = append(nets, n)
		}
		if sharedBridge != "" {
			nets = append(nets, sharedBridge)
		}

		// Volumes: named volumes are auto-created (declared non-external); binds use the host path as-is.
		var mounts []stackspec.MountSpec
		for _, vm := range entry.Volumes {
			typ := vm.Type
			if typ == "" {
				typ = "volume"
			}
			src := vm.Name
			if typ == "volume" {
				if src == "" {
					src = service + "-" + slugPath(vm.Target)
				}
				spec.Volumes = append(spec.Volumes, stackspec.VolumeSpec{Name: src})
			}
			mounts = append(mounts, stackspec.MountSpec{Type: typ, Source: src, Target: vm.Target, ReadOnly: vm.ReadOnly})
		}

		labels := map[string]string{
			docker.LabelPlugin:      "true",
			docker.LabelPluginPort:  strconv.Itoa(entry.PortOrDefault()),
			docker.LabelPluginPath:  entry.PathOrDefault(),
			docker.LabelPluginTitle: entry.Title,
			docker.LabelPluginIcon:  entry.Icon,
		}
		for k, v := range entry.Labels {
			labels[k] = v
		}

		spec.Services = append(spec.Services, stackspec.ContainerSpec{
			Name:     service,
			Image:    entry.Image,
			Restart:  "unless-stopped",
			Env:      env,
			Networks: nets,
			Mounts:   mounts,
			Labels:   labels,
		})
		plan = append(plan, planned{inst: inst, entry: entry, service: service, key: key})
	}
	for n := range externalNets {
		spec.Networks = append(spec.Networks, stackspec.NetworkSpec{Name: n, External: true})
	}

	// Deploy the whole stack (pulls images, creates/refs nets + vols, creates containers).
	emit("deploying " + project + "…")
	if err := r.deploy.ApplyStack(ctx, spec, emit); err != nil {
		return err
	}

	// Per instance: wait until reachable, enable, validate + init settings.
	for _, pl := range plan {
		emit("waiting for " + pl.service + " to start…")
		if err := r.waitReachable(ctx, pl.key, 60*time.Second); err != nil {
			return fmt.Errorf("%s deployed but hope couldn't reach it — a remote daemon with no agent needs a published port: %w", pl.service, err)
		}
		ep, schemaRaw, rec, err := r.enableRecord(ctx, pl.key, pl.entry.ID)
		if err != nil {
			return fmt.Errorf("enable %s: %s", pl.service, err.Error())
		}
		emit("enabled " + pl.service)

		settings := mergeSettings(pl.entry.Settings, pl.inst.Settings)
		settings = validateSettings(schemaRaw, settings, pl.service, emit)
		rec.Settings = settings
		_ = r.store.PutPlugin(*rec)
		r.initPlugin(ctx, ep, rec, emit)
		emit("installed " + pl.service)
	}
	return nil
}

// reconfigure recreates an installed plugin's container with new env, from hope's
// stored spec, then re-verifies + re-enables it. Streaming via emit.
func (r *PluginsRouter) reconfigure(ctx context.Context, key string, env map[string]string, emit func(string)) error {
	if r.deploy == nil {
		return fmt.Errorf("reconfigure unavailable: the deploy engine is not wired")
	}
	rec, err := r.store.Plugin(key)
	if err != nil {
		return err
	}
	if rec == nil {
		return fmt.Errorf("plugin not found")
	}
	if rec.CatalogID == "" {
		return fmt.Errorf("this plugin wasn't installed by hope — edit its env via the deploy editor")
	}
	spec, err := r.deploy.Store().Load(rec.Host, rec.Project)
	if err != nil {
		return err
	}
	if spec == nil {
		return fmt.Errorf("no stored spec for this plugin's stack (was it deployed elsewhere?)")
	}
	svc, ok := spec.ServiceByName(rec.Service)
	if !ok {
		return fmt.Errorf("service %q not found in the stored stack", rec.Service)
	}
	// Apply env edits: blank = keep existing; never drop the trust token.
	if svc.Env == nil {
		svc.Env = map[string]string{}
	}
	for k, v := range env {
		if k == "HOPE_PLUGIN_TOKEN" {
			continue
		}
		if strings.TrimSpace(v) == "" {
			continue // keep existing (blank secret)
		}
		svc.Env[k] = v
	}
	svc.Env["HOPE_PLUGIN_TOKEN"] = r.store.DeriveToken(key)
	// Write the edited service back into the spec.
	for i := range spec.Services {
		if spec.Services[i].Name == rec.Service {
			spec.Services[i] = svc
		}
	}

	emit("reconfiguring " + rec.Service + "…")
	if err := r.deploy.ApplyStack(ctx, spec, emit); err != nil {
		return err
	}
	emit("waiting for " + rec.Service + " to restart…")
	if err := r.waitReachable(ctx, key, 60*time.Second); err != nil {
		return fmt.Errorf("recreated but hope couldn't reach it: %w", err)
	}
	ep, _, rec2, err := r.enableRecord(ctx, key, rec.CatalogID)
	if err != nil {
		return fmt.Errorf("re-enable: %s", err.Error())
	}
	r.initPlugin(ctx, ep, rec2, emit)
	emit("reconfigured " + rec.Service)
	return nil
}

// waitReachable polls (with fresh scans) until the plugin at key is running AND
// answering hope.schema, or the timeout elapses.
func (r *PluginsRouter) waitReachable(ctx context.Context, key string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		r.scan(ctx, true)
		if members, host, ok := r.group(ctx, key); ok {
			rep := representative(members)
			if rep.Running {
				if ep, derr := r.dial(ctx, host, rep, r.store.DeriveToken(key), false); derr == nil {
					if _, serr := ep.callRPC(ctx, "hope.schema", nil); serr == nil {
						return nil
					}
				}
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// initPlugin runs the hope.init handshake (delivering the record's settings + hope's
// protocol/caps). On an older plugin that doesn't implement hope.init it falls back to
// the hope.settings push. Best-effort: a failure is emitted, not fatal (the plugin has
// its declared defaults). Records the container id it initialized.
func (r *PluginsRouter) initPlugin(ctx context.Context, ep *endpoint, rec *store.PluginRecord, emit func(string)) {
	params := map[string]any{
		"settings":        rec.Settings,
		"protocolVersion": ProtocolVersion,
		"capabilities": map[string]any{
			"view_kinds": splitCSV(capViewKinds),
			"features":   splitCSV(capFeatures),
		},
	}
	if _, err := ep.callRPC(ctx, "hope.init", params); err != nil {
		// Older plugin (no hope.init) or a transient error — fall back to hope.settings.
		if _, serr := ep.callRPC(ctx, "hope.settings", map[string]any{"values": rec.Settings}); serr != nil {
			emit("note: couldn't deliver settings to " + rec.Service + " (" + serr.Error() + ")")
			return
		}
	}
	rec.InitContainerID = rec.ContainerID
	_ = r.store.PutPlugin(*rec)
}

// validateEnv checks required + select env fields against the catalog entry's schema.
func validateEnv(entry catalog.CatalogEntry, env map[string]string) error {
	for _, f := range entry.Env {
		v := strings.TrimSpace(env[f.Key])
		if f.Required && v == "" && f.Default == "" {
			return fmt.Errorf("%s: %s is required", entry.Title, f.Label)
		}
		if f.Kind == "select" && v != "" && !optionAllowed(f, v) {
			return fmt.Errorf("%s: %s must be one of the allowed values", entry.Title, f.Label)
		}
	}
	return nil
}

func optionAllowed(f catalog.EnvField, v string) bool {
	for _, o := range f.Options {
		if o.Value == v {
			return true
		}
	}
	return false
}

// mergeSettings folds the catalog's value-only seeds with per-instance overrides.
func mergeSettings(seeds []catalog.SettingSeed, overrides map[string]string) map[string]string {
	out := map[string]string{}
	for _, s := range seeds {
		out[s.Key] = s.Value
	}
	for k, v := range overrides {
		out[k] = v
	}
	return out
}

// validateSettings drops setting keys the plugin's live schema doesn't declare and
// rejects values outside a select setting's options — so a seed can't push a value the
// plugin can't use. Emits a note for anything dropped.
func validateSettings(schemaRaw json.RawMessage, settings map[string]string, service string, emit func(string)) map[string]string {
	if len(settings) == 0 {
		return settings
	}
	var sch struct {
		Settings []struct {
			Key     string `json:"key"`
			Kind    string `json:"kind"`
			Options []struct {
				Value string `json:"value"`
			} `json:"options"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(schemaRaw, &sch); err != nil {
		return settings // can't validate; pass through
	}
	declared := make(map[string]struct {
		kind    string
		options map[string]bool
	}, len(sch.Settings))
	for _, s := range sch.Settings {
		opts := map[string]bool{}
		for _, o := range s.Options {
			opts[o.Value] = true
		}
		declared[s.Key] = struct {
			kind    string
			options map[string]bool
		}{kind: s.Kind, options: opts}
	}
	out := map[string]string{}
	for k, v := range settings {
		d, ok := declared[k]
		if !ok {
			emit("note: " + service + " doesn't declare setting " + k + " — skipped")
			continue
		}
		if d.kind == "select" && len(d.options) > 0 && !d.options[v] {
			emit("note: " + service + " setting " + k + "=" + v + " isn't an allowed option — skipped")
			continue
		}
		out[k] = v
	}
	return out
}

// sanitizeName lowercases and keeps [a-z0-9_-], collapsing the rest to '-', so a
// user-typed name is a valid compose project/service + container name.
func sanitizeName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// splitCSV splits a comma list into trimmed, non-empty tokens.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// slugPath turns a mount target ("/data/cache") into a volume-name-safe slug ("data-cache").
func slugPath(p string) string {
	s := sanitizeName(strings.ReplaceAll(strings.Trim(p, "/"), "/", "-"))
	if s == "" {
		return "data"
	}
	return s
}
