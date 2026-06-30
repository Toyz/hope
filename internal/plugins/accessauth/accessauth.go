// Package accessauth is a sov RouteHandler that turns a Cloudflare Access
// assertion into a hope session. It claims POST /rpc/Auth/sso: when the request
// carries a valid Cf-Access-Jwt-Assertion (added by the Access edge), it mints a
// hope token for the asserted email — so a user who already passed Access lands
// straight in hope without a second login. Without the header (LAN/ZeroTier),
// it 401s and the SPA falls back to the password form.
package accessauth

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/Toyz/sov/gateway"
	"github.com/toyz/hope/internal/auth"
)

const pathSSO = "/rpc/Auth/sso"

// Plugin mints hope tokens from Cloudflare Access assertions.
type Plugin struct {
	tokens   *auth.TokenManager
	verifier *auth.AccessVerifier
}

var (
	_ gateway.Plugin       = (*Plugin)(nil)
	_ gateway.PluginDoc    = (*Plugin)(nil)
	_ gateway.RouteHandler = (*Plugin)(nil)
)

// New returns the plugin, wired to the shared token manager and an Access
// verifier for the configured team/AUD.
func New(tokens *auth.TokenManager, verifier *auth.AccessVerifier) *Plugin {
	return &Plugin{tokens: tokens, verifier: verifier}
}

func (p *Plugin) PluginName() string { return "accessauth" }
func (p *Plugin) Doc() string {
	return "Exchanges a Cloudflare Access assertion (Cf-Access-Jwt-Assertion) for a hope session."
}

func (p *Plugin) RoutePatterns() []string { return []string{pathSSO} }

func (p *Plugin) ServeRoute(_ context.Context, req *gateway.Request) *gateway.Response {
	if req.Method != http.MethodPost {
		return errResp(http.StatusMethodNotAllowed, "POST required")
	}
	assertion := req.Header.Get("Cf-Access-Jwt-Assertion")
	if assertion == "" {
		return errResp(http.StatusUnauthorized, "no access assertion")
	}
	email, err := p.verifier.Verify(assertion)
	if err != nil {
		return errResp(http.StatusUnauthorized, "invalid access assertion")
	}
	tok, exp := p.tokens.IssueFor(email)
	body, _ := json.Marshal(map[string]any{
		"data": map[string]any{
			"token":      tok,
			"subject":    email,
			"expires_at": exp,
		},
	})
	return &gateway.Response{
		Status: http.StatusOK,
		Header: gateway.Header{"Content-Type": "application/json"},
		Body:   body,
	}
}

func errResp(status int, msg string) *gateway.Response {
	body, _ := json.Marshal(map[string]any{
		"error": map[string]string{"code": http.StatusText(status), "message": msg},
	})
	return &gateway.Response{
		Status: status,
		Header: gateway.Header{"Content-Type": "application/json"},
		Body:   body,
	}
}
