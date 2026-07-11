package pluginhost

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/store"
)

// -----------------------------------------------------------------------------
// gate: every method is off when [plugins] enabled=false
// -----------------------------------------------------------------------------

func TestGateBlocksWhenDisabled(t *testing.T) {
	f := newFixtureWith(t, false, false)
	if _, err := f.r.List(f.ctx, &ListParams{}); err == nil {
		t.Fatal("List should be gated when disabled")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
	if _, err := f.r.Enable(f.ctx, &TargetParams{Key: f.key}); err == nil {
		t.Fatal("Enable should be gated when disabled")
	}
	if _, err := f.r.Catalog(f.ctx); err == nil {
		t.Fatal("Catalog should be gated when disabled")
	}
}

// -----------------------------------------------------------------------------
// List: reconcile discovered-from-docker vs stored records
// -----------------------------------------------------------------------------

func TestListDiscoveredUntrusted(t *testing.T) {
	f := newFixture(t)
	out, err := f.r.List(f.ctx, &ListParams{Refresh: true})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("want 1 view, got %d: %+v", len(out), out)
	}
	v := out[0]
	if v.Key != f.key || !v.Present || v.Trusted || v.Enabled {
		t.Fatalf("discovered-but-untrusted view wrong: %+v", v)
	}
	if v.Title != "My Plugin" || v.Image != f.pc.Image || v.Replicas != 1 || !v.Running {
		t.Fatalf("view fields wrong: %+v", v)
	}
}

func TestListMergesTrustedAndMissing(t *testing.T) {
	f := newFixture(t)
	// Trusted+enabled record for the discovered plugin.
	if err := f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Name: "Renamed", Enabled: true, Fingerprint: "sha256:aaa"}); err != nil {
		t.Fatal(err)
	}
	// A trusted record whose identity is no longer discovered.
	if err := f.st.PutPlugin(store.PluginRecord{Key: "local|gone/x", Host: "local", Project: "gone", Service: "x", Name: "Ghost", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	out, err := f.r.List(f.ctx, &ListParams{Refresh: true})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	byKey := map[string]PluginView{}
	for _, v := range out {
		byKey[v.Key] = v
	}
	live := byKey[f.key]
	if !live.Present || !live.Trusted || !live.Enabled {
		t.Fatalf("live trusted view wrong: %+v", live)
	}
	if live.Name != "Renamed" {
		t.Fatalf("stored Name should win: %q", live.Name)
	}
	ghost := byKey["local|gone/x"]
	if ghost.Present || !ghost.Trusted || ghost.Enabled {
		t.Fatalf("missing trusted record should be Present=false, Trusted=true, Enabled=false: %+v", ghost)
	}
}

func TestListStaleFingerprint(t *testing.T) {
	f := newFixture(t)
	// Enabled with a fingerprint that no longer matches the live image digest.
	if err := f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Enabled: true, Fingerprint: "sha256:OLD"}); err != nil {
		t.Fatal(err)
	}
	out, _ := f.r.List(f.ctx, &ListParams{Refresh: true})
	if len(out) == 0 || !out[0].Stale {
		t.Fatalf("expected Stale=true when the image digest changed since approval: %+v", out)
	}
}

func TestListHostFilter(t *testing.T) {
	f := newFixture(t)
	// A record on a different host must be filtered out when scoping to "local".
	if err := f.st.PutPlugin(store.PluginRecord{Key: "other|p/s", Host: "other", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	out, _ := f.r.List(f.ctx, &ListParams{Refresh: true, Host: "local"})
	for _, v := range out {
		if v.Host != "local" {
			t.Fatalf("host filter leaked a %q view", v.Host)
		}
	}
}

// -----------------------------------------------------------------------------
// Enable / Disable / Forget
// -----------------------------------------------------------------------------

func TestEnablePersistsRecord(t *testing.T) {
	f := newFixture(t)
	sub, cancel := f.bus.Subscribe(0)
	defer cancel()

	if _, err := f.r.Enable(f.ctx, &TargetParams{Key: f.key}); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	rec, err := f.st.Plugin(f.key)
	if err != nil || rec == nil {
		t.Fatalf("record not persisted: %v", err)
	}
	if !rec.Enabled {
		t.Fatal("record should be Enabled")
	}
	if rec.Token != f.st.DeriveToken(f.key) {
		t.Fatalf("token = %q, want the derived token", rec.Token)
	}
	if rec.SchemaHash != hashBytes([]byte(defaultSchema)) {
		t.Fatalf("SchemaHash = %q, want hash of the pinned schema", rec.SchemaHash)
	}
	if rec.Fingerprint != "sha256:aaa" {
		t.Fatalf("Fingerprint = %q, want the image digest", rec.Fingerprint)
	}
	// The schema declares a "storage" permission the operator hasn't decided => pending.
	if len(rec.Pending) != 1 || rec.Pending[0] != "storage" {
		t.Fatalf("Pending = %v, want [storage]", rec.Pending)
	}
	// A plugin.changed event fires; a permission.requested is raised for the scope.
	if !drainForKind(sub, events.KindPluginChanged, events.KindPermissionReq) {
		t.Fatal("expected plugin.changed / permission.requested events after Enable")
	}
	// hope.init re-runs on Enable so a running plugin re-receives settings/callback.
	if !f.plugin.sawMethod("hope.init") {
		t.Fatal("Enable should re-run the hope.init handshake")
	}
}

func TestEnableValidation(t *testing.T) {
	f := newFixture(t)
	if _, err := f.r.Enable(f.ctx, &TargetParams{Key: ""}); err == nil {
		t.Fatal("empty key should be rejected")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
}

func TestEnableRequiresStore(t *testing.T) {
	// Store disabled (path "") => Enable can't persist the token.
	st, _ := store.Open("")
	dock := &mockDock{localSocket: true}
	dock.pluginContainers = func(ctx context.Context) ([]docker.PluginContainer, error) { return nil, nil }
	set := hosts.New(dock, true, nil)
	r := NewPluginsRouter(set, st, nil, nil, nil, true, false, DefaultLimits, nil)
	ctx := rpcContext()
	if _, err := r.Enable(ctx, &TargetParams{Key: "local|p/s"}); err == nil {
		t.Fatal("Enable without a store should error")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
}

func TestEnableUnreachablePlugin(t *testing.T) {
	f := newFixture(t)
	// No container discovered for this key.
	f.dock.pluginContainers = func(ctx context.Context) ([]docker.PluginContainer, error) { return nil, nil }
	if _, err := f.r.Enable(f.ctx, &TargetParams{Key: f.key}); err == nil {
		t.Fatal("enabling a plugin with no live container should error")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
}

func TestDisable(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	if _, err := f.r.Disable(f.ctx, &TargetParams{Key: f.key}); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	rec, _ := f.st.Plugin(f.key)
	if rec == nil || rec.Enabled {
		t.Fatalf("record should remain but be disabled: %+v", rec)
	}
	// Disable detaches the plugin from hope's shared network.
	f.dock.mu.Lock()
	got := len(f.dock.detaches)
	f.dock.mu.Unlock()
	if got == 0 {
		t.Fatal("Disable should DetachNetwork the plugin container")
	}
	// Disabling an unknown key is a no-op success.
	if _, err := f.r.Disable(f.ctx, &TargetParams{Key: "nope|x/y"}); err != nil {
		t.Fatalf("Disable(unknown) = %v, want nil", err)
	}
}

func TestForget(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	_ = f.st.PutPluginKV(f.key, "k", []byte(`v`))
	if _, err := f.r.Forget(f.ctx, &TargetParams{Key: f.key}); err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if rec, _ := f.st.Plugin(f.key); rec != nil {
		t.Fatal("record should be deleted after Forget")
	}
}

// -----------------------------------------------------------------------------
// Grant / Deny / PendingConsents
// -----------------------------------------------------------------------------

func TestGrantDenyPending(t *testing.T) {
	f := newFixture(t)
	f.enable(t) // seeds Pending=[storage]

	consents, err := f.r.PendingConsents(f.ctx)
	if err != nil {
		t.Fatalf("PendingConsents: %v", err)
	}
	if len(consents) != 1 || consents[0].Scope != "storage" {
		t.Fatalf("PendingConsents = %+v, want one storage prompt", consents)
	}

	// Grant moves storage from pending to grants.
	if _, err := f.r.Grant(f.ctx, &GrantParams{Key: f.key, Scope: "storage"}); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	rec, _ := f.st.Plugin(f.key)
	if len(rec.Pending) != 0 || !rec.HasGrant("storage") {
		t.Fatalf("after Grant: pending=%v grants=%v", rec.Pending, rec.Grants)
	}

	// Deny with DontAsk revokes the grant and remembers the denial.
	if _, err := f.r.Deny(f.ctx, &GrantParams{Key: f.key, Scope: "storage", DontAsk: true}); err != nil {
		t.Fatalf("Deny: %v", err)
	}
	rec, _ = f.st.Plugin(f.key)
	if rec.HasGrant("storage") {
		t.Fatal("Deny should revoke the grant")
	}
	found := false
	for _, d := range rec.Denied {
		if d == "storage" {
			found = true
		}
	}
	if !found {
		t.Fatalf("DontAsk should record the denial: %v", rec.Denied)
	}
}

func TestGrantValidation(t *testing.T) {
	f := newFixture(t)
	if _, err := f.r.Grant(f.ctx, &GrantParams{Key: f.key, Scope: ""}); err == nil {
		t.Fatal("Grant needs a scope")
	}
	if _, err := f.r.Grant(f.ctx, &GrantParams{Key: "missing|x/y", Scope: "storage"}); err == nil {
		t.Fatal("Grant on a missing record should error")
	}
	// Deny on a missing record is a no-op success.
	if _, err := f.r.Deny(f.ctx, &GrantParams{Key: "missing|x/y", Scope: "storage"}); err != nil {
		t.Fatalf("Deny(missing) = %v, want nil", err)
	}
}

// -----------------------------------------------------------------------------
// Config / Catalog / RefreshCatalog
// -----------------------------------------------------------------------------

func TestConfigMasksValues(t *testing.T) {
	f := newFixture(t)
	// Hand-labeled plugin (no CatalogID) => empty config.
	if err := f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	cfg, err := f.r.Config(f.ctx, &TargetParams{Key: f.key})
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if len(cfg.Fields) != 0 || len(cfg.Values) != 0 {
		t.Fatalf("hand-labeled plugin should have empty config: %+v", cfg)
	}

	// Installed plugin (CatalogID set) => field schema, but values are masked.
	if err := f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Enabled: true, CatalogID: "hope-redis"}); err != nil {
		t.Fatal(err)
	}
	cfg, err = f.r.Config(f.ctx, &TargetParams{Key: f.key})
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if len(cfg.Fields) == 0 || cfg.Fields[0].Key != "REDIS_URL" {
		t.Fatalf("expected the catalog env schema, got %+v", cfg.Fields)
	}
	if len(cfg.Values) != 0 {
		t.Fatalf("Config must never return stored secret values, got %v", cfg.Values)
	}
}

func TestConfigValidation(t *testing.T) {
	f := newFixture(t)
	if _, err := f.r.Config(f.ctx, &TargetParams{Key: ""}); err == nil {
		t.Fatal("Config needs a key")
	}
	// No record at all => empty config, no error.
	cfg, err := f.r.Config(f.ctx, &TargetParams{Key: "missing|x/y"})
	if err != nil || len(cfg.Fields) != 0 {
		t.Fatalf("Config(missing) = %+v, %v; want empty", cfg, err)
	}
}

func TestCatalogAndRefresh(t *testing.T) {
	f := newFixture(t)
	entries, err := f.r.Catalog(f.ctx)
	if err != nil {
		t.Fatalf("Catalog: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("Catalog should return the built-ins")
	}
	found := false
	for _, e := range entries {
		if e.ID == "hope-redis" {
			found = true
		}
	}
	if !found {
		t.Fatal("built-in hope-redis missing from catalog")
	}
	// Refresh with no remote sources returns the built-ins, no error.
	got, err := f.r.RefreshCatalog(f.ctx)
	if err != nil || len(got) == 0 {
		t.Fatalf("RefreshCatalog = %d entries, %v", len(got), err)
	}
}

func TestCatalogEmptyWhenUnwired(t *testing.T) {
	set := hosts.New(&mockDock{localSocket: true}, true, nil)
	r := NewPluginsRouter(set, newStore(t), nil, nil, nil, true, false, DefaultLimits, nil)
	entries, err := r.Catalog(rpcContext())
	if err != nil || len(entries) != 0 {
		t.Fatalf("nil catalog should yield empty, got %d, %v", len(entries), err)
	}
}

// -----------------------------------------------------------------------------
// Manifest (dial -> schema + layout; re-approval gate)
// -----------------------------------------------------------------------------

func TestManifest(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	m, err := f.r.Manifest(f.ctx, &TargetParams{Key: f.key})
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	if string(m.Schema) != defaultSchema {
		t.Fatalf("schema mismatch:\n got %s\nwant %s", m.Schema, defaultSchema)
	}
	if len(m.Layout) == 0 {
		t.Fatal("layout should be present")
	}
	if m.Protocol != 1 || m.Compat != "ok" {
		t.Fatalf("protocol=%d compat=%q, want 1/ok", m.Protocol, m.Compat)
	}
}

func TestManifestNotEnabled(t *testing.T) {
	f := newFixture(t)
	if _, err := f.r.Manifest(f.ctx, &TargetParams{Key: f.key}); err == nil {
		t.Fatal("Manifest on a not-enabled plugin should error")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
}

func TestManifestSchemaDriftAutoDisables(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	// The live schema no longer matches the approved hash.
	f.plugin.setSchema(`{"protocolVersion":1,"name":"Changed","permissions":[{"scope":"admin"}]}`)
	if _, err := f.r.Manifest(f.ctx, &TargetParams{Key: f.key}); err == nil {
		t.Fatal("a drifted schema should force re-approval")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
	rec, _ := f.st.Plugin(f.key)
	if rec.Enabled {
		t.Fatal("schema drift should auto-disable the plugin (no auto-reapprove)")
	}
}

func TestManifestSchemaDriftAutoReapprove(t *testing.T) {
	f := newFixtureWith(t, true, true) // autoReapprove on
	f.enable(t)
	newSchema := `{"protocolVersion":1,"name":"Changed"}`
	f.plugin.setSchema(newSchema)
	if _, err := f.r.Manifest(f.ctx, &TargetParams{Key: f.key}); err != nil {
		t.Fatalf("auto-reapprove should keep it enabled: %v", err)
	}
	rec, _ := f.st.Plugin(f.key)
	if !rec.Enabled {
		t.Fatal("auto-reapprove should keep the plugin enabled")
	}
	if rec.SchemaHash != hashBytes([]byte(newSchema)) {
		t.Fatal("auto-reapprove should re-record the new schema hash")
	}
}

// -----------------------------------------------------------------------------
// Call (proxy) + metrics + audit
// -----------------------------------------------------------------------------

func TestCallProxiesMethod(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	res, err := f.r.Call(f.ctx, &CallParams{Key: f.key, Method: "echo", Args: json.RawMessage(`{"x":1}`), Audit: true})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if string(res) != `{"x":1}` {
		t.Fatalf("Call result = %s, want the echoed args", res)
	}
	// Audited call lands in the audit log.
	entries, err := f.r.Audit(f.ctx, &AuditParams{Key: f.key})
	if err != nil {
		t.Fatalf("Audit: %v", err)
	}
	if len(entries) != 1 || entries[0].Method != "echo" || !entries[0].OK {
		t.Fatalf("audit log = %+v, want one OK echo entry", entries)
	}
	// Metrics recorded the call.
	ms, err := f.r.Metrics(f.ctx)
	if err != nil {
		t.Fatalf("Metrics: %v", err)
	}
	if len(ms) != 1 || ms[0].Calls != 1 {
		t.Fatalf("metrics = %+v, want one call", ms)
	}
}

func TestCallRejectsReservedAndValidation(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	if _, err := f.r.Call(f.ctx, &CallParams{Key: f.key, Method: "hope.schema"}); err == nil {
		t.Fatal("hope.* methods must not be proxyable")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
	if _, err := f.r.Call(f.ctx, &CallParams{Key: "", Method: "x"}); err == nil {
		t.Fatal("Call needs key+method")
	}
}

func TestCallPropagatesPluginError(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	f.plugin.mu.Lock()
	f.plugin.errs["boom"] = "kaboom"
	f.plugin.mu.Unlock()
	if _, err := f.r.Call(f.ctx, &CallParams{Key: f.key, Method: "boom"}); err == nil {
		t.Fatal("a plugin JSON-RPC error should surface")
	} else {
		wantCode(t, err, "INTERNAL")
	}
}

// -----------------------------------------------------------------------------
// SetSettings (validate against schema, push hope.settings)
// -----------------------------------------------------------------------------

func TestSetSettings(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	// page_size is declared; bogus is not (dropped); mode=ro is an allowed option.
	res, err := f.r.SetSettings(f.ctx, &SetSettingsParams{Key: f.key, Values: map[string]string{
		"page_size": "25", "mode": "ro", "bogus": "x",
	}})
	if err != nil {
		t.Fatalf("SetSettings: %v", err)
	}
	m := res.(map[string]any)
	if m["pushed"] != true {
		t.Fatalf("expected pushed=true, got %+v", m)
	}
	rec, _ := f.st.Plugin(f.key)
	// SetSettings persists the raw values (validation happens on the push path/install).
	if rec.Settings["page_size"] != "25" {
		t.Fatalf("settings not persisted: %v", rec.Settings)
	}
	if !f.plugin.sawMethod("hope.settings") {
		t.Fatal("SetSettings should push hope.settings to the running plugin")
	}
	if !strings.Contains(f.plugin.settingParam, `"page_size":"25"`) {
		t.Fatalf("pushed settings payload wrong: %s", f.plugin.settingParam)
	}
}

func TestSetSettingsValidation(t *testing.T) {
	f := newFixture(t)
	if _, err := f.r.SetSettings(f.ctx, &SetSettingsParams{Key: ""}); err == nil {
		t.Fatal("SetSettings needs a key")
	}
	// Not enabled => rejected.
	if _, err := f.r.SetSettings(f.ctx, &SetSettingsParams{Key: f.key, Values: map[string]string{}}); err == nil {
		t.Fatal("SetSettings on a not-enabled plugin should error")
	} else {
		wantCode(t, err, "BAD_REQUEST")
	}
}

// -----------------------------------------------------------------------------
// Surfaces / Dashboard / StackWidgets / Pages / Page
// -----------------------------------------------------------------------------

func TestSurfaces(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	out, err := f.r.Surfaces(f.ctx, &SurfacesParams{Host: "local", ContainerID: "some-container"})
	if err != nil {
		t.Fatalf("Surfaces: %v", err)
	}
	if len(out) != 1 || out[0].Title != "Details" || out[0].Key != f.key {
		t.Fatalf("Surfaces = %+v, want one container contribution", out)
	}
	if len(out[0].Actions) != 1 || out[0].Actions[0] != "refresh" {
		t.Fatalf("surface actions wrong: %+v", out[0].Actions)
	}
}

func TestSurfacesValidation(t *testing.T) {
	f := newFixture(t)
	if _, err := f.r.Surfaces(f.ctx, &SurfacesParams{Host: "", ContainerID: ""}); err == nil {
		t.Fatal("Surfaces needs host+container_id")
	}
	// No stored plugins => empty, no dial.
	out, err := f.r.Surfaces(f.ctx, &SurfacesParams{Host: "local", ContainerID: "c"})
	if err != nil || len(out) != 0 {
		t.Fatalf("Surfaces with no plugins = %+v, %v", out, err)
	}
}

func TestDashboard(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	out, err := f.r.Dashboard(f.ctx)
	if err != nil {
		t.Fatalf("Dashboard: %v", err)
	}
	if len(out) != 1 || out[0].Title != "Widget" || out[0].Stack != "proj" {
		t.Fatalf("Dashboard = %+v, want one widget tagged with its stack", out)
	}
}

func TestStackWidgets(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	f.dock.projectIDs = func(ctx context.Context, project string) ([]string, error) {
		return []string{"cid1"}, nil
	}
	out, err := f.r.StackWidgets(f.ctx, &StackParams{Host: "local", Project: "proj"})
	if err != nil {
		t.Fatalf("StackWidgets: %v", err)
	}
	if len(out) != 1 || out[0].Title != "Stack Panel" {
		t.Fatalf("StackWidgets = %+v, want one stack panel", out)
	}
	if _, err := f.r.StackWidgets(f.ctx, &StackParams{}); err == nil {
		t.Fatal("StackWidgets needs host+project")
	}
}

func TestPagesAndPage(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	pages, err := f.r.Pages(f.ctx)
	if err != nil {
		t.Fatalf("Pages: %v", err)
	}
	if len(pages) != 1 || len(pages[0].Pages) != 1 {
		t.Fatalf("Pages = %+v, want one plugin with one page node", pages)
	}
	node := pages[0].Pages[0]
	if node.Title != "Home" || node.Path != "home" {
		t.Fatalf("page node wrong: %+v", node)
	}
	// Fetch the page by its stable id path.
	surf, err := f.r.Page(f.ctx, &PageParams{Key: f.key, Path: node.Path})
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	if surf.Title != "Home" || len(surf.Node) == 0 {
		t.Fatalf("Page surface wrong: %+v", surf)
	}
	// Bad path => BadRequest.
	if _, err := f.r.Page(f.ctx, &PageParams{Key: f.key, Path: "999"}); err == nil {
		t.Fatal("Page with a nonexistent path should error")
	}
	if _, err := f.r.Page(f.ctx, &PageParams{Key: "", Path: "x"}); err == nil {
		t.Fatal("Page needs key+path")
	}
}

// -----------------------------------------------------------------------------
// dial: URL candidate construction (alias branch, no network I/O)
// -----------------------------------------------------------------------------

func TestDialBuildsAliasCandidates(t *testing.T) {
	f := newFixture(t)
	// Let the shared-net attach "succeed" so dial adds the alias + name URLs.
	f.dock.attachErr = nil
	f.dock.dialCandidates = func(ctx context.Context, id string, port int) ([]string, []string, string, error) {
		return []string{"10.0.0.5:8080"}, []string{"127.0.0.1:9999"}, "", nil
	}
	ep, err := f.r.dial(context.Background(), "local", f.pc, "tok", false)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// Order: shared-net alias (short id) -> container name -> direct -> net IP.
	want := []string{
		"http://cid1:8080/__hope",
		"http://svc:8080/__hope",
		"http://127.0.0.1:9999/__hope",
		"http://10.0.0.5:8080/__hope",
	}
	if len(ep.urls) != len(want) {
		t.Fatalf("dial urls = %v, want %v", ep.urls, want)
	}
	for i := range want {
		if ep.urls[i] != want[i] {
			t.Fatalf("dial url[%d] = %q, want %q", i, ep.urls[i], want[i])
		}
	}
	if ep.token != "tok" {
		t.Fatalf("endpoint token = %q", ep.token)
	}
}

func TestDialUnknownHost(t *testing.T) {
	f := newFixture(t)
	if _, err := f.r.dial(context.Background(), "ghost-host", f.pc, "tok", false); err == nil {
		t.Fatal("dial to an unconnected host should error")
	}
}

// -----------------------------------------------------------------------------
// install() orchestrator + reconfigure()
// -----------------------------------------------------------------------------

func TestInstallOrchestrator(t *testing.T) {
	f := newFixture(t)
	var lines []string
	emit := func(s string) { lines = append(lines, s) }
	p := InstallParams{
		Host:    "local",
		Project: "proj",
		Plugins: []PluginInstance{{
			CatalogID: "hope-redis",
			Name:      "svc",
			Env:       map[string]string{"REDIS_URL": "redis://x"},
			Settings:  map[string]string{"page_size": "25"},
		}},
	}
	ctx := hosts.WithTarget(context.Background(), hosts.LocalID)
	if err := f.r.install(ctx, f.dock, "local", p, emit); err != nil {
		t.Fatalf("install: %v\nlog: %v", err, lines)
	}
	// The stack was deployed (a container created) and the plugin enabled + inited.
	f.dock.mu.Lock()
	created := len(f.dock.created)
	f.dock.mu.Unlock()
	if created == 0 {
		t.Fatal("install should CreateContainer the plugin")
	}
	rec, _ := f.st.Plugin(f.key)
	if rec == nil || !rec.Enabled {
		t.Fatalf("install should leave an enabled record: %+v", rec)
	}
	if rec.CatalogID != "hope-redis" {
		t.Fatalf("CatalogID = %q, want hope-redis", rec.CatalogID)
	}
	if rec.Settings["page_size"] != "25" {
		t.Fatalf("install should seed validated settings: %v", rec.Settings)
	}
	if rec.InitContainerID != "cid1" {
		t.Fatalf("initPlugin should record the container id, got %q", rec.InitContainerID)
	}
	if !f.plugin.sawMethod("hope.init") {
		t.Fatal("install should run the hope.init handshake")
	}
}

func TestInstallValidationErrors(t *testing.T) {
	f := newFixture(t)
	ctx := hosts.WithTarget(context.Background(), hosts.LocalID)
	// Unknown catalog id.
	err := f.r.install(ctx, f.dock, "local", InstallParams{Project: "proj", Plugins: []PluginInstance{{CatalogID: "nope", Name: "svc"}}}, func(string) {})
	if err == nil {
		t.Fatal("unknown catalog id should error")
	}
	// Missing required env (REDIS_URL).
	err = f.r.install(ctx, f.dock, "local", InstallParams{Project: "proj", Plugins: []PluginInstance{{CatalogID: "hope-redis", Name: "svc"}}}, func(string) {})
	if err == nil {
		t.Fatal("missing required env should error")
	}
	// No plugins selected.
	if err := f.r.install(ctx, f.dock, "local", InstallParams{Project: "proj"}, func(string) {}); err == nil {
		t.Fatal("no plugins should error")
	}
}

func TestInstallUnavailableWithoutDeps(t *testing.T) {
	// No deploy engine wired.
	set := hosts.New(&mockDock{localSocket: true}, true, nil)
	r := NewPluginsRouter(set, newStore(t), nil, nil, nil, true, false, DefaultLimits, nil)
	ctx := hosts.WithTarget(context.Background(), hosts.LocalID)
	if err := r.install(ctx, &mockDock{localSocket: true}, "local", InstallParams{Plugins: []PluginInstance{{CatalogID: "x"}}}, func(string) {}); err == nil {
		t.Fatal("install without a deploy engine should error")
	}
}

func TestReconfigure(t *testing.T) {
	f := newFixture(t)
	// Install first so there's a stored spec + record to reconfigure.
	ctx := hosts.WithTarget(context.Background(), hosts.LocalID)
	p := InstallParams{Project: "proj", Plugins: []PluginInstance{{CatalogID: "hope-redis", Name: "svc", Env: map[string]string{"REDIS_URL": "redis://x"}}}}
	if err := f.r.install(ctx, f.dock, "local", p, func(string) {}); err != nil {
		t.Fatalf("install (setup): %v", err)
	}
	f.dock.mu.Lock()
	f.dock.created = nil // reset so we can see the reconfigure recreate
	f.dock.mu.Unlock()

	var lines []string
	if err := f.r.reconfigure(ctx, f.key, map[string]string{"REDIS_URL": "redis://new"}, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("reconfigure: %v\nlog: %v", err, lines)
	}
	f.dock.mu.Lock()
	created := len(f.dock.created)
	f.dock.mu.Unlock()
	if created == 0 {
		t.Fatal("reconfigure should recreate the container")
	}
	rec, _ := f.st.Plugin(f.key)
	if rec == nil || !rec.Enabled {
		t.Fatalf("reconfigure should re-enable: %+v", rec)
	}
}

func TestReconfigureErrors(t *testing.T) {
	f := newFixture(t)
	ctx := hosts.WithTarget(context.Background(), hosts.LocalID)
	// No record.
	if err := f.r.reconfigure(ctx, "missing|x/y", nil, func(string) {}); err == nil {
		t.Fatal("reconfigure of a missing plugin should error")
	}
	// Record with no CatalogID (hand-labeled) can't be reconfigured.
	_ = f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Enabled: true})
	if err := f.r.reconfigure(ctx, f.key, nil, func(string) {}); err == nil {
		t.Fatal("reconfigure of a non-installed plugin should error")
	}
}

// -----------------------------------------------------------------------------
// waitReachable
// -----------------------------------------------------------------------------

func TestWaitReachable(t *testing.T) {
	f := newFixture(t)
	if err := f.r.waitReachable(context.Background(), f.key, 5*time.Second); err != nil {
		t.Fatalf("waitReachable (running+answering): %v", err)
	}
}

func TestWaitReachableTimeout(t *testing.T) {
	f := newFixture(t)
	// Container present but not running => never reachable.
	notRunning := f.pc
	notRunning.Running = false
	f.dock.pluginContainers = func(ctx context.Context) ([]docker.PluginContainer, error) {
		return []docker.PluginContainer{notRunning}, nil
	}
	if err := f.r.waitReachable(context.Background(), f.key, 10*time.Millisecond); err == nil {
		t.Fatal("waitReachable should time out for a stopped container")
	}
}
