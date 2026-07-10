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

const pathPluginEvents = "/rpc/_plugin_events"

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

func (h *PluginIngress) RoutePatterns() []string { return []string{pathPluginEvents} }

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

// ServeRoute authenticates + authorizes the plugin, then publishes its event with
// server-controlled attribution.
func (h *PluginIngress) ServeRoute(ctx context.Context, req *gateway.Request) *gateway.Response {
	if req.Method != http.MethodPost {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusMethodNotAllowed, Code: "BAD_REQUEST", Message: "method not allowed"})
	}
	if h.store == nil || !h.store.Enabled() {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusServiceUnavailable, Code: "UNAVAILABLE", Message: "plugin store not mounted"})
	}
	var body publishBody
	if err := json.Unmarshal(req.Body, &body); err != nil || body.Key == "" {
		return gateway.ErrorResponse(rpc.BadRequest("invalid body"))
	}
	rec, err := h.store.Plugin(body.Key)
	if err != nil || rec == nil || !rec.Enabled {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED", Message: "unknown or disabled plugin"})
	}
	// Verify the per-plugin token, constant time. The token is HMAC(hope secret, key)
	// and the secret never leaves hope, so another container can't compute it.
	tok, _ := auth.Bearer(req.Header.Get("Authorization"))
	want := h.store.DeriveToken(body.Key)
	if tok == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(want)) != 1 {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED", Message: "bad plugin token"})
	}
	if !rec.HasGrant(scopeEventsPublish) {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusForbidden, Code: "FORBIDDEN", Message: "plugin lacks the events:publish permission"})
	}
	if !h.limiter(body.Key).allowRate() {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusTooManyRequests, Code: "RATE_LIMITED", Message: "publish rate exceeded"})
	}
	if len(body.Event.Data) > h.limits.MaxFrameBytes {
		return gateway.ErrorResponse(&rpc.Error{Status: http.StatusRequestEntityTooLarge, Code: "TOO_LARGE", Message: "event data too large"})
	}
	// Server-forced attribution: Source and the Kind namespace are hope's, not the
	// plugin's — it may only pick the kind SUFFIX (sanitized).
	h.bus.Publish(events.Event{
		Kind:    events.Kind("plugin." + body.Key + "." + cleanKindSuffix(string(body.Event.Kind))),
		Host:    rec.Host,
		Project: rec.Project,
		Source:  "plugin." + body.Key,
		Data:    body.Event.Data,
	})
	return &gateway.Response{Status: http.StatusOK, Header: gateway.Header{"Content-Type": "application/json"}, Body: []byte(`{"ok":true}`)}
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
