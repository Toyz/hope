// Package hosts tracks the Docker daemons hope can drive — the local socket
// plus any connected agents — and which one is currently active. Routers resolve
// Active() per call, so switching hosts (or an agent dropping) takes effect
// immediately with no rebuild: a vanished agent transparently falls back to
// local.
package hosts

import (
	"fmt"
	"sync"
	"time"

	"github.com/toyz/hope/internal/agent"
	"github.com/toyz/hope/internal/docker"
)

// LocalID is the reserved id for the local Docker socket.
const LocalID = "local"

// Set is the live collection of hosts with a single active selection.
type Set struct {
	mu      sync.RWMutex
	local   *docker.Client
	localUp bool            // local daemon reachable at boot
	reg     *agent.Registry // connected agents (nil = no hub)
	// active is "" for AUTO (local if up, else the first connected agent),
	// LocalID for an explicit local pick, or an agent id.
	active string
}

// New builds a Set over the local client and (optional) agent registry. localUp
// reports whether the local daemon was reachable, so AUTO mode can fall back to
// a connected agent when there is no usable local socket.
func New(local *docker.Client, localUp bool, reg *agent.Registry) *Set {
	return &Set{local: local, localUp: localUp, reg: reg}
}

// firstAgent returns any connected agent's client, or nil.
func (s *Set) firstAgent() (string, *docker.Client) {
	if s.reg == nil {
		return "", nil
	}
	for _, h := range s.reg.List() {
		if c := s.reg.Get(h.ID); c != nil {
			return h.ID, c
		}
	}
	return "", nil
}

// resolve maps the current selection to a concrete (id, client). A selected
// agent that dropped, or AUTO with a dead local, falls back to a live agent so
// the UI keeps working without a manual switch.
func (s *Set) resolve() (string, *docker.Client) {
	s.mu.RLock()
	active := s.active
	s.mu.RUnlock()

	if active == LocalID {
		return LocalID, s.local
	}
	if active != "" && s.reg != nil {
		if c := s.reg.Get(active); c != nil {
			return active, c
		}
	}
	// AUTO (or a vanished selection): prefer a working local, else any agent.
	if s.localUp {
		return LocalID, s.local
	}
	if id, c := s.firstAgent(); c != nil {
		return id, c
	}
	return LocalID, s.local
}

// Active returns the docker client for the resolved active host.
func (s *Set) Active() *docker.Client { _, c := s.resolve(); return c }

// ActiveID returns the resolved active host id (what the UI should highlight).
func (s *Set) ActiveID() string { id, _ := s.resolve(); return id }

// SetActive selects the active host. LocalID selects local explicitly; any
// other id must be a currently-connected agent.
func (s *Set) SetActive(id string) error {
	if id == LocalID {
		s.mu.Lock()
		s.active = LocalID
		s.mu.Unlock()
		return nil
	}
	if s.reg == nil || s.reg.Get(id) == nil {
		return fmt.Errorf("unknown or disconnected host %q", id)
	}
	s.mu.Lock()
	s.active = id
	s.mu.Unlock()
	return nil
}

// HostClient pairs a host id/kind with its docker client, for code that fans
// out across every host (e.g. the cross-fleet overview).
type HostClient struct {
	ID     string
	Kind   string // "local" | "agent"
	Online bool
	Client *docker.Client
}

// All returns local plus every connected agent with its client, in stable order
// (local first). Used to query every host at once.
func (s *Set) All() []HostClient {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []HostClient{{ID: LocalID, Kind: "local", Online: s.localUp, Client: s.local}}
	if s.reg != nil {
		for _, h := range s.reg.List() {
			if c := s.reg.Get(h.ID); c != nil {
				out = append(out, HostClient{ID: h.ID, Kind: "agent", Online: true, Client: c})
			}
		}
	}
	return out
}

// HostView is the frontend-facing summary of one selectable host.
type HostView struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"` // "local" | "agent"
	Connected   bool       `json:"connected"`
	Active      bool       `json:"active"`
	Remote      string     `json:"remote,omitempty"`
	ConnectedAt *time.Time `json:"connected_at,omitempty"`
}

// List returns local plus every connected agent, flagging the active one.
func (s *Set) List() []HostView {
	activeID := s.ActiveID()
	out := []HostView{{
		ID:        LocalID,
		Kind:      "local",
		Connected: true,
		Active:    activeID == LocalID,
	}}
	if s.reg != nil {
		for _, h := range s.reg.List() {
			at := h.ConnectedAt
			out = append(out, HostView{
				ID:          h.ID,
				Kind:        "agent",
				Connected:   true,
				Active:      activeID == h.ID,
				Remote:      h.Remote,
				ConnectedAt: &at,
			})
		}
	}
	return out
}
