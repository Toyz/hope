// Package agent implements hope's remote-host model. A hope-agent runs on a
// remote Docker host and dials OUT to a hope hub (so the remote needs only
// outbound access — no inbound ports, no VPN). Over that single connection it
// multiplexes (yamux) the host's Docker socket back to hope: hope opens a
// stream per Docker request and the agent proxies each to the local daemon. So
// hope's entire existing Docker layer works against the remote host unchanged.
package agent

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"github.com/toyz/hope/internal/version"
)

// protoLine is the handshake the agent sends first: "HOPE-AGENT/1 <token> <id>".
const protoVersion = "HOPE-AGENT/1"

// capStreamTypes is the handshake capability token for typed tunnel streams: the
// agent advertises it, the hub echoes it in the OK reply, and when both agree each
// stream is prefixed with a type line ("DOCKER" or "DIAL <addr>") so the same
// tunnel can proxy the docker socket AND dial plugin containers. Back-compatible:
// any peer that omits it stays docker-only.
const capStreamTypes = "streamtypes"

// capReverse is the handshake capability for the plugin reverse channel over the
// tunnel: when both peers advertise it, the agent opens REVERSE streams carrying an
// agent-hosted plugin's HTTP call back to hope's /rpc/_plugin_* ingress (so
// Publish/Alert/Storage/Action work off-host, not just for co-located plugins).
// Back-compatible: any peer that omits it leaves the reverse channel co-located-only.
const capReverse = "reverse"

// ReversePort is the port the agent listens on (inside its container) for a
// co-located plugin's reverse-channel HTTP, reachable by the agent's container id
// once hope attaches the agent to the ink-plugins network. Shared by the agent
// listener and the callback URL hope hands an agent-hosted plugin.
const ReversePort = 8790

// Logger is the small logging surface the agent/hub need (hope's logger fits).
type Logger interface {
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
	Error(msg string, kv ...any)
}

// Options configures a hope-agent.
type Options struct {
	// Connect is the hub endpoint. A ws://host/path or wss://host/path URL rides
	// hope's main HTTPS port through Cloudflare (no extra port); a bare host:port
	// or tcp://host:port uses a raw TCP hub listener (LAN/overlay).
	Connect string
	Token   string // shared enrollment secret the hub checks
	HostID  string // stable id this host registers under
	Docker  string // local docker endpoint to expose (unix:// or tcp://)
	// CFAccessClientID/Secret, when set, are sent as the Cloudflare Access
	// service-token headers so the agent passes Access as a machine identity
	// (leave empty if you instead bypass Access for the agent path).
	CFAccessClientID     string
	CFAccessClientSecret string
	Log                  Logger
}

// yamuxCfg enables application-level keepalive so a dead peer or an idle
// Cloudflare connection is detected (and kept warm) within ~30s.
func yamuxCfg() *yamux.Config {
	c := yamux.DefaultConfig()
	c.EnableKeepAlive = true
	c.KeepAliveInterval = 15 * time.Second
	c.ConnectionWriteTimeout = 15 * time.Second
	c.LogOutput = io.Discard
	return c
}

// Run connects to a hope hub and serves the local Docker socket over the tunnel
// until ctx is cancelled, reconnecting on drop.
func Run(ctx context.Context, opts Options) error {
	for {
		if err := serveOnce(ctx, opts); err != nil && ctx.Err() == nil {
			opts.Log.Warn("agent disconnected", "err", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

func serveOnce(ctx context.Context, opts Options) error {
	conn, err := dialHub(ctx, opts)
	if err != nil {
		return err
	}
	defer conn.Close()

	// Handshake: proto token hostID + build info (version revision go os/arch
	// buildtime) + the agent's own container id. Empty fields are "-" so
	// positions stay fixed; older hubs ignore the extra fields, older agents
	// simply omit them.
	v := version.Get()
	f := func(s string) string {
		if s == "" {
			return "-"
		}
		return s
	}
	selfID, _ := os.Hostname() // inside the container this is its short id
	if _, err := fmt.Fprintf(conn, "%s %s %s %s %s %s %s/%s %s %s %s\n",
		protoVersion, opts.Token, opts.HostID,
		f(v.Version), f(v.Revision), f(v.GoVersion), runtime.GOOS, runtime.GOARCH, f(v.BuildTime), f(selfID), capStreamTypes); err != nil {
		return err
	}
	reply, err := readLine(conn)
	if err != nil {
		return err
	}
	replyFields := strings.Fields(strings.TrimSpace(reply))
	if len(replyFields) == 0 || replyFields[0] != "OK" {
		return fmt.Errorf("hub rejected: %s", strings.TrimSpace(reply))
	}
	streamTypes := false
	for _, cap := range replyFields[1:] {
		if cap == capStreamTypes {
			streamTypes = true
		}
	}
	opts.Log.Info("agent connected", "hub", opts.Connect, "host", opts.HostID, "stream_types", streamTypes)

	// Agent accepts streams; hope (the hub) opens them.
	sess, err := yamux.Server(conn, yamuxCfg())
	if err != nil {
		return err
	}
	defer sess.Close()

	go func() {
		<-ctx.Done()
		sess.Close()
	}()

	for {
		stream, err := sess.Accept()
		if err != nil {
			return err // session closed
		}
		if streamTypes {
			go handleStream(stream, opts.Docker)
		} else {
			go proxyToDocker(stream, opts.Docker)
		}
	}
}

// handleStream dispatches a typed tunnel stream by its first line: "DIAL <addr>"
// connects to a container's ip:port on this host; anything else (DOCKER) proxies
// the docker socket. The header is read byte-by-byte so the remaining bytes are
// left intact for the proxy.
func handleStream(stream net.Conn, dockerHost string) {
	line, err := readStreamLine(stream)
	if err != nil {
		stream.Close()
		return
	}
	if addr, ok := strings.CutPrefix(line, "DIAL "); ok {
		proxyToContainer(stream, strings.TrimSpace(addr))
		return
	}
	proxyToDocker(stream, dockerHost)
}

// readStreamLine reads a single '\n'-terminated header from a stream without
// over-reading into the payload that follows.
func readStreamLine(r net.Conn) (string, error) {
	var b []byte
	one := make([]byte, 1)
	for {
		if _, err := r.Read(one); err != nil {
			return "", err
		}
		if one[0] == '\n' {
			return strings.TrimSpace(string(b)), nil
		}
		if b = append(b, one[0]); len(b) > 256 {
			return "", fmt.Errorf("stream header too long")
		}
	}
}

// proxyToContainer pipes a tunnel stream to a container's ip:port on this host.
func proxyToContainer(stream net.Conn, addr string) {
	defer stream.Close()
	d, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return
	}
	defer d.Close()
	done := make(chan struct{}, 1)
	go func() { _, _ = io.Copy(d, stream); done <- struct{}{} }()
	_, _ = io.Copy(stream, d)
	<-done
}

// dialHub opens the transport to the hub: a WebSocket (ws://, wss://) so the
// tunnel rides hope's main HTTPS port through Cloudflare, or a raw TCP socket
// (tcp://host:port or bare host:port) for a LAN/overlay hub listener.
func dialHub(ctx context.Context, opts Options) (net.Conn, error) {
	if strings.HasPrefix(opts.Connect, "ws://") || strings.HasPrefix(opts.Connect, "wss://") {
		return dialWS(ctx, opts)
	}
	addr := strings.TrimPrefix(opts.Connect, "tcp://")
	return net.DialTimeout("tcp", addr, 10*time.Second)
}

// dialWS connects over WebSocket, attaching the Cloudflare Access service-token
// headers when configured, and adapts the connection to a net.Conn for yamux.
func dialWS(ctx context.Context, opts Options) (net.Conn, error) {
	if _, err := url.Parse(opts.Connect); err != nil {
		return nil, fmt.Errorf("bad connect url %q: %w", opts.Connect, err)
	}
	hdr := http.Header{}
	if opts.CFAccessClientID != "" && opts.CFAccessClientSecret != "" {
		hdr.Set("CF-Access-Client-Id", opts.CFAccessClientID)
		hdr.Set("CF-Access-Client-Secret", opts.CFAccessClientSecret)
	}
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(dialCtx, opts.Connect, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(-1) // yamux frames span the whole tunnel; no per-message cap
	go pingWS(ctx, c)  // keep the tunnel alive through Cloudflare's idle WS reaper
	// Tie the conn lifetime to the parent ctx, not the short dial ctx.
	return websocket.NetConn(ctx, c, websocket.MessageBinary), nil
}

// wsPingInterval is well under Cloudflare's idle-WebSocket timeout (~100s) so an idle
// tunnel is never reaped.
const wsPingInterval = 20 * time.Second

// pingWS sends a WebSocket PING control frame every wsPingInterval so an idle tunnel
// stays alive through Cloudflare. It is belt-and-suspenders over yamux's in-tunnel
// keepalive: CF's edge counts a WS control frame as liveness even when no yamux data
// flows. Returns when ctx ends or a ping fails (the tunnel is already dead — the
// read/write loop surfaces the real error). Safe alongside NetConn: coder/websocket
// processes the pong on the same reader yamux is already blocked on.
func pingWS(ctx context.Context, c *websocket.Conn) {
	t := time.NewTicker(wsPingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// proxyToDocker pipes one tunnel stream to the local Docker endpoint.
func proxyToDocker(stream net.Conn, dockerHost string) {
	defer stream.Close()
	network, addr := dockerDial(dockerHost)
	d, err := net.DialTimeout(network, addr, 10*time.Second)
	if err != nil {
		return
	}
	defer d.Close()
	done := make(chan struct{}, 1)
	go func() { _, _ = io.Copy(d, stream); done <- struct{}{} }()
	_, _ = io.Copy(stream, d)
	<-done
}

// dockerDial splits a docker host URI into a net network+address.
func dockerDial(host string) (network, addr string) {
	switch {
	case strings.HasPrefix(host, "unix://"):
		return "unix", strings.TrimPrefix(host, "unix://")
	case strings.HasPrefix(host, "tcp://"):
		return "tcp", strings.TrimPrefix(host, "tcp://")
	case host == "":
		return "unix", "/var/run/docker.sock"
	default:
		return "unix", host
	}
}

// readLine reads a single '\n'-terminated line without buffering past it, so the
// remaining bytes stay on the wire for yamux.
func readLine(conn net.Conn) (string, error) {
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	defer conn.SetReadDeadline(time.Time{})
	br := bufio.NewReaderSize(oneByteReader{conn}, 1)
	return br.ReadString('\n')
}

// oneByteReader forces single-byte reads so a bufio.Reader can't pull more than
// the handshake line off the connection.
type oneByteReader struct{ r io.Reader }

func (o oneByteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return o.r.Read(p)
}
