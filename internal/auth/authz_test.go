package auth

import (
	"testing"

	"github.com/Toyz/sov/gateway"
)

func TestAuthzCheck(t *testing.T) {
	r := NewAuthzRouter()
	who := &gateway.Claims{Subject: "helba"}

	cases := []struct {
		svc, method  string
		claims       *gateway.Claims
		allow, authn bool
	}{
		// public — reachable anonymously (mint a token / gateway internals / status)
		{"Auth", "login", nil, true, false},
		{"Auth", "sso", nil, true, false},
		{"Auth", "verify", nil, true, false},
		{"Meme", "nodes", nil, true, false},
		// non-public, anonymous → 401 (Authenticate), not a bare 403
		{"System", "info", nil, false, true},
		{"Containers", "stop", nil, false, true},
		{"Stacks", "redeploy", nil, false, true},
		{"Tunnels", "addTunnel", nil, false, true},
		// non-public with a subject → allowed
		{"System", "info", who, true, false},
		{"System", "setActiveHost", who, true, false},
		{"Containers", "stop", who, true, false},
	}
	for _, c := range cases {
		d, err := r.Check(nil, &gateway.CheckParams{Service: c.svc, Method: c.method, Claims: c.claims})
		if err != nil {
			t.Fatalf("%s.%s: unexpected error %v", c.svc, c.method, err)
		}
		if d.Allow != c.allow || d.Authenticate != c.authn {
			t.Errorf("%s.%s (claims=%v): got allow=%v authn=%v, want allow=%v authn=%v",
				c.svc, c.method, c.claims != nil, d.Allow, d.Authenticate, c.allow, c.authn)
		}
	}
}
