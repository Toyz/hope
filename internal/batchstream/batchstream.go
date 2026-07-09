// Package batchstream adds a STREAMING batch endpoint at /rpc/_batchstream, as a
// hope-owned sov RouteHandler (no change to the sov framework itself).
//
// Why it exists: sov's built-in /rpc/_batch is all-or-nothing — it dispatches every
// entry concurrently but only returns once the SLOWEST has finished, as one JSON blob.
// So a page that coalesces a fast call (a counter) with a slow one (a heavy query, or a
// plugin call over the agent tunnel) makes the fast result wait on the slow one:
// head-of-line blocking, felt as UI lag.
//
// This endpoint takes the same {calls} body but returns NDJSON: it emits one frame the
// MOMENT each entry resolves, so the client can settle each call's promise independently
// while still paying a single round-trip. Frame shape:
//
//	{"alias":"c3","result":{"data":...}}      // success
//	{"alias":"c4","result":{"error":{...}}}   // per-entry error (HTTP-agnostic)
//
// Entries dispatch through gw.Handle exactly like the built-in batch's per-entry path
// (full middleware chain: auth, authz, plugin hooks), so trust/behavior is identical —
// only the delivery is incremental. It intentionally does NOT do the built-in's
// remote-batch cascade (coalescing 2+ same-pod remote entries into one nested batch):
// the win here is per-alias streaming, and hope is a local daemon plus agent tunnels, so
// per-entry dispatch is the common path anyway. The client falls back to /rpc/_batch on
// a 404 (an older gateway) so this is purely additive.
package batchstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
)

// Handler owns /rpc/_batchstream. It holds the gateway pointer (via Apply) to dispatch
// each entry through the full request chain.
type Handler struct {
	gw *gateway.Gateway
}

// Compile-time proof of the hooks bound — a signature drift is a build error here, not a
// silent non-binding at runtime.
var (
	_ gateway.Plugin        = (*Handler)(nil)
	_ gateway.PluginDoc     = (*Handler)(nil)
	_ gateway.ConfigApplier = (*Handler)(nil)
	_ gateway.RouteHandler  = (*Handler)(nil)
)

// New returns the streaming-batch route handler.
func New() *Handler { return &Handler{} }

func (h *Handler) PluginName() string { return "batchstream" }

func (h *Handler) Doc() string {
	return "Streaming /rpc/_batchstream — dispatches batch entries concurrently and emits each result as NDJSON the moment it resolves, so a fast call never waits on a slow sibling (avoids the all-or-nothing head-of-line blocking of /rpc/_batch)."
}

// Apply grabs the gateway pointer for per-entry dispatch.
func (h *Handler) Apply(g *gateway.Gateway) error { h.gw = g; return nil }

// RoutePatterns claims the streaming batch endpoint (exact path, not a subtree).
func (h *Handler) RoutePatterns() []string { return []string{"/rpc/_batchstream"} }

// streamFrame is one NDJSON line: the caller's alias plus that entry's raw RPC envelope
// ({"data":...} or {"error":...}), identical to a value in /rpc/_batch's results map.
type streamFrame struct {
	Alias  string          `json:"alias"`
	Result json.RawMessage `json:"result"`
}

// hasSubject reports whether the request carries an authenticated subject — set by the
// gateway's edge auth middleware. req.User is a subject string or *gateway.Claims; an
// anonymous request leaves it nil.
func hasSubject(req *gateway.Request) bool {
	switch u := req.User.(type) {
	case string:
		return u != ""
	case *gateway.Claims:
		return u != nil && u.Subject != ""
	}
	return false
}

// ServeRoute parses {calls}, then streams one frame per entry as it finishes.
func (h *Handler) ServeRoute(ctx context.Context, req *gateway.Request) *gateway.Response {
	if req.Method != http.MethodPost {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusMethodNotAllowed, Code: "BAD_REQUEST", Message: "method not allowed"})
	}
	// Require an authenticated subject for the whole envelope. The gateway's edge auth
	// middleware already resolved req.User before this handler runs; RouteHandlers aren't
	// gated by the deny-by-default authz the way business methods are, so gate it here so
	// an anonymous caller can't even open a batch (belt-and-suspenders — each proxied call
	// is re-authed through gw.Handle regardless, but this fails fast at the edge).
	if !hasSubject(req) {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED", Message: "authentication required"})
	}
	var br gateway.BatchRequest
	if err := json.Unmarshal(req.Body, &br); err != nil {
		return gateway.ErrorResponse(rpc.BadRequest("invalid body: %v", err))
	}
	if len(br.Calls) == 0 {
		return gateway.ErrorResponse(rpc.BadRequest("calls is empty"))
	}

	hdr := gateway.Header{}
	hdr.Set("Content-Type", "application/x-ndjson")
	return &gateway.Response{
		Status: http.StatusOK,
		Header: hdr,
		Stream: gateway.PipeStream(func(w io.Writer) error {
			enc := json.NewEncoder(w)
			// Serialize encoder writes: entries resolve on their own goroutines and each
			// writes a frame the moment it's done, so without the lock two frames could
			// interleave on the wire.
			var mu sync.Mutex
			write := func(alias string, body json.RawMessage) {
				mu.Lock()
				defer mu.Unlock()
				_ = enc.Encode(streamFrame{Alias: alias, Result: body})
			}
			var wg sync.WaitGroup
			wg.Add(len(br.Calls))
			for alias, call := range br.Calls {
				go func(alias string, call gateway.BatchCall) {
					defer wg.Done()
					write(alias, h.runOne(ctx, req, call))
				}(alias, call)
			}
			wg.Wait()
			return nil
		}),
	}
}

// runOne dispatches a single batch entry through the full gateway chain and returns its
// raw response body (the RPC envelope). Mirrors the built-in batch's per-entry dispatch:
// wrap the args as {"args": <args>}, clone the header (the requestid plugin MUTATES it,
// so parallel sub-dispatches must each own their map), and carry the authenticated user.
func (h *Handler) runOne(ctx context.Context, parent *gateway.Request, call gateway.BatchCall) json.RawMessage {
	bodyArgs := call.Args
	if len(bodyArgs) == 0 {
		bodyArgs = json.RawMessage(`[]`)
	}
	wrapped, _ := json.Marshal(struct {
		Args json.RawMessage `json:"args"`
	}{Args: bodyArgs})

	sub := &gateway.Request{
		Method:   http.MethodPost,
		Path:     "/rpc/" + call.Service + "/" + call.Method,
		Header:   parent.Header.Clone(),
		Body:     wrapped,
		RemoteIP: parent.RemoteIP,
		User:     parent.User,
	}
	resp := h.gw.Handle(ctx, sub)
	if resp == nil {
		return rpc.MarshalError(&rpc.Error{Status: http.StatusInternalServerError, Code: "INTERNAL", Message: "nil batch response"})
	}
	return resp.Body
}
