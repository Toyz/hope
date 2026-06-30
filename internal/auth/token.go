// Package auth provides hope's single-user login: an HMAC-signed,
// stateless bearer token plus a sov AuthService router that mints and
// verifies it. Stateless means no server session store — any hope replica
// validates a token with only the shared secret.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrInvalidToken is returned by TokenManager.Verify for any malformed,
// tampered, or expired token. Callers map it to 401.
var ErrInvalidToken = errors.New("invalid or expired token")

// TokenManager signs and verifies stateless bearer tokens with HMAC-SHA256.
// Wire form: base64url(payload) "." base64url(mac). payload is JSON
// {"sub":...,"exp":unix}.
type TokenManager struct {
	secret []byte
	ttl    time.Duration
	// now is overridable in tests; defaults to time.Now.
	now func() time.Time
}

// NewTokenManager returns a manager keyed by secret with the given TTL.
func NewTokenManager(secret string, ttl time.Duration) *TokenManager {
	return &TokenManager{secret: []byte(secret), ttl: ttl, now: time.Now}
}

type payload struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
}

// Issue mints a token for subject valid for the manager's TTL. It returns
// the token and its absolute expiry.
func (m *TokenManager) Issue(subject string) (token string, expires time.Time) {
	expires = m.now().Add(m.ttl).UTC()
	body, _ := json.Marshal(payload{Sub: subject, Exp: expires.Unix()})
	b64 := base64.RawURLEncoding.EncodeToString(body)
	return b64 + "." + m.sign(b64), expires
}

// Verify checks the signature and expiry, returning the subject and expiry.
func (m *TokenManager) Verify(token string) (subject string, expires time.Time, err error) {
	b64, mac, ok := strings.Cut(token, ".")
	if !ok {
		return "", time.Time{}, ErrInvalidToken
	}
	if subtle.ConstantTimeCompare([]byte(mac), []byte(m.sign(b64))) != 1 {
		return "", time.Time{}, ErrInvalidToken
	}
	body, err := base64.RawURLEncoding.DecodeString(b64)
	if err != nil {
		return "", time.Time{}, ErrInvalidToken
	}
	var p payload
	if err := json.Unmarshal(body, &p); err != nil || p.Sub == "" {
		return "", time.Time{}, ErrInvalidToken
	}
	exp := time.Unix(p.Exp, 0).UTC()
	if m.now().After(exp) {
		return "", time.Time{}, ErrInvalidToken
	}
	return p.Sub, exp, nil
}

func (m *TokenManager) sign(b64 string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte(b64))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// Bearer extracts the token from an "Authorization: Bearer <token>" value,
// returning ("", error) if absent or malformed. Shared by the logstream
// plugin so it can authenticate streaming requests without the gateway
// middleware.
func Bearer(authHeader string) (string, error) {
	const prefix = "Bearer "
	if !strings.HasPrefix(authHeader, prefix) {
		return "", fmt.Errorf("missing bearer token")
	}
	return strings.TrimPrefix(authHeader, prefix), nil
}
