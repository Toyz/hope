package auth

import (
	"crypto/subtle"
	"strings"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/config"
	"golang.org/x/crypto/bcrypt"
)

// AuthRouter is hope's identity surface. It implements sov's AuthService
// (Verify) so the gateway resolves bearer tokens to Claims, and exposes a
// public Login method that exchanges the configured credential for a token.
//
// Wire name: "Auth" (struct prefix). Methods: login, verify.
type AuthRouter struct {
	cfg    config.AuthConfig
	tokens *TokenManager
}

// NewAuthRouter builds the router from config, constructing the shared
// TokenManager. The same TokenManager is handed to the logstream plugin.
func NewAuthRouter(cfg config.AuthConfig) (*AuthRouter, *TokenManager) {
	tm := NewTokenManager(cfg.TokenSecret, cfg.TokenTTL, cfg.APIKeys)
	return &AuthRouter{cfg: cfg, tokens: tm}, tm
}

// PublicMethods lets the gateway/authz skip the auth gate for login —
// requiring auth to log in would be a chicken-and-egg failure.
func (r *AuthRouter) PublicMethods() []string { return []string{"login"} }

// LoginParams is the Login request body.
type LoginParams struct {
	Username string `sov:"username,0,required" json:"username"`
	Password string `sov:"password,1,required" json:"password"`
}

// LoginResult is the Login response: the bearer token and its expiry.
type LoginResult struct {
	Token     string    `json:"token"`
	Subject   string    `json:"subject"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Login verifies the single configured credential and issues a token.
func (r *AuthRouter) Login(_ *rpc.Context, p *LoginParams) (*LoginResult, error) {
	if p.Username == "" || p.Password == "" {
		return nil, rpc.BadRequest("username and password required")
	}
	if !r.checkCredential(p.Username, p.Password) {
		return nil, rpc.Unauthorized("bad credentials")
	}
	tok, exp := r.tokens.Issue(p.Username)
	return &LoginResult{Token: tok, Subject: p.Username, ExpiresAt: exp}, nil
}

// Verify is the gateway-facing endpoint: resolve a bearer token to Claims.
func (r *AuthRouter) Verify(_ *rpc.Context, p *gateway.VerifyParams) (*gateway.Claims, error) {
	if p.Token == "" {
		return nil, rpc.Unauthorized("missing token")
	}
	sub, exp, err := r.tokens.Verify(p.Token)
	if err != nil {
		return nil, rpc.Unauthorized("invalid or expired token")
	}
	return &gateway.Claims{Subject: sub, Issuer: "hope", ExpiresAt: exp}, nil
}

// checkCredential compares username + password against config. Password may
// be a bcrypt hash ("$2...") or plaintext (constant-time compared).
func (r *AuthRouter) checkCredential(username, password string) bool {
	userOK := subtle.ConstantTimeCompare([]byte(username), []byte(r.cfg.Username)) == 1
	var passOK bool
	if strings.HasPrefix(r.cfg.Password, "$2") {
		passOK = bcrypt.CompareHashAndPassword([]byte(r.cfg.Password), []byte(password)) == nil
	} else {
		passOK = subtle.ConstantTimeCompare([]byte(password), []byte(r.cfg.Password)) == 1
	}
	return userOK && passOK
}
