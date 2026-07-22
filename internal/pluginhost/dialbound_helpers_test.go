package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/audit"
	"github.com/toyz/hope/internal/catalog"
	"github.com/toyz/hope/internal/deploy"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
	"github.com/toyz/hope/internal/store"
)

// This file wires the two doubles that make the daemon+dial-bound router methods
// reachable in a unit test:
//
//  1. mockDock — a docker.API test double. It embeds the interface (nil) so any
//     method a test does NOT wire panics on call (surfacing an unexpected daemon
//     touch). The handful of methods dial()/discovery/install exercise are wired
//     with test-friendly returns; PluginDialCandidates points hope's dialer at the
//     fake plugin server so a real HTTP JSON-RPC round-trip happens.
//  2. fakePlugin — an httptest server that answers the hope.* JSON-RPC protocol
//     (schema/layout/settings/init/event) plus arbitrary proxied methods, so the
//     endpoint.callRPC path runs end to end against a live socket.

// -----------------------------------------------------------------------------
// docker.API mock
// -----------------------------------------------------------------------------

type mockDock struct {
	docker.API // nil embed: un-wired methods panic with a nil-deref

	localSocket bool
	selfCID     string
	selfID      string
	// attachErr, when non-nil, makes AttachNetwork fail so dial() does NOT set the
	// shared-net alias — leaving only the direct (httptest) candidate URL. That keeps
	// callRPC pointed straight at the fake server instead of first trying bogus
	// container-id/name hostnames (whose DNS lookups would be slow/flaky). Tests that
	// specifically assert the alias branch leave this nil.
	attachErr error

	mu       sync.Mutex
	attaches []string // container ids AttachNetwork was called with
	detaches []string // container ids DetachNetwork was called with
	created  []string // container names CreateContainer was called with

	pluginContainers func(ctx context.Context) ([]docker.PluginContainer, error)
	dialCandidates   func(ctx context.Context, id string, port int) (net, direct []string, attach string, err error)
	matchInfo        func(ctx context.Context, id string) (string, map[string]string, error)
	projectIDs       func(ctx context.Context, project string) ([]string, error)
	projectSpec      func(ctx context.Context, project string) (*stackspec.StackSpec, error)
	createContainer  func(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error)
}

func (m *mockDock) IsLocalSocket() bool                  { return m.localSocket }
func (m *mockDock) SelfContainerID(ctx context.Context) string { return m.selfCID }
func (m *mockDock) SelfID() string                       { return m.selfID }
func (m *mockDock) EnsurePluginNetwork(ctx context.Context) error { return nil }

func (m *mockDock) AttachNetwork(ctx context.Context, cid, net string, aliases []string) error {
	m.mu.Lock()
	m.attaches = append(m.attaches, cid)
	m.mu.Unlock()
	return m.attachErr
}

func (m *mockDock) DetachNetwork(ctx context.Context, cid, net string) error {
	m.mu.Lock()
	m.detaches = append(m.detaches, cid)
	m.mu.Unlock()
	return nil
}

func (m *mockDock) PluginContainers(ctx context.Context) ([]docker.PluginContainer, error) {
	if m.pluginContainers == nil {
		return nil, nil
	}
	return m.pluginContainers(ctx)
}

func (m *mockDock) PluginDialCandidates(ctx context.Context, id string, port int) ([]string, []string, string, error) {
	if m.dialCandidates == nil {
		panic("mockDock.PluginDialCandidates called but not wired")
	}
	return m.dialCandidates(ctx, id, port)
}

func (m *mockDock) PluginNetworkIP(ctx context.Context, id string) string { return "" }

func (m *mockDock) ContainerMatchInfo(ctx context.Context, id string) (string, map[string]string, error) {
	if m.matchInfo == nil {
		return "", nil, nil
	}
	return m.matchInfo(ctx, id)
}

func (m *mockDock) ProjectContainerIDs(ctx context.Context, project string) ([]string, error) {
	if m.projectIDs == nil {
		return nil, nil
	}
	return m.projectIDs(ctx, project)
}

// --- methods ApplyStack (the deploy engine) reaches through for install/reconfigure ---

func (m *mockDock) ProjectSpec(ctx context.Context, project string) (*stackspec.StackSpec, error) {
	if m.projectSpec == nil {
		return nil, errors.New("no live stack") // live map stays empty => services are "new"
	}
	return m.projectSpec(ctx, project)
}

func (m *mockDock) CreateContainer(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error) {
	m.mu.Lock()
	m.created = append(m.created, name)
	m.mu.Unlock()
	if m.createContainer == nil {
		return "cid1", nil
	}
	return m.createContainer(ctx, name, spec, pull, emit)
}

func (m *mockDock) NetworkExists(ctx context.Context, name string) (bool, error) { return true, nil }
func (m *mockDock) VolumeExists(ctx context.Context, name string) (bool, error)  { return true, nil }
func (m *mockDock) CreateNetwork(ctx context.Context, spec stackspec.NetworkSpec) (string, error) {
	return spec.Name, nil
}
func (m *mockDock) CreateVolume(ctx context.Context, spec stackspec.VolumeSpec) (string, error) {
	return spec.Name, nil
}

// -----------------------------------------------------------------------------
// fake plugin JSON-RPC server
// -----------------------------------------------------------------------------

const (
	defaultSchema = `{"protocolVersion":1,"name":"My Plugin","icon":"plug","settings":[{"key":"page_size","kind":"number"},{"key":"mode","kind":"select","options":[{"value":"ro"},{"value":"rw"}]}],"permissions":[{"scope":"storage","reason":"save your data"}]}`
	defaultLayout = `{"contributions":[{"surface":"container","title":"Details","node":{"kind":"kv"},"match":{"always":true},"actions":["refresh"]},{"surface":"dashboard","title":"Widget","node":{"kind":"stat"}},{"surface":"stack","title":"Stack Panel","node":{"kind":"table"},"match":{"always":true}},{"surface":"page","id":"home","title":"Home","node":{"kind":"text"}}]}`
)

type fakePlugin struct {
	ts *httptest.Server

	mu           sync.Mutex
	calls        []string          // methods received, in order
	schema       string            // raw hope.schema result
	layout       string            // raw hope.layout result
	initParams   string              // last hope.init params
	settingParam string              // last hope.settings params
	results      map[string]string   // method -> raw result JSON override
	errs         map[string]string   // method -> error message (returns JSON-RPC error)
	streams      map[string][]string // method -> NDJSON result frames (for the stream path)
}

func newFakePlugin(t *testing.T) *fakePlugin {
	t.Helper()
	f := &fakePlugin{schema: defaultSchema, layout: defaultLayout, results: map[string]string{}, errs: map[string]string{}, streams: map[string][]string{}}
	f.ts = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.ts.Close)
	return f
}

// addr is the host:port the dialer targets (ts.URL with the scheme stripped).
func (f *fakePlugin) addr() string { return strings.TrimPrefix(f.ts.URL, "http://") }

func (f *fakePlugin) setSchema(s string) {
	f.mu.Lock()
	f.schema = s
	f.mu.Unlock()
}

func (f *fakePlugin) sawMethod(method string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == method {
			return true
		}
	}
	return false
}

func (f *fakePlugin) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var envelope struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	_ = json.Unmarshal(body, &envelope)
	req := struct{ Method string }{Method: envelope.Method}

	f.mu.Lock()
	f.calls = append(f.calls, req.Method)
	switch req.Method {
	case "hope.init":
		f.initParams = string(envelope.Params)
	case "hope.settings":
		f.settingParam = string(envelope.Params)
	}
	errMsg, hasErr := f.errs[req.Method]
	schema, layout := f.schema, f.layout
	override, hasOverride := f.results[req.Method]
	frames, isStream := f.streams[req.Method]
	f.mu.Unlock()

	// Stream method: emit one NDJSON result line per frame, then close (EOF ends it).
	if isStream {
		w.Header().Set("Content-Type", "application/x-ndjson")
		for _, fr := range frames {
			io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":`+fr+"}\n")
			if fl, ok := w.(http.Flusher); ok {
				fl.Flush()
			}
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if hasErr {
		io.WriteString(w, fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":%q}}`, errMsg))
		return
	}
	var result string
	switch {
	case hasOverride:
		result = override
	case req.Method == "hope.schema":
		result = schema
	case req.Method == "hope.layout":
		result = layout
	case req.Method == "hope.settings":
		result = `{"ok":true}`
	case req.Method == "hope.init":
		result = `{"ok":true,"values":{}}`
	case req.Method == "hope.event":
		result = `{"ok":true}`
	default:
		if len(envelope.Params) > 0 {
			result = string(envelope.Params) // echo the args back
		} else {
			result = "null"
		}
	}
	io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":`+result+`}`)
}

// -----------------------------------------------------------------------------
// router fixture
// -----------------------------------------------------------------------------

// testKey2 is the stable identity of the fixture's single discovered plugin
// (LocalID | project/service). Distinct name from ingress_test's testKey.
const testKey2 = "local|proj/svc"

type fixture struct {
	r      *PluginsRouter
	dock   *mockDock
	st     *store.Store
	dep    *deploy.Engine
	cat    *catalog.Service
	set    *hosts.Set
	bus    *events.Bus
	plugin *fakePlugin
	ctx    *rpc.Context
	pc     docker.PluginContainer
	key    string
}

// newStore opens a real bbolt store in a temp dir with the secret set so DeriveToken
// / Seal work.
func newStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	st.SetSecret("test-secret")
	return st
}

// newFixture wires a real router over the mock docker API + fake plugin server, with
// ONE discovered plugin container at testKey2. enabled=true, autoReapprove=false.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	return newFixtureWith(t, true, false)
}

func newFixtureWith(t *testing.T, enabled, autoReapprove bool) *fixture {
	t.Helper()
	st := newStore(t)
	plugin := newFakePlugin(t)
	pc := docker.PluginContainer{
		ContainerID: "cid1",
		Name:        "svc",
		Port:        8080,
		Path:        "/__hope",
		Title:       "My Plugin",
		Icon:        "plug",
		Project:     "proj",
		Service:     "svc",
		Networks:    []string{"ink-plugins"},
		Image:       "ghcr.io/toyz/hope-redis:latest",
		ImageID:     "sha256:aaa",
		Running:     true,
	}
	dock := &mockDock{
		localSocket: true,
		selfCID:     "self",
		selfID:      "",
		attachErr:   errors.New("no shared net in test"), // keep dial pointed at the direct target
	}
	dock.pluginContainers = func(ctx context.Context) ([]docker.PluginContainer, error) {
		return []docker.PluginContainer{pc}, nil
	}
	dock.dialCandidates = func(ctx context.Context, id string, port int) ([]string, []string, string, error) {
		return nil, []string{plugin.addr()}, "", nil
	}
	set := hosts.New(dock, true, nil)
	cat := catalog.New(nil, 0, nil) // built-ins only, no remote sources
	dep := deploy.NewEngine(set, deploy.NewStore(st), nil)
	bus := events.New()
	r := NewPluginsRouter(set, st, nil, dep, cat, enabled, autoReapprove, DefaultLimits, bus)
	SetAuditor(r, audit.New(st)) // so r.Audit() reflects recorded plugin actions in tests
	ctx := rpc.NewContext(hosts.WithTarget(context.Background(), hosts.LocalID))
	return &fixture{r: r, dock: dock, st: st, dep: dep, cat: cat, set: set, bus: bus, plugin: plugin, ctx: ctx, pc: pc, key: testKey2}
}

// enable trusts the fixture's plugin and fails the test if it doesn't take.
func (f *fixture) enable(t *testing.T) {
	t.Helper()
	if _, err := f.r.Enable(f.ctx, &TargetParams{Key: f.key}); err != nil {
		t.Fatalf("Enable: %v", err)
	}
}

// rpcContext builds a request context targeting the local host (so ActiveFor /
// hostClient resolve to the mock docker client).
func rpcContext() *rpc.Context {
	return rpc.NewContext(hosts.WithTarget(context.Background(), hosts.LocalID))
}

// drainForKind reads from a bus subscription until every requested kind has been
// seen (returns true) or a short deadline elapses (false).
func drainForKind(sub <-chan events.Event, kinds ...events.Kind) bool {
	want := map[events.Kind]bool{}
	for _, k := range kinds {
		want[k] = true
	}
	deadline := time.After(2 * time.Second)
	for len(want) > 0 {
		select {
		case e := <-sub:
			delete(want, e.Kind)
		case <-deadline:
			return false
		}
	}
	return true
}

// wantCode asserts err is a *rpc.Error with the given Code (e.g. "BAD_REQUEST").
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want error with code %s, got nil", code)
	}
	var re *rpc.Error
	if !errors.As(err, &re) {
		t.Fatalf("want *rpc.Error(%s), got %T: %v", code, err, err)
	}
	if re.Code != code {
		t.Fatalf("error code = %s, want %s (%v)", re.Code, code, err)
	}
}
