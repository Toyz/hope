package cloudflare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/toyz/hope/internal/config"
)

func TestNew(t *testing.T) {
	if c := New(config.CloudflareConfig{Enabled: false}); c != nil {
		t.Errorf("New(disabled) = %v, want nil", c)
	}
	c := New(config.CloudflareConfig{Enabled: true, APIToken: "tok", AccountID: "acct-9"})
	if c == nil {
		t.Fatal("New(enabled) = nil, want a client")
	}
	if c.AccountID() != "acct-9" {
		t.Errorf("AccountID() = %q, want acct-9", c.AccountID())
	}
	if c.token != "tok" {
		t.Errorf("token = %q, want tok", c.token)
	}
	if c.http == nil {
		t.Error("http client not initialized")
	}
}

const (
	testToken   = "cf-token-xyz"
	testAccount = "acct-123"
	apiPrefix   = "/client/v4" // apiBase's path component; the client prepends it to every request path
)

// rewriteTransport redirects a request aimed at api.cloudflare.com to the
// httptest server, preserving path/query/method/body so handlers can assert them.
// This is how we exercise do() without an overridable base URL (apiBase is a const)
// and without touching production code.
type rewriteTransport struct{ base *url.URL }

func (rt *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = rt.base.Scheme
	req.URL.Host = rt.base.Host
	return http.DefaultTransport.RoundTrip(req)
}

// newTestClient spins up an httptest server running h and returns a Client wired
// to it. Same-package construction lets us set the unexported fields directly.
func newTestClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	base, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse server url: %v", err)
	}
	return &Client{
		token:     testToken,
		accountID: testAccount,
		http:      &http.Client{Transport: &rewriteTransport{base: base}},
	}
}

// writeResult encodes a success envelope wrapping result.
func writeResult(t *testing.T, w http.ResponseWriter, result any) {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if err := json.NewEncoder(w).Encode(envelope{Success: true, Result: raw}); err != nil {
		t.Fatalf("encode envelope: %v", err)
	}
}

func decodeBody(t *testing.T, r *http.Request, out any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		t.Fatalf("decode request body: %v", err)
	}
}

func TestClientRequestHeaders(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+testToken {
			t.Errorf("Authorization = %q, want %q", got, "Bearer "+testToken)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q, want application/json", got)
		}
		// PATCH has a body -> Content-Type must be set.
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		writeResult(t, w, nil)
	})
	if err := c.RenameTunnel(context.Background(), "tun-1", "new-name"); err != nil {
		t.Fatalf("RenameTunnel: %v", err)
	}
}

func TestNoContentTypeWhenNoBody(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "" {
			t.Errorf("Content-Type = %q, want empty for a bodyless request", got)
		}
		writeResult(t, w, nil)
	})
	if err := c.DeleteTunnel(context.Background(), "tun-1"); err != nil {
		t.Fatalf("DeleteTunnel: %v", err)
	}
}

func TestCreateTunnel_TokenInResult(t *testing.T) {
	wantPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		var body map[string]any
		decodeBody(t, r, &body)
		if body["name"] != "my-tunnel" {
			t.Errorf("body name = %v, want my-tunnel", body["name"])
		}
		if body["config_src"] != "cloudflare" {
			t.Errorf("body config_src = %v, want cloudflare", body["config_src"])
		}
		writeResult(t, w, map[string]string{"id": "tun-abc", "token": "run-token-1"})
	})
	id, token, err := c.CreateTunnel(context.Background(), "my-tunnel")
	if err != nil {
		t.Fatalf("CreateTunnel: %v", err)
	}
	if id != "tun-abc" || token != "run-token-1" {
		t.Errorf("got id=%q token=%q, want tun-abc/run-token-1", id, token)
	}
}

func TestCreateTunnel_TokenFetchedSeparately(t *testing.T) {
	var sawTokenCall bool
	tokenPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel/tun-abc/token"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/cfd_tunnel"):
			// create returns no token -> triggers a token fetch
			writeResult(t, w, map[string]string{"id": "tun-abc", "token": ""})
		case r.Method == http.MethodGet && r.URL.Path == tokenPath:
			sawTokenCall = true
			writeResult(t, w, "run-token-2")
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	})
	id, token, err := c.CreateTunnel(context.Background(), "my-tunnel")
	if err != nil {
		t.Fatalf("CreateTunnel: %v", err)
	}
	if !sawTokenCall {
		t.Error("expected a separate TunnelToken fetch when create omits the token")
	}
	if id != "tun-abc" || token != "run-token-2" {
		t.Errorf("got id=%q token=%q, want tun-abc/run-token-2", id, token)
	}
}

func TestCreateTunnel_CreateFails(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":9109,"message":"no perms"}]}`))
	})
	if _, _, err := c.CreateTunnel(context.Background(), "my-tunnel"); err == nil {
		t.Fatal("expected error when create call fails")
	}
}

func TestCreateTunnel_TokenFetchFails(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/cfd_tunnel"):
			writeResult(t, w, map[string]string{"id": "tun-abc", "token": ""})
		default: // the follow-up token GET fails
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":1,"message":"boom"}]}`))
		}
	})
	if _, _, err := c.CreateTunnel(context.Background(), "my-tunnel"); err == nil {
		t.Fatal("expected error when the follow-up token fetch fails")
	}
}

func TestTunnelToken(t *testing.T) {
	wantPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel/tun-9/token"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		writeResult(t, w, "the-run-token")
	})
	tok, err := c.TunnelToken(context.Background(), "tun-9")
	if err != nil {
		t.Fatalf("TunnelToken: %v", err)
	}
	if tok != "the-run-token" {
		t.Errorf("token = %q, want the-run-token", tok)
	}
}

func TestDeleteTunnel(t *testing.T) {
	wantPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel/tun-del"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("method = %s, want DELETE", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		writeResult(t, w, nil)
	})
	if err := c.DeleteTunnel(context.Background(), "tun-del"); err != nil {
		t.Fatalf("DeleteTunnel: %v", err)
	}
}

func TestRenameTunnel(t *testing.T) {
	wantPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel/tun-r"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		var body map[string]string
		decodeBody(t, r, &body)
		if body["name"] != "renamed" {
			t.Errorf("body name = %q, want renamed", body["name"])
		}
		writeResult(t, w, nil)
	})
	if err := c.RenameTunnel(context.Background(), "tun-r", "renamed"); err != nil {
		t.Fatalf("RenameTunnel: %v", err)
	}
}

func TestTunnelConfig(t *testing.T) {
	wantPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel/tun-c/configurations"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		writeResult(t, w, map[string]any{
			"config": map[string]any{
				"ingress": []IngressRule{
					{Hostname: "a.example.com", Service: "http://web:80"},
					{Service: "http_status:404"},
				},
			},
		})
	})
	rules, err := c.TunnelConfig(context.Background(), "tun-c")
	if err != nil {
		t.Fatalf("TunnelConfig: %v", err)
	}
	want := []IngressRule{
		{Hostname: "a.example.com", Service: "http://web:80"},
		{Service: "http_status:404"},
	}
	if !reflect.DeepEqual(rules, want) {
		t.Errorf("rules = %+v, want %+v", rules, want)
	}
}

func TestPutTunnelConfig_EnforcesCatchAll(t *testing.T) {
	wantPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel/tun-p/configurations"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s, want PUT", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		var body struct {
			Config struct {
				Ingress []IngressRule `json:"ingress"`
			} `json:"config"`
		}
		decodeBody(t, r, &body)
		got := body.Config.Ingress
		if len(got) != 2 {
			t.Fatalf("ingress len = %d, want 2 (rule + appended catch-all): %+v", len(got), got)
		}
		if got[0].Hostname != "a.example.com" {
			t.Errorf("first rule host = %q, want a.example.com", got[0].Hostname)
		}
		last := got[len(got)-1]
		if last.Hostname != "" || last.Service != "http_status:404" {
			t.Errorf("last rule = %+v, want catch-all http_status:404", last)
		}
		writeResult(t, w, nil)
	})
	// Pass rules WITHOUT a catch-all; PutTunnelConfig must append exactly one.
	err := c.PutTunnelConfig(context.Background(), "tun-p", []IngressRule{
		{Hostname: "a.example.com", Service: "http://web:80"},
	})
	if err != nil {
		t.Fatalf("PutTunnelConfig: %v", err)
	}
}

func TestTunnelStatus(t *testing.T) {
	wantPath := apiPrefix + "/accounts/" + testAccount + "/cfd_tunnel/tun-s"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		writeResult(t, w, map[string]any{
			"id": "tun-s", "name": "prod", "status": "healthy", "created_at": "2026-01-01T00:00:00Z",
			"connections": []map[string]any{
				{"colo_name": "LAX", "client_version": "2026.1.0"},
			},
		})
	})
	d, err := c.TunnelStatus(context.Background(), "tun-s")
	if err != nil {
		t.Fatalf("TunnelStatus: %v", err)
	}
	if d.Name != "prod" || d.Status != "healthy" || len(d.Connections) != 1 {
		t.Errorf("detail = %+v, want prod/healthy/1 conn", d)
	}
	if d.Connections[0].ColoName != "LAX" {
		t.Errorf("colo = %q, want LAX", d.Connections[0].ColoName)
	}
}

func TestZones(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != apiPrefix+"/zones" {
			t.Errorf("path = %s, want %s", r.URL.Path, apiPrefix+"/zones")
		}
		if r.URL.Query().Get("per_page") != "200" {
			t.Errorf("per_page = %q, want 200", r.URL.Query().Get("per_page"))
		}
		writeResult(t, w, []Zone{{ID: "z1", Name: "helba.ai"}, {ID: "z2", Name: "example.com"}})
	})
	zones, err := c.Zones(context.Background())
	if err != nil {
		t.Fatalf("Zones: %v", err)
	}
	want := []Zone{{ID: "z1", Name: "helba.ai"}, {ID: "z2", Name: "example.com"}}
	if !reflect.DeepEqual(zones, want) {
		t.Errorf("zones = %+v, want %+v", zones, want)
	}
}

func TestZoneForHost(t *testing.T) {
	zones := []Zone{{ID: "z1", Name: "helba.ai"}, {ID: "z2", Name: "sub.helba.ai"}}
	newC := func() *Client {
		return newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			writeResult(t, w, zones)
		})
	}
	// Longest matching suffix wins.
	z, err := newC().ZoneForHost(context.Background(), "a.sub.helba.ai")
	if err != nil {
		t.Fatalf("ZoneForHost: %v", err)
	}
	if z.ID != "z2" {
		t.Errorf("zone = %q, want z2 (longest suffix)", z.ID)
	}
	// Exact zone-name match.
	z, err = newC().ZoneForHost(context.Background(), "helba.ai")
	if err != nil {
		t.Fatalf("ZoneForHost exact: %v", err)
	}
	if z.ID != "z1" {
		t.Errorf("zone = %q, want z1", z.ID)
	}
	// No matching zone -> error.
	if _, err := newC().ZoneForHost(context.Background(), "nope.org"); err == nil {
		t.Error("expected error for host with no matching zone")
	}
}

func TestListDNS(t *testing.T) {
	wantPath := apiPrefix + "/zones/zone-1/dns_records"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		if got := r.URL.Query().Get("name"); got != "blog.helba.ai" {
			t.Errorf("name query = %q, want blog.helba.ai", got)
		}
		writeResult(t, w, []DNSRecord{
			{ID: "rec-1", Type: "CNAME", Name: "blog.helba.ai", Content: "tun.cfargotunnel.com", Proxied: true},
		})
	})
	recs, err := c.ListDNS(context.Background(), "zone-1", "blog.helba.ai")
	if err != nil {
		t.Fatalf("ListDNS: %v", err)
	}
	if len(recs) != 1 || recs[0].ID != "rec-1" || recs[0].Type != "CNAME" {
		t.Errorf("recs = %+v, want single CNAME rec-1", recs)
	}
}

func TestCreateDNS(t *testing.T) {
	wantPath := apiPrefix + "/zones/zone-1/dns_records"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		var sent DNSRecord
		decodeBody(t, r, &sent)
		if sent.Type != "CNAME" || sent.Name != "blog.helba.ai" || sent.Content != "tun.cfargotunnel.com" || !sent.Proxied {
			t.Errorf("sent record = %+v, want proxied CNAME blog.helba.ai -> tun.cfargotunnel.com", sent)
		}
		// echo it back with an id assigned
		sent.ID = "rec-new"
		writeResult(t, w, sent)
	})
	out, err := c.CreateDNS(context.Background(), "zone-1", DNSRecord{
		Type: "CNAME", Name: "blog.helba.ai", Content: "tun.cfargotunnel.com", Proxied: true,
	})
	if err != nil {
		t.Fatalf("CreateDNS: %v", err)
	}
	if out.ID != "rec-new" {
		t.Errorf("returned id = %q, want rec-new", out.ID)
	}
}

func TestUpdateDNS(t *testing.T) {
	wantPath := apiPrefix + "/zones/zone-1/dns_records/rec-1"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		var body map[string]any
		decodeBody(t, r, &body)
		if body["content"] != "tun2.cfargotunnel.com" {
			t.Errorf("content = %v, want tun2.cfargotunnel.com", body["content"])
		}
		if body["proxied"] != true {
			t.Errorf("proxied = %v, want true", body["proxied"])
		}
		writeResult(t, w, nil)
	})
	if err := c.UpdateDNS(context.Background(), "zone-1", "rec-1", "tun2.cfargotunnel.com"); err != nil {
		t.Fatalf("UpdateDNS: %v", err)
	}
}

func TestDeleteDNS(t *testing.T) {
	wantPath := apiPrefix + "/zones/zone-1/dns_records/rec-1"
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("method = %s, want DELETE", r.Method)
		}
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		writeResult(t, w, nil)
	})
	if err := c.DeleteDNS(context.Background(), "zone-1", "rec-1"); err != nil {
		t.Fatalf("DeleteDNS: %v", err)
	}
}

// TestErrorResponses covers the non-happy paths do() must surface.
func TestErrorResponses(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		wantErrSub string
	}{
		{
			name:       "success false with errors",
			status:     http.StatusOK,
			body:       `{"success":false,"errors":[{"code":1003,"message":"invalid zone"}]}`,
			wantErrSub: "1003 invalid zone",
		},
		{
			name:       "http 4xx with cf error body",
			status:     http.StatusForbidden,
			body:       `{"success":false,"errors":[{"code":9109,"message":"unauthorized"}]}`,
			wantErrSub: "unauthorized",
		},
		{
			name:       "success false empty errors falls back to status",
			status:     http.StatusInternalServerError,
			body:       `{"success":false,"errors":[]}`,
			wantErrSub: "500",
		},
		{
			name:       "malformed json body",
			status:     http.StatusBadGateway,
			body:       `<<not json>>`,
			wantErrSub: "decode",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			// Zones is a convenient GET to drive do().
			_, err := c.Zones(context.Background())
			if err == nil {
				t.Fatalf("expected an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErrSub) {
				t.Errorf("error = %q, want it to contain %q", err.Error(), tc.wantErrSub)
			}
		})
	}
}

// TestWithCatchAll unit-tests the ingress catch-all normalizer directly.
func TestWithCatchAll(t *testing.T) {
	catchAll := IngressRule{Service: "http_status:404"}
	tests := []struct {
		name string
		in   []IngressRule
		want []IngressRule
	}{
		{
			name: "empty gets a lone catch-all",
			in:   nil,
			want: []IngressRule{catchAll},
		},
		{
			name: "appends catch-all after a real rule",
			in:   []IngressRule{{Hostname: "a.com", Service: "http://x:1"}},
			want: []IngressRule{{Hostname: "a.com", Service: "http://x:1"}, catchAll},
		},
		{
			name: "drops an existing trailing catch-all and re-adds one",
			in:   []IngressRule{{Hostname: "a.com", Service: "http://x:1"}, catchAll},
			want: []IngressRule{{Hostname: "a.com", Service: "http://x:1"}, catchAll},
		},
		{
			name: "drops a catch-all found mid-list",
			in: []IngressRule{
				{Service: "http_status:503"},
				{Hostname: "a.com", Service: "http://x:1"},
			},
			want: []IngressRule{{Hostname: "a.com", Service: "http://x:1"}, catchAll},
		},
		{
			name: "keeps an empty-host rule that is not an http_status service",
			in: []IngressRule{
				{Hostname: "", Service: "ssh://box:22"},
			},
			want: []IngressRule{{Hostname: "", Service: "ssh://box:22"}, catchAll},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := withCatchAll(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("withCatchAll(%+v) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestJoinErrors(t *testing.T) {
	tests := []struct {
		name     string
		errs     []apiError
		fallback string
		want     string
	}{
		{name: "empty uses fallback", errs: nil, fallback: "500 Server Error", want: "500 Server Error"},
		{name: "single", errs: []apiError{{Code: 1003, Message: "bad"}}, fallback: "x", want: "1003 bad"},
		{
			name:     "multiple joined",
			errs:     []apiError{{Code: 1, Message: "a"}, {Code: 2, Message: "b"}},
			fallback: "x",
			want:     "1 a; 2 b",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := joinErrors(tc.errs, tc.fallback); got != tc.want {
				t.Errorf("joinErrors = %q, want %q", got, tc.want)
			}
		})
	}
}
