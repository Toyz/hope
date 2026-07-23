package logstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/toyz/hope/internal/audit"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/deploy"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
)

// --- test doubles -----------------------------------------------------------

// mockDock is a docker.API test double. It embeds the interface (nil) so any
// method the test does not override panics on call — surfacing an unexpected
// daemon touch (e.g. a streaming method reached through the wrong code path).
type mockDock struct {
	docker.API

	existsFn  func(id string) bool
	projConts func(project, service string) ([]docker.ContainerRef, error)

	createContainer   func(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error)
	redeployContainer func(ctx context.Context, id string, pull, force bool, emit func(string)) error
	redeployProject   func(ctx context.Context, project string, pull, force bool, emit func(string)) error
	pullContainers    func(ctx context.Context, ids []string, emit func(string)) error
	pruneImagesStream func(ctx context.Context, all bool, emit func(string)) error
	recreateFromSpec  func(ctx context.Context, id string, spec stackspec.ContainerSpec, pull bool, emit func(string)) error
}

func (m *mockDock) Exists(_ context.Context, id string) bool {
	if m.existsFn != nil {
		return m.existsFn(id)
	}
	return true
}

func (m *mockDock) ProjectContainers(_ context.Context, project, service string) ([]docker.ContainerRef, error) {
	if m.projConts != nil {
		return m.projConts(project, service)
	}
	return nil, nil
}

func (m *mockDock) CreateContainer(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error) {
	return m.createContainer(ctx, name, spec, pull, emit)
}

func (m *mockDock) RedeployContainer(ctx context.Context, id string, pull, force bool, emit func(string)) error {
	return m.redeployContainer(ctx, id, pull, force, emit)
}

func (m *mockDock) RedeployProject(ctx context.Context, project string, pull, force bool, emit func(string)) error {
	return m.redeployProject(ctx, project, pull, force, emit)
}

func (m *mockDock) PullContainers(ctx context.Context, ids []string, emit func(string)) error {
	return m.pullContainers(ctx, ids, emit)
}

func (m *mockDock) PruneImagesStream(ctx context.Context, all bool, emit func(string)) error {
	return m.pruneImagesStream(ctx, all, emit)
}

func (m *mockDock) RecreateFromSpec(ctx context.Context, id string, spec stackspec.ContainerSpec, pull bool, emit func(string)) error {
	return m.recreateFromSpec(ctx, id, spec, pull, emit)
}

// pluginWith builds a Plugin over a docker.API double plus a token manager and
// (optional) deploy engine + bus.
func pluginWith(dock docker.API, tm *auth.TokenManager, eng *deploy.Engine, bus *events.Bus) *Plugin {
	return New(hosts.New(dock, true, nil), tm, eng, bus, nil)
}

func newTM(t *testing.T) *auth.TokenManager {
	t.Helper()
	return auth.NewTokenManager("test-secret", time.Hour, nil)
}

// post builds a valid, authenticated POST request for path with the given
// positional args and (optional) X-Hope-Host target.
func post(t *testing.T, tm *auth.TokenManager, path string, args []string, host string) *gateway.Request {
	t.Helper()
	tok, _ := tm.Issue("user")
	body, err := json.Marshal(map[string]any{"args": args})
	if err != nil {
		t.Fatalf("marshal args: %v", err)
	}
	return postRaw(tm, path, body, host, tok)
}

func postRaw(tm *auth.TokenManager, path string, body []byte, host, tok string) *gateway.Request {
	h := gateway.Header{}
	if tok != "" {
		h.Set("Authorization", "Bearer "+tok)
	}
	if host != "" {
		h.Set(hosts.TargetHeader, host)
	}
	return &gateway.Request{Method: http.MethodPost, Path: path, Header: h, Body: body}
}

// readStream drains a streaming response body to bytes.
func readStream(t *testing.T, resp *gateway.Response) []byte {
	t.Helper()
	if resp.Stream == nil {
		t.Fatalf("response has no stream (status %d, body %s)", resp.Status, resp.Body)
	}
	b, err := io.ReadAll(resp.Stream)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	return b
}

func decodeNDJSON[T any](t *testing.T, data []byte) []T {
	t.Helper()
	var out []T
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		var v T
		if err := dec.Decode(&v); err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("decode ndjson: %v (data=%q)", err, data)
		}
		out = append(out, v)
	}
	return out
}

// errBody parses an {"error":{"code","message"}} JSON body.
func errBody(t *testing.T, resp *gateway.Response) (code, msg string) {
	t.Helper()
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp.Body, &env); err != nil {
		t.Fatalf("parse error body %q: %v", resp.Body, err)
	}
	return env.Error.Code, env.Error.Message
}

// fakeDockerClient builds a real *docker.Client wired to an httptest server that
// speaks just enough of the Docker Engine API to exercise the SDK-hijack
// streaming paths (ContainerLogs / ContainerStats / ContainerInspect).
func fakeDockerClient(t *testing.T, route func(w http.ResponseWriter, r *http.Request)) docker.API {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Api-Version", "1.45")
		if strings.HasSuffix(r.URL.Path, "/_ping") {
			w.WriteHeader(http.StatusOK)
			return
		}
		route(w, r)
	}))
	t.Cleanup(srv.Close)
	c, err := docker.New(srv.URL, "")
	if err != nil {
		t.Fatalf("build docker client against fake daemon: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// stdFrames encodes lines as a docker multiplexed (stdcopy) stream on one stream
// type — the wire form ContainerLogs returns for a non-TTY container.
func stdFrames(streamType stdcopy.StdType, lines ...string) []byte {
	var buf bytes.Buffer
	w := stdcopy.NewStdWriter(&buf, streamType)
	for _, l := range lines {
		_, _ = w.Write([]byte(l))
	}
	return buf.Bytes()
}

// --- auth + method gating ---------------------------------------------------

func TestServeRoute_MethodNotAllowed(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil, nil)
	req := &gateway.Request{Method: http.MethodGet, Path: pathLogs, Header: gateway.Header{}}
	resp := p.ServeRoute(context.Background(), req)
	if resp.Status != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.Status)
	}
}

func TestServeRoute_Unauthorized(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil, nil)

	cases := []struct {
		name string
		auth string // Authorization header value
	}{
		{"missing header", ""},
		{"no bearer prefix", "token-only"},
		{"garbage token", "Bearer not.a.valid.token"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := gateway.Header{}
			if tc.auth != "" {
				h.Set("Authorization", tc.auth)
			}
			req := &gateway.Request{Method: http.MethodPost, Path: pathLogs, Header: h, Body: []byte(`{"args":["cid"]}`)}
			resp := p.ServeRoute(context.Background(), req)
			if resp.Status != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", resp.Status)
			}
		})
	}
}

func TestAuthenticate_ValidToken(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil, nil)
	tok, _ := tm.Issue("alice")
	req := postRaw(tm, pathLogs, nil, "", tok)
	sub, err := p.authenticate(req)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if sub != "alice" {
		t.Fatalf("subject = %q, want alice", sub)
	}
}

func TestServeRoute_UnknownStream(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil, nil)
	req := post(t, tm, "/rpc/Stream/nope", []string{"x"}, "")
	resp := p.ServeRoute(context.Background(), req)
	if resp.Status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.Status)
	}
	_, msg := errBody(t, resp)
	if msg != "unknown stream" {
		t.Fatalf("message = %q, want 'unknown stream'", msg)
	}
}

// --- host targeting for writes ---------------------------------------------

func TestServeRoute_WriteRequiresHost(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil, events.New())
	// A write path with NO X-Hope-Host must be rejected before arg parsing.
	req := post(t, tm, pathRedeploy, []string{"cid"}, "")
	resp := p.ServeRoute(context.Background(), req)
	if resp.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.Status)
	}
	if _, msg := errBody(t, resp); !strings.Contains(msg, "explicit host") {
		t.Fatalf("message = %q, want to mention explicit host", msg)
	}
}

// --- arg validation ---------------------------------------------------------

func TestServeRoute_BadArgsBody(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil, nil)
	tok, _ := tm.Issue("user")
	// pathLogs is a read path (no host required) so we reach stringArgs.
	req := postRaw(tm, pathLogs, []byte(`{"args":[123]}`), "", tok)
	resp := p.ServeRoute(context.Background(), req)
	if resp.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.Status)
	}
}

func TestServeRoute_ArgValidation(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil, nil)

	cases := []struct {
		name    string
		path    string
		args    []string
		wantMsg string
	}{
		{"logs no id", pathLogs, nil, "container id required"},
		{"stats no id", pathStats, nil, "container id required"},
		{"stackLogs no project", pathStackLogs, nil, "project required"},
		{"serviceLogs no project", pathServiceLogs, nil, "project required"},
		{"serviceLogs no service", pathServiceLogs, []string{"proj"}, "service required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := post(t, tm, tc.path, tc.args, "")
			resp := p.ServeRoute(context.Background(), req)
			if resp.Status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", resp.Status)
			}
			if _, msg := errBody(t, resp); msg != tc.wantMsg {
				t.Fatalf("message = %q, want %q", msg, tc.wantMsg)
			}
		})
	}
}

func TestServeRoute_LogsContainerNotFound(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{existsFn: func(string) bool { return false }}, tm, nil, nil)
	for _, path := range []string{pathLogs, pathStats} {
		req := post(t, tm, path, []string{"missing"}, "")
		resp := p.ServeRoute(context.Background(), req)
		if resp.Status != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", path, resp.Status)
		}
		if _, msg := errBody(t, resp); msg != "container not found" {
			t.Fatalf("%s message = %q", path, msg)
		}
	}
}

func TestServeRoute_StackLogsNoContainers(t *testing.T) {
	tm := newTM(t)
	// empty result and error both map to 404.
	empty := &mockDock{projConts: func(string, string) ([]docker.ContainerRef, error) { return nil, nil }}
	failed := &mockDock{projConts: func(string, string) ([]docker.ContainerRef, error) { return nil, errors.New("boom") }}

	for name, dock := range map[string]docker.API{"empty": empty, "error": failed} {
		t.Run(name, func(t *testing.T) {
			p := pluginWith(dock, tm, nil, nil)
			req := post(t, tm, pathStackLogs, []string{"proj"}, "")
			resp := p.ServeRoute(context.Background(), req)
			if resp.Status != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", resp.Status)
			}
		})
	}
}

func TestServeRoute_ServiceLogsPassesService(t *testing.T) {
	tm := newTM(t)
	var gotProject, gotService string
	dock := &mockDock{projConts: func(project, service string) ([]docker.ContainerRef, error) {
		gotProject, gotService = project, service
		return nil, nil // 404, but we only assert the args were threaded
	}}
	p := pluginWith(dock, tm, nil, nil)
	req := post(t, tm, pathServiceLogs, []string{"proj", "web"}, "")
	_ = p.ServeRoute(context.Background(), req)
	if gotProject != "proj" || gotService != "web" {
		t.Fatalf("ProjectContainers(%q,%q), want (proj,web)", gotProject, gotService)
	}
}

// --- op streams (redeploy / pull / prune / edit) ----------------------------

func TestServeRoute_RedeploySuccess(t *testing.T) {
	tm := newTM(t)
	bus := events.New()
	ch, cancel := bus.Subscribe(0)
	defer cancel()

	var gotID string
	var gotPull, gotForce bool
	dock := &mockDock{
		redeployContainer: func(_ context.Context, id string, pull, force bool, emit func(string)) error {
			gotID, gotPull, gotForce = id, pull, force
			emit("pulling image")
			emit("recreating")
			return nil
		},
	}
	p := pluginWith(dock, tm, nil, bus)
	req := post(t, tm, pathRedeploy, []string{"cid"}, hosts.LocalID)
	resp := p.ServeRoute(context.Background(), req)

	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/x-ndjson" {
		t.Fatalf("content-type = %q", ct)
	}
	frames := decodeNDJSON[opFrame](t, readStream(t, resp))
	if len(frames) != 3 {
		t.Fatalf("frames = %d (%+v), want 3", len(frames), frames)
	}
	if frames[0].Type != "log" || frames[0].Data != "pulling image" {
		t.Fatalf("frame[0] = %+v", frames[0])
	}
	if frames[1].Type != "log" || frames[1].Data != "recreating" {
		t.Fatalf("frame[1] = %+v", frames[1])
	}
	if frames[2].Type != "done" || !frames[2].OK || frames[2].Error != "" {
		t.Fatalf("done frame = %+v, want ok:true", frames[2])
	}
	if gotID != "cid" || !gotPull || gotForce {
		t.Fatalf("op args: id=%q pull=%v force=%v; want cid,true,false", gotID, gotPull, gotForce)
	}

	select {
	case e := <-ch:
		if e.Kind != events.KindStackRedeployed || e.Host != hosts.LocalID || len(e.IDs) != 1 || e.IDs[0] != "cid" {
			t.Fatalf("event = %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no redeploy event published")
	}
}

func TestServeRoute_RedeployPullForceArgs(t *testing.T) {
	tm := newTM(t)
	cases := []struct {
		args      []string
		wantPull  bool
		wantForce bool
	}{
		{[]string{"c"}, true, false},
		{[]string{"c", "false"}, false, false},
		{[]string{"c", "true"}, true, false},
		{[]string{"c", "true", "true"}, true, true},
		{[]string{"c", "false", "true"}, false, true},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, "_"), func(t *testing.T) {
			var pull, force bool
			dock := &mockDock{redeployContainer: func(_ context.Context, _ string, pl, fr bool, _ func(string)) error {
				pull, force = pl, fr
				return nil
			}}
			p := pluginWith(dock, tm, nil, events.New())
			resp := p.ServeRoute(context.Background(), post(t, tm, pathRedeploy, tc.args, hosts.LocalID))
			_ = readStream(t, resp)
			if pull != tc.wantPull || force != tc.wantForce {
				t.Fatalf("args %v -> pull=%v force=%v; want pull=%v force=%v", tc.args, pull, force, tc.wantPull, tc.wantForce)
			}
		})
	}
}

func TestServeRoute_RedeployFailureNoEvent(t *testing.T) {
	tm := newTM(t)
	bus := events.New()
	ch, cancel := bus.Subscribe(0)
	defer cancel()

	dock := &mockDock{redeployContainer: func(_ context.Context, _ string, _, _ bool, emit func(string)) error {
		emit("trying")
		return errors.New("daemon exploded")
	}}
	p := pluginWith(dock, tm, nil, bus)
	resp := p.ServeRoute(context.Background(), post(t, tm, pathRedeploy, []string{"cid"}, hosts.LocalID))
	frames := decodeNDJSON[opFrame](t, readStream(t, resp))
	last := frames[len(frames)-1]
	if last.Type != "done" || last.OK || last.Error != "daemon exploded" {
		t.Fatalf("done frame = %+v, want ok:false error set", last)
	}
	select {
	case e := <-ch:
		t.Fatalf("unexpected event on failure: %+v", e)
	case <-time.After(50 * time.Millisecond):
	}
}

// A cancelled request context must NOT cancel the detached op: streamOp runs the
// op under context.WithoutCancel so a client disconnect never aborts an in-flight
// redeploy/edit.
func TestServeRoute_OpDetachedFromRequestContext(t *testing.T) {
	tm := newTM(t)
	var opErr error
	dock := &mockDock{redeployContainer: func(ctx context.Context, _ string, _, _ bool, _ func(string)) error {
		opErr = ctx.Err()
		return nil
	}}
	p := pluginWith(dock, tm, nil, events.New())
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // client already gone
	resp := p.ServeRoute(ctx, post(t, tm, pathRedeploy, []string{"cid"}, hosts.LocalID))
	_ = readStream(t, resp)
	if opErr != nil {
		t.Fatalf("op ran with cancelled ctx err=%v; want detached (nil)", opErr)
	}
}

func TestServeRoute_RedeployStack(t *testing.T) {
	tm := newTM(t)
	bus := events.New()
	ch, cancel := bus.Subscribe(0)
	defer cancel()

	var gotProject string
	dock := &mockDock{redeployProject: func(_ context.Context, project string, _, _ bool, emit func(string)) error {
		gotProject = project
		emit("stack up")
		return nil
	}}
	p := pluginWith(dock, tm, nil, bus)
	resp := p.ServeRoute(context.Background(), post(t, tm, pathRedeployStack, []string{"myproj"}, hosts.LocalID))
	frames := decodeNDJSON[opFrame](t, readStream(t, resp))
	if frames[len(frames)-1].Type != "done" || !frames[len(frames)-1].OK {
		t.Fatalf("frames = %+v", frames)
	}
	if gotProject != "myproj" {
		t.Fatalf("project = %q", gotProject)
	}
	select {
	case e := <-ch:
		if e.Kind != events.KindStackRedeployed || e.Project != "myproj" {
			t.Fatalf("event = %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
}

func TestServeRoute_Pull(t *testing.T) {
	tm := newTM(t)
	bus := events.New()
	ch, cancel := bus.Subscribe(0)
	defer cancel()

	var gotIDs []string
	dock := &mockDock{pullContainers: func(_ context.Context, ids []string, emit func(string)) error {
		gotIDs = ids
		emit("pulling")
		return nil
	}}
	p := pluginWith(dock, tm, nil, bus)
	resp := p.ServeRoute(context.Background(), post(t, tm, pathPull, []string{"a", "b"}, hosts.LocalID))
	frames := decodeNDJSON[opFrame](t, readStream(t, resp))
	if !frames[len(frames)-1].OK {
		t.Fatalf("frames = %+v", frames)
	}
	if len(gotIDs) != 2 || gotIDs[0] != "a" || gotIDs[1] != "b" {
		t.Fatalf("ids = %v, want [a b]", gotIDs)
	}
	select {
	case e := <-ch:
		if e.Kind != events.KindImageCurrent || len(e.IDs) != 2 {
			t.Fatalf("event = %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
}

func TestServeRoute_PruneImages(t *testing.T) {
	tm := newTM(t)
	cases := []struct {
		args    []string
		wantAll bool
	}{
		{nil, false},
		{[]string{"true"}, true},
		{[]string{"false"}, false},
	}
	for _, tc := range cases {
		var gotAll bool
		dock := &mockDock{pruneImagesStream: func(_ context.Context, all bool, emit func(string)) error {
			gotAll = all
			emit("pruned")
			return nil
		}}
		p := pluginWith(dock, tm, nil, events.New())
		resp := p.ServeRoute(context.Background(), post(t, tm, pathPruneImages, tc.args, hosts.LocalID))
		frames := decodeNDJSON[opFrame](t, readStream(t, resp))
		if !frames[len(frames)-1].OK {
			t.Fatalf("args %v frames %+v", tc.args, frames)
		}
		if gotAll != tc.wantAll {
			t.Fatalf("args %v -> all=%v, want %v", tc.args, gotAll, tc.wantAll)
		}
	}
}

func TestServeRoute_EditContainer(t *testing.T) {
	tm := newTM(t)

	t.Run("needs id and spec", func(t *testing.T) {
		p := pluginWith(&mockDock{}, tm, nil, nil)
		resp := p.ServeRoute(context.Background(), post(t, tm, pathEditContainer, []string{"onlyid"}, hosts.LocalID))
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.Status)
		}
	})

	t.Run("not found", func(t *testing.T) {
		dock := &mockDock{existsFn: func(string) bool { return false }}
		p := pluginWith(dock, tm, nil, nil)
		resp := p.ServeRoute(context.Background(), post(t, tm, pathEditContainer, []string{"cid", `{}`}, hosts.LocalID))
		if resp.Status != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", resp.Status)
		}
	})

	t.Run("bad spec", func(t *testing.T) {
		p := pluginWith(&mockDock{}, tm, nil, nil)
		resp := p.ServeRoute(context.Background(), post(t, tm, pathEditContainer, []string{"cid", "not-json"}, hosts.LocalID))
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.Status)
		}
		if _, msg := errBody(t, resp); !strings.Contains(msg, "bad container spec") {
			t.Fatalf("message = %q", msg)
		}
	})

	t.Run("success recreates from spec", func(t *testing.T) {
		var gotID string
		var gotPull bool
		dock := &mockDock{recreateFromSpec: func(_ context.Context, id string, _ stackspec.ContainerSpec, pull bool, emit func(string)) error {
			gotID, gotPull = id, pull
			emit("recreating")
			return nil
		}}
		p := pluginWith(dock, tm, nil, nil)
		resp := p.ServeRoute(context.Background(), post(t, tm, pathEditContainer, []string{"cid", `{"image":"nginx"}`}, hosts.LocalID))
		frames := decodeNDJSON[opFrame](t, readStream(t, resp))
		if !frames[len(frames)-1].OK {
			t.Fatalf("frames = %+v", frames)
		}
		if gotID != "cid" || !gotPull {
			t.Fatalf("recreate id=%q pull=%v, want cid,true", gotID, gotPull)
		}
	})
}

// --- deploy-engine paths (validation only; the engine itself is tested in its
// own package) --------------------------------------------------------------

func TestServeRoute_DeployPathsUnavailableWhenNilEngine(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{}, tm, nil /* no engine */, nil)
	for _, path := range []string{pathApplyStack, pathDeployCont, pathDestroyStack} {
		req := post(t, tm, path, []string{"x"}, hosts.LocalID)
		resp := p.ServeRoute(context.Background(), req)
		if resp.Status != http.StatusServiceUnavailable {
			t.Fatalf("%s status = %d, want 503", path, resp.Status)
		}
	}
}

func TestServeRoute_DeployPathsValidation(t *testing.T) {
	tm := newTM(t)
	// A non-nil engine gets past the availability check; we still only exercise
	// the pre-stream validation branches (empty args / bad JSON), which return
	// before any docker/engine call.
	eng := deploy.NewEngine(hosts.New(&mockDock{}, true, nil), nil, nil)
	p := pluginWith(&mockDock{}, tm, eng, nil)

	cases := []struct {
		name    string
		path    string
		args    []string
		wantMsg string
	}{
		{"applyStack empty", pathApplyStack, nil, "stack spec required"},
		{"applyStack bad json", pathApplyStack, []string{"not-json"}, "bad stack spec: "},
		{"deployContainer empty", pathDeployCont, nil, "container spec required"},
		{"deployContainer bad json", pathDeployCont, []string{"not-json"}, "bad container spec: "},
		{"destroyStack empty", pathDestroyStack, nil, "project required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := p.ServeRoute(context.Background(), post(t, tm, tc.path, tc.args, hosts.LocalID))
			if resp.Status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", resp.Status)
			}
			if _, msg := errBody(t, resp); !strings.HasPrefix(msg, tc.wantMsg) {
				t.Fatalf("message = %q, want prefix %q", msg, tc.wantMsg)
			}
		})
	}
}

// deployContainer streams through the deploy engine; drive its success path with
// a minimal engine (just CreateContainer wired) to cover the op wrapper. The
// engine's full behavior is covered in the deploy package's own tests.
func TestServeRoute_DeployContainerSuccess(t *testing.T) {
	tm := newTM(t)
	bus := events.New()
	ch, cancel := bus.Subscribe(0)
	defer cancel()

	var gotImage string
	engineDock := &mockDock{createContainer: func(_ context.Context, _ string, spec stackspec.ContainerSpec, _ bool, emit func(string)) (string, error) {
		gotImage = spec.Image
		emit("creating")
		return "newid", nil
	}}
	eng := deploy.NewEngine(hosts.New(engineDock, true, nil), nil, bus)
	p := New(hosts.New(&mockDock{}, true, nil), tm, eng, bus, nil)

	resp := p.ServeRoute(context.Background(), post(t, tm, pathDeployCont, []string{`{"image":"nginx"}`}, hosts.LocalID))
	frames := decodeNDJSON[opFrame](t, readStream(t, resp))
	if !frames[len(frames)-1].OK {
		t.Fatalf("frames = %+v", frames)
	}
	if gotImage != "nginx" {
		t.Fatalf("image = %q, want nginx", gotImage)
	}
	select {
	case e := <-ch:
		if e.Kind != events.KindStackDeployed {
			t.Fatalf("event = %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no deploy event")
	}
}

// --- SDK-hijack streaming reads (via a fake Docker daemon) ------------------

func TestStreamLogs(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/logs"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(stdFrames(stdcopy.Stdout, "hello\n"))
			_, _ = w.Write(stdFrames(stdcopy.Stderr, "oops\n"))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		}
	})
	p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
	resp := p.streamLogs(context.Background(), "cid")
	frames := decodeNDJSON[logFrame](t, readStream(t, resp))
	if len(frames) != 2 {
		t.Fatalf("frames = %d (%+v), want 2", len(frames), frames)
	}
	if frames[0].Type != "stdout" || frames[0].Data != "hello\n" {
		t.Fatalf("frame[0] = %+v", frames[0])
	}
	if frames[1].Type != "stderr" || frames[1].Data != "oops\n" {
		t.Fatalf("frame[1] = %+v", frames[1])
	}
}

func TestStreamLogs_OpenError(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
	resp := p.streamLogs(context.Background(), "cid")
	if resp.Status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.Status)
	}
}

func TestStreamStats(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/stats") {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"cpu":1}` + "\n" + `{"cpu":2}` + "\n"))
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
	resp := p.streamStats(context.Background(), "cid")
	frames := decodeNDJSON[map[string]any](t, readStream(t, resp))
	if len(frames) != 2 {
		t.Fatalf("frames = %d (%+v), want 2", len(frames), frames)
	}
	if frames[0]["cpu"].(float64) != 1 || frames[1]["cpu"].(float64) != 2 {
		t.Fatalf("frames = %+v", frames)
	}
}

func TestStreamStats_OpenError(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
	resp := p.streamStats(context.Background(), "cid")
	if resp.Status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.Status)
	}
}

// streamMulti fans in two containers' backlog in true timestamp order and tags
// each line with its source. The later-timestamped container's line must sort
// after the earlier one even though it was fetched first.
func TestStreamMulti_BacklogMergedAndTagged(t *testing.T) {
	early := "2021-01-01T00:00:00.000000000Z from-web\n"
	late := "2021-06-01T00:00:00.000000000Z from-db\n"
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/logs") {
			w.WriteHeader(http.StatusOK)
			return
		}
		follow := r.URL.Query().Get("follow") == "1"
		w.WriteHeader(http.StatusOK)
		if follow {
			return // no live output; backlog only
		}
		// Non-follow backlog fetch: emit this container's single line.
		if strings.Contains(r.URL.Path, "/db/") {
			_, _ = w.Write(stdFrames(stdcopy.Stdout, late))
		} else {
			_, _ = w.Write(stdFrames(stdcopy.Stdout, early))
		}
	})
	p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
	refs := []docker.ContainerRef{
		{ID: "web", Name: "web"},
		{ID: "db", Name: "db"},
	}
	resp := p.streamMulti(context.Background(), refs)
	frames := decodeNDJSON[logFrame](t, readStream(t, resp))
	if len(frames) != 2 {
		t.Fatalf("frames = %d (%+v), want 2", len(frames), frames)
	}
	// Sorted chronologically: web (Jan) before db (Jun), each tagged by source.
	if frames[0].Source != "web" || !strings.Contains(frames[0].Data, "from-web") {
		t.Fatalf("frame[0] = %+v, want web first", frames[0])
	}
	if frames[1].Source != "db" || !strings.Contains(frames[1].Data, "from-db") {
		t.Fatalf("frame[1] = %+v, want db second", frames[1])
	}
}

// A full ServeRoute pass for a read stream: X-Hope-Host target is honored, the
// container-exists gate passes, and the logs stream is returned.
func TestServeRoute_LogsHappyPath(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/logs"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(stdFrames(stdcopy.Stdout, "line\n"))
		default: // ContainerInspect for Exists
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"Id":"cid"}`))
		}
	})
	tm := newTM(t)
	p := New(hosts.New(dock, true, nil), tm, nil, nil, nil)
	resp := p.ServeRoute(context.Background(), post(t, tm, pathLogs, []string{"cid"}, hosts.LocalID))
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	frames := decodeNDJSON[logFrame](t, readStream(t, resp))
	if len(frames) != 1 || frames[0].Type != "stdout" {
		t.Fatalf("frames = %+v", frames)
	}
}

func TestServeRoute_StatsHappyPath(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/stats"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"cpu":1}` + "\n"))
		default: // ContainerInspect for Exists
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"Id":"cid"}`))
		}
	})
	tm := newTM(t)
	p := New(hosts.New(dock, true, nil), tm, nil, nil, nil)
	resp := p.ServeRoute(context.Background(), post(t, tm, pathStats, []string{"cid"}, hosts.LocalID))
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	frames := decodeNDJSON[map[string]any](t, readStream(t, resp))
	if len(frames) != 1 || frames[0]["cpu"].(float64) != 1 {
		t.Fatalf("frames = %+v", frames)
	}
}

// The mutation paths validate args after the host-target gate; these branches
// return before any streamOp is started.
func TestServeRoute_WriteArgValidation(t *testing.T) {
	tm := newTM(t)
	p := pluginWith(&mockDock{existsFn: func(string) bool { return false }}, tm, nil, nil)
	cases := []struct {
		name   string
		path   string
		args   []string
		status int
		msg    string
	}{
		{"redeploy no id", pathRedeploy, nil, http.StatusBadRequest, "container id required"},
		{"redeploy not found", pathRedeploy, []string{"missing"}, http.StatusNotFound, "container not found"},
		{"redeployStack no project", pathRedeployStack, nil, http.StatusBadRequest, "project required"},
		{"pull no id", pathPull, nil, http.StatusBadRequest, "container id required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := p.ServeRoute(context.Background(), post(t, tm, tc.path, tc.args, hosts.LocalID))
			if resp.Status != tc.status {
				t.Fatalf("status = %d, want %d", resp.Status, tc.status)
			}
			if _, msg := errBody(t, resp); msg != tc.msg {
				t.Fatalf("message = %q, want %q", msg, tc.msg)
			}
		})
	}
}

// A follow-open failure for one container is swallowed: its goroutine returns and
// the backlog it already produced is still delivered.
func TestStreamMulti_FollowError(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/logs") {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.URL.Query().Get("follow") == "1" {
			w.WriteHeader(http.StatusInternalServerError) // live follow open fails
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(stdFrames(stdcopy.Stdout, "2021-01-01T00:00:00.000000000Z hi\n"))
	})
	p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
	resp := p.streamMulti(context.Background(), []docker.ContainerRef{{ID: "c", Name: "c"}})
	frames := decodeNDJSON[logFrame](t, readStream(t, resp))
	if len(frames) != 1 || frames[0].Source != "c" {
		t.Fatalf("frames = %+v, want 1 backlog frame", frames)
	}
}

// backlogLines silently yields nothing when the tail fetch fails to open or when
// the returned stream isn't a valid multiplexed frame.
func TestStreamMulti_BacklogErrors(t *testing.T) {
	cases := map[string]func(w http.ResponseWriter){
		"open error": func(w http.ResponseWriter) { w.WriteHeader(http.StatusInternalServerError) },
		"stdcopy error": func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusOK)
			// A full 8-byte frame header whose stream-type byte (9) is not one of
			// stdin/stdout/stderr/systemerr: StdCopy rejects it with an error.
			_, _ = w.Write([]byte{9, 0, 0, 0, 0, 0, 0, 0})
		},
	}
	for name, backlog := range cases {
		t.Run(name, func(t *testing.T) {
			dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasSuffix(r.URL.Path, "/logs") {
					w.WriteHeader(http.StatusOK)
					return
				}
				if r.URL.Query().Get("follow") == "1" {
					w.WriteHeader(http.StatusOK) // live follow: no output, clean close
					return
				}
				backlog(w)
			})
			p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
			resp := p.streamMulti(context.Background(), []docker.ContainerRef{{ID: "c", Name: "c"}})
			frames := decodeNDJSON[logFrame](t, readStream(t, resp))
			if len(frames) != 0 {
				t.Fatalf("frames = %+v, want none", frames)
			}
		})
	}
}

// A malformed object mid-stream aborts streamStats: the first valid frame is sent,
// then the decode error truncates the stream (surfaced to the reader).
func TestStreamStats_DecodeError(t *testing.T) {
	dock := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/stats") {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"cpu":1}` + "\n" + `!!!not-json`))
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	p := New(hosts.New(dock, true, nil), newTM(t), nil, nil, nil)
	resp := p.streamStats(context.Background(), "cid")
	if _, err := io.ReadAll(resp.Stream); err == nil {
		t.Fatal("expected read error from malformed stats stream")
	}
}

// --- pure helpers -----------------------------------------------------------

func TestChanFramer(t *testing.T) {
	ch := make(chan logFrame, 1)
	f := &chanFramer{ch: ch, ctx: context.Background(), source: "web", kind: "stdout"}
	n, err := f.Write([]byte("payload"))
	if err != nil || n != len("payload") {
		t.Fatalf("Write = %d,%v", n, err)
	}
	got := <-ch
	if got.Type != "stdout" || got.Source != "web" || got.Data != "payload" {
		t.Fatalf("frame = %+v", got)
	}

	// A cancelled context makes a blocked send give up with ErrClosedPipe.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	blocked := &chanFramer{ch: make(chan logFrame), ctx: ctx, kind: "stderr"}
	if _, err := blocked.Write([]byte("x")); err != io.ErrClosedPipe {
		t.Fatalf("cancelled Write err = %v, want ErrClosedPipe", err)
	}
}

func TestFramer(t *testing.T) {
	var buf bytes.Buffer
	var mu sync.Mutex
	f := framer{enc: json.NewEncoder(&buf), kind: "stdout", mu: &mu}
	n, err := f.Write([]byte("hi\n"))
	if err != nil || n != 3 {
		t.Fatalf("Write = %d,%v", n, err)
	}
	var got logFrame
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != "stdout" || got.Data != "hi\n" {
		t.Fatalf("frame = %+v", got)
	}
}

// failWriter always errors, used to drive the encoder-failure branch.
type failWriter struct{}

func (failWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

func TestFramer_EncodeError(t *testing.T) {
	var mu sync.Mutex
	f := framer{enc: json.NewEncoder(failWriter{}), kind: "stdout", mu: &mu}
	if _, err := f.Write([]byte("x")); err == nil {
		t.Fatal("expected error from failing encoder")
	}
}

func TestParseLogTS(t *testing.T) {
	ts := "2021-03-04T05:06:07.123456789Z"
	cases := []struct {
		name string
		line string
		zero bool
	}{
		{"timestamped line", ts + " hello world", false},
		{"bare timestamp no space", ts, false},
		{"unparseable prefix", "notatimestamp hello", true},
		{"empty", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseLogTS(tc.line)
			if got.IsZero() != tc.zero {
				t.Fatalf("parseLogTS(%q) zero=%v, want %v", tc.line, got.IsZero(), tc.zero)
			}
			if !tc.zero {
				want, _ := time.Parse(time.RFC3339Nano, ts)
				if !got.Equal(want) {
					t.Fatalf("parseLogTS(%q) = %v, want %v", tc.line, got, want)
				}
			}
		})
	}
}

func TestStringArgs(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		got, err := stringArgs([]byte(`{"args":["a","b"]}`))
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if len(got) != 2 || got[0] != "a" || got[1] != "b" {
			t.Fatalf("args = %v", got)
		}
	})
	t.Run("empty args ok", func(t *testing.T) {
		got, err := stringArgs([]byte(`{"args":[]}`))
		if err != nil || len(got) != 0 {
			t.Fatalf("args=%v err=%v", got, err)
		}
	})
	for _, bad := range []string{`not json`, `{"args":[123]}`, `{"args":[""]}`, `{"args":[null]}`} {
		t.Run("bad_"+bad, func(t *testing.T) {
			if _, err := stringArgs([]byte(bad)); err == nil {
				t.Fatalf("stringArgs(%q) = nil err, want error", bad)
			}
		})
	}
}

func TestErrResp(t *testing.T) {
	resp := errResp(http.StatusNotFound, "gone")
	if resp.Status != http.StatusNotFound {
		t.Fatalf("status = %d", resp.Status)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
	var env struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(resp.Body, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error.Code != "NOT_FOUND" || env.Error.Message != "gone" {
		t.Fatalf("error = %+v, want NOT_FOUND/gone", env.Error)
	}
}

func TestNdjsonResponse(t *testing.T) {
	resp := ndjsonResponse(strings.NewReader("x"))
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d", resp.Status)
	}
	if resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("content-type = %q", resp.Header.Get("Content-Type"))
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("cache-control = %q", resp.Header.Get("Cache-Control"))
	}
	if resp.Stream == nil {
		t.Fatal("stream nil")
	}
}

// streamOp finishes with a done{ok:false,error} frame when the op returns an
// error, exercised here directly with a synthetic run func.
func TestStreamOp_Direct(t *testing.T) {
	p := New(hosts.New(&mockDock{}, true, nil), newTM(t), nil, nil, nil)

	t.Run("success", func(t *testing.T) {
		resp := p.streamOp(context.Background(), audit.Entry{}, func(_ context.Context, emit func(string)) error {
			emit("one")
			emit("two")
			return nil
		})
		frames := decodeNDJSON[opFrame](t, readStream(t, resp))
		if len(frames) != 3 || frames[2].Type != "done" || !frames[2].OK {
			t.Fatalf("frames = %+v", frames)
		}
	})

	t.Run("error", func(t *testing.T) {
		resp := p.streamOp(context.Background(), audit.Entry{}, func(_ context.Context, _ func(string)) error {
			return errors.New("nope")
		})
		frames := decodeNDJSON[opFrame](t, readStream(t, resp))
		last := frames[len(frames)-1]
		if last.Type != "done" || last.OK || last.Error != "nope" {
			t.Fatalf("done = %+v", last)
		}
	})
}

func TestOpFrameJSONShape(t *testing.T) {
	// log frame: no ok/error keys, data present.
	b, _ := json.Marshal(opFrame{Type: "log", Data: "hi"})
	if s := string(b); !strings.Contains(s, `"type":"log"`) || !strings.Contains(s, `"data":"hi"`) {
		t.Fatalf("log frame = %s", s)
	}
	// ping frame: ok defaults false and is always present, no data/error.
	b, _ = json.Marshal(opFrame{Type: "ping"})
	if s := string(b); strings.Contains(s, "data") || strings.Contains(s, "error") {
		t.Fatalf("ping frame should omit data/error: %s", s)
	}
	// done ok frame carries ok:true.
	b, _ = json.Marshal(opFrame{Type: "done", OK: true})
	if s := string(b); !strings.Contains(s, `"ok":true`) {
		t.Fatalf("done frame = %s", s)
	}
}

func TestLogFrameJSONShape(t *testing.T) {
	// source is omitempty; a single-container frame has no source key.
	b, _ := json.Marshal(logFrame{Type: "stdout", Data: "x"})
	if strings.Contains(string(b), "source") {
		t.Fatalf("single frame should omit source: %s", b)
	}
	b, _ = json.Marshal(logFrame{Type: "stdout", Data: "x", Source: "web"})
	if !strings.Contains(string(b), `"source":"web"`) {
		t.Fatalf("multiplexed frame missing source: %s", b)
	}
}

func TestConstantsAndMetadata(t *testing.T) {
	if keepAlive != 15*time.Second {
		t.Fatalf("keepAlive = %v, want 15s", keepAlive)
	}
	if opTimeout != 30*time.Minute {
		t.Fatalf("opTimeout = %v, want 30m", opTimeout)
	}
	if multiTail != "60" {
		t.Fatalf("multiTail = %q, want 60", multiTail)
	}

	p := New(nil, nil, nil, nil, nil)
	if p.PluginName() != "logstream" {
		t.Fatalf("PluginName = %q", p.PluginName())
	}
	if p.Doc() == "" {
		t.Fatal("Doc empty")
	}
	patterns := p.RoutePatterns()
	if len(patterns) != 12 {
		t.Fatalf("RoutePatterns len = %d, want 12", len(patterns))
	}
	// every declared write path must be present in the route patterns.
	set := map[string]bool{}
	for _, pat := range patterns {
		set[pat] = true
	}
	for w := range streamWrites {
		if !set[w] {
			t.Fatalf("write path %q not in RoutePatterns", w)
		}
	}
}
