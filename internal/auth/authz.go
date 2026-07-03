package auth

import (
	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
)

// publicMethods are the only endpoints reachable without a valid bearer token:
// password login and the Cloudflare-Access SSO exchange (both mint a token), the
// gateway's own token→claims resolver, and the public status feed. Keyed by the
// wire "Service.method" the gateway sends in CheckParams.
var publicMethods = map[string]bool{
	"Auth.login":  true, // password login → token
	"Auth.sso":    true, // Cloudflare Access assertion → token (accessauth plugin)
	"Auth.verify": true, // token → claims resolver
	"Meme.nodes":  true, // public fleet status feed (login strip)
}

// AuthzRouter is hope's single authorization gate. Bound via gw.RegisterAuthz, so
// sov calls Check on EVERY request — replacing the rpc.RequireSubject guard that
// was copy-pasted into every handler (and the per-router act/gate/enabled
// helpers). One policy, one place.
type AuthzRouter struct{}

// NewAuthzRouter builds the gate.
func NewAuthzRouter() *AuthzRouter { return &AuthzRouter{} }

// Check allows the public methods for anyone and requires an authenticated
// subject for everything else. An anonymous caller of a non-public method gets
// Authenticate:true → the gateway returns 401 (log in) rather than a bare 403.
func (r *AuthzRouter) Check(_ *rpc.Context, p *gateway.CheckParams) (*gateway.AuthzDecision, error) {
	if publicMethods[p.Service+"."+p.Method] {
		return &gateway.AuthzDecision{Allow: true}, nil
	}
	if p.Claims != nil && p.Claims.Subject != "" {
		return &gateway.AuthzDecision{Allow: true}, nil
	}
	return &gateway.AuthzDecision{Allow: false, Authenticate: true, Reason: "authentication required"}, nil
}
