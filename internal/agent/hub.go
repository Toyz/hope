package agent

import (
	"context"
	"crypto/subtle"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/toyz/hope/internal/docker"
)

// Host is a connected remote Docker host, exposed to hope as a normal
// docker.Client that happens to run over the agent tunnel.
type Host struct {
	ID          string
	Docker      *docker.Client
	Remote      string
	ConnectedAt time.Time
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

// List returns the connected hosts (id + when), newest-stable order.
func (r *Registry) List() []HostInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]HostInfo, 0, len(r.hosts))
	for _, h := range r.hosts {
		out = append(out, HostInfo{ID: h.ID, Remote: h.Remote, ConnectedAt: h.ConnectedAt})
	}
	return out
}

// HostInfo is the frontend-facing summary of a connected agent.
type HostInfo struct {
	ID          string    `json:"id"`
	Remote      string    `json:"remote"`
	ConnectedAt time.Time `json:"connected_at"`
}

// Hub accepts agent connections and registers each as a Host.
type Hub struct {
	token      string
	configPath string
	reg        *Registry
	log        Logger
}

// NewHub builds a hub. token is the shared enrollment secret; configPath is the
// docker config.json for registry creds applied to remote pulls.
func NewHub(token, configPath string, log Logger) *Hub {
	return &Hub{token: token, configPath: configPath, reg: newRegistry(), log: log}
}

// Registry exposes the live hosts for routing.
func (h *Hub) Registry() *Registry { return h.reg }

// Listen accepts agents on addr until ctx is cancelled.
func (h *Hub) Listen(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			continue
		}
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
	if len(parts) != 3 || parts[0] != protoVersion ||
		subtle.ConstantTimeCompare([]byte(parts[1]), []byte(h.token)) != 1 {
		_, _ = conn.Write([]byte("DENIED\n"))
		conn.Close()
		return
	}
	hostID := parts[2]
	if _, err := conn.Write([]byte("OK\n")); err != nil {
		conn.Close()
		return
	}

	// Hope opens streams; the agent serves them. A docker.Client over the
	// session reaches the remote daemon as if it were local.
	sess, err := yamux.Client(conn, nil)
	if err != nil {
		conn.Close()
		return
	}
	dock, err := docker.NewOverDialer(h.configPath, func(_ context.Context, _, _ string) (net.Conn, error) {
		return sess.Open()
	})
	if err != nil {
		sess.Close()
		return
	}
	host := &Host{ID: hostID, Docker: dock, Remote: conn.RemoteAddr().String(), ConnectedAt: time.Now()}
	h.reg.add(host)
	h.log.Info("agent online", "host", hostID, "remote", host.Remote)

	select {
	case <-sess.CloseChan():
	case <-ctx.Done():
	}
	sess.Close()
	dock.Close()
	h.reg.remove(hostID, host)
	h.log.Info("agent offline", "host", hostID)
}
