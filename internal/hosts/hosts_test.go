package hosts

import (
	"context"
	"errors"
	"testing"

	"github.com/toyz/hope/internal/agent"
	"github.com/toyz/hope/internal/docker"
)

// TestActiveIDForMatchesActiveFor locks the invariant behind a data-safety bug:
// a per-request X-Hope-Host target must resolve the STATE key (ActiveIDFor) to
// the same host as the Docker client (ActiveFor). ActiveID() ignores the request
// target, so keying a stored stack spec off it while deploying via ActiveFor(ctx)
// loaded one host's spec and applied it to another — cloning a stack onto the
// wrong host. ActiveIDFor must never disagree with ActiveFor.
func TestActiveIDForMatchesActiveFor(t *testing.T) {
	local := &docker.Client{} // identity sentinel; no Docker calls are made
	s := New(local, true, nil) // reg nil, local up, AUTO selection

	cases := []struct {
		name    string
		ctx     context.Context
		wantID  string
		wantLoc bool // ActiveFor should return the local client
	}{
		{"no target -> active (local)", context.Background(), LocalID, true},
		{"explicit local target", WithTarget(context.Background(), LocalID), LocalID, true},
		// Unknown/disconnected agent target: both must fall back to the active
		// host in lockstep, never split.
		{"unknown agent target falls back", WithTarget(context.Background(), "ghost-agent"), LocalID, true},
	}
	for _, c := range cases {
		gotID := s.ActiveIDFor(c.ctx)
		gotClient := s.ActiveFor(c.ctx)
		if gotID != c.wantID {
			t.Errorf("%s: ActiveIDFor = %q, want %q", c.name, gotID, c.wantID)
		}
		if (gotClient == local) != c.wantLoc {
			t.Errorf("%s: ActiveFor local=%v, want %v", c.name, gotClient == local, c.wantLoc)
		}
		// The core guarantee: id says "local" iff the client IS local.
		if (gotID == LocalID) != (gotClient == local) {
			t.Errorf("%s: ActiveIDFor/ActiveFor disagree on local (id=%q, isLocal=%v)",
				c.name, gotID, gotClient == local)
		}
	}
}

// TestTargetContext round-trips WithTarget/TargetFrom and covers the empty/nil
// edge cases, including that the value survives a derived (child) context.
func TestTargetContext(t *testing.T) {
	if got := TargetFrom(nil); got != "" { //nolint:staticcheck // exercising the nil guard
		t.Errorf("TargetFrom(nil) = %q, want empty", got)
	}
	if got := TargetFrom(context.Background()); got != "" {
		t.Errorf("TargetFrom(no target) = %q, want empty", got)
	}
	ctx := WithTarget(context.Background(), "agent-7")
	if got := TargetFrom(ctx); got != "agent-7" {
		t.Errorf("TargetFrom = %q, want agent-7", got)
	}
	// Survives derivation (a timeout/cancel child inherits the value).
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	if got := TargetFrom(child); got != "agent-7" {
		t.Errorf("TargetFrom(child) = %q, want agent-7", got)
	}
}

// TestResolveActive covers Active/ActiveID resolution across the selection states
// reachable without a live agent client: AUTO with local up/down, and an explicit
// local pick. With no reachable agent, every path resolves to local.
func TestResolveActive(t *testing.T) {
	local := &docker.Client{}
	cases := []struct {
		name    string
		set     *Set
		wantID  string
		wantLoc bool
	}{
		{"AUTO local up", New(local, true, nil), LocalID, true},
		// AUTO with a dead local and no agents still falls back to local.
		{"AUTO local down, no agents", New(local, false, nil), LocalID, true},
		// Empty registry behaves like no registry for resolution.
		{"AUTO local down, empty reg", New(local, false, &agent.Registry{}), LocalID, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.set.ActiveID(); got != c.wantID {
				t.Errorf("ActiveID = %q, want %q", got, c.wantID)
			}
			if got := c.set.Active(); (got == local) != c.wantLoc {
				t.Errorf("Active local=%v, want %v", got == local, c.wantLoc)
			}
		})
	}

	// An explicit local pick is honored.
	s := New(local, false, nil)
	if err := s.SetActive(LocalID); err != nil {
		t.Fatalf("SetActive(local): %v", err)
	}
	if s.ActiveID() != LocalID || s.Active() != local {
		t.Errorf("after SetActive(local): id=%q localclient=%v", s.ActiveID(), s.Active() == local)
	}
}

// TestSetActive covers the selection guardrails: local always OK, an unknown or
// disconnected agent errors, and an agent id with no registry errors.
func TestSetActive(t *testing.T) {
	local := &docker.Client{}
	if err := New(local, true, nil).SetActive(LocalID); err != nil {
		t.Errorf("SetActive(local) with nil reg: %v", err)
	}
	if err := New(local, true, nil).SetActive("agent-x"); err == nil {
		t.Error("SetActive(agent) with nil reg: want error")
	}
	if err := New(local, true, &agent.Registry{}).SetActive("agent-x"); err == nil {
		t.Error("SetActive(unknown agent): want error")
	}
}

// TestActiveForFallback: an X-Hope-Host target that is unknown/disconnected falls
// back to the active host (a read must never run nowhere), while an explicit local
// target returns the local client directly.
func TestActiveForFallback(t *testing.T) {
	local := &docker.Client{}
	s := New(local, true, &agent.Registry{})

	// Explicit local target.
	ctx := WithTarget(context.Background(), LocalID)
	if s.ActiveFor(ctx) != local || s.ActiveIDFor(ctx) != LocalID {
		t.Errorf("local target: client=%v id=%q", s.ActiveFor(ctx) == local, s.ActiveIDFor(ctx))
	}
	// Unknown agent target -> falls back to the active (local) host.
	ghost := WithTarget(context.Background(), "ghost")
	if s.ActiveFor(ghost) != local || s.ActiveIDFor(ghost) != LocalID {
		t.Errorf("ghost target: client=%v id=%q", s.ActiveFor(ghost) == local, s.ActiveIDFor(ghost))
	}
	// No target -> active host.
	if s.ActiveFor(context.Background()) != local {
		t.Error("no target: want active (local) client")
	}
}

// TestResolveTarget covers the strict write-path resolver, which never falls back
// to the active host: empty is ErrHostRequired, a named-but-absent host errors,
// and local resolves (or errors when the local client is nil).
func TestResolveTarget(t *testing.T) {
	local := &docker.Client{}
	s := New(local, true, &agent.Registry{})

	if _, _, err := s.ResolveTarget(""); !errors.Is(err, ErrHostRequired) {
		t.Errorf("ResolveTarget(\"\") err = %v, want ErrHostRequired", err)
	}
	id, c, err := s.ResolveTarget(LocalID)
	if err != nil || id != LocalID || c != local {
		t.Errorf("ResolveTarget(local) = (%q, %v, %v)", id, c == local, err)
	}
	if _, _, err := s.ResolveTarget("ghost"); err == nil {
		t.Error("ResolveTarget(ghost): want error")
	}
	// RequireTarget reads the target off the context and defers to ResolveTarget.
	if _, _, err := s.RequireTarget(context.Background()); !errors.Is(err, ErrHostRequired) {
		t.Errorf("RequireTarget(no target) err = %v, want ErrHostRequired", err)
	}
	if _, _, err := s.RequireTarget(WithTarget(context.Background(), LocalID)); err != nil {
		t.Errorf("RequireTarget(local): %v", err)
	}

	// A nil local client makes an explicit local target unavailable, not a fallback.
	if _, _, err := New(nil, false, nil).ResolveTarget(LocalID); err == nil {
		t.Error("ResolveTarget(local) with nil client: want unavailable error")
	}
}

// TestAllListAgentHosts covers the fan-out/enumeration helpers with only the local
// host present (no live agents constructible from outside the agent package).
func TestAllListAgentHosts(t *testing.T) {
	local := &docker.Client{}
	s := New(local, true, &agent.Registry{})

	all := s.All()
	if len(all) != 1 || all[0].ID != LocalID || all[0].Kind != "local" || !all[0].Online || all[0].Client != local {
		t.Errorf("All() = %+v", all)
	}

	list := s.List()
	if len(list) != 1 || list[0].ID != LocalID || !list[0].Connected || !list[0].Active {
		t.Errorf("List() = %+v", list)
	}

	// AgentHosts: nil registry -> nil; empty registry -> empty (non-nil) slice.
	if hs := New(local, true, nil).AgentHosts(); hs != nil {
		t.Errorf("AgentHosts() with nil reg = %+v, want nil", hs)
	}
	if hs := s.AgentHosts(); len(hs) != 0 {
		t.Errorf("AgentHosts() with empty reg = %+v, want empty", hs)
	}
}
