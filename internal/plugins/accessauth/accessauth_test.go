package accessauth

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Toyz/sov/gateway"
	"github.com/toyz/hope/internal/auth"
)

// errBody pulls .error.message out of an errResp payload.
func errMessage(t *testing.T, body []byte) string {
	t.Helper()
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("unmarshal error body %q: %v", body, err)
	}
	return env.Error.Message
}

func TestServeRoute(t *testing.T) {
	// A real verifier is fine for the reject paths: a token that isn't a 3-part
	// JWT fails locally in Verify (wrong segment count) with no network fetch.
	verifier := auth.NewAccessVerifier("testteam", "test-aud")
	p := New(nil, verifier)

	tests := []struct {
		name       string
		method     string
		assertion  string // Cf-Access-Jwt-Assertion header, "" = absent
		wantStatus int
		wantMsg    string
	}{
		{
			name:       "non-POST is rejected",
			method:     http.MethodGet,
			assertion:  "anything",
			wantStatus: http.StatusMethodNotAllowed,
			wantMsg:    "POST required",
		},
		{
			name:       "missing assertion header",
			method:     http.MethodPost,
			assertion:  "",
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "no access assertion",
		},
		{
			name:       "unverifiable assertion",
			method:     http.MethodPost,
			assertion:  "not-a-valid-jwt", // no dots -> Verify errors locally
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "invalid access assertion",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := &gateway.Request{Method: tt.method, Header: gateway.Header{}}
			if tt.assertion != "" {
				req.Header.Set("Cf-Access-Jwt-Assertion", tt.assertion)
			}
			resp := p.ServeRoute(context.Background(), req)
			if resp.Status != tt.wantStatus {
				t.Errorf("status = %d; want %d", resp.Status, tt.wantStatus)
			}
			if got := errMessage(t, resp.Body); got != tt.wantMsg {
				t.Errorf("message = %q; want %q", got, tt.wantMsg)
			}
			if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q; want application/json", ct)
			}
		})
	}
}

func TestPluginMeta(t *testing.T) {
	p := New(nil, nil)
	if p.PluginName() != "accessauth" {
		t.Errorf("PluginName = %q", p.PluginName())
	}
	if p.Doc() == "" {
		t.Error("Doc should be non-empty")
	}
	if want := []string{pathSSO}; len(p.RoutePatterns()) != 1 || p.RoutePatterns()[0] != want[0] {
		t.Errorf("RoutePatterns = %v; want %v", p.RoutePatterns(), want)
	}
}
