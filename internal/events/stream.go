package events

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/auth"
)

// pathEvents is the single global event feed. Underscore prefix marks it a
// framework/internal route (like /rpc/_batch, /rpc/_batchstream), not a business
// method.
const pathEvents = "/rpc/_events"

// keepAlive pings an idle feed so a silent stretch (no fleet activity) doesn't let
// a proxy / agent-tunnel / Cloudflare idle-timeout drop the connection.
const keepAlive = 15 * time.Second

// Handler serves the NDJSON event feed off a Bus. It is a sov RouteHandler
// registered via gw.MustUse. A RouteHandler does NOT get req.User populated by the
// gateway's auth chain (that's set for RPC-dispatched calls), so — like logstream —
// it verifies the operator's bearer token directly via the TokenManager.
type Handler struct {
	bus    *Bus
	tokens *auth.TokenManager
}

// Compile-time proof of the hooks bound.
var (
	_ gateway.Plugin       = (*Handler)(nil)
	_ gateway.PluginDoc    = (*Handler)(nil)
	_ gateway.RouteHandler = (*Handler)(nil)
)

// NewHandler returns the event-feed route handler for the given bus + token manager
// (used to authenticate the operator's bearer on each connection).
func NewHandler(bus *Bus, tokens *auth.TokenManager) *Handler { return &Handler{bus: bus, tokens: tokens} }

func (h *Handler) PluginName() string { return "events" }

func (h *Handler) Doc() string {
	return "Global event feed at /rpc/_events — one long-lived NDJSON stream of hope state-change events (stack/container/image/plugin/tunnel/agent) so the UI updates live without polling. Reconnect with {\"since\":<lastSeq>} to replay the gap; a gap older than the ring degrades to one resync frame."
}

// RoutePatterns claims the exact feed path.
func (h *Handler) RoutePatterns() []string { return []string{pathEvents} }

// subscribeBody is the optional POST body: the last Seq the client saw, so a
// reconnect replays only what it missed. Absent/zero = a fresh connect (no replay).
type subscribeBody struct {
	Since uint64 `json:"since"`
}

// ServeRoute authenticates, subscribes to the bus, and streams events as NDJSON
// until the client disconnects (ctx cancel) — which unsubscribes it. Unlike
// logstream's ops, this feed HONORS the request context: a closed tab must free its
// subscriber immediately, so there is no context.WithoutCancel here.
func (h *Handler) ServeRoute(ctx context.Context, req *gateway.Request) *gateway.Response {
	if req.Method != http.MethodPost {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusMethodNotAllowed, Code: "BAD_REQUEST", Message: "method not allowed"})
	}
	if !h.authenticated(req) {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED", Message: "authentication required"})
	}
	var body subscribeBody
	if len(req.Body) > 0 {
		_ = json.Unmarshal(req.Body, &body) // best-effort; a bad/empty body just means since=0
	}

	ch, cancel := h.bus.Subscribe(body.Since)
	hdr := gateway.Header{}
	hdr.Set("Content-Type", "application/x-ndjson")
	hdr.Set("Cache-Control", "no-cache")
	return &gateway.Response{
		Status: http.StatusOK,
		Header: hdr,
		Stream: gateway.PipeStream(func(w io.Writer) error {
			defer cancel() // unsubscribe when the pipe closes (client gone or ctx cancelled)
			enc := json.NewEncoder(w)
			ticker := time.NewTicker(keepAlive)
			defer ticker.Stop()
			// Single writer goroutine → no mutex. A failed Encode means the client is
			// gone; returning tears the pipe down and the deferred cancel unsubscribes.
			for {
				select {
				case e := <-ch:
					if err := enc.Encode(e); err != nil {
						return err
					}
				case <-ticker.C:
					if err := enc.Encode(Event{Kind: KindPing}); err != nil {
						return err
					}
				case <-ctx.Done():
					return nil
				}
			}
		}),
	}
}

// authenticated verifies the operator's bearer token directly (a RouteHandler doesn't
// receive req.User from the gateway auth chain). Mirrors logstream.authenticate.
func (h *Handler) authenticated(req *gateway.Request) bool {
	if h.tokens == nil {
		return false
	}
	tok, err := auth.Bearer(req.Header.Get("Authorization"))
	if err != nil {
		return false
	}
	_, _, err = h.tokens.Verify(tok)
	return err == nil
}
