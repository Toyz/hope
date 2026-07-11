package auth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// --- JWT / JWKS test helpers ---------------------------------------------

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// makeJWT builds a compact JWT with the given header + claims maps, signed
// RS256 over header.payload. Callers pass a bad alg / kid via header.
func makeJWT(t *testing.T, key *rsa.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	h, err := json.Marshal(header)
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}
	c, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	signing := b64url(h) + "." + b64url(c)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signing + "." + b64url(sig)
}

// jwksJSON renders the Cloudflare-style JWKS document for one RSA public key.
func jwksJSON(kid string, pub *rsa.PublicKey) string {
	doc := map[string]any{
		"keys": []map[string]any{{
			"kid": kid,
			"n":   b64url(pub.N.Bytes()),
			"e":   b64url(big.NewInt(int64(pub.E)).Bytes()),
		}},
	}
	b, _ := json.Marshal(doc)
	return string(b)
}

// newTestVerifier wires an AccessVerifier to a JWKS server serving kid/pub.
func newTestVerifier(t *testing.T, kid string, pub *rsa.PublicKey) (*AccessVerifier, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(jwksJSON(kid, pub)))
	}))
	t.Cleanup(srv.Close)
	v := NewAccessVerifier("myteam", "my-aud")
	v.certsURL = srv.URL
	v.client = srv.Client()
	return v, srv
}

// validClaims is the baseline claim set for verifier v; individual tests mutate a copy.
func validClaims(v *AccessVerifier) map[string]any {
	return map[string]any{
		"iss":   v.issuer,
		"aud":   v.aud,
		"exp":   time.Now().Add(time.Hour).Unix(),
		"email": "helba@example.com",
	}
}

func header(kid string) map[string]any { return map[string]any{"alg": "RS256", "kid": kid} }

// --- constructor ----------------------------------------------------------

func TestNewAccessVerifierDomain(t *testing.T) {
	// bare subdomain gets the cloudflareaccess.com suffix.
	v := NewAccessVerifier("yourteam", "aud1")
	if v.issuer != "https://yourteam.cloudflareaccess.com" {
		t.Errorf("issuer = %q", v.issuer)
	}
	if v.certsURL != "https://yourteam.cloudflareaccess.com/cdn-cgi/access/certs" {
		t.Errorf("certsURL = %q", v.certsURL)
	}
	// a value already containing a dot is used as-is.
	v2 := NewAccessVerifier("custom.example.com", "aud2")
	if v2.issuer != "https://custom.example.com" {
		t.Errorf("issuer = %q; want the full domain unchanged", v2.issuer)
	}
	if v2.aud != "aud2" {
		t.Errorf("aud = %q", v2.aud)
	}
}

// --- happy path -----------------------------------------------------------

func TestAccessVerifySuccess(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)

	tok := makeJWT(t, key, header("kid-1"), validClaims(v))
	email, err := v.Verify(tok)
	if err != nil {
		t.Fatalf("Verify valid token: %v", err)
	}
	if email != "helba@example.com" {
		t.Errorf("email = %q", email)
	}
}

func TestAccessVerifyAudArray(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)

	claims := validClaims(v)
	claims["aud"] = []string{"other-aud", "my-aud"} // array form, contains want
	tok := makeJWT(t, key, header("kid-1"), claims)
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("aud array containing want should verify: %v", err)
	}
}

// --- failure paths --------------------------------------------------------

func TestAccessVerifyFailures(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048) // signs tokens the server can't validate

	cases := []struct {
		name string
		// token returns the token to verify against a fresh verifier; the closure
		// also owns building the verifier since some cases need to tamper with it.
		make func(t *testing.T) (string, *AccessVerifier)
	}{
		{"not three parts", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			return "only.two", v
		}},
		{"header not base64", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			return "!!!.payload.sig", v
		}},
		{"wrong alg", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			return makeJWT(t, key, map[string]any{"alg": "HS256", "kid": "kid-1"}, validClaims(v)), v
		}},
		{"unknown kid", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			return makeJWT(t, key, header("nope"), validClaims(v)), v
		}},
		{"bad signature (wrong key)", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			return makeJWT(t, other, header("kid-1"), validClaims(v)), v
		}},
		{"signature not base64", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			tok := makeJWT(t, key, header("kid-1"), validClaims(v))
			// replace the signature segment with non-base64 chars.
			return tok[:len(tok)-4] + "!!!!", v
		}},
		{"wrong issuer", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			c := validClaims(v)
			c["iss"] = "https://evil.cloudflareaccess.com"
			return makeJWT(t, key, header("kid-1"), c), v
		}},
		{"expired", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			c := validClaims(v)
			c["exp"] = time.Now().Add(-time.Hour).Unix()
			return makeJWT(t, key, header("kid-1"), c), v
		}},
		{"wrong aud", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			c := validClaims(v)
			c["aud"] = "some-other-aud"
			return makeJWT(t, key, header("kid-1"), c), v
		}},
		{"empty email", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			c := validClaims(v)
			c["email"] = ""
			return makeJWT(t, key, header("kid-1"), c), v
		}},
		{"claims not base64", func(t *testing.T) (string, *AccessVerifier) {
			v, _ := newTestVerifier(t, "kid-1", &key.PublicKey)
			// valid header + valid RS256 sig computed over header.payload where
			// payload isn't base64-decodable. Build manually.
			h := b64url(mustJSON(t, map[string]any{"alg": "RS256", "kid": "kid-1"}))
			p := "!!!not-base64!!!"
			sum := sha256.Sum256([]byte(h + "." + p))
			sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
			return h + "." + p + "." + b64url(sig), v
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tok, v := c.make(t)
			email, err := v.Verify(tok)
			if err != errAccess {
				t.Errorf("Verify: err = %v; want errAccess", err)
			}
			if email != "" {
				t.Errorf("failed Verify should return empty email, got %q", email)
			}
		})
	}
}

// --- audContains ----------------------------------------------------------

func TestAudContains(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"string match", `"aud-1"`, true},
		{"string mismatch", `"other"`, false},
		{"array contains", `["x","aud-1","y"]`, true},
		{"array missing", `["x","y"]`, false},
		{"neither string nor array", `12345`, false},
		{"empty array", `[]`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := audContains(json.RawMessage(c.raw), "aud-1"); got != c.want {
				t.Errorf("audContains(%s) = %v; want %v", c.raw, got, c.want)
			}
		})
	}
}

// --- JWKS refresh / caching ----------------------------------------------

func TestKeyRefreshHTTPError(t *testing.T) {
	// Server that always 500s → refresh returns an error and, with no cached
	// key, key() surfaces errAccess.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	v := NewAccessVerifier("team", "aud")
	v.certsURL = srv.URL
	v.client = srv.Client()
	// key() surfaces the raw refresh error (only Verify() maps to errAccess).
	if _, err := v.key("any-kid"); err == nil {
		t.Error("key() with 500 JWKS and no cached fallback should error")
	}
}

func TestKeyRefreshConnRefused(t *testing.T) {
	// A closed server's URL → client.Get returns a transport error path.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()
	v := NewAccessVerifier("team", "aud")
	v.certsURL = url
	if _, err := v.key("kid"); err == nil {
		t.Error("key() against a dead server should error")
	}
}

func TestKeyRefreshBadJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{not valid json"))
	}))
	t.Cleanup(srv.Close)
	v := NewAccessVerifier("team", "aud")
	v.certsURL = srv.URL
	v.client = srv.Client()
	if _, err := v.key("kid"); err == nil {
		t.Error("key() with malformed JWKS JSON should error")
	}
}

func TestKeyRefreshSkipsMalformedEntries(t *testing.T) {
	good, _ := rsa.GenerateKey(rand.Reader, 2048)
	// JWKS with a good key plus two malformed ones (bad n, bad e) that refresh
	// must skip via `continue` without aborting the whole document.
	doc := map[string]any{"keys": []map[string]any{
		{"kid": "bad-n", "n": "!!!", "e": b64url(big.NewInt(int64(good.PublicKey.E)).Bytes())},
		{"kid": "bad-e", "n": b64url(good.PublicKey.N.Bytes()), "e": "!!!"},
		{"kid": "good", "n": b64url(good.PublicKey.N.Bytes()), "e": b64url(big.NewInt(int64(good.PublicKey.E)).Bytes())},
	}}
	body, _ := json.Marshal(doc)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	v := NewAccessVerifier("team", "aud")
	v.certsURL = srv.URL
	v.client = srv.Client()

	if _, err := v.key("good"); err != nil {
		t.Errorf("good key should load despite malformed siblings: %v", err)
	}
	if _, err := v.key("bad-n"); err != errAccess {
		t.Errorf("malformed-n key should have been skipped: err = %v", err)
	}
}

func TestKeyServedFromFreshCache(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Error(w, "should not be called", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	v := NewAccessVerifier("team", "aud")
	v.certsURL = srv.URL
	v.client = srv.Client()

	// Pre-seed a fresh cache entry; key() must return it without any HTTP call.
	v.keys["cached"] = &key.PublicKey
	v.fetched = time.Now()
	if _, err := v.key("cached"); err != nil {
		t.Fatalf("cached key should return without refresh: %v", err)
	}
	if hits != 0 {
		t.Errorf("fresh cache hit made %d HTTP calls; want 0", hits)
	}
}

func TestKeyStaleTriggersRefresh(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	v, _ := newTestVerifier(t, "rotated", &key.PublicKey)

	// Seed a stale cache holding a DIFFERENT key under the same kid; a stale
	// entry forces refresh(), replacing it with the server's real key so a
	// token signed by `key` verifies.
	stale, _ := rsa.GenerateKey(rand.Reader, 2048)
	v.keys["rotated"] = &stale.PublicKey
	v.fetched = time.Now().Add(-2 * time.Hour) // stale (> 1h)

	tok := makeJWT(t, key, header("rotated"), validClaims(v))
	if _, err := v.Verify(tok); err != nil {
		t.Errorf("stale cache should refresh to the current key: %v", err)
	}
}

func TestIssueFor(t *testing.T) {
	t0 := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	m := NewTokenManager("s", 2*time.Hour, nil)
	m.now = fixedClock(t0)
	tok, exp := m.IssueFor("user@example.com")
	if want := t0.Add(2 * time.Hour); !exp.Equal(want) {
		t.Errorf("IssueFor expiry = %v; want %v", exp, want)
	}
	sub, _, err := m.Verify(tok)
	if err != nil || sub != "user@example.com" {
		t.Errorf("IssueFor token: sub=%q err=%v", sub, err)
	}
}
