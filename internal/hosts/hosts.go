// Package hosts tracks the Docker daemons hope can drive — the local socket
// plus any connected agents — and which one is currently active. Routers resolve
// Active() per call, so switching hosts (or an agent dropping) takes effect
// immediately with no rebuild: a vanished agent transparently falls back to
// local.
package hosts

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/toyz/hope/internal/agent"
	"github.com/toyz/hope/internal/docker"
)

// LocalID is the reserved id for the local Docker socket.
const LocalID = "local"

// ErrHostRequired is returned by RequireTarget when a host-scoped WRITE arrives
// with no explicit X-Hope-Host target. Writes must name their host so a mutation
// can never silently land on the globally-active host — a different host than the
// caller is looking at. This is the server-side backstop behind the client always
// putting the host in the URL.
var ErrHostRequired = errors.New("this operation requires an explicit host (X-Hope-Host); none was provided")

// TargetHeader is the per-request host override for headless API callers: set
// X-Hope-Host to a host id (e.g. "local" or an agent id) to run that one call
// against it, without touching the globally-active host. Absent = active host.
const TargetHeader = "X-Hope-Host"

type targetKey struct{}

// WithTarget returns a context carrying a per-request host target. Stored as a
// context value so it flows to derived contexts (timeouts) and is readable from
// both *rpc.Context and the plain context.Context used by streams/the engine.
func WithTarget(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, targetKey{}, id)
}

// TargetFrom returns the per-request host target, or "" when none was set.
func TargetFrom(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if id, ok := ctx.Value(targetKey{}).(string); ok {
		return id
	}
	return ""
}

// Set is the live collection of hosts with a single active selection.
type Set struct {
	mu      sync.RWMutex
	local   docker.API
	localUp bool            // local daemon reachable at boot
	reg     *agent.Registry // connected agents (nil = no hub)
	// active is "" for AUTO (local if up, else the first connected agent),
	// LocalID for an explicit local pick, or an agent id.
	active string
}

// New builds a Set over the local client and (optional) agent registry. localUp
// reports whether the local daemon was reachable, so AUTO mode can fall back to
// a connected agent when there is no usable local socket.
func New(local docker.API, localUp bool, reg *agent.Registry) *Set {
	return &Set{local: local, localUp: localUp, reg: reg}
}

// firstAgent returns any connected agent's client, or nil.
func (s *Set) firstAgent() (string, docker.API) {
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
func (s *Set) resolve() (string, docker.API) {
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
func (s *Set) Active() docker.API { _, c := s.resolve(); return c }

// ActiveFor returns the docker client for a request: a per-request X-Hope-Host
// target (headless API) when present and reachable, else the globally-active
// host. An unknown/disconnected target falls back to the active host so a call
// never silently runs nowhere.
func (s *Set) ActiveFor(ctx context.Context) docker.API {
	id := TargetFrom(ctx)
	if id == "" {
		return s.Active()
	}
	if id == LocalID {
		return s.local
	}
	if s.reg != nil {
		if c := s.reg.Get(id); c != nil {
			return c
		}
	}
	return s.Active()
}

// ActiveID returns the resolved active host id (what the UI should highlight).
func (s *Set) ActiveID() string { id, _ := s.resolve(); return id }

// ActiveIDFor returns the host id a request resolves to, mirroring ActiveFor's
// logic exactly (per-request X-Hope-Host target when present and reachable, else
// the globally-active host). Any per-host STATE key — a stored stack spec, an
// update cache — MUST derive from this, never from ActiveID(): ActiveID ignores
// the request target, so on a fleet it returns the globally-active host while
// ActiveFor(ctx) talks to the request's target host. Keying state off ActiveID
// while acting on ActiveFor loads/writes one host's spec against another host's
// Docker — cross-host contamination (a stack cloned onto the wrong host).
func (s *Set) ActiveIDFor(ctx context.Context) string {
	id := TargetFrom(ctx)
	if id == "" {
		return s.ActiveID()
	}
	if id == LocalID {
		return LocalID
	}
	if s.reg != nil {
		if c := s.reg.Get(id); c != nil {
			return id
		}
	}
	return s.ActiveID()
}

// RequireTarget resolves the request's EXPLICIT host target for a write. Unlike
// ActiveFor / ActiveIDFor it never falls back to the globally-active host: an
// absent target is ErrHostRequired, and a named-but-disconnected target is an
// error rather than a silent fallback. Host-scoped mutations resolve their Docker
// client through this so a write always lands on the host the caller named — or
// fails loudly. Reads keep using ActiveFor (a fallback is harmless for a read).
func (s *Set) RequireTarget(ctx context.Context) (string, docker.API, error) {
	return s.ResolveTarget(TargetFrom(ctx))
}

// ResolveTarget is RequireTarget over an explicit id (e.g. read straight off the
// X-Hope-Host header by middleware, which runs before the target lands on the
// context). Empty id -> ErrHostRequired; a named-but-disconnected host is an
// error, never a silent fallback.
func (s *Set) ResolveTarget(id string) (string, docker.API, error) {
	if id == "" {
		return "", nil, ErrHostRequired
	}
	if id == LocalID {
		if s.local == nil {
			return "", nil, fmt.Errorf("local host is unavailable")
		}
		return LocalID, s.local, nil
	}
	if s.reg != nil {
		if c := s.reg.Get(id); c != nil {
			return id, c, nil
		}
	}
	return "", nil, fmt.Errorf("host %q is not connected", id)
}

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
	Client docker.API
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

// AgentHosts returns the live agent Host records (build info + connection +
// docker client), for the agents detail view.
func (s *Set) AgentHosts() []*agent.Host {
	if s.reg == nil {
		return nil
	}
	out := []*agent.Host{}
	for _, hv := range s.reg.List() {
		if h := s.reg.Host(hv.ID); h != nil {
			out = append(out, h)
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
