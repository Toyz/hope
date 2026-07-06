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
)

// pathPluginStream is the loom-rpc @stream route for a plugin's live stream. It
// lives under /rpc/ so it rides the same transport, intercepted by this
// RouteHandler before RPC dispatch (there is no streaming RPC router). Args:
// [key, method].
const pathPluginStream = "/rpc/Stream/pluginStream"

// keepAlivePlugin pings an idle stream so it doesn't time out at a proxy / the
// agent tunnel / Cloudflare while the plugin is quiet.
const keepAlivePlugin = 15 * time.Second

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
func (h *StreamHandler) RoutePatterns() []string { return []string{pathPluginStream} }

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
	// Cap concurrent streams per plugin so a plugin (or a runaway UI) can't hold
	// unbounded live connections through the control plane.
	releaseStream, ok := h.r.limiter(key).acquireStream()
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
		gate := newFrameGate()
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
			done <- ep.stream(ctx, method, nil, func(fr json.RawMessage) error {
				// Drop oversize or too-fast frames — a plugin must not flood the UI /
				// control plane. Dropping (not erroring) keeps a bursty-but-benign
				// stream alive while starving an abusive one.
				if !gate.allow(len(fr)) {
					return nil
				}
				select {
				case frames <- fr:
					return nil
				case <-ctx.Done():
					return ctx.Err()
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
