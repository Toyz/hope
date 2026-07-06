package agent

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"github.com/toyz/hope/internal/docker"
)

// AgentInfo is the remote agent's build metadata, reported in the handshake.
type AgentInfo struct {
	Version     string `json:"version"`
	Revision    string `json:"revision"`
	GoVersion   string `json:"go_version"`
	Platform    string `json:"platform"`
	BuildTime   string `json:"build_time"`
	ContainerID string `json:"container_id"` // the agent's own container id (for self-recreate)
}

// Host is a connected remote Docker host, exposed to hope as a normal
// docker.Client that happens to run over the agent tunnel.
type Host struct {
	ID          string
	Docker      *docker.Client
	Remote      string
	ConnectedAt time.Time
	Info        AgentInfo

	sess        *yamux.Session // for opening typed streams (container dial)
	streamTypes bool           // agent negotiated typed streams (DOCKER/DIAL)
}

// DialContainer opens a tunnel stream that the agent connects to addr (an
// ip:port on the agent's host) and returns it as a net.Conn. Requires a
// stream-type-capable agent.
func (h *Host) DialContainer(addr string) (net.Conn, error) {
	if !h.streamTypes || h.sess == nil {
		return nil, errors.New("agent is too old to dial containers (update the agent)")
	}
	s, err := h.sess.Open()
	if err != nil {
		return nil, err
	}
	if _, err := s.Write([]byte("DIAL " + addr + "\n")); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// Registry tracks the live agents. Safe for concurrent use.
type Registry struct {
	mu    sync.RWMutex
	hosts map[string]*Host
}

func newRegistry() *Registry { return &Registry{hosts: map[string]*Host{}} }

func (r *Registry) add(h *Host) {
	r.mu.Lock()
	if old := r.hosts[h.ID]; old != nil {
		old.Docker.Close() // a reconnect supersedes the stale session
	}
	r.hosts[h.ID] = h
	r.mu.Unlock()
}
func (r *Registry) remove(id string, h *Host) {
	r.mu.Lock()
	if r.hosts[id] == h { // don't evict a newer reconnect
		delete(r.hosts, id)
	}
	r.mu.Unlock()
}

// Get returns the docker client for a host id, or nil.
func (r *Registry) Get(id string) *docker.Client {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if h := r.hosts[id]; h != nil {
		return h.Docker
	}
	return nil
}

// Host returns the live Host for an id (build info, connection), or nil.
func (r *Registry) Host(id string) *Host {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.hosts[id]
}

// List returns the connected hosts (id + when + build info), newest-stable order.
func (r *Registry) List() []HostInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]HostInfo, 0, len(r.hosts))
	for _, h := range r.hosts {
		out = append(out, HostInfo{ID: h.ID, Remote: h.Remote, ConnectedAt: h.ConnectedAt, Info: h.Info})
	}
	return out
}

// HostInfo is the frontend-facing summary of a connected agent.
type HostInfo struct {
	ID          string    `json:"id"`
	Remote      string    `json:"remote"`
	ConnectedAt time.Time `json:"connected_at"`
	Info        AgentInfo `json:"info"`
}

// Hub accepts agent connections and registers each as a Host.
type Hub struct {
	token      string
	configPath string
	reg        *Registry
	log        Logger
	onConnect  func(ctx context.Context, h *Host)
}

// OnConnect registers a callback run for each agent once it's online, with a
// context cancelled when that agent disconnects. hope uses it to start the
// host's background jobs (registry creds, update + disk crawlers) so a remote
// host gets the same periodic work as the local daemon.
func (h *Hub) OnConnect(fn func(ctx context.Context, host *Host)) { h.onConnect = fn }

// NewHub builds a hub. token is the shared enrollment secret; configPath is the
// docker config.json for registry creds applied to remote pulls.
func NewHub(token, configPath string, log Logger) *Hub {
	return &Hub{token: token, configPath: configPath, reg: newRegistry(), log: log}
}

// Registry exposes the live hosts for routing.
func (h *Hub) Registry() *Registry { return h.reg }

// DialContainer opens a stream to a connected host's agent that connects to addr
// (ip:port) on that host, for reaching a plugin container over the tunnel.
func (h *Hub) DialContainer(hostID, addr string) (net.Conn, error) {
	host := h.reg.Host(hostID)
	if host == nil {
		return nil, fmt.Errorf("host %q is not connected", hostID)
	}
	return host.DialContainer(addr)
}

// ServeWS upgrades an HTTP request to a WebSocket and runs the agent tunnel
// over it, so the agent can reach the hub on hope's main HTTPS port (through
// Cloudflare) with no extra port. Cloudflare Access auth (service token or a
// bypass policy) is enforced at the edge before the request arrives; the shared
// token in the handshake is the second factor. ctx bounds the tunnel lifetime.
func (h *Hub) ServeWS(ctx context.Context) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
		if err != nil {
			return // Accept already wrote the error
		}
		c.SetReadLimit(-1) // yamux frames span the whole tunnel; no per-message cap
		go pingWS(ctx, c)  // keep the tunnel alive through Cloudflare's idle WS reaper
		conn := websocket.NetConn(ctx, c, websocket.MessageBinary)
		h.handle(ctx, conn) // blocks until the tunnel closes, keeping the conn open
	}
}

// Listen accepts agents on addr until ctx is cancelled.
func (h *Hub) Listen(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	go func() { <-ctx.Done(); ln.Close() }()
	var backoff time.Duration
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// A recurring Accept error (classically fd exhaustion / EMFILE) returns
			// instantly, so a bare `continue` here busy-spins a whole CPU core until
			// the condition clears. Back off with an escalating, capped delay — the
			// same strategy net/http's Server.Serve uses — so a failing listener
			// costs ~nothing instead of pegging the CPU.
			if backoff == 0 {
				backoff = 5 * time.Millisecond
			} else if backoff *= 2; backoff > time.Second {
				backoff = time.Second
			}
			if h.log != nil {
				h.log.Warn("agent listener accept failed; backing off", "err", err, "delay", backoff.String())
			}
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(backoff):
			}
			continue
		}
		backoff = 0
		go h.handle(ctx, conn)
	}
}

func (h *Hub) handle(ctx context.Context, conn net.Conn) {
	line, err := readLine(conn)
	if err != nil {
		conn.Close()
		return
	}
	parts := strings.Fields(strings.TrimSpace(line))
	if len(parts) < 3 || parts[0] != protoVersion ||
		subtle.ConstantTimeCompare([]byte(parts[1]), []byte(h.token)) != 1 {
		_, _ = conn.Write([]byte("DENIED\n"))
		conn.Close()
		return
	}
	hostID := parts[2]
	// Optional build info (newer agents): version revision go os/arch buildtime.
	var info AgentInfo
	if len(parts) >= 8 {
		deDash := func(s string) string {
			if s == "-" {
				return ""
			}
			return s
		}
		info = AgentInfo{
			Version:   deDash(parts[3]),
			Revision:  deDash(parts[4]),
			GoVersion: deDash(parts[5]),
			Platform:  deDash(parts[6]),
			BuildTime: deDash(parts[7]),
		}
		if len(parts) >= 9 {
			info.ContainerID = deDash(parts[8])
		}
	}
	// Typed-stream negotiation: a capable agent advertises capStreamTypes in a
	// trailing handshake field; hope echoes it in the OK reply only when it too
	// supports it. Both new => streams carry a DOCKER/DIAL header; any old peer =>
	// plain OK, docker-only (fully back-compatible).
	streamTypes := false
	for _, f := range parts[min(len(parts), 9):] {
		if f == capStreamTypes {
			streamTypes = true
		}
	}
	reply := "OK\n"
	if streamTypes {
		reply = "OK " + capStreamTypes + "\n"
	}
	if _, err := conn.Write([]byte(reply)); err != nil {
		conn.Close()
		return
	}

	// Hope opens streams; the agent serves them. A docker.Client over the
	// session reaches the remote daemon as if it were local.
	sess, err := yamux.Client(conn, yamuxCfg())
	if err != nil {
		conn.Close()
		return
	}
	// When typed streams are on, every docker stream is prefixed with a DOCKER
	// line so the agent can distinguish it from a container DIAL.
	dock, err := docker.NewOverDialer(h.configPath, func(_ context.Context, _, _ string) (net.Conn, error) {
		s, err := sess.Open()
		if err != nil {
			return nil, err
		}
		if streamTypes {
			if _, err := s.Write([]byte("DOCKER\n")); err != nil {
				s.Close()
				return nil, err
			}
		}
		return s, nil
	})
	if err != nil {
		sess.Close()
		return
	}
	// So recreating the agent's own container routes through the detached
	// self-updater (which runs on the remote host) instead of stopping the
	// tunnel mid-op.
	if info.ContainerID != "" {
		dock.SetSelfID(info.ContainerID)
	}
	host := &Host{ID: hostID, Docker: dock, Remote: conn.RemoteAddr().String(), ConnectedAt: time.Now(), Info: info, sess: sess, streamTypes: streamTypes}
	h.reg.add(host)
	h.log.Info("agent online", "host", hostID, "remote", host.Remote)

	// Per-session context so the host's background jobs stop when it drops.
	sessCtx, cancel := context.WithCancel(ctx)
	if h.onConnect != nil {
		h.onConnect(sessCtx, host)
	}

	select {
	case <-sess.CloseChan():
	case <-ctx.Done():
	}
	cancel()
	sess.Close()
	dock.Close()
	h.reg.remove(hostID, host)
	h.log.Info("agent offline", "host", hostID)
}
