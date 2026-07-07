package plugin

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// call posts a JSON-RPC request and decodes the unary response.
func call(t *testing.T, srv *httptest.Server, token, method string, params any) rpcResponse {
	t.Helper()
	body, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: method, Params: mustRaw(params)})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/__hope", strings.NewReader(string(body)))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	var out rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func mustRaw(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, _ := json.Marshal(v)
	return b
}

func newTestPlugin() *Plugin {
	p := New("test", "0.1.0").Token("secret").Description("fixture")
	p.View("counts", "Counts", KV, func(ctx context.Context) (any, error) {
		return map[string]any{"a": 1}, nil
	})
	p.View("run", "Run Query", Query, func(ctx context.Context) (any, error) {
		return map[string]any{"echo": Input(ctx)}, nil
	})
	p.Action("noop", "No-op", nil, func(ctx context.Context, in map[string]any) (any, error) {
		return in["x"], nil
	})
	p.Stream("ticks", "Ticks", Counter, func(ctx context.Context, emit EmitFunc) error {
		for i := range 3 {
			emit(map[string]any{"n": i})
		}
		return nil
	})
	return p
}

func TestSchemaUnauthenticated(t *testing.T) {
	srv := httptest.NewServer(newTestPlugin().Handler())
	defer srv.Close()

	got := call(t, srv, "", "hope.schema", nil) // no token
	if got.Error != nil {
		t.Fatalf("hope.schema should be unauthenticated, got error %+v", got.Error)
	}
	var s Schema
	if err := json.Unmarshal(mustRaw(got.Result), &s); err != nil {
		t.Fatal(err)
	}
	if s.Name != "test" || s.ProtocolVersion != ProtocolVersion {
		t.Fatalf("bad schema: %+v", s)
	}
	if len(s.Views) != 2 || len(s.Actions) != 1 || len(s.Streams) != 1 {
		t.Fatalf("capability counts off: %+v", s)
	}
}

func TestLayoutRequiresAuth(t *testing.T) {
	srv := httptest.NewServer(newTestPlugin().Handler())
	defer srv.Close()

	if got := call(t, srv, "", "hope.layout", nil); got.Error == nil || got.Error.Code != codeUnauthorized {
		t.Fatalf("hope.layout without token should be unauthorized, got %+v", got)
	}
	got := call(t, srv, "secret", "hope.layout", nil)
	if got.Error != nil {
		t.Fatalf("hope.layout with token errored: %+v", got.Error)
	}
	var l Layout
	if err := json.Unmarshal(mustRaw(got.Result), &l); err != nil {
		t.Fatal(err)
	}
	if len(l.Contributions) != 1 || l.Contributions[0].Surface != SurfaceContainer {
		t.Fatalf("auto-layout wrong: %+v", l)
	}
}

func TestViewActionAuth(t *testing.T) {
	srv := httptest.NewServer(newTestPlugin().Handler())
	defer srv.Close()

	if got := call(t, srv, "wrong", "counts", nil); got.Error == nil || got.Error.Code != codeUnauthorized {
		t.Fatalf("wrong token should be unauthorized, got %+v", got)
	}
	// Query view echoes its input param.
	got := call(t, srv, "secret", "run", map[string]any{"input": "SELECT 1"})
	m, _ := got.Result.(map[string]any)
	if got.Error != nil || m["echo"] != "SELECT 1" {
		t.Fatalf("query input not echoed: %+v", got)
	}
	// Action receives its params.
	got = call(t, srv, "secret", "noop", map[string]any{"x": "hi"})
	if got.Error != nil || got.Result != "hi" {
		t.Fatalf("action params not received: %+v", got)
	}
	// Unknown method.
	if got := call(t, srv, "secret", "nope", nil); got.Error == nil || got.Error.Code != codeMethodNotFn {
		t.Fatalf("unknown method should be method-not-found, got %+v", got)
	}
}

func TestStreamNDJSON(t *testing.T) {
	srv := httptest.NewServer(newTestPlugin().Handler())
	defer srv.Close()

	body, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "ticks"})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/__hope", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "application/x-ndjson" {
		t.Fatalf("stream content-type = %q", ct)
	}
	sc := bufio.NewScanner(resp.Body)
	var frames int
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == "" {
			continue
		}
		frames++
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan stream: %v", err)
	}
	if frames != 3 {
		t.Fatalf("expected 3 stream frames, got %d", frames)
	}
}

func TestTOFUPinsFirstToken(t *testing.T) {
	// No configured token => trust-on-first-use.
	p := New("tofu", "0.1.0")
	p.View("counts", "Counts", KV, func(ctx context.Context) (any, error) { return 1, nil })
	srv := httptest.NewServer(p.Handler())
	defer srv.Close()

	if got := call(t, srv, "", "counts", nil); got.Error == nil {
		t.Fatal("empty bearer must be rejected even in TOFU")
	}
	if got := call(t, srv, "first", "counts", nil); got.Error != nil {
		t.Fatalf("first bearer should pin+pass: %+v", got.Error)
	}
	if got := call(t, srv, "second", "counts", nil); got.Error == nil {
		t.Fatal("a different bearer after pin must be rejected")
	}
	if got := call(t, srv, "first", "counts", nil); got.Error != nil {
		t.Fatalf("pinned bearer should keep passing: %+v", got.Error)
	}
}

func TestReservedNamespacePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registering a hope.* method should panic")
		}
	}()
	New("x", "1").View("hope.schema", "bad", KV, func(ctx context.Context) (any, error) { return nil, nil })
}

// TestDynamicPageFuncLive verifies a DynamicPageFunc's items are produced fresh on
// every hope.layout (not frozen at registration) and don't mutate the stored contrib.
func TestDynamicPageFuncLive(t *testing.T) {
	p := New("test", "1.0.0")
	calls := 0
	p.DynamicPageFunc("Browse", Section(""), func(ctx context.Context) []PageItem {
		calls++
		return make([]PageItem, calls) // count grows each call -> proves live re-eval
	})
	l1 := p.layout(context.Background())
	if len(l1.Contributions) != 1 || l1.Contributions[0].Surface != SurfacePage {
		t.Fatalf("want one page contribution, got %+v", l1.Contributions)
	}
	if got := len(l1.Contributions[0].Pages); got != 1 {
		t.Fatalf("want 1 live page on first fetch, got %d", got)
	}
	if got := len(p.layout(context.Background()).Contributions[0].Pages); got != 2 {
		t.Fatalf("want fn re-evaluated (2 pages) on second fetch, got %d", got)
	}
	if p.contribs[0].Pages != nil {
		t.Fatalf("registered contribution must stay unmutated, got %+v", p.contribs[0].Pages)
	}
}
