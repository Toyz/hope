package pluginhost

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/deploy"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/store"
)

const (
	pathPluginEvents  = "/rpc/_plugin_events"
	pathPluginKV      = "/rpc/_plugin/kv"
	pathPluginReqPerm = "/rpc/_plugin/request-permission"
	pathPluginAction  = "/rpc/_plugin/action"
)

// actionTimeout bounds a plugin-triggered stack re-apply (it recreates changed
// services) so a hung apply can't hold resources forever.
const actionTimeout = 5 * time.Minute

// timeNow is the current unix-milli clock (audit timing).
func timeNow() int64 { return time.Now().UnixMilli() }

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
	deploy *deploy.Engine // for operator actions (spec mutation); nil = actions unavailable
	limits Limits

	mu   sync.Mutex
	lims map[string]*pluginLimiter // per-plugin publish-rate limiters
}

var (
	_ gateway.Plugin       = (*PluginIngress)(nil)
	_ gateway.PluginDoc    = (*PluginIngress)(nil)
	_ gateway.RouteHandler = (*PluginIngress)(nil)
)

// NewPluginIngress builds the reverse-channel handler. eng enables operator actions
// (spec mutation); pass nil to leave actions unavailable.
func NewPluginIngress(st *store.Store, bus *events.Bus, eng *deploy.Engine, limits Limits) *PluginIngress {
	return &PluginIngress{store: st, bus: bus, deploy: eng, limits: limits.WithDefaults(), lims: map[string]*pluginLimiter{}}
}

func (h *PluginIngress) PluginName() string { return "plugin-ingress" }

func (h *PluginIngress) Doc() string {
	return "Plugin->hope reverse channel (/rpc/_plugin_events): a token-authenticated, events:publish-granted plugin publishes an event onto hope's bus. Attribution (Source/Kind) is server-forced so a plugin can't spoof another's events or a core kind."
}

func (h *PluginIngress) RoutePatterns() []string {
	return []string{pathPluginEvents, pathPluginKV, pathPluginReqPerm, pathPluginAction}
}

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
	case pathPluginReqPerm:
		return h.requestPermission(req)
	case pathPluginAction:
		return h.action(ctx, req)
	}
	return ingressErr(http.StatusNotFound, "NOT_FOUND", "unknown endpoint")
}

// actionBody is an operator-action request. Op selects the mutation; the remaining
// fields are its args. Actions are always scoped to the plugin's OWN stack (hope uses
// the record's host/project — the plugin cannot target another).
type actionBody struct {
	Key        string `json:"key"`
	Op         string `json:"op"` // "addServiceLabel"
	Service    string `json:"service"`
	LabelKey   string `json:"labelKey"`
	LabelValue string `json:"labelValue"`
}

// actionScope maps an action op to the permission scope it requires. Empty = unknown op.
func actionScope(op string) string {
	switch op {
	case "addServiceLabel":
		return scopeSpecLabel
	}
	return ""
}

// action handles POST /rpc/_plugin/action — plugins as operators. It is the highest-
// privilege reverse capability: a granted plugin mutates its own stack's spec and hope
// re-applies it, so the change PERSISTS across future redeploys (unlike a live-container
// relabel, which evaporates on the next recreate). Enforcement: the scope must be
// granted, and the target is ALWAYS the plugin's own host/project (:own) — hope ignores
// any cross-stack target. Every action is audited.
func (h *PluginIngress) action(ctx context.Context, req *gateway.Request) *gateway.Response {
	var body actionBody
	if err := json.Unmarshal(req.Body, &body); err != nil {
		return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "invalid body")
	}
	scope := actionScope(body.Op)
	if scope == "" {
		return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "unknown action op")
	}
	rec, errResp := h.verify(req, body.Key, scope)
	if errResp != nil {
		return errResp
	}
	if h.deploy == nil {
		return ingressErr(http.StatusServiceUnavailable, "UNAVAILABLE", "actions unavailable (no deploy engine)")
	}
	switch body.Op {
	case "addServiceLabel":
		return h.addServiceLabel(ctx, rec, body)
	}
	return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "unknown action op")
}

// addServiceLabel adds/updates one label on a service in the plugin's OWN stack spec,
// then re-applies the stack so the label persists. The stack is resolved from the
// record (rec.Host/rec.Project) — the plugin names only the service, never a project.
func (h *PluginIngress) addServiceLabel(ctx context.Context, rec *store.PluginRecord, body actionBody) *gateway.Response {
	if body.Service == "" || body.LabelKey == "" {
		return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "service and labelKey required")
	}
	if rec.Project == "" {
		return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "plugin is not part of a stack hope can edit")
	}
	spec, err := h.deploy.Store().Load(rec.Host, rec.Project)
	if err != nil || spec == nil {
		return ingressErr(http.StatusBadRequest, "NO_SPEC", "no stored spec for this stack (hope can only edit stacks it deployed)")
	}
	found := false
	for i := range spec.Services {
		if spec.Services[i].Name == body.Service {
			if spec.Services[i].Labels == nil {
				spec.Services[i].Labels = map[string]string{}
			}
			spec.Services[i].Labels[body.LabelKey] = body.LabelValue
			found = true
		}
	}
	if !found {
		return ingressErr(http.StatusBadRequest, "NO_SERVICE", "service not found in this stack")
	}

	// Apply detached + time-bounded: the re-apply outlives the plugin's HTTP call but
	// can't hang a worker forever.
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), actionTimeout)
	defer cancel()
	start := timeNow()
	applyErr := h.deploy.ApplyStack(actx, spec, false, func(string) {})
	h.audit(rec, "addServiceLabel:"+body.Service+"/"+body.LabelKey, applyErr, start)
	if applyErr != nil {
		return ingressErr(http.StatusInternalServerError, "APPLY_FAILED", applyErr.Error())
	}
	return ingressOK(`{"ok":true}`)
}

// audit records a plugin-initiated mutation (actor is the plugin itself — no human
// subject on the reverse channel).
func (h *PluginIngress) audit(rec *store.PluginRecord, method string, err error, start int64) {
	_ = h.store.AppendAudit(store.AuditEntry{
		Actor:  "plugin:" + rec.Key,
		Plugin: rec.Key,
		Host:   rec.Host,
		Method: method,
		Danger: true,
		OK:     err == nil,
		Err:    errString(err),
		Millis: timeNow() - start,
	})
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// requestPermission handles POST /rpc/_plugin/request-permission: a plugin asks, at
// runtime, for a scope it doesn't hold (the Android runtime-permission model). It does
// NOT grant — it queues the scope as pending and raises a consent prompt for the
// operator. Anti-nuisance: already-granted / already-pending / don't-ask-again-denied
// are silent no-ops, so a plugin can't spam the operator.
func (h *PluginIngress) requestPermission(req *gateway.Request) *gateway.Response {
	var body struct {
		Key    string `json:"key"`
		Scope  string `json:"scope"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(req.Body, &body); err != nil || body.Scope == "" {
		return ingressErr(http.StatusBadRequest, "BAD_REQUEST", "key and scope required")
	}
	rec, errResp := h.authenticate(req, body.Key)
	if errResp != nil {
		return errResp
	}
	// Already decided or queued -> no new prompt.
	if slices.Contains(rec.Grants, body.Scope) || slices.Contains(rec.Denied, body.Scope) || slices.Contains(rec.Pending, body.Scope) {
		return ingressOK(`{"ok":true,"pending":false}`)
	}
	rec.Pending = append(rec.Pending, body.Scope)
	if err := h.store.PutPlugin(*rec); err != nil {
		return ingressErr(http.StatusInternalServerError, "INTERNAL", "persist failed")
	}
	h.bus.Publish(events.Event{Kind: events.KindPermissionReq, Host: rec.Host, Data: permissionReqData(body.Key, rec.Name, body.Scope, body.Reason)})
	return ingressOK(`{"ok":true,"pending":true}`)
}

// authenticate proves the caller is the plugin at key (enabled record + valid token)
// and applies the per-plugin rate cap. It does NOT check any grant — that's the
// caller's job via verify. Returns the record or a non-nil error response.
func (h *PluginIngress) authenticate(req *gateway.Request, key string) (*store.PluginRecord, *gateway.Response) {
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
	if !h.limiter(key).allowRate() {
		return nil, ingressErr(http.StatusTooManyRequests, "RATE_LIMITED", "rate exceeded")
	}
	return rec, nil
}

// verify authenticates the caller AND authorizes the given scope — the trust boundary
// for a capability that requires an operator grant.
func (h *PluginIngress) verify(req *gateway.Request, key, scope string) (*store.PluginRecord, *gateway.Response) {
	rec, errResp := h.authenticate(req, key)
	if errResp != nil {
		return nil, errResp
	}
	if !rec.HasGrant(scope) {
		return nil, ingressErr(http.StatusForbidden, "FORBIDDEN", "plugin lacks the "+scope+" permission")
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
