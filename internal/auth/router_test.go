package auth

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/config"
	"golang.org/x/crypto/bcrypt"
)

func newRouter(cfg config.AuthConfig) *AuthRouter {
	if cfg.TokenTTL == 0 {
		cfg.TokenTTL = time.Hour
	}
	if cfg.TokenSecret == "" {
		cfg.TokenSecret = "router-test-secret"
	}
	r, _ := NewAuthRouter(cfg)
	return r
}

// statusOf pulls the HTTP status off a sov *rpc.Error, or -1 if it isn't one.
func statusOf(err error) int {
	var e *rpc.Error
	if errors.As(err, &e) {
		return e.Status
	}
	return -1
}

func TestNewAuthRouter(t *testing.T) {
	r, tm := NewAuthRouter(config.AuthConfig{Username: "u", Password: "p", TokenSecret: "s", TokenTTL: time.Hour})
	if r == nil || tm == nil {
		t.Fatal("NewAuthRouter must return a non-nil router and token manager")
	}
	if r.tokens != tm {
		t.Error("router must share the returned TokenManager")
	}
}

func TestPublicMethods(t *testing.T) {
	if got := newRouter(config.AuthConfig{}).PublicMethods(); !reflect.DeepEqual(got, []string{"login"}) {
		t.Errorf("PublicMethods = %v; want [login]", got)
	}
}

func TestLoginPlaintext(t *testing.T) {
	r := newRouter(config.AuthConfig{Username: "helba", Password: "hunter2"})

	res, err := r.Login(nil, &LoginParams{Username: "helba", Password: "hunter2"})
	if err != nil {
		t.Fatalf("valid login: %v", err)
	}
	if res.Subject != "helba" || res.Token == "" {
		t.Errorf("login result = %+v; want subject helba + non-empty token", res)
	}
	if res.ExpiresAt.IsZero() {
		t.Error("login result must carry an expiry")
	}
	// The issued token round-trips through the same manager.
	if sub, _, err := r.tokens.Verify(res.Token); err != nil || sub != "helba" {
		t.Errorf("issued token verify: sub=%q err=%v", sub, err)
	}
}

func TestLoginBcrypt(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("s3cret"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt hash: %v", err)
	}
	r := newRouter(config.AuthConfig{Username: "helba", Password: string(hash)})

	if _, err := r.Login(nil, &LoginParams{Username: "helba", Password: "s3cret"}); err != nil {
		t.Errorf("correct bcrypt password should log in: %v", err)
	}
	if _, err := r.Login(nil, &LoginParams{Username: "helba", Password: "wrong"}); statusOf(err) != 401 {
		t.Errorf("wrong bcrypt password: status = %d; want 401", statusOf(err))
	}
}

func TestLoginFailures(t *testing.T) {
	r := newRouter(config.AuthConfig{Username: "helba", Password: "hunter2"})
	cases := []struct {
		name       string
		p          *LoginParams
		wantStatus int
	}{
		{"missing username", &LoginParams{Username: "", Password: "hunter2"}, 400},
		{"missing password", &LoginParams{Username: "helba", Password: ""}, 400},
		{"wrong username", &LoginParams{Username: "nope", Password: "hunter2"}, 401},
		{"wrong password", &LoginParams{Username: "helba", Password: "nope"}, 401},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, err := r.Login(nil, c.p)
			if res != nil {
				t.Errorf("failed login should return nil result, got %+v", res)
			}
			if got := statusOf(err); got != c.wantStatus {
				t.Errorf("status = %d; want %d (err=%v)", got, c.wantStatus, err)
			}
		})
	}
}

func TestRouterVerify(t *testing.T) {
	r := newRouter(config.AuthConfig{Username: "helba", Password: "hunter2"})
	iss, _ := r.Login(nil, &LoginParams{Username: "helba", Password: "hunter2"})

	// Valid token → Claims with hope issuer + subject.
	claims, err := r.Verify(nil, &gateway.VerifyParams{Token: iss.Token})
	if err != nil {
		t.Fatalf("Verify valid token: %v", err)
	}
	if claims.Subject != "helba" || claims.Issuer != "hope" {
		t.Errorf("claims = %+v; want subject helba, issuer hope", claims)
	}
	if claims.ExpiresAt.IsZero() {
		t.Error("claims must carry the token expiry")
	}

	// Empty token → 401.
	if _, err := r.Verify(nil, &gateway.VerifyParams{Token: ""}); statusOf(err) != 401 {
		t.Errorf("empty token: status = %d; want 401", statusOf(err))
	}
	// Garbage token → 401.
	if _, err := r.Verify(nil, &gateway.VerifyParams{Token: "garbage.token"}); statusOf(err) != 401 {
		t.Errorf("bad token: status = %d; want 401", statusOf(err))
	}
}

func TestCheckCredential(t *testing.T) {
	r := newRouter(config.AuthConfig{Username: "helba", Password: "hunter2"})
	cases := []struct {
		user, pass string
		want       bool
	}{
		{"helba", "hunter2", true},
		{"helba", "wrong", false},
		{"eve", "hunter2", false},
		{"eve", "wrong", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := r.checkCredential(c.user, c.pass); got != c.want {
			t.Errorf("checkCredential(%q,%q) = %v; want %v", c.user, c.pass, got, c.want)
		}
	}
}
