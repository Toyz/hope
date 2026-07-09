package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/hosts"
)

// pathPluginStream is the loom-rpc @stream route for a plugin's live stream. It
// lives under /rpc/ so it rides the same transport, intercepted by this
// RouteHandler before RPC dispatch (there is no streaming RPC router). Args:
// [key, method].
const pathPluginStream = "/rpc/Stream/pluginStream"

// pathInstallPlugin deploys catalog plugins from the UI (args: [json InstallParams]);
// pathReconfigurePlugin recreates an installed plugin with new env (args: [key, json env
// map]). Both stream opFrame progress and require an X-Hope-Host target (a write).
const (
	pathInstallPlugin     = "/rpc/Stream/installPlugin"
	pathReconfigurePlugin = "/rpc/Stream/reconfigurePlugin"
)

// keepAlivePlugin pings an idle stream so it doesn't time out at a proxy / the
// agent tunnel / Cloudflare while the plugin is quiet.
const keepAlivePlugin = 15 * time.Second

// opTimeout bounds a detached install/reconfigure op so a hung docker call can't
// leak the goroutine forever (image pulls over a slow link are legitimately long).
const opTimeout = 30 * time.Minute

// StreamHandler proxies a container plugin's NDJSON stream to the UI. It shares
// the PluginsRouter's discovery + dial machinery (same package) and authenticates
// like the other stream routes.
type StreamHandler struct {
	r      *PluginsRouter
	tokens *auth.TokenManager
}

// NewStreamHandler wires the plugin stream route to the router + token manager.
func NewStreamHandler(r *PluginsRouter, tokens *auth.TokenManager) *StreamHandler {
	return &StreamHandler{r: r, tokens: tokens}
}

var (
	_ gateway.Plugin       = (*StreamHandler)(nil)
	_ gateway.PluginDoc    = (*StreamHandler)(nil)
	_ gateway.RouteHandler = (*StreamHandler)(nil)
)

func (h *StreamHandler) PluginName() string { return "pluginstream" }
func (h *StreamHandler) Doc() string {
	return "Streams a container plugin's NDJSON stream to the loom-rpc @stream transport."
}
func (h *StreamHandler) RoutePatterns() []string {
	return []string{pathPluginStream, pathInstallPlugin, pathReconfigurePlugin}
}

// streamFrame is one NDJSON line hope sends the UI: a plugin data frame, a
// keepalive ping (ignored by the UI), or a terminal error.
type streamFrame struct {
	Type  string          `json:"type"` // "data" | "ping" | "error"
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

// ServeRoute validates auth + the request, resolves the enabled plugin, and pipes
// its NDJSON stream to the UI, injecting keepalive pings while the plugin is quiet.
func (h *StreamHandler) ServeRoute(ctx context.Context, req *gateway.Request) *gateway.Response {
	if req.Method != http.MethodPost {
		return errResp(http.StatusMethodNotAllowed, "POST required")
	}
	if _, err := h.authenticate(req); err != nil {
		return errResp(http.StatusUnauthorized, err.Error())
	}
	if err := h.r.gate(); err != nil {
		return errResp(http.StatusBadRequest, err.Error())
	}
	switch req.Path {
	case pathInstallPlugin:
		return h.serveInstall(ctx, req)
	case pathReconfigurePlugin:
		return h.serveReconfigure(ctx, req)
	}

	args, err := stringArgs(req.Body)
	if err != nil || len(args) < 2 {
		return errResp(http.StatusBadRequest, "key and method are required")
	}
	key, method := args[0], args[1]
	if strings.HasPrefix(method, "hope.") {
		return errResp(http.StatusBadRequest, "hope.* methods are reserved")
	}

	rec, err := h.r.store.Plugin(key)
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error())
	}
	if rec == nil || !rec.Enabled {
		return errResp(http.StatusBadRequest, "plugin is not enabled")
	}
	// Cap concurrent streams per plugin AND consume a rate token (the stream path
	// otherwise bypasses the per-plugin rate envelope the unary Call enforces).
	lim := h.r.limiter(key)
	if !lim.allowRate() {
		return errResp(http.StatusTooManyRequests, "rate limit exceeded for this plugin")
	}
	releaseStream, ok := lim.acquireStream()
	if !ok {
		return errResp(http.StatusTooManyRequests, "too many concurrent streams for this plugin")
	}
	ep, err := h.r.tryDial(ctx, key, rec.Token, true)
	if err != nil {
		releaseStream()
		return errResp(http.StatusInternalServerError, err.Error())
	}

	return ndjsonResponse(gateway.PipeStream(func(w io.Writer) error {
		defer releaseStream()
		// Cancel the reader goroutine when this pipe returns for ANY reason (client
		// gone, ping-write failure) — not just ctx cancellation. Otherwise the reader
		// can block forever on `frames <- fr` once nobody drains it, holding the
		// plugin's HTTP body + connection open (goroutine leak).
		sctx, cancel := context.WithCancel(ctx)
		defer cancel()
		gate := newFrameGate(h.r.limits)
		enc := json.NewEncoder(w)
		var mu sync.Mutex
		write := func(f streamFrame) error {
			mu.Lock()
			defer mu.Unlock()
			return enc.Encode(f)
		}

		// Read the plugin's frames in a goroutine so the main loop can emit pings
		// while the plugin is quiet. onFrame returns an error (dropping the plugin
		// stream) once the client is gone.
		frames := make(chan json.RawMessage, 16)
		done := make(chan error, 1)
		go func() {
			done <- ep.stream(sctx, method, nil, func(fr json.RawMessage) error {
				// Drop oversize or too-fast frames — a plugin must not flood the UI /
				// control plane. Dropping (not erroring) keeps a bursty-but-benign
				// stream alive while starving an abusive one.
				if !gate.allow(len(fr)) {
					return nil
				}
				select {
				case frames <- fr:
					return nil
				case <-sctx.Done():
					return sctx.Err()
				}
			})
		}()

		ticker := time.NewTicker(keepAlivePlugin)
		defer ticker.Stop()
		for {
			select {
			case fr := <-frames:
				if err := write(streamFrame{Type: "data", Data: fr}); err != nil {
					return err // client gone
				}
			case err := <-done:
				if err != nil && ctx.Err() == nil && !errors.Is(err, io.EOF) {
					_ = write(streamFrame{Type: "error", Error: err.Error()})
				}
				return err
			case <-ticker.C:
				if err := write(streamFrame{Type: "ping"}); err != nil {
					return err
				}
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}))
}

// serveInstall streams a plugin install. Args: [json InstallParams]. A write, so it
// must name its host (X-Hope-Host) — never falls back to the active host.
func (h *StreamHandler) serveInstall(ctx context.Context, req *gateway.Request) *gateway.Response {
	if id := req.Header.Get(hosts.TargetHeader); id != "" {
		ctx = hosts.WithTarget(ctx, id)
	}
	host, dock, err := h.r.hosts.RequireTarget(ctx)
	if err != nil {
		return errResp(http.StatusBadRequest, err.Error())
	}
	args, err := stringArgs(req.Body)
	if err != nil || len(args) < 1 {
		return errResp(http.StatusBadRequest, "install params required")
	}
	var p InstallParams
	if err := json.Unmarshal([]byte(args[0]), &p); err != nil {
		return errResp(http.StatusBadRequest, "bad install params: "+err.Error())
	}
	p.Host = host
	return h.runOp(ctx, func(ctx context.Context, emit func(string)) error { return h.r.install(ctx, dock, host, p, emit) })
}

// serveReconfigure streams an env-reconfigure (recreate). Args: [key, json env map].
func (h *StreamHandler) serveReconfigure(ctx context.Context, req *gateway.Request) *gateway.Response {
	if id := req.Header.Get(hosts.TargetHeader); id != "" {
		ctx = hosts.WithTarget(ctx, id)
	}
	if _, _, err := h.r.hosts.RequireTarget(ctx); err != nil {
		return errResp(http.StatusBadRequest, err.Error())
	}
	args, err := stringArgs(req.Body)
	if err != nil || len(args) < 2 {
		return errResp(http.StatusBadRequest, "key and env are required")
	}
	key := args[0]
	var env map[string]string
	if err := json.Unmarshal([]byte(args[1]), &env); err != nil {
		return errResp(http.StatusBadRequest, "bad env: "+err.Error())
	}
	return h.runOp(ctx, func(ctx context.Context, emit func(string)) error { return h.r.reconfigure(ctx, key, env, emit) })
}

// opFrame is one NDJSON line of a streamed operation: "log" progress lines, a "ping"
// keepalive, then a terminal "done" carrying success/failure — the same shape the
// deploy streams use, so the UI consumes install exactly like applyStack.
type opFrame struct {
	Type  string `json:"type"` // "log" | "ping" | "done"
	Data  string `json:"data,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// runOp runs a long operation, forwarding each progress line as an opFrame and
// finishing with a terminal done frame. The op runs in a goroutine so keepalive pings
// go out during a silent step; writes are serialized.
func (h *StreamHandler) runOp(ctx context.Context, run func(context.Context, func(string)) error) *gateway.Response {
	// Detach the op from the request context (see streamOp): install/reconfigure both
	// deploy + recreate containers, so a client disconnect mid-op must not cancel the
	// docker work and leave a half-deployed stack. WithoutCancel keeps the target-host
	// value; the timeout bounds a hung op; cancel fires only when the op completes.
	opCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), opTimeout)
	return ndjsonResponse(gateway.PipeStream(func(w io.Writer) error {
		enc := json.NewEncoder(w)
		var mu sync.Mutex
		write := func(f opFrame) error {
			mu.Lock()
			defer mu.Unlock()
			return enc.Encode(f)
		}
		emit := func(line string) { _ = write(opFrame{Type: "log", Data: line}) }

		done := make(chan error, 1)
		go func() { defer cancel(); done <- run(opCtx, emit) }()

		ticker := time.NewTicker(keepAlivePlugin)
		defer ticker.Stop()
		for {
			select {
			case err := <-done:
				if err != nil {
					return write(opFrame{Type: "done", OK: false, Error: err.Error()})
				}
				return write(opFrame{Type: "done", OK: true})
			case <-ticker.C:
				if err := write(opFrame{Type: "ping"}); err != nil {
					return err
				}
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}))
}

// authenticate resolves + verifies the bearer token (same as the other streams).
func (h *StreamHandler) authenticate(req *gateway.Request) (string, error) {
	tok, err := auth.Bearer(req.Header.Get("Authorization"))
	if err != nil {
		return "", err
	}
	sub, _, err := h.tokens.Verify(tok)
	if err != nil {
		return "", err
	}
	return sub, nil
}

// --- local copies of the small NDJSON helpers (logstream keeps its own) --------

func ndjsonResponse(stream io.Reader) *gateway.Response {
	return &gateway.Response{
		Status: http.StatusOK,
		Header: gateway.Header{"Content-Type": "application/x-ndjson", "Cache-Control": "no-cache"},
		Stream: stream,
	}
}

func errResp(status int, msg string) *gateway.Response {
	code := strings.ToUpper(strings.ReplaceAll(http.StatusText(status), " ", "_"))
	body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": msg}})
	return &gateway.Response{Status: status, Header: gateway.Header{"Content-Type": "application/json"}, Body: body}
}

func stringArgs(body []byte) ([]string, error) {
	var env struct {
		Args []json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, errors.New("bad args")
	}
	out := make([]string, 0, len(env.Args))
	for _, raw := range env.Args {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil || s == "" {
			return nil, errors.New("bad args")
		}
		out = append(out, s)
	}
	return out, nil
}
