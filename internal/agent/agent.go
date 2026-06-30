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
	if _, err := fmt.Fprintf(conn, "%s %s %s %s %s %s %s/%s %s %s\n",
		protoVersion, opts.Token, opts.HostID,
		f(v.Version), f(v.Revision), f(v.GoVersion), runtime.GOOS, runtime.GOARCH, f(v.BuildTime), f(selfID)); err != nil {
		return err
	}
	reply, err := readLine(conn)
	if err != nil {
		return err
	}
	if strings.TrimSpace(reply) != "OK" {
		return fmt.Errorf("hub rejected: %s", strings.TrimSpace(reply))
	}
	opts.Log.Info("agent connected", "hub", opts.Connect, "host", opts.HostID)

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
		go proxyToDocker(stream, opts.Docker)
	}
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
	// Tie the conn lifetime to the parent ctx, not the short dial ctx.
	return websocket.NetConn(ctx, c, websocket.MessageBinary), nil
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
