package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// fixedClock returns a now-func pinned to t, for deterministic TTL/expiry tests.
func fixedClock(at time.Time) func() time.Time { return func() time.Time { return at } }

// signWith reproduces TokenManager.sign externally so tests can forge a
// correctly-signed-but-otherwise-invalid payload (bad base64 / bad JSON /
// empty subject) without going through Issue.
func signWith(secret, b64 string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(b64))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func TestNewTokenManagerFiltersEmptyAPIKeys(t *testing.T) {
	m := NewTokenManager("secret", time.Hour, []string{"real", "", "  ", "\t", "other"})
	if len(m.apiKeys) != 2 {
		t.Fatalf("apiKeys = %v; want the 2 non-blank keys kept", m.apiKeys)
	}
	if m.apiKeys[0] != "real" || m.apiKeys[1] != "other" {
		t.Errorf("apiKeys = %v; want [real other]", m.apiKeys)
	}
	if m.now == nil {
		t.Error("now func must default to non-nil (time.Now)")
	}
}

func TestIssueVerifyRoundTrip(t *testing.T) {
	t0 := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	m := NewTokenManager("shared-secret", time.Hour, nil)
	m.now = fixedClock(t0)

	tok, exp := m.Issue("helba")
	if want := t0.Add(time.Hour); !exp.Equal(want) {
		t.Errorf("Issue expiry = %v; want now+ttl = %v", exp, want)
	}
	if !strings.Contains(tok, ".") {
		t.Fatalf("token %q should be payload.mac", tok)
	}

	// Verify well within the TTL window.
	m.now = fixedClock(t0.Add(30 * time.Minute))
	sub, gotExp, err := m.Verify(tok)
	if err != nil {
		t.Fatalf("Verify valid token: unexpected error %v", err)
	}
	if sub != "helba" {
		t.Errorf("subject = %q; want helba", sub)
	}
	if !gotExp.Equal(time.Unix(exp.Unix(), 0).UTC()) {
		t.Errorf("Verify expiry = %v; want %v", gotExp, exp)
	}
}

func TestVerifyExpired(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	m := NewTokenManager("s", time.Hour, nil)
	m.now = fixedClock(t0)
	tok, _ := m.Issue("helba")

	// exactly at expiry is still valid (After is strict).
	m.now = fixedClock(t0.Add(time.Hour))
	if _, _, err := m.Verify(tok); err != nil {
		t.Errorf("at exact expiry should still be valid, got %v", err)
	}
	// one second past expiry is invalid.
	m.now = fixedClock(t0.Add(time.Hour + time.Second))
	if _, _, err := m.Verify(tok); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("expired token: err = %v; want ErrInvalidToken", err)
	}
}

func TestVerifyFailurePaths(t *testing.T) {
	const secret = "correct-secret"
	t0 := time.Date(2026, 5, 5, 0, 0, 0, 0, time.UTC)
	newM := func() *TokenManager {
		m := NewTokenManager(secret, time.Hour, nil)
		m.now = fixedClock(t0)
		return m
	}

	// A helper that builds a payload+mac string with a chosen secret so we can
	// forge both tampered and correctly-signed-garbage tokens.
	forge := func(b64, macSecret string) string { return b64 + "." + signWith(macSecret, b64) }
	goodBody := base64.RawURLEncoding.EncodeToString(mustJSON(t, payload{Sub: "u", Exp: t0.Add(time.Hour).Unix()}))

	cases := []struct {
		name  string
		token string
	}{
		{"no dot / malformed", "not-a-token"},
		{"empty string", ""},
		{"bad signature (wrong secret)", forge(goodBody, "attacker-secret")},
		{"tampered payload keeps old mac", func() string {
			m := newM()
			tok, _ := m.Issue("u")
			b64, mac, _ := strings.Cut(tok, ".")
			// flip a char in the payload; mac no longer matches.
			return b64 + "x." + mac
		}()},
		{"valid sig over non-base64 payload", forge("!!!not-base64!!!", secret)},
		{"valid sig over non-JSON payload", forge(base64.RawURLEncoding.EncodeToString([]byte("{not json")), secret)},
		{"valid sig but empty subject", forge(base64.RawURLEncoding.EncodeToString(mustJSON(t, payload{Sub: "", Exp: t0.Add(time.Hour).Unix()})), secret)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := newM()
			sub, exp, err := m.Verify(c.token)
			if !errors.Is(err, ErrInvalidToken) {
				t.Errorf("Verify(%q): err = %v; want ErrInvalidToken", c.token, err)
			}
			if sub != "" || !exp.IsZero() {
				t.Errorf("failed Verify should return zero values, got sub=%q exp=%v", sub, exp)
			}
		})
	}
}

func TestVerifyCrossSecretRejected(t *testing.T) {
	t0 := time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC)
	signer := NewTokenManager("secret-A", time.Hour, nil)
	signer.now = fixedClock(t0)
	tok, _ := signer.Issue("helba")

	verifier := NewTokenManager("secret-B", time.Hour, nil)
	verifier.now = fixedClock(t0)
	if _, _, err := verifier.Verify(tok); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("token from a different secret must not verify; err = %v", err)
	}
}

func TestVerifyAPIKey(t *testing.T) {
	t0 := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	m := NewTokenManager("secret", time.Hour, []string{"key-one", "key-two"})
	m.now = fixedClock(t0)

	// A matching API key authenticates as the "api" subject with ~1yr expiry.
	sub, exp, err := m.Verify("key-two")
	if err != nil {
		t.Fatalf("valid API key: unexpected error %v", err)
	}
	if sub != apiSubject {
		t.Errorf("API-key subject = %q; want %q", sub, apiSubject)
	}
	if want := t0.Add(365 * 24 * time.Hour); !exp.Equal(want) {
		t.Errorf("API-key expiry = %v; want %v", exp, want)
	}

	// A non-matching bearer falls through to HMAC parsing and fails.
	if _, _, err := m.Verify("not-a-key"); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("unknown bearer = %v; want ErrInvalidToken", err)
	}

	// A normal HMAC token still verifies even when API keys are configured.
	tok, _ := m.Issue("helba")
	if sub, _, err := m.Verify(tok); err != nil || sub != "helba" {
		t.Errorf("HMAC token alongside API keys: sub=%q err=%v", sub, err)
	}
}

func TestMatchAPIKey(t *testing.T) {
	m := NewTokenManager("s", time.Hour, []string{"alpha", "beta"})
	if !m.matchAPIKey("alpha") || !m.matchAPIKey("beta") {
		t.Error("configured keys must match")
	}
	if m.matchAPIKey("gamma") || m.matchAPIKey("") {
		t.Error("non-configured value must not match")
	}
	// No keys configured → nothing matches.
	empty := NewTokenManager("s", time.Hour, nil)
	if empty.matchAPIKey("anything") {
		t.Error("manager with no API keys must never match")
	}
}

func TestBearer(t *testing.T) {
	cases := []struct {
		name    string
		header  string
		want    string
		wantErr bool
	}{
		{"valid", "Bearer abc.def", "abc.def", false},
		{"empty token after prefix", "Bearer ", "", false},
		{"missing header", "", "", true},
		{"wrong scheme", "Token abc", "", true},
		{"lowercase scheme (case-sensitive)", "bearer abc", "", true},
		{"no space", "Bearerabc", "", true},
		{"leading space", " Bearer abc", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Bearer(c.header)
			if (err != nil) != c.wantErr {
				t.Fatalf("Bearer(%q): err = %v; wantErr = %v", c.header, err, c.wantErr)
			}
			if got != c.want {
				t.Errorf("Bearer(%q) = %q; want %q", c.header, got, c.want)
			}
		})
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
