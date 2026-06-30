// Package logstream is a sov RouteHandler plugin that streams container logs
// and stats as NDJSON (application/x-ndjson, one JSON object per line) over a
// chunked response. It is the server half of the frontend's loom-rpc @stream
// transport.
//
// Auth is validated BEFORE the first byte: the bearer token rides the
// Authorization header (these are POST routes), and the container is checked
// to exist, so a failure still returns a normal error status. Once the stream
// starts, no status can be sent — see PipeStream.
package logstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/Toyz/sov/gateway"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// Route paths the loom-rpc stream transport POSTs to. They live under /rpc/
// so they ride the same transport, but a RouteHandler intercepts them before
// business dispatch (there is no "Stream" RPC router).
const (
	pathLogs          = "/rpc/Stream/logs"
	pathStats         = "/rpc/Stream/stats"
	pathStackLogs     = "/rpc/Stream/stackLogs"     // args: [project]
	pathServiceLogs   = "/rpc/Stream/serviceLogs"   // args: [project, service]
	pathRedeploy      = "/rpc/Stream/redeploy"      // args: [container id, pull?, force?]
	pathRedeployStack = "/rpc/Stream/redeployStack" // args: [project, pull?, force?]
	pathPull          = "/rpc/Stream/pull"          // args: [container id, ...] (pull their images, no recreate)
	pathPruneImages   = "/rpc/Stream/pruneImages"   // args: ["true"|"false"]  (all unused vs dangling)
)

// multiTail caps per-container backlog when fanning in many containers.
const multiTail = "60"

// Plugin streams logs/stats for a container.
type Plugin struct {
	hosts  *hosts.Set
	tokens *auth.TokenManager
}

// dock is the docker client for the currently-active host.
func (p *Plugin) dock() *docker.Client { return p.hosts.Active() }

// Compile-time proof of the hooks this plugin binds — a signature drift here
// is a build error, not a silent non-binding at runtime.
var (
	_ gateway.Plugin       = (*Plugin)(nil)
	_ gateway.PluginDoc    = (*Plugin)(nil)
	_ gateway.RouteHandler = (*Plugin)(nil)
)

// New returns the logstream plugin (active-host aware).
func New(hs *hosts.Set, tm *auth.TokenManager) *Plugin {
	return &Plugin{hosts: hs, tokens: tm}
}

// PluginName surfaces in /rpc/_introspect.plugins[].
func (p *Plugin) PluginName() string { return "logstream" }

// Doc surfaces a one-line description in introspect + explorer.
func (p *Plugin) Doc() string {
	return "Streams container logs and stats as NDJSON for the loom-rpc @stream transport."
}

// RoutePatterns claims the exact stream paths.
func (p *Plugin) RoutePatterns() []string {
	return []string{pathLogs, pathStats, pathStackLogs, pathServiceLogs, pathRedeploy, pathRedeployStack, pathPull, pathPruneImages}
}

// ServeRoute validates auth + the target container, then returns an NDJSON
// stream. Validation happens before any bytes are written.
func (p *Plugin) ServeRoute(ctx context.Context, req *gateway.Request) *gateway.Response {
	if req.Method != http.MethodPost {
		return errResp(http.StatusMethodNotAllowed, "POST required")
	}
	if _, err := p.authenticate(req); err != nil {
		return errResp(http.StatusUnauthorized, err.Error())
	}
	args, err := stringArgs(req.Body)
	if err != nil {
		return errResp(http.StatusBadRequest, err.Error())
	}

	switch req.Path {
	case pathLogs, pathStats:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "container id required")
		}
		id := args[0]
		if !p.dock().Exists(ctx, id) {
			return errResp(http.StatusNotFound, "container not found")
		}
		if req.Path == pathLogs {
			return p.streamLogs(ctx, id)
		}
		return p.streamStats(ctx, id)

	case pathStackLogs, pathServiceLogs:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "project required")
		}
		service := ""
		if req.Path == pathServiceLogs {
			if len(args) < 2 {
				return errResp(http.StatusBadRequest, "service required")
			}
			service = args[1]
		}
		refs, err := p.dock().ProjectContainers(ctx, args[0], service)
		if err != nil || len(refs) == 0 {
			return errResp(http.StatusNotFound, "no containers for that target")
		}
		return p.streamMulti(ctx, refs)

	case pathRedeploy:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "container id required")
		}
		if !p.dock().Exists(ctx, args[0]) {
			return errResp(http.StatusNotFound, "container not found")
		}
		id := args[0]
		pull := !(len(args) > 1 && args[1] == "false") // pull unless explicitly off
		force := len(args) > 2 && args[2] == "true"
		return p.streamOp(ctx, func(emit func(string)) error { return p.dock().RedeployContainer(ctx, id, pull, force, emit) })

	case pathRedeployStack:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "project required")
		}
		project := args[0]
		pull := !(len(args) > 1 && args[1] == "false")
		force := len(args) > 2 && args[2] == "true"
		return p.streamOp(ctx, func(emit func(string)) error { return p.dock().RedeployProject(ctx, project, pull, force, emit) })

	case pathPull:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "container id required")
		}
		ids := append([]string(nil), args...)
		return p.streamOp(ctx, func(emit func(string)) error { return p.dock().PullContainers(ctx, ids, emit) })

	case pathPruneImages:
		all := len(args) > 0 && args[0] == "true"
		return p.streamOp(ctx, func(emit func(string)) error { return p.dock().PruneImagesStream(ctx, all, emit) })

	default:
		return errResp(http.StatusNotFound, "unknown stream")
	}
}

// opFrame is one NDJSON line of a streamed operation (redeploy): progress "log"
// lines, then a terminal "done" frame carrying success/failure.
type opFrame struct {
	Type  string `json:"type"` // "log" | "done"
	Data  string `json:"data,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// streamOp runs a long operation, forwarding each progress line as an opFrame
// and finishing with a terminal done frame (so the client knows the outcome
// even though the HTTP status is already committed).
func (p *Plugin) streamOp(ctx context.Context, run func(emit func(string)) error) *gateway.Response {
	_ = ctx
	return ndjsonResponse(gateway.PipeStream(func(w io.Writer) error {
		enc := json.NewEncoder(w)
		emit := func(line string) { _ = enc.Encode(opFrame{Type: "log", Data: line}) }
		err := run(emit)
		if err != nil {
			return enc.Encode(opFrame{Type: "done", OK: false, Error: err.Error()})
		}
		return enc.Encode(opFrame{Type: "done", OK: true})
	}))
}

// authenticate resolves the bearer token from the Authorization header.
func (p *Plugin) authenticate(req *gateway.Request) (string, error) {
	tok, err := auth.Bearer(req.Header.Get("Authorization"))
	if err != nil {
		return "", err
	}
	sub, _, err := p.tokens.Verify(tok)
	if err != nil {
		return "", err
	}
	return sub, nil
}

// logFrame is one NDJSON line of container log output. Source is set only for
// multiplexed (stack/service) streams to tag which container emitted the line.
type logFrame struct {
	Type   string `json:"type"` // "stdout" | "stderr"
	Data   string `json:"data"`
	Source string `json:"source,omitempty"`
}

func (p *Plugin) streamLogs(ctx context.Context, id string) *gateway.Response {
	reader, err := p.dock().SDK().ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Timestamps: true,
		Tail:       "200",
	})
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error())
	}
	return ndjsonResponse(gateway.PipeStream(func(w io.Writer) error {
		defer reader.Close()
		enc := json.NewEncoder(w)
		// Demux the multiplexed log stream into stdout/stderr framers; each
		// demuxed chunk becomes one NDJSON frame.
		_, err := stdcopy.StdCopy(
			framer{enc: enc, kind: "stdout"},
			framer{enc: enc, kind: "stderr"},
			reader,
		)
		return err
	}))
}

func (p *Plugin) streamStats(ctx context.Context, id string) *gateway.Response {
	stats, err := p.dock().SDK().ContainerStats(ctx, id, true)
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error())
	}
	return ndjsonResponse(gateway.PipeStream(func(w io.Writer) error {
		defer stats.Body.Close()
		dec := json.NewDecoder(stats.Body)
		enc := json.NewEncoder(w)
		// Docker emits a stream of stats JSON objects; re-emit each as one
		// NDJSON line so the client parses uniformly.
		for {
			var raw json.RawMessage
			if err := dec.Decode(&raw); err != nil {
				if err == io.EOF {
					return nil
				}
				return err
			}
			if err := enc.Encode(raw); err != nil {
				return err
			}
		}
	}))
}

// streamMulti fans logs from many containers into one NDJSON stream, each line
// tagged with its source container. Reader goroutines push frames to a channel;
// a single collector serializes them to the wire. A cancelable context stops
// the readers when the client disconnects.
func (p *Plugin) streamMulti(reqCtx context.Context, refs []docker.ContainerRef) *gateway.Response {
	return ndjsonResponse(gateway.PipeStream(func(w io.Writer) error {
		ctx, cancel := context.WithCancel(reqCtx)
		defer cancel()

		frames := make(chan logFrame, 256)
		var wg sync.WaitGroup
		for _, ref := range refs {
			wg.Add(1)
			go func(ref docker.ContainerRef) {
				defer wg.Done()
				rc, err := p.dock().SDK().ContainerLogs(ctx, ref.ID, container.LogsOptions{
					ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true, Tail: multiTail,
				})
				if err != nil {
					return
				}
				defer rc.Close()
				_, _ = stdcopy.StdCopy(
					&chanFramer{ch: frames, ctx: ctx, source: ref.Name, kind: "stdout"},
					&chanFramer{ch: frames, ctx: ctx, source: ref.Name, kind: "stderr"},
					rc,
				)
			}(ref)
		}
		go func() { wg.Wait(); close(frames) }()

		enc := json.NewEncoder(w)
		for f := range frames {
			if err := enc.Encode(f); err != nil {
				cancel() // client gone — stop the readers
				return err
			}
		}
		return nil
	}))
}

// chanFramer turns each demuxed Write into a tagged frame on a channel, giving
// up if the stream context is cancelled (so a stalled reader can't deadlock).
type chanFramer struct {
	ch     chan logFrame
	ctx    context.Context
	source string
	kind   string
}

func (f *chanFramer) Write(p []byte) (int, error) {
	select {
	case f.ch <- logFrame{Type: f.kind, Data: string(p), Source: f.source}:
		return len(p), nil
	case <-f.ctx.Done():
		return 0, io.ErrClosedPipe
	}
}

// framer turns each Write into one NDJSON logFrame line. json.Encoder.Encode
// appends a newline, giving NDJSON framing for free.
type framer struct {
	enc  *json.Encoder
	kind string
}

func (f framer) Write(p []byte) (int, error) {
	if err := f.enc.Encode(logFrame{Type: f.kind, Data: string(p)}); err != nil {
		return 0, err
	}
	return len(p), nil
}

func ndjsonResponse(stream io.Reader) *gateway.Response {
	return &gateway.Response{
		Status: http.StatusOK,
		Header: gateway.Header{
			"Content-Type":  "application/x-ndjson",
			"Cache-Control": "no-cache",
		},
		Stream: stream,
	}
}

func errResp(status int, msg string) *gateway.Response {
	code := strings.ToUpper(strings.ReplaceAll(http.StatusText(status), " ", "_"))
	body, _ := json.Marshal(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
	return &gateway.Response{
		Status: status,
		Header: gateway.Header{"Content-Type": "application/json"},
		Body:   body,
	}
}

// stringArgs extracts the positional string args from an {"args":[...]} body.
func stringArgs(body []byte) ([]string, error) {
	var env struct {
		Args []json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, errBadArgs
	}
	out := make([]string, 0, len(env.Args))
	for _, raw := range env.Args {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil || s == "" {
			return nil, errBadArgs
		}
		out = append(out, s)
	}
	return out, nil
}

var errBadArgs = &argErr{"expected args[0] = container id"}

type argErr struct{ msg string }

func (e *argErr) Error() string { return e.msg }
