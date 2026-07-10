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
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/deploy"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
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
	pathApplyStack    = "/rpc/Stream/applyStack"    // args: [json StackSpec]  (build/deploy/edit a stack)
	pathDeployCont    = "/rpc/Stream/deployContainer" // args: [json ContainerSpec] (one-off container)
	pathDestroyStack  = "/rpc/Stream/destroyStack"  // args: [project, "true"|"false" prune]
	pathEditContainer = "/rpc/Stream/editContainer" // args: [container id, json ContainerSpec]
)

// streamWrites are the mutation paths — each recreates/removes/deploys on one
// host's Docker, so it must name that host (X-Hope-Host) or be rejected, never
// fall back to the active host. The log/stat tail paths are absent (reads).
var streamWrites = map[string]bool{
	pathRedeploy:      true,
	pathRedeployStack: true,
	pathPull:          true,
	pathPruneImages:   true,
	pathApplyStack:    true,
	pathDeployCont:    true,
	pathDestroyStack:  true,
	pathEditContainer: true,
}

// multiTail caps per-container backlog when fanning in many containers.
const multiTail = "60"

// Plugin streams logs/stats for a container.
type Plugin struct {
	hosts  *hosts.Set
	tokens *auth.TokenManager
	deploy *deploy.Engine
	bus    *events.Bus // nil-safe: publishes redeploy/pull outcomes to the global feed
}

// dock is the docker client for the currently-active host.
func (p *Plugin) dock(ctx context.Context) *docker.Client { return p.hosts.ActiveFor(ctx) }

// Compile-time proof of the hooks this plugin binds — a signature drift here
// is a build error, not a silent non-binding at runtime.
var (
	_ gateway.Plugin       = (*Plugin)(nil)
	_ gateway.PluginDoc    = (*Plugin)(nil)
	_ gateway.RouteHandler = (*Plugin)(nil)
)

// New returns the logstream plugin (active-host aware). eng drives the streaming
// deploy operations (apply/deploy/destroy).
func New(hs *hosts.Set, tm *auth.TokenManager, eng *deploy.Engine, bus *events.Bus) *Plugin {
	return &Plugin{hosts: hs, tokens: tm, deploy: eng, bus: bus}
}

// PluginName surfaces in /rpc/_introspect.plugins[].
func (p *Plugin) PluginName() string { return "logstream" }

// Doc surfaces a one-line description in introspect + explorer.
func (p *Plugin) Doc() string {
	return "Streams container logs and stats as NDJSON for the loom-rpc @stream transport."
}

// RoutePatterns claims the exact stream paths.
func (p *Plugin) RoutePatterns() []string {
	return []string{pathLogs, pathStats, pathStackLogs, pathServiceLogs, pathRedeploy, pathRedeployStack, pathPull, pathPruneImages, pathApplyStack, pathDeployCont, pathDestroyStack, pathEditContainer}
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
	// Honor a per-request host target (headless streaming) — the RouteHandler path
	// doesn't run the ContextContributor, so read the header here.
	if id := req.Header.Get(hosts.TargetHeader); id != "" {
		ctx = hosts.WithTarget(ctx, id)
	}
	// Streaming mutations must name their host explicitly — a RouteHandler bypasses
	// the gateway middleware, so enforce the same rule here that hostguard enforces
	// for normal RPC writes. Read streams (logs/stats) keep the active-host fallback.
	if streamWrites[req.Path] {
		if _, _, err := p.hosts.RequireTarget(ctx); err != nil {
			return errResp(http.StatusBadRequest, err.Error())
		}
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
		if !p.dock(ctx).Exists(ctx, id) {
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
		refs, err := p.dock(ctx).ProjectContainers(ctx, args[0], service)
		if err != nil || len(refs) == 0 {
			return errResp(http.StatusNotFound, "no containers for that target")
		}
		return p.streamMulti(ctx, refs)

	case pathRedeploy:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "container id required")
		}
		if !p.dock(ctx).Exists(ctx, args[0]) {
			return errResp(http.StatusNotFound, "container not found")
		}
		id := args[0]
		pull := !(len(args) > 1 && args[1] == "false") // pull unless explicitly off
		force := len(args) > 2 && args[2] == "true"
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error {
			err := p.dock(ctx).RedeployContainer(ctx, id, pull, force, emit)
			if err == nil {
				p.bus.Publish(events.Event{Kind: events.KindStackRedeployed, Host: p.hosts.ActiveIDFor(ctx), IDs: []string{id}})
			}
			return err
		})

	case pathRedeployStack:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "project required")
		}
		project := args[0]
		pull := !(len(args) > 1 && args[1] == "false")
		force := len(args) > 2 && args[2] == "true"
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error {
			err := p.dock(ctx).RedeployProject(ctx, project, pull, force, emit)
			if err == nil {
				p.bus.Publish(events.Event{Kind: events.KindStackRedeployed, Host: p.hosts.ActiveIDFor(ctx), Project: project})
			}
			return err
		})

	case pathPull:
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "container id required")
		}
		ids := append([]string(nil), args...)
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error {
			err := p.dock(ctx).PullContainers(ctx, ids, emit)
			if err == nil {
				p.bus.Publish(events.Event{Kind: events.KindImageCurrent, Host: p.hosts.ActiveIDFor(ctx), IDs: ids})
			}
			return err
		})

	case pathPruneImages:
		all := len(args) > 0 && args[0] == "true"
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error { return p.dock(ctx).PruneImagesStream(ctx, all, emit) })

	case pathApplyStack:
		if p.deploy == nil {
			return errResp(http.StatusServiceUnavailable, "deploy is not available")
		}
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "stack spec required")
		}
		var spec stackspec.StackSpec
		if err := json.Unmarshal([]byte(args[0]), &spec); err != nil {
			return errResp(http.StatusBadRequest, "bad stack spec: "+err.Error())
		}
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error { return p.deploy.ApplyStack(ctx, &spec, false, emit) })

	case pathDeployCont:
		if p.deploy == nil {
			return errResp(http.StatusServiceUnavailable, "deploy is not available")
		}
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "container spec required")
		}
		var spec stackspec.ContainerSpec
		if err := json.Unmarshal([]byte(args[0]), &spec); err != nil {
			return errResp(http.StatusBadRequest, "bad container spec: "+err.Error())
		}
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error { return p.deploy.DeployContainer(ctx, spec, emit) })

	case pathDestroyStack:
		if p.deploy == nil {
			return errResp(http.StatusServiceUnavailable, "deploy is not available")
		}
		if len(args) == 0 {
			return errResp(http.StatusBadRequest, "project required")
		}
		project := args[0]
		prune := len(args) > 1 && args[1] == "true"
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error { return p.deploy.Destroy(ctx, project, prune, emit) })

	case pathEditContainer:
		if len(args) < 2 {
			return errResp(http.StatusBadRequest, "container id and spec required")
		}
		id := args[0]
		if !p.dock(ctx).Exists(ctx, id) {
			return errResp(http.StatusNotFound, "container not found")
		}
		var spec stackspec.ContainerSpec
		if err := json.Unmarshal([]byte(args[1]), &spec); err != nil {
			return errResp(http.StatusBadRequest, "bad container spec: "+err.Error())
		}
		return p.streamOp(ctx, func(ctx context.Context, emit func(string)) error { return p.dock(ctx).RecreateFromSpec(ctx, id, spec, true, emit) })

	default:
		return errResp(http.StatusNotFound, "unknown stream")
	}
}

// opFrame is one NDJSON line of a streamed operation (redeploy): progress "log"
// lines, a periodic "ping" keepalive (ignored by the UI), then a terminal "done"
// frame carrying success/failure.
type opFrame struct {
	Type  string `json:"type"` // "log" | "ping" | "done"
	Data  string `json:"data,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// keepAlive is how often streamOp emits a ping during a silent step, to keep the
// NDJSON connection from idling out at a proxy / agent-tunnel / Cloudflare
// timeout (a big image-layer extract emits nothing for tens of seconds).
const keepAlive = 15 * time.Second

// opTimeout bounds a detached op so a genuinely hung docker call can't leak the
// goroutine forever. Generous: a cold multi-image stack pull over a slow link is
// legitimately minutes long.
const opTimeout = 30 * time.Minute

// streamOp runs a long operation, forwarding each progress line as an opFrame and
// finishing with a terminal done frame (so the client knows the outcome even
// though the HTTP status is already committed). The op runs in a goroutine so the
// main loop can emit keepalive pings while it's blocked on a silent step; writes
// are serialized so the two goroutines never interleave a frame.
func (p *Plugin) streamOp(ctx context.Context, run func(context.Context, func(string)) error) *gateway.Response {
	// Detach the op from the REQUEST context. net/http cancels r.Context() the moment
	// the client disconnects — and when the client reaches hope THROUGH the very
	// tunnel/connector this op is recreating, the first destructive step (stop/remove)
	// drops that tunnel, cancels the request, and would abort the op before it
	// recreates the container (how an edit/redeploy destroys it for good). WithoutCancel
	// keeps request VALUES (the target host lives in a ctx value) but strips
	// cancellation; the timeout bounds a genuinely hung op. cancel fires when the op
	// finishes — NOT when the client drops — so a disconnect never kills the work.
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

		// Run the op detached: it keeps going to completion on the host even if the
		// client (or its stream) drops. done is buffered so it never blocks.
		done := make(chan error, 1)
		go func() { defer cancel(); done <- run(opCtx, emit) }()

		ticker := time.NewTicker(keepAlive)
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
					return err // client gone; the op still finishes server-side
				}
			}
		}
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
// multiplexed (stack/service) streams to tag which container emitted the line. A
// "ping" frame carries no data and is a keepalive the UI ignores — a container
// that logs nothing for a while would otherwise let the follow stream idle out.
type logFrame struct {
	Type   string `json:"type"` // "stdout" | "stderr" | "ping"
	Data   string `json:"data"`
	Source string `json:"source,omitempty"`
}

func (p *Plugin) streamLogs(ctx context.Context, id string) *gateway.Response {
	reader, err := p.dock(ctx).SDK().ContainerLogs(ctx, id, container.LogsOptions{
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
		// StdCopy runs in a goroutine so the main loop can emit keepalive pings
		// while a quiet container produces no log lines; a mutex serializes the two
		// writers so their NDJSON frames never interleave.
		var mu sync.Mutex
		done := make(chan error, 1)
		go func() {
			_, err := stdcopy.StdCopy(
				framer{enc: enc, kind: "stdout", mu: &mu},
				framer{enc: enc, kind: "stderr", mu: &mu},
				reader,
			)
			done <- err
		}()
		ticker := time.NewTicker(keepAlive)
		defer ticker.Stop()
		for {
			select {
			case err := <-done:
				return err
			case <-ticker.C:
				mu.Lock()
				e := enc.Encode(logFrame{Type: "ping"})
				mu.Unlock()
				if e != nil {
					return e // client gone
				}
			}
		}
	}))
}

func (p *Plugin) streamStats(ctx context.Context, id string) *gateway.Response {
	stats, err := p.dock(ctx).SDK().ContainerStats(ctx, id, true)
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
		enc := json.NewEncoder(w)

		// Phase 1 — backlog, merged across all containers in true timestamp order.
		// Each container's tail is fetched non-following, split into timestamped
		// lines, then the whole set is sorted so "all logs" reads chronologically
		// instead of one container's history dumped, then the next's.
		var backlog []tsLine
		for _, ref := range refs {
			backlog = append(backlog, p.backlogLines(ctx, ref.ID, ref.Name)...)
		}
		sort.SliceStable(backlog, func(i, j int) bool { return backlog[i].ts.Before(backlog[j].ts) })
		for _, l := range backlog {
			if err := enc.Encode(logFrame{Type: l.kind, Data: l.data, Source: l.source}); err != nil {
				return err
			}
		}

		// Phase 2 — live follow. Fan-in arrival order is chronological enough for
		// the live tail; Since=now (captured after the backlog) avoids re-emitting
		// what phase 1 already sent.
		since := time.Now().UTC().Format(time.RFC3339Nano)
		frames := make(chan logFrame, 256)
		var wg sync.WaitGroup
		for _, ref := range refs {
			wg.Add(1)
			go func(ref docker.ContainerRef) {
				defer wg.Done()
				rc, err := p.dock(ctx).SDK().ContainerLogs(ctx, ref.ID, container.LogsOptions{
					ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true, Since: since,
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

		// One writer (this loop) drains the fan-in channel, so no mutex is needed;
		// a ticker interleaves keepalive pings when every container is quiet.
		ticker := time.NewTicker(keepAlive)
		defer ticker.Stop()
		for {
			select {
			case f, ok := <-frames:
				if !ok {
					return nil // all readers finished
				}
				if err := enc.Encode(f); err != nil {
					cancel() // client gone — stop the readers
					return err
				}
			case <-ticker.C:
				if err := enc.Encode(logFrame{Type: "ping"}); err != nil {
					cancel()
					return err
				}
			}
		}
	}))
}

// tsLine is one backlog log line tagged with its parsed leading timestamp (from
// docker's Timestamps:true prefix), its source container, and stream kind.
type tsLine struct {
	ts     time.Time
	source string
	kind   string
	data   string
}

// backlogLines fetches a container's recent history (non-following) and splits it
// into timestamped lines for the cross-container merge. Docker prefixes each line
// with an RFC3339Nano timestamp when Timestamps is set; a line that fails to parse
// sorts as zero-time (stable order preserved among those).
func (p *Plugin) backlogLines(ctx context.Context, id, source string) []tsLine {
	rc, err := p.dock(ctx).SDK().ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Follow: false, Timestamps: true, Tail: multiTail,
	})
	if err != nil {
		return nil
	}
	defer rc.Close()
	var out, errb bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, &errb, rc); err != nil {
		return nil
	}
	var lines []tsLine
	collect := func(buf *bytes.Buffer, kind string) {
		for _, ln := range strings.Split(strings.TrimRight(buf.String(), "\n"), "\n") {
			if ln == "" {
				continue
			}
			lines = append(lines, tsLine{ts: parseLogTS(ln), source: source, kind: kind, data: ln + "\n"})
		}
	}
	collect(&out, "stdout")
	collect(&errb, "stderr")
	return lines
}

// parseLogTS reads the leading RFC3339Nano token docker prepends with
// Timestamps:true; zero time if the line isn't timestamped.
func parseLogTS(line string) time.Time {
	tok := line
	if i := strings.IndexByte(line, ' '); i >= 0 {
		tok = line[:i]
	}
	t, err := time.Parse(time.RFC3339Nano, tok)
	if err != nil {
		return time.Time{}
	}
	return t
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
// appends a newline, giving NDJSON framing for free. mu serializes against the
// keepalive-ping writer sharing the same encoder.
type framer struct {
	enc  *json.Encoder
	kind string
	mu   *sync.Mutex
}

func (f framer) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
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
