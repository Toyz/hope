package pluginhost

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/toyz/hope/internal/audit"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/store"
)

// -----------------------------------------------------------------------------
// discovery: touchesPlugin + invalidateScan
// -----------------------------------------------------------------------------

func TestTouchesPluginAndInvalidate(t *testing.T) {
	f := newFixture(t)
	f.r.scan(f.ctx, true) // warm the cache with the discovered container (cid1)
	if !f.r.touchesPlugin([]string{"cid1"}) {
		t.Fatal("touchesPlugin should match a discovered container id")
	}
	if f.r.touchesPlugin([]string{"nope"}) {
		t.Fatal("touchesPlugin should not match an unknown id")
	}
	if f.r.touchesPlugin(nil) {
		t.Fatal("touchesPlugin(nil) should be false")
	}
	// invalidateScan forces the next scan to re-list rather than serve the cache.
	f.r.invalidateScan()
	calls := 0
	f.dock.pluginContainers = func(ctx context.Context) ([]docker.PluginContainer, error) {
		calls++
		return []docker.PluginContainer{f.pc}, nil
	}
	f.r.scan(f.ctx, false) // not a forced refresh, but the cache was invalidated
	if calls == 0 {
		t.Fatal("invalidateScan should force the next scan to re-list the fleet")
	}
}

// -----------------------------------------------------------------------------
// limits: acquireStream, frameGate
// -----------------------------------------------------------------------------

func TestLimiterStreamsAndFrameGate(t *testing.T) {
	lim := newPluginLimiter(Limits{MaxConcurrentCalls: 1, MaxConcurrentStreams: 1, CallRatePerSec: 10, CallBurst: 10, MaxFrameBytes: 8, MaxFramesPerSec: 2})
	rel, ok := lim.acquireStream()
	if !ok {
		t.Fatal("first stream slot should be available")
	}
	if _, ok := lim.acquireStream(); ok {
		t.Fatal("second stream should be refused at cap 1")
	}
	rel() // release
	if _, ok := lim.acquireStream(); !ok {
		t.Fatal("stream slot should be reusable after release")
	}

	g := newFrameGate(Limits{MaxFrameBytes: 8, MaxFramesPerSec: 2})
	if g.allow(100) {
		t.Fatal("oversize frame must be dropped")
	}
	if !g.allow(4) || !g.allow(4) {
		t.Fatal("first two in-size frames should pass")
	}
	if g.allow(4) {
		t.Fatal("third frame within the same second exceeds the rate")
	}
}

// -----------------------------------------------------------------------------
// surfaces helpers: image-glob / service match, nested page nodes
// -----------------------------------------------------------------------------

func TestSurfacesImageGlobAndServiceMatch(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	// A contribution that matches by image glob AND compose service.
	f.plugin.layout = `{"contributions":[{"surface":"container","title":"PG","node":{"kind":"kv"},"match":{"images":["postgres*"],"services":["db"]}}]}`
	f.dock.matchInfo = func(ctx context.Context, id string) (string, map[string]string, error) {
		return "postgres:16", map[string]string{docker.LabelService: "db"}, nil
	}
	out, err := f.r.Surfaces(f.ctx, &SurfacesParams{Host: "local", ContainerID: "target"})
	if err != nil {
		t.Fatalf("Surfaces: %v", err)
	}
	if len(out) != 1 || out[0].Title != "PG" {
		t.Fatalf("image-glob+service match should apply: %+v", out)
	}

	// A non-matching image excludes the contribution.
	f.dock.matchInfo = func(ctx context.Context, id string) (string, map[string]string, error) {
		return "redis:7", map[string]string{docker.LabelService: "cache"}, nil
	}
	f.r.invalidateScan()
	out, _ = f.r.Surfaces(f.ctx, &SurfacesParams{Host: "local", ContainerID: "target"})
	if len(out) != 0 {
		t.Fatalf("non-matching image should exclude the surface: %+v", out)
	}
}

func TestPagesNestedNodes(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	// A page contribution with a nested pages tree exercises buildPageNodes recursion.
	// The shared node is required for Page() to resolve a leaf.
	f.plugin.layout = `{"contributions":[{"surface":"page","title":"Root","node":{"kind":"text"},"pages":[{"title":"Group","children":[{"title":"Leaf"}]}]}]}`
	pages, err := f.r.Pages(f.ctx)
	if err != nil {
		t.Fatalf("Pages: %v", err)
	}
	if len(pages) != 1 || len(pages[0].Pages) != 1 {
		t.Fatalf("Pages = %+v", pages)
	}
	grp := pages[0].Pages[0]
	if grp.Title != "Group" || len(grp.Children) != 1 || grp.Children[0].Title != "Leaf" {
		t.Fatalf("nested page nodes wrong: %+v", grp)
	}
	// The leaf's dotted path addresses it: "<contrib>.<i>.<j>".
	if grp.Children[0].Path != "0.0.0" {
		t.Fatalf("leaf path = %q, want 0.0.0", grp.Children[0].Path)
	}
	// Fetch the nested leaf page by its dotted path.
	surf, err := f.r.Page(f.ctx, &PageParams{Key: f.key, Path: "0.0.0"})
	if err != nil {
		t.Fatalf("Page(nested): %v", err)
	}
	if surf.Title != "Leaf" {
		t.Fatalf("nested page title = %q, want Leaf", surf.Title)
	}
}

// -----------------------------------------------------------------------------
// gc.go: reconcileOnce / reapStack / reap + the Start* subscribers
// -----------------------------------------------------------------------------

func TestReapStackDeletesRecords(t *testing.T) {
	f := newFixture(t)
	_ = f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Enabled: true})
	_ = f.st.PutPlugin(store.PluginRecord{Key: "local|other/x", Host: "local", Project: "other", Service: "x", Enabled: true})
	f.r.reapStack("local", "proj")
	if rec, _ := f.st.Plugin(f.key); rec != nil {
		t.Fatal("reapStack should delete the destroyed stack's record")
	}
	if rec, _ := f.st.Plugin("local|other/x"); rec == nil {
		t.Fatal("reapStack must not touch another stack's record")
	}
}

func TestReconcileOnceReapsAfterMisses(t *testing.T) {
	f := newFixture(t)
	f.r.missCount = map[string]int{}
	// An enabled record whose identity is NOT discovered (no live container).
	_ = f.st.PutPlugin(store.PluginRecord{Key: "local|ghost/x", Host: "local", Project: "ghost", Service: "x", Enabled: true})
	// The discovered container (cid1) keeps testKey2 present, so only the ghost misses.
	for i := 0; i < reconcileMisses; i++ {
		f.r.reconcileOnce(f.ctx)
	}
	if rec, _ := f.st.Plugin("local|ghost/x"); rec != nil {
		t.Fatalf("a record absent for %d passes on a reachable host should be reaped", reconcileMisses)
	}
	if _, ok := f.r.missCount["local|ghost/x"]; ok {
		t.Fatal("miss streak should be cleared after reaping")
	}
}

func TestReconcileKeepsPresentAndOffline(t *testing.T) {
	f := newFixture(t)
	f.r.missCount = map[string]int{}
	// A record whose HOST is offline: absence is unknowable, never reaped.
	set := hosts.New(f.dock, false, nil) // localUp=false => host offline
	f.r.hosts = set
	_ = f.st.PutPlugin(store.PluginRecord{Key: "local|off/x", Host: "local", Project: "off", Service: "x", Enabled: true})
	for i := 0; i < reconcileMisses+2; i++ {
		f.r.reconcileOnce(f.ctx)
	}
	if rec, _ := f.st.Plugin("local|off/x"); rec == nil {
		t.Fatal("a record on an OFFLINE host must never be reaped (absence proves nothing)")
	}
}

func TestStartRecordGCReapsOnDestroyed(t *testing.T) {
	f := newFixture(t)
	_ = f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Enabled: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartRecordGC(ctx, f.r)
	f.bus.Publish(events.Event{Kind: events.KindStackDestroyed, Host: "local", Project: "proj"})
	// Wait for the async reaper.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rec, _ := f.st.Plugin(f.key); rec == nil {
			return // reaped
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("StartRecordGC should reap records on a stack.destroyed event")
}

func TestStartPluginLivenessBustsCache(t *testing.T) {
	f := newFixture(t)
	f.r.scan(f.ctx, true) // warm cache so touchesPlugin(cid1) matches
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub, cancelSub := f.bus.Subscribe(0)
	defer cancelSub()
	StartPluginLiveness(ctx, f.r)
	f.bus.Publish(events.Event{Kind: events.KindContainerState, Host: "local", IDs: []string{"cid1"}})
	// It should republish a plugin.changed after busting the cache.
	if !drainForKind(sub, events.KindPluginChanged) {
		t.Fatal("StartPluginLiveness should republish plugin.changed for a touched container")
	}
}

func TestStartRecordReconcileRuns(t *testing.T) {
	f := newFixture(t)
	_ = f.st.PutPlugin(store.PluginRecord{Key: "local|ghost/x", Host: "local", Project: "ghost", Service: "x", Enabled: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartRecordReconcile(ctx, f.r, 5*time.Millisecond)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if rec, _ := f.st.Plugin("local|ghost/x"); rec == nil {
			return // reconciled away
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("StartRecordReconcile should eventually reap an absent record")
}

// -----------------------------------------------------------------------------
// fanout.go: dispatchEvent / pushEvent / StartEventFanout
// -----------------------------------------------------------------------------

func TestDispatchEventPushesToSubscribed(t *testing.T) {
	f := newFixture(t)
	// Enabled + events:subscribe granted => hope.event is pushed.
	_ = f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Enabled: true, Grants: []string{scopeEventsSubscribe}})
	sem := make(chan struct{}, fanoutWorkers)
	f.r.dispatchEvent(f.ctx, events.Event{Kind: events.KindStackDeployed, Host: "local"}, sem)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.plugin.sawMethod("hope.event") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("dispatchEvent should deliver hope.event to a subscribed plugin")
}

func TestDispatchEventSkipsControlKinds(t *testing.T) {
	f := newFixture(t)
	_ = f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Enabled: true, Grants: []string{scopeEventsSubscribe}})
	sem := make(chan struct{}, fanoutWorkers)
	// A ping is a control frame — never fanned out.
	f.r.dispatchEvent(f.ctx, events.Event{Kind: events.KindPing}, sem)
	time.Sleep(50 * time.Millisecond)
	if f.plugin.sawMethod("hope.event") {
		t.Fatal("control-kind events must not be delivered to plugins")
	}
}

func TestPushEventBestEffort(t *testing.T) {
	f := newFixture(t)
	rec := store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Enabled: true, Token: f.st.DeriveToken(f.key)}
	// Directly exercise the push path (dials + hope.event).
	f.r.pushEvent(context.Background(), rec, events.Event{Kind: events.KindStackDeployed})
	if !f.plugin.sawMethod("hope.event") {
		t.Fatal("pushEvent should dial the plugin and call hope.event")
	}
	// A key with no live container is a silent no-op (no panic).
	f.r.pushEvent(context.Background(), store.PluginRecord{Key: "gone|x/y", Host: "local"}, events.Event{Kind: events.KindStackDeployed})
}

func TestStartEventFanout(t *testing.T) {
	f := newFixture(t)
	_ = f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Project: "proj", Service: "svc", Enabled: true, Grants: []string{scopeEventsSubscribe}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartEventFanout(ctx, f.r)
	f.bus.Publish(events.Event{Kind: events.KindStackDeployed, Host: "local"})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.plugin.sawMethod("hope.event") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("StartEventFanout should deliver bus events to subscribed plugins")
}

// -----------------------------------------------------------------------------
// router package funcs: SetCallbackURL / SetAgentCallback / SetAgentAttach + callbackFor
// -----------------------------------------------------------------------------

func TestCallbackWiring(t *testing.T) {
	f := newFixture(t)
	SetCallbackURL(f.r, "http://hope:9000")
	if got := f.r.callbackFor("local"); got != "http://hope:9000" {
		t.Fatalf("callbackFor(local) = %q, want the co-located URL", got)
	}
	// An agent resolver wins when it returns a non-empty URL.
	SetAgentCallback(f.r, func(hostID string) string {
		if hostID == "agent-1" {
			return "http://agent-1:7000"
		}
		return ""
	})
	if got := f.r.callbackFor("agent-1"); got != "http://agent-1:7000" {
		t.Fatalf("callbackFor(agent-1) = %q, want the agent-relayed URL", got)
	}
	if got := f.r.callbackFor("local"); got != "http://hope:9000" {
		t.Fatalf("callbackFor(local) with agent resolver present = %q, want the co-located URL", got)
	}
	attached := ""
	SetAgentAttach(f.r, func(ctx context.Context, hostID string) { attached = hostID })
	f.r.agentAttach(context.Background(), "agent-1")
	if attached != "agent-1" {
		t.Fatalf("SetAgentAttach hook not wired: %q", attached)
	}
}

// -----------------------------------------------------------------------------
// stream.go: install/reconfigure via ServeRoute + the plugin data stream
// -----------------------------------------------------------------------------

// streamReq builds an authenticated POST gateway.Request for a stream route.
func streamReq(t *testing.T, tokens *auth.TokenManager, path string, args ...string) *gateway.Request {
	t.Helper()
	tok, _ := tokens.Issue("tester")
	raw := make([]json.RawMessage, len(args))
	for i, a := range args {
		b, _ := json.Marshal(a)
		raw[i] = b
	}
	body, _ := json.Marshal(map[string]any{"args": raw})
	h := gateway.Header{}
	h.Set("Authorization", "Bearer "+tok)
	h.Set(hosts.TargetHeader, "local")
	return &gateway.Request{Method: "POST", Path: path, Header: h, Body: body}
}

func drainStream(t *testing.T, resp *gateway.Response) string {
	t.Helper()
	if resp.Stream == nil {
		return string(resp.Body)
	}
	b, err := io.ReadAll(resp.Stream)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	if c, ok := resp.Stream.(io.Closer); ok {
		_ = c.Close()
	}
	return string(b)
}

func TestStreamHandlerAuthAndValidation(t *testing.T) {
	f := newFixture(t)
	tokens := auth.NewTokenManager("stream-secret", time.Hour, nil)
	h := NewStreamHandler(f.r, tokens)

	// Metadata methods.
	if h.PluginName() == "" || h.Doc() == "" || len(h.RoutePatterns()) == 0 {
		t.Fatal("stream handler metadata should be populated")
	}
	// Wrong HTTP method.
	if r := h.ServeRoute(context.Background(), &gateway.Request{Method: "GET", Path: pathPluginStream, Header: gateway.Header{}}); r.Status != 405 {
		t.Fatalf("GET status = %d, want 405", r.Status)
	}
	// Missing/invalid auth.
	bad := &gateway.Request{Method: "POST", Path: pathPluginStream, Header: gateway.Header{}, Body: []byte(`{"args":[]}`)}
	if r := h.ServeRoute(context.Background(), bad); r.Status != 401 {
		t.Fatalf("no-auth status = %d, want 401", r.Status)
	}
	// Authed but too few args.
	if r := h.ServeRoute(context.Background(), streamReq(t, tokens, pathPluginStream, "onlykey")); r.Status != 400 {
		t.Fatalf("missing-method status = %d, want 400", r.Status)
	}
	// Reserved hope.* method rejected.
	if r := h.ServeRoute(context.Background(), streamReq(t, tokens, pathPluginStream, f.key, "hope.schema")); r.Status != 400 {
		t.Fatalf("reserved-method status = %d, want 400", r.Status)
	}
	// Not enabled.
	if r := h.ServeRoute(context.Background(), streamReq(t, tokens, pathPluginStream, f.key, "tail")); r.Status != 400 {
		t.Fatalf("not-enabled status = %d, want 400", r.Status)
	}
}

func TestStreamHandlerPipesFrames(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	f.plugin.mu.Lock()
	f.plugin.streams["tail"] = []string{`{"line":1}`, `{"line":2}`}
	f.plugin.mu.Unlock()

	tokens := auth.NewTokenManager("stream-secret", time.Hour, nil)
	h := NewStreamHandler(f.r, tokens)
	resp := h.ServeRoute(context.Background(), streamReq(t, tokens, pathPluginStream, f.key, "tail"))
	if resp.Status != 200 {
		t.Fatalf("stream status = %d, want 200", resp.Status)
	}
	_ = drainStream(t, resp) // fully drives ep.stream + the frame-gate + pipe goroutine
}

func TestStreamHandlerInstall(t *testing.T) {
	f := newFixture(t)
	tokens := auth.NewTokenManager("stream-secret", time.Hour, nil)
	h := NewStreamHandler(f.r, tokens)
	p := InstallParams{Project: "proj", Plugins: []PluginInstance{{CatalogID: "hope-redis", Name: "svc", Env: map[string]string{"REDIS_URL": "redis://x"}}}}
	pj, _ := json.Marshal(p)
	resp := h.ServeRoute(context.Background(), streamReq(t, tokens, pathInstallPlugin, string(pj)))
	if resp.Status != 200 {
		t.Fatalf("install stream status = %d, want 200", resp.Status)
	}
	out := drainStream(t, resp)
	if !strings.Contains(out, `"done"`) {
		t.Fatalf("install stream should end with a done frame: %s", out)
	}
	if rec, _ := f.st.Plugin(f.key); rec == nil || !rec.Enabled {
		t.Fatal("install stream should enable the plugin")
	}
}

func TestStreamHandlerReconfigureValidation(t *testing.T) {
	f := newFixture(t)
	tokens := auth.NewTokenManager("stream-secret", time.Hour, nil)
	h := NewStreamHandler(f.r, tokens)
	// Too few args (needs key + env json).
	if r := h.ServeRoute(context.Background(), streamReq(t, tokens, pathReconfigurePlugin, f.key)); r.Status != 400 {
		t.Fatalf("reconfigure with missing env = %d, want 400", r.Status)
	}
}

// -----------------------------------------------------------------------------
// ingress.go: requestPermission + addServiceLabel success paths
// -----------------------------------------------------------------------------

func TestIngressRequestPermission(t *testing.T) {
	f := newFixture(t)
	_ = f.st.PutPlugin(store.PluginRecord{Key: f.key, Host: "local", Enabled: true})
	h := NewPluginIngress(f.st, f.bus, nil, nil, DefaultLimits)
	token := f.st.DeriveToken(f.key)

	body, _ := json.Marshal(map[string]string{"key": f.key, "scope": "storage", "reason": "save data"})
	hdr := gateway.Header{}
	hdr.Set("Authorization", "Bearer "+token)
	req := &gateway.Request{Method: "POST", Path: pathPluginReqPerm, Header: hdr, Body: body}
	resp := h.ServeRoute(context.Background(), req)
	if resp.Status != 200 || !strings.Contains(string(resp.Body), `"pending":true`) {
		t.Fatalf("requestPermission = %d %s, want 200 pending:true", resp.Status, resp.Body)
	}
	rec, _ := f.st.Plugin(f.key)
	if len(rec.Pending) != 1 || rec.Pending[0] != "storage" {
		t.Fatalf("scope should be queued pending: %v", rec.Pending)
	}
	// A second identical request is a silent no-op (already pending).
	resp = h.ServeRoute(context.Background(), req)
	if resp.Status != 200 || !strings.Contains(string(resp.Body), `"pending":false`) {
		t.Fatalf("repeat requestPermission should be pending:false: %d %s", resp.Status, resp.Body)
	}
}

func TestIngressMetadata(t *testing.T) {
	h := NewPluginIngress(newStore(t), events.New(), nil, nil, DefaultLimits)
	if h.PluginName() == "" || h.Doc() == "" || len(h.RoutePatterns()) == 0 {
		t.Fatal("ingress metadata should be populated")
	}
}

// TestPageTemplating covers fillTemplate + fillCrumbs (a master-detail page whose
// subtitle/breadcrumbs interpolate the URL arg).
func TestPageTemplating(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	f.plugin.layout = `{"contributions":[{"surface":"page","id":"detail","title":"Detail","node":{"kind":"text"},"param_key":"id","subtitle":"user {id}","breadcrumbs":[{"label":"Users","to":"/users"},{"label":"user {id}","to":"/users/{id}"}]}]}`
	surf, err := f.r.Page(f.ctx, &PageParams{Key: f.key, Path: "detail", Arg: "42"})
	if err != nil {
		t.Fatalf("Page(detail): %v", err)
	}
	if surf.Subtitle != "user 42" {
		t.Fatalf("subtitle template not filled: %q", surf.Subtitle)
	}
	if len(surf.Breadcrumbs) != 2 || surf.Breadcrumbs[1].Label != "user 42" || surf.Breadcrumbs[1].To != "/users/42" {
		t.Fatalf("breadcrumb templates not filled: %+v", surf.Breadcrumbs)
	}
}

// TestStackWidgetsImageMatch covers stackSurfaceApplies' per-member image match.
func TestStackWidgetsImageMatch(t *testing.T) {
	f := newFixture(t)
	f.enable(t)
	f.plugin.layout = `{"contributions":[{"surface":"stack","title":"PG","node":{"kind":"table"},"match":{"images":["postgres*"]}}]}`
	f.dock.projectIDs = func(ctx context.Context, project string) ([]string, error) { return []string{"c1"}, nil }
	f.dock.matchInfo = func(ctx context.Context, id string) (string, map[string]string, error) {
		return "postgres:16", nil, nil
	}
	out, err := f.r.StackWidgets(f.ctx, &StackParams{Host: "local", Project: "other-project"})
	if err != nil {
		t.Fatalf("StackWidgets: %v", err)
	}
	if len(out) != 1 || out[0].Title != "PG" {
		t.Fatalf("image-matched stack widget should apply: %+v", out)
	}
}

// TestInitPluginSettingsFallback covers initPlugin's hope.settings fallback when the
// plugin doesn't implement hope.init.
func TestInitPluginSettingsFallback(t *testing.T) {
	f := newFixture(t)
	f.plugin.mu.Lock()
	f.plugin.errs["hope.init"] = "method not found" // force the fallback
	f.plugin.mu.Unlock()
	f.enable(t) // Enable runs initPlugin, which now falls back to hope.settings
	if !f.plugin.sawMethod("hope.settings") {
		t.Fatal("initPlugin should fall back to hope.settings when hope.init is unimplemented")
	}
}

func TestIngressAddServiceLabel(t *testing.T) {
	f := newFixture(t)
	// Install so there's a stored spec whose "svc" service hope can edit.
	ctx := hosts.WithTarget(context.Background(), hosts.LocalID)
	p := InstallParams{Project: "proj", Plugins: []PluginInstance{{CatalogID: "hope-redis", Name: "svc", Env: map[string]string{"REDIS_URL": "redis://x"}}}}
	if err := f.r.install(ctx, f.dock, "local", p, func(string) {}); err != nil {
		t.Fatalf("install (setup): %v", err)
	}
	// Grant spec:label so the action passes the scope check.
	rec, _ := f.st.Plugin(f.key)
	rec.Grants = append(rec.Grants, scopeSpecLabel)
	_ = f.st.PutPlugin(*rec)

	aud := audit.New(f.st)
	h := NewPluginIngress(f.st, f.bus, f.dep, aud, DefaultLimits)
	token := f.st.DeriveToken(f.key)
	body, _ := json.Marshal(actionBody{Key: f.key, Op: "addServiceLabel", Service: "svc", LabelKey: "team", LabelValue: "infra"})
	hdr := gateway.Header{}
	hdr.Set("Authorization", "Bearer "+token)
	req := &gateway.Request{Method: "POST", Path: pathPluginAction, Header: hdr, Body: body}
	resp := h.ServeRoute(ctx, req)
	if resp.Status != 200 {
		t.Fatalf("addServiceLabel = %d %s, want 200", resp.Status, resp.Body)
	}
	// The label landed in the stored spec.
	spec, _ := f.dep.Store().Load("local", "proj")
	svc, ok := spec.ServiceByName("svc")
	if !ok || svc.Labels["team"] != "infra" {
		t.Fatalf("label not applied to the stored spec: %+v", svc)
	}
	// It was audited.
	entries, _ := aud.Query(audit.Filter{Target: f.key})
	if len(entries) == 0 {
		t.Fatal("addServiceLabel should be audited")
	}
}
