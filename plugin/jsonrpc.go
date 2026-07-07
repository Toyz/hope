package plugin

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// JSON-RPC 2.0 error codes. The negative custom codes stay clear of the reserved
// -32768..-32000 spec range except -32001, which we use for unauthorized.
const (
	codeParse        = -32700
	codeInvalidReq   = -32600
	codeMethodNotFn  = -32601
	codeInvalidArgs  = -32602
	codeInternal     = -32603
	codeUnauthorized = -32001
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return e.Message }

// paramsKey carries the raw request params into a handler's context so helpers
// like Input and Params can read them without changing the handler signature.
type paramsKey struct{}

// Params unmarshals the current call's JSON-RPC params into v. Use inside an
// action/view/stream handler to read structured input.
func Params(ctx context.Context, v any) error {
	raw, _ := ctx.Value(paramsKey{}).(json.RawMessage)
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, v)
}

// Input returns the "input" string from a Query view's params (the text the user
// typed into the query box), or "" if absent.
func Input(ctx context.Context) string {
	var p struct {
		Input string `json:"input"`
	}
	_ = Params(ctx, &p)
	return p.Input
}

// TableSort is the sort request for a server-driven table: which column, and the
// direction (1 ascending, -1 descending; 0 = unsorted).
type TableSort struct {
	Column string `json:"column"`
	Dir    int    `json:"dir"`
}

// TableQuery is hope's per-call query state for a ServerSide table: which page (0-
// based) of what size, an optional sort, the free-text filter, and any Facet
// selections (filters[key] = chosen value). Use it to run just that slice of your
// data and return {columns, rows, total}.
type TableQuery struct {
	Page     int               `json:"page"`
	PageSize int               `json:"page_size"`
	Sort     TableSort         `json:"sort"`
	Filter   string            `json:"filter"`
	Filters  map[string]string `json:"filters"`
}

// ReadTableQuery reads the server-table query state hope sends (under "_q"). ok is
// false when the call carried none (e.g. a non-server table) — treat that as page 0.
func ReadTableQuery(ctx context.Context) (q TableQuery, ok bool) {
	var w struct {
		Q *TableQuery `json:"_q"`
	}
	if err := Params(ctx, &w); err != nil || w.Q == nil {
		return TableQuery{}, false
	}
	return *w.Q, true
}

// SearchQuery reads the text a Search (autocomplete) view was called with (the "q"
// param). Empty when there's no query yet — return no items for that.
func SearchQuery(ctx context.Context) string {
	var w struct {
		Q string `json:"q"`
	}
	_ = Params(ctx, &w)
	return w.Q
}

// Handler returns the http.Handler that serves the JSON-RPC endpoint at the
// plugin's path. Mount it yourself, or use ListenAndServe.
func (p *Plugin) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(p.path, p.serve)
	return mux
}

// ListenAndServe serves the plugin on addr (e.g. ":8080"). Blocks. A
// ReadHeaderTimeout guards against a slow-header (Slowloris) client holding a
// goroutine; no WriteTimeout is set because stream handlers write indefinitely.
func (p *Plugin) ListenAndServe(addr string) error {
	srv := &http.Server{Addr: addr, Handler: p.Handler(), ReadHeaderTimeout: 10 * time.Second}
	return srv.ListenAndServe()
}

func (p *Plugin) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, p.maxBody)

	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, nil, codeParse, "parse error")
		return
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		writeError(w, req.ID, codeInvalidReq, "invalid request")
		return
	}

	// hope.schema is the sole unauthenticated method (pre-enable discovery).
	if req.Method == "hope.schema" {
		writeResult(w, req.ID, p.schema())
		return
	}

	if !p.authorize(r) {
		writeError(w, req.ID, codeUnauthorized, "unauthorized")
		return
	}

	if req.Method == "hope.layout" {
		writeResult(w, req.ID, p.layout(r.Context()))
		return
	}

	// hope pushes operator-managed setting values here; the plugin reads them via
	// SettingValue. params: {"values": {"<key>": "<value>"}}.
	if req.Method == "hope.settings" {
		var in struct {
			Values map[string]string `json:"values"`
		}
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &in); err != nil {
				writeError(w, req.ID, codeInvalidArgs, "invalid params")
				return
			}
		}
		p.applySettings(in.Values)
		writeResult(w, req.ID, map[string]any{"ok": true})
		return
	}

	ctx := context.WithValue(r.Context(), paramsKey{}, req.Params)

	if st, ok := p.streams[req.Method]; ok {
		p.serveStream(w, req.ID, st, ctx)
		return
	}
	if v, ok := p.views[req.Method]; ok {
		out, err := v.fn(ctx)
		p.finish(w, req.ID, out, err)
		return
	}
	if a, ok := p.actions[req.Method]; ok {
		var in map[string]any
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &in); err != nil {
				writeError(w, req.ID, codeInvalidArgs, "invalid params")
				return
			}
		}
		out, err := a.fn(ctx, in)
		p.finish(w, req.ID, out, err)
		return
	}
	writeError(w, req.ID, codeMethodNotFn, "method not found: "+req.Method)
}

// finish writes a unary result or maps an error to a JSON-RPC error frame. A
// handler may return an *rpcError to control the code; anything else is internal.
func (p *Plugin) finish(w http.ResponseWriter, id json.RawMessage, out any, err error) {
	if err != nil {
		var re *rpcError
		if errors.As(err, &re) {
			writeErrorObj(w, id, re)
			return
		}
		writeError(w, id, codeInternal, err.Error())
		return
	}
	writeResult(w, id, out)
}

// authorize checks the bearer token. With a configured secret (env/Token) it must
// match exactly. Without one, the plugin trusts-on-first-use: it pins the first
// non-empty bearer hope presents and requires it thereafter. An empty bearer is
// always rejected for authenticated methods.
func (p *Plugin) authorize(r *http.Request) bool {
	got := bearer(r)
	if got == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.token != "" {
		return ctEqual(got, p.token)
	}
	if p.pinned == "" {
		p.pinned = got
		return true
	}
	return ctEqual(got, p.pinned)
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const pfx = "Bearer "
	if len(h) > len(pfx) && strings.EqualFold(h[:len(pfx)], pfx) {
		return h[len(pfx):]
	}
	return ""
}

func ctEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func writeResult(w http.ResponseWriter, id json.RawMessage, result any) {
	writeJSON(w, rpcResponse{JSONRPC: "2.0", ID: id, Result: result})
}

func writeError(w http.ResponseWriter, id json.RawMessage, code int, msg string) {
	writeErrorObj(w, id, &rpcError{Code: code, Message: msg})
}

func writeErrorObj(w http.ResponseWriter, id json.RawMessage, e *rpcError) {
	writeJSON(w, rpcResponse{JSONRPC: "2.0", ID: id, Error: e})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// NewError builds an *rpcError a handler can return to control the JSON-RPC error
// code sent to hope (e.g. invalid query -> codeInvalidArgs).
func NewError(code int, msg string) error { return &rpcError{Code: code, Message: msg} }
