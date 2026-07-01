package auth

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// AccessVerifier validates a Cloudflare Access JWT (the Cf-Access-Jwt-Assertion
// header set by the Access edge). It checks the RS256 signature against the
// team's published JWKS, the issuer, the application AUD, and expiry — so the
// header can't be forged. No external JWT dependency: stdlib crypto only.
type AccessVerifier struct {
	issuer   string // https://<team>.cloudflareaccess.com
	certsURL string // <issuer>/cdn-cgi/access/certs
	aud      string

	mu      sync.RWMutex
	keys    map[string]*rsa.PublicKey // kid -> key
	fetched time.Time
	client  *http.Client
}

// NewAccessVerifier builds a verifier for a Cloudflare Access team + app AUD.
// team is the subdomain ("yourteam") or the full "yourteam.cloudflareaccess.com".
func NewAccessVerifier(team, aud string) *AccessVerifier {
	domain := team
	if !strings.Contains(domain, ".") {
		domain += ".cloudflareaccess.com"
	}
	issuer := "https://" + domain
	return &AccessVerifier{
		issuer:   issuer,
		certsURL: issuer + "/cdn-cgi/access/certs",
		aud:      aud,
		keys:     map[string]*rsa.PublicKey{},
		client:   &http.Client{Timeout: 8 * time.Second},
	}
}

var errAccess = errors.New("invalid access assertion")

// Verify checks the token and returns the authenticated email on success.
func (v *AccessVerifier) Verify(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errAccess
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if b, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil || json.Unmarshal(b, &hdr) != nil {
		return "", errAccess
	}
	if hdr.Alg != "RS256" {
		return "", errAccess
	}

	key, err := v.key(hdr.Kid)
	if err != nil {
		return "", errAccess
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errAccess
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig) != nil {
		return "", errAccess
	}

	var claims struct {
		Iss   string          `json:"iss"`
		Aud   json.RawMessage `json:"aud"`
		Exp   int64           `json:"exp"`
		Email string          `json:"email"`
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(pb, &claims) != nil {
		return "", errAccess
	}
	if claims.Iss != v.issuer {
		return "", errAccess
	}
	if time.Now().After(time.Unix(claims.Exp, 0)) {
		return "", errAccess
	}
	if !audContains(claims.Aud, v.aud) {
		return "", errAccess
	}
	if claims.Email == "" {
		return "", errAccess
	}
	return claims.Email, nil
}

// audContains handles aud being either a string or a string array.
func audContains(raw json.RawMessage, want string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == want
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		if slices.Contains(many, want) {
			return true
		}
	}
	return false
}

// key returns the RSA public key for kid, refreshing the JWKS if it's unknown
// or stale (Cloudflare rotates keys).
func (v *AccessVerifier) key(kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	k, ok := v.keys[kid]
	fresh := time.Since(v.fetched) < time.Hour
	v.mu.RUnlock()
	if ok && fresh {
		return k, nil
	}
	if err := v.refresh(); err != nil && !ok {
		return nil, err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	return nil, errAccess
}

func (v *AccessVerifier) refresh() error {
	resp, err := v.client.Get(v.certsURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("access certs: %s", resp.Status)
	}
	var jwks struct {
		Keys []struct {
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return err
	}
	keys := make(map[string]*rsa.PublicKey, len(jwks.Keys))
	for _, jk := range jwks.Keys {
		nb, err := base64.RawURLEncoding.DecodeString(jk.N)
		if err != nil {
			continue
		}
		eb, err := base64.RawURLEncoding.DecodeString(jk.E)
		if err != nil {
			continue
		}
		e := 0
		for _, b := range eb {
			e = e<<8 | int(b)
		}
		keys[jk.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: e}
	}
	v.mu.Lock()
	v.keys = keys
	v.fetched = time.Now()
	v.mu.Unlock()
	return nil
}

// IssueFor mints a hope token for an Access-authenticated email.
func (m *TokenManager) IssueFor(email string) (string, time.Time) { return m.Issue(email) }
