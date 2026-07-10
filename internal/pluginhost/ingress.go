package pluginhost

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/store"
)

const (
	pathPluginEvents = "/rpc/_plugin_events"
	pathPluginKV     = "/rpc/_plugin/kv"
)

// PluginIngress is the plugin->hope reverse channel — hope's FIRST inbound-from-plugin
// surface. A plugin POSTs here to publish an event onto hope's bus. The trust boundary
// is strict and entirely server-side: the caller proves identity with its per-plugin
// token (HMAC(store secret, stable identity), which never leaves hope), hope looks up
// the ENABLED record and the required GRANT, and hope — not the plugin — stamps
// Source/Kind. So a co-located hostile container cannot forge another plugin's events,
// and no plugin can emit a core hope kind or spoof its Source.
type PluginIngress struct {
	store  *store.Store
	bus    *events.Bus
	limits Limits

	mu   sync.Mutex
	lims map[string]*pluginLimiter // per-plugin publish-rate limiters
}

var (
	_ gateway.Plugin       = (*PluginIngress)(nil)
	_ gateway.PluginDoc    = (*PluginIngress)(nil)
	_ gateway.RouteHandler = (*PluginIngress)(nil)
)

// NewPluginIngress builds the reverse-channel handler.
func NewPluginIngress(st *store.Store, bus *events.Bus, limits Limits) *PluginIngress {
	return &PluginIngress{store: st, bus: bus, limits: limits.WithDefaults(), lims: map[string]*pluginLimiter{}}
}

func (h *PluginIngress) PluginName() string { return "plugin-ingress" }

func (h *PluginIngress) Doc() string {
	return "Plugin->hope reverse channel (/rpc/_plugin_events): a token-authenticated, events:publish-granted plugin publishes an event onto hope's bus. Attribution (Source/Kind) is server-forced so a plugin can't spoof another's events or a core kind."
}

func (h *PluginIngress) RoutePatterns() []string { return []string{pathPluginEvents, pathPluginKV} }

func (h *PluginIngress) limiter(key string) *pluginLimiter {
	h.mu.Lock()
	defer h.mu.Unlock()
	l := h.lims[key]
	if l == nil {
		l = newPluginLimiter(h.limits)
		h.lims[key] = l
	}
	return l
}

// publishBody is the reverse-publish request: the plugin's stable key + the event it
// wants to publish (only Kind + Data are honored; Source/Host/Project are ignored and
// re-stamped by hope).
type publishBody struct {
	Key   string       `json:"key"`
	Event events.Event `json:"event"`
}

// ServeRoute dispatches the reverse-channel endpoints. Both require the store mounted
// and a POST; each handler authenticates the plugin and checks the scope it needs.
func (h *PluginIngress) ServeRoute(ctx context.Context, req *gateway.Request) *gateway.Response {
	if req.Method != http.MethodPost {
		return ingressErr(http.StatusMethodNotAllowed, "BAD_REQUEST", "method not allowed")
	}
	if h.store == nil || !h.store.Enabled() {
		return ingressErr(http.StatusServiceUnavailable, "UNAVAILABLE", "plugin store not mounted")
	}
	switch req.Path {
	case pathPluginEvents:
		return h.publish(req)
	case pathPluginKV:
		return h.kv(req)
	}
	return ingressErr(http.StatusNotFound, "NOT_FOUND", "unknown endpoint")
}

// verify authenticates the caller as the plugin at key and authorizes the given scope.
// It returns the enabled record, or a non-nil error response to send verbatim. The
// whole plugin->hope trust boundary lives here.
func (h *PluginIngress) verify(req *gateway.Request, key, scope string) (*store.PluginRecord, *gateway.Response) {
	if key == "" {
		return nil, ingressErr(http.StatusBadRequest, "BAD_REQUEST", "key required")
	}
	rec, err := h.store.Plugin(key)
	if err != nil || rec == nil || !rec.Enabled {
		return nil, ingressErr(http.StatusUnauthorized, "UNAUTHENTICATED", "unknown or disabled plugin")
	}
	// Constant-time token check. The token is HMAC(hope secret, key); the secret never
	// leaves hope, so a co-located container can't compute another plugin's token.
	tok, _ := auth.Bearer(req.Header.Get("Authorization"))
	want := h.store.DeriveToken(key)
	if tok == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(want)) != 1 {
		return nil, ingressErr(http.StatusUnauthorized, "UNAUTHENTICATED", "bad plugin token")
	}
	if !rec.HasGrant(scope) {
		return nil, ingressErr(http.StatusForbidden, "FORBIDDEN", "plugin lacks the "+scope+" permission")
	}
	if !h.limiter(key).allowRate() {
		return nil, ingressErr(http.StatusTooManyRequests, "RATE_LIMITED", "rate exceeded")
	}
	return rec, nil
}

// publish handles POST /rpc/_plugin_events: emit an event onto the bus with
// server-forced attribution.
func (h *PluginIngress) publish(req *gateway.Request) *gateway.Response {
	var body publishBody
	if err := json.Unmarshal(req.Body, &body); err != nil {
		return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "invalid body")
	}
	rec, errResp := h.verify(req, body.Key, scopeEventsPublish)
	if errResp != nil {
		return errResp
	}
	if len(body.Event.Data) > h.limits.MaxFrameBytes {
		return ingressErr(http.StatusRequestEntityTooLarge, "TOO_LARGE", "event data too large")
	}
	// Server-forced attribution: Source and the Kind namespace are hope's — the plugin
	// picks only the (sanitized) kind suffix + Data.
	h.bus.Publish(events.Event{
		Kind:    events.Kind("plugin." + body.Key + "." + cleanKindSuffix(string(body.Event.Kind))),
		Host:    rec.Host,
		Project: rec.Project,
		Source:  "plugin." + body.Key,
		Data:    body.Event.Data,
	})
	return ingressOK(`{"ok":true}`)
}

// kvBody is a storage request. Op is get|set|del|list; k is the user key; value is
// the JSON to store (set); prefix filters a list.
type kvBody struct {
	Key    string          `json:"key"`
	Op     string          `json:"op"`
	K      string          `json:"k"`
	Prefix string          `json:"prefix"`
	Value  json.RawMessage `json:"value"`
}

// kv handles POST /rpc/_plugin/kv: the p.Storage capability (opaque per-plugin KV).
func (h *PluginIngress) kv(req *gateway.Request) *gateway.Response {
	var body kvBody
	if err := json.Unmarshal(req.Body, &body); err != nil {
		return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "invalid body")
	}
	if _, errResp := h.verify(req, body.Key, scopeStorage); errResp != nil {
		return errResp
	}
	switch body.Op {
	case "get":
		v, err := h.store.GetPluginKV(body.Key, body.K)
		if err != nil {
			return ingressErr(http.StatusInternalServerError, "INTERNAL", "read failed")
		}
		out, _ := json.Marshal(map[string]any{"value": rawOrNull(v)})
		return ingressOK(string(out))
	case "set":
		if len(body.Value) > h.limits.MaxFrameBytes {
			return ingressErr(http.StatusRequestEntityTooLarge, "TOO_LARGE", "value too large")
		}
		if err := h.store.PutPluginKV(body.Key, body.K, body.Value); err != nil {
			return ingressErr(http.StatusInternalServerError, "INTERNAL", "write failed")
		}
		return ingressOK(`{"ok":true}`)
	case "del":
		if err := h.store.DeletePluginKV(body.Key, body.K); err != nil {
			return ingressErr(http.StatusInternalServerError, "INTERNAL", "delete failed")
		}
		return ingressOK(`{"ok":true}`)
	case "list":
		keys, err := h.store.ListPluginKV(body.Key, body.Prefix)
		if err != nil {
			return ingressErr(http.StatusInternalServerError, "INTERNAL", "list failed")
		}
		if keys == nil {
			keys = []string{}
		}
		out, _ := json.Marshal(map[string]any{"keys": keys})
		return ingressOK(string(out))
	}
	return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "unknown op")
}

// rawOrNull returns v as raw JSON, or JSON null when absent.
func rawOrNull(v []byte) json.RawMessage {
	if len(v) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(v)
}

func ingressOK(body string) *gateway.Response {
	return &gateway.Response{Status: http.StatusOK, Header: gateway.Header{"Content-Type": "application/json"}, Body: []byte(body)}
}

func ingressErr(status int, code, msg string) *gateway.Response {
	return gateway.ErrorResponse(&rpc.Error{Status: status, Code: code, Message: msg})
}

// cleanKindSuffix keeps the plugin-supplied kind suffix to a safe token
// (letters/digits/._-), defaulting to "event". The plugin controls only this suffix;
// hope owns the plugin.<key>. prefix.
func cleanKindSuffix(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "event"
	}
	return b.String()
}
