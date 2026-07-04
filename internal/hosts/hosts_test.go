package hosts

import (
	"context"
	"testing"

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
