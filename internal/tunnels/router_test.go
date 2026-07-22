package tunnels

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/cloudflare"
	"github.com/toyz/hope/internal/config"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// ── docker mock ────────────────────────────────────────────────────────────
//
// mockAPI embeds docker.API (so any un-overridden method panics on a nil deref
// if a test path unexpectedly reaches it) and stubs only the handful of methods
// the TunnelsRouter touches. Each field defaults to a benign zero-value response
// when nil, so a test sets only what it exercises.
type mockAPI struct {
	docker.API
	connectors        func(ctx context.Context) ([]docker.Connector, error)
	cachedStatus      func(ref string) string
	originIndex       func(ctx context.Context) (map[string]docker.OriginRef, error)
	deployConnector   func(ctx context.Context, name, tunnelID, token string, isDefault bool) (string, error)
	remove            func(ctx context.Context, id string) error
	attachNetwork     func(ctx context.Context, containerID, netName string, aliases []string) error
	detachNetwork     func(ctx context.Context, containerID, netName string) error
	containerNetworks func(ctx context.Context, id string) ([]string, error)
	ensureTunnelsNet  func(ctx context.Context) (string, error)
	stacks            func(ctx context.Context) ([]docker.StackSummary, error)
}

func (m *mockAPI) Connectors(ctx context.Context) ([]docker.Connector, error) {
	if m.connectors == nil {
		return nil, nil
	}
	return m.connectors(ctx)
}
func (m *mockAPI) CachedStatus(ref string) string {
	if m.cachedStatus == nil {
		return ""
	}
	return m.cachedStatus(ref)
}
func (m *mockAPI) OriginIndex(ctx context.Context) (map[string]docker.OriginRef, error) {
	if m.originIndex == nil {
		return map[string]docker.OriginRef{}, nil
	}
	return m.originIndex(ctx)
}
func (m *mockAPI) DeployConnector(ctx context.Context, name, tunnelID, token string, isDefault bool) (string, error) {
	if m.deployConnector == nil {
		return "", nil
	}
	return m.deployConnector(ctx, name, tunnelID, token, isDefault)
}
func (m *mockAPI) Remove(ctx context.Context, id string) error {
	if m.remove == nil {
		return nil
	}
	return m.remove(ctx, id)
}
func (m *mockAPI) AttachNetwork(ctx context.Context, containerID, netName string, aliases []string) error {
	if m.attachNetwork == nil {
		return nil
	}
	return m.attachNetwork(ctx, containerID, netName, aliases)
}
func (m *mockAPI) DetachNetwork(ctx context.Context, containerID, netName string) error {
	if m.detachNetwork == nil {
		return nil
	}
	return m.detachNetwork(ctx, containerID, netName)
}
func (m *mockAPI) ContainerNetworks(ctx context.Context, id string) ([]string, error) {
	if m.containerNetworks == nil {
		return nil, nil
	}
	return m.containerNetworks(ctx, id)
}
func (m *mockAPI) EnsureTunnelsNetwork(ctx context.Context) (string, error) {
	if m.ensureTunnelsNet == nil {
		return "", nil
	}
	return m.ensureTunnelsNet(ctx)
}
func (m *mockAPI) Stacks(ctx context.Context) ([]docker.StackSummary, error) {
	if m.stacks == nil {
		return nil, nil
	}
	return m.stacks(ctx)
}

// ── cloudflare fake ────────────────────────────────────────────────────────
//
// cfFake is an httptest handler speaking the slice of the Cloudflare API the
// router drives. Each hook is optional; a nil hook returns a benign success.
// A non-empty returned error string is surfaced as a Cloudflare error envelope
// (HTTP 500, success:false) so the client's do() returns an error.
type cfFake struct {
	createTunnel func(name string) (id, token, errMsg string)
	deleteTunnel func(id string) (errMsg string)
	renameTunnel func(id, name string) (errMsg string)
	tunnelConfig func(id string) (rules []cloudflare.IngressRule, errMsg string)
	putConfig    func(id string, rules []cloudflare.IngressRule) (errMsg string)
	tunnelStatus func(id string) (d cloudflare.TunnelDetail, errMsg string)
	zones        func() (z []cloudflare.Zone, errMsg string)
	listDNS      func(zoneID, name string) (recs []cloudflare.DNSRecord, errMsg string)
	createDNS    func(zoneID string, rec cloudflare.DNSRecord) (out cloudflare.DNSRecord, errMsg string)
	updateDNS    func(zoneID, recID, content string) (errMsg string)
	deleteDNS    func(zoneID, recID string) (errMsg string)
}

func cfWriteOK(w http.ResponseWriter, result any) {
	raw, _ := json.Marshal(result)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": json.RawMessage(raw)})
}

func cfWriteErr(w http.ResponseWriter, msg string) {
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": false,
		"errors":  []map[string]any{{"code": 1, "message": msg}},
	})
}

func (f *cfFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	seg := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/client/v4"), "/"), "/")
	switch {
	// /accounts/{acct}/cfd_tunnel[...]
	case len(seg) >= 3 && seg[0] == "accounts" && seg[2] == "cfd_tunnel":
		f.serveTunnel(w, r, seg)
	// /zones[...]
	case len(seg) >= 1 && seg[0] == "zones":
		f.serveZones(w, r, seg)
	default:
		cfWriteErr(w, "cfFake: unrouted "+r.Method+" "+r.URL.Path)
	}
}

func (f *cfFake) serveTunnel(w http.ResponseWriter, r *http.Request, seg []string) {
	// seg: accounts {acct} cfd_tunnel [id] [sub]
	if len(seg) == 3 && r.Method == http.MethodPost { // create
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		id, token, errMsg := "tun-created", "run-tok", ""
		if f.createTunnel != nil {
			id, token, errMsg = f.createTunnel(body.Name)
		}
		if errMsg != "" {
			cfWriteErr(w, errMsg)
			return
		}
		cfWriteOK(w, map[string]string{"id": id, "token": token})
		return
	}
	if len(seg) < 4 {
		cfWriteErr(w, "cfFake: bad tunnel path")
		return
	}
	id := seg[3]
	switch {
	case len(seg) == 4 && r.Method == http.MethodDelete:
		errMsg := ""
		if f.deleteTunnel != nil {
			errMsg = f.deleteTunnel(id)
		}
		reply(w, errMsg, nil)
	case len(seg) == 4 && r.Method == http.MethodPatch:
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		errMsg := ""
		if f.renameTunnel != nil {
			errMsg = f.renameTunnel(id, body.Name)
		}
		reply(w, errMsg, nil)
	case len(seg) == 4 && r.Method == http.MethodGet: // status
		d := cloudflare.TunnelDetail{ID: id, Status: "healthy"}
		errMsg := ""
		if f.tunnelStatus != nil {
			d, errMsg = f.tunnelStatus(id)
		}
		reply(w, errMsg, d)
	case len(seg) == 5 && seg[4] == "token" && r.Method == http.MethodGet:
		cfWriteOK(w, "run-tok")
	case len(seg) == 5 && seg[4] == "configurations" && r.Method == http.MethodGet:
		var rules []cloudflare.IngressRule
		errMsg := ""
		if f.tunnelConfig != nil {
			rules, errMsg = f.tunnelConfig(id)
		}
		if errMsg != "" {
			cfWriteErr(w, errMsg)
			return
		}
		cfWriteOK(w, map[string]any{"config": map[string]any{"ingress": rules}})
	case len(seg) == 5 && seg[4] == "configurations" && r.Method == http.MethodPut:
		var body struct {
			Config struct {
				Ingress []cloudflare.IngressRule `json:"ingress"`
			} `json:"config"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		errMsg := ""
		if f.putConfig != nil {
			errMsg = f.putConfig(id, body.Config.Ingress)
		}
		reply(w, errMsg, nil)
	default:
		cfWriteErr(w, "cfFake: unrouted tunnel "+r.Method)
	}
}

func (f *cfFake) serveZones(w http.ResponseWriter, r *http.Request, seg []string) {
	// seg: zones [zone] [dns_records] [rec]
	if len(seg) == 1 && r.Method == http.MethodGet {
		var z []cloudflare.Zone
		errMsg := ""
		if f.zones != nil {
			z, errMsg = f.zones()
		}
		reply(w, errMsg, z)
		return
	}
	if len(seg) < 3 || seg[2] != "dns_records" {
		cfWriteErr(w, "cfFake: bad zones path")
		return
	}
	zoneID := seg[1]
	switch {
	case len(seg) == 3 && r.Method == http.MethodGet:
		var recs []cloudflare.DNSRecord
		errMsg := ""
		if f.listDNS != nil {
			recs, errMsg = f.listDNS(zoneID, r.URL.Query().Get("name"))
		}
		reply(w, errMsg, recs)
	case len(seg) == 3 && r.Method == http.MethodPost:
		var rec cloudflare.DNSRecord
		_ = json.NewDecoder(r.Body).Decode(&rec)
		out, errMsg := rec, ""
		out.ID = "rec-created"
		if f.createDNS != nil {
			out, errMsg = f.createDNS(zoneID, rec)
		}
		reply(w, errMsg, out)
	case len(seg) == 4 && r.Method == http.MethodPatch:
		var body struct {
			Content string `json:"content"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		errMsg := ""
		if f.updateDNS != nil {
			errMsg = f.updateDNS(zoneID, seg[3], body.Content)
		}
		reply(w, errMsg, nil)
	case len(seg) == 4 && r.Method == http.MethodDelete:
		errMsg := ""
		if f.deleteDNS != nil {
			errMsg = f.deleteDNS(zoneID, seg[3])
		}
		reply(w, errMsg, nil)
	default:
		cfWriteErr(w, "cfFake: unrouted dns "+r.Method)
	}
}

func reply(w http.ResponseWriter, errMsg string, result any) {
	if errMsg != "" {
		cfWriteErr(w, errMsg)
		return
	}
	cfWriteOK(w, result)
}

// cfRewriteTransport redirects the real cloudflare.Client's requests (aimed at
// api.cloudflare.com) to the httptest server, keeping path/method/body intact.
type cfRewriteTransport struct {
	base *url.URL
	next http.RoundTripper
}

func (t *cfRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = t.base.Scheme
	req.URL.Host = t.base.Host
	return t.next.RoundTrip(req)
}

// newCF spins up f on an httptest server and returns a REAL cloudflare.Client
// pointed at it. cloudflare.New builds an *http.Client with a nil Transport, so
// it uses http.DefaultTransport; overriding that global (restored on cleanup)
// redirects the client without any production change. Tests using it must not
// run in parallel — the Go test runner runs package tests serially by default.
func newCF(t *testing.T, f *cfFake) *cloudflare.Client {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	base, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse server url: %v", err)
	}
	orig := http.DefaultTransport
	http.DefaultTransport = &cfRewriteTransport{base: base, next: orig}
	t.Cleanup(func() { http.DefaultTransport = orig })
	return cloudflare.New(config.CloudflareConfig{Enabled: true, APIToken: "test-tok", AccountID: "acct-test"})
}

// newRouter wires a router over the mock docker API + CF client with a local
// target on the context.
func newRouter(m *mockAPI, cf *cloudflare.Client) (*TunnelsRouter, *rpc.Context) {
	hs := hosts.New(m, true, nil)
	r := NewTunnelsRouter(hs, cf, nil, nil) // nil bus: Publish is nil-safe
	rctx := rpc.NewContext(hosts.WithTarget(context.Background(), hosts.LocalID))
	return r, rctx
}

// wantStatus asserts err is an *rpc.Error with the given HTTP status.
func wantStatus(t *testing.T, err error, status int) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected *rpc.Error status %d, got nil", status)
	}
	var re *rpc.Error
	if !errors.As(err, &re) {
		t.Fatalf("error %v (%T) is not *rpc.Error", err, err)
	}
	if re.Status != status {
		t.Fatalf("status = %d, want %d (err=%v)", re.Status, status, err)
	}
}

// ── enabled gate ───────────────────────────────────────────────────────────

func TestEnabledGate(t *testing.T) {
	r, rctx := newRouter(&mockAPI{}, nil) // no CF client -> integration disabled
	if _, err := r.Connectors(rctx); err == nil {
		t.Fatal("Connectors with nil cf: want disabled error")
	} else {
		wantStatus(t, err, 400)
	}
	if _, err := r.Zones(rctx); err == nil {
		t.Fatal("Zones with nil cf: want disabled error")
	}
	if _, err := r.Tunnels(rctx); err == nil {
		t.Fatal("Tunnels with nil cf: want disabled error")
	}
}

// ── Connectors ─────────────────────────────────────────────────────────────

func TestConnectors(t *testing.T) {
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", Name: "conn", TunnelID: "tun1", Image: "img:1", Running: true}}, nil
		},
		cachedStatus: func(ref string) string {
			if ref == "img:1" {
				return "outdated"
			}
			return ""
		},
	}
	cf := newCF(t, &cfFake{
		tunnelStatus: func(id string) (cloudflare.TunnelDetail, string) {
			d := cloudflare.TunnelDetail{ID: id, Name: "prod", Status: "healthy", CreatedAt: "2026-01-01T00:00:00Z"}
			d.Connections = append(d.Connections, struct {
				ColoName           string `json:"colo_name"`
				ClientVersion      string `json:"client_version"`
				OpenedAt           string `json:"opened_at"`
				IsPendingReconnect bool   `json:"is_pending_reconnect"`
			}{ColoName: "LAX", ClientVersion: "2026.1.0"})
			return d, ""
		},
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{rule("a.com", "", "http://x:1"), rule("", "", "http_status:404")}, ""
		},
	})
	r, rctx := newRouter(m, cf)
	out, err := r.Connectors(rctx)
	if err != nil {
		t.Fatalf("Connectors: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("len = %d, want 1", len(out))
	}
	v := out[0]
	if !v.UpdateReady {
		t.Error("UpdateReady = false, want true (image outdated)")
	}
	if !v.Online || v.Status != "healthy" {
		t.Errorf("online=%v status=%q, want online healthy", v.Online, v.Status)
	}
	if v.Connections != 1 || len(v.Colos) != 1 || v.Colos[0] != "LAX" {
		t.Errorf("connections=%d colos=%v, want 1 [LAX]", v.Connections, v.Colos)
	}
	if v.Version != "2026.1.0" {
		t.Errorf("version = %q, want 2026.1.0", v.Version)
	}
	if v.Title != "prod" {
		t.Errorf("title = %q, want live name prod", v.Title)
	}
	if v.Routes != 1 {
		t.Errorf("routes = %d, want 1", v.Routes)
	}
}

func TestConnectors_DockerError(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return nil, errors.New("docker down")
	}}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.Connectors(rctx)
	wantStatus(t, err, 500)
}

// ── Tunnels ────────────────────────────────────────────────────────────────

func TestTunnels(t *testing.T) {
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", Name: "conn", TunnelID: "tun1"}}, nil
		},
		originIndex: func(context.Context) (map[string]docker.OriginRef, error) {
			return map[string]docker.OriginRef{
				"web-1": {ContainerID: "web1", Name: "web-1", Project: "blog", Service: "web"},
			}, nil
		},
	}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{
				rule("app.example.com", "", "http://web-1:8080"),
				rule("", "", "http_status:404"), // catch-all skipped
			}, ""
		},
	})
	r, rctx := newRouter(m, cf)
	out, err := r.Tunnels(rctx)
	if err != nil {
		t.Fatalf("Tunnels: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("len = %d, want 1 (catch-all excluded)", len(out))
	}
	tv := out[0]
	if tv.Hostname != "app.example.com" || tv.Port != "8080" {
		t.Errorf("host=%q port=%q, want app.example.com/8080", tv.Hostname, tv.Port)
	}
	if tv.Project != "blog" || tv.SvcName != "web" || tv.Container != "web-1" || tv.ContainerID != "web1" {
		t.Errorf("origin resolution = %+v, want blog/web/web-1/web1", tv)
	}
}

func TestTunnels_Errors(t *testing.T) {
	cf := newCF(t, &cfFake{})
	// Connectors error.
	r, rctx := newRouter(&mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return nil, errors.New("boom")
	}}, cf)
	wantStatusFromTunnels(t, r, rctx)
	// OriginIndex error.
	r, rctx = newRouter(&mockAPI{
		connectors:  func(context.Context) ([]docker.Connector, error) { return nil, nil },
		originIndex: func(context.Context) (map[string]docker.OriginRef, error) { return nil, errors.New("idx") },
	}, cf)
	wantStatusFromTunnels(t, r, rctx)
}

func wantStatusFromTunnels(t *testing.T, r *TunnelsRouter, rctx *rpc.Context) {
	t.Helper()
	_, err := r.Tunnels(rctx)
	wantStatus(t, err, 500)
}

// ── Zones ──────────────────────────────────────────────────────────────────

func TestZones(t *testing.T) {
	cf := newCF(t, &cfFake{zones: func() ([]cloudflare.Zone, string) {
		return []cloudflare.Zone{{ID: "z1", Name: "a.com"}, {ID: "z2", Name: "b.com"}}, ""
	}})
	r, rctx := newRouter(&mockAPI{}, cf)
	out, err := r.Zones(rctx)
	if err != nil {
		t.Fatalf("Zones: %v", err)
	}
	if len(out) != 2 || out[0].Name != "a.com" || out[1].Name != "b.com" {
		t.Errorf("zones = %+v, want a.com,b.com", out)
	}
}

func TestZones_Error(t *testing.T) {
	cf := newCF(t, &cfFake{zones: func() ([]cloudflare.Zone, string) { return nil, "no perms" }})
	r, rctx := newRouter(&mockAPI{}, cf)
	_, err := r.Zones(rctx)
	wantStatus(t, err, 500)
}

// ── CreateConnector ────────────────────────────────────────────────────────

func TestCreateConnector_Happy(t *testing.T) {
	var deployed bool
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) { return nil, nil }, // no default yet
		deployConnector: func(_ context.Context, name, tunnelID, token string, isDefault bool) (string, error) {
			deployed = true
			if name != "edge" || tunnelID != "tun-new" || token != "tok-x" || !isDefault {
				t.Errorf("DeployConnector args = %q/%q/%q/%v, want edge/tun-new/tok-x/true", name, tunnelID, token, isDefault)
			}
			return "cid-new", nil
		},
	}
	var deletedTunnel string
	cf := newCF(t, &cfFake{
		createTunnel: func(name string) (string, string, string) { return "tun-new", "tok-x", "" },
		deleteTunnel: func(id string) string { deletedTunnel = id; return "" },
	})
	r, rctx := newRouter(m, cf)
	con, err := r.CreateConnector(rctx, &CreateConnectorParams{Name: "edge"})
	if err != nil {
		t.Fatalf("CreateConnector: %v", err)
	}
	if !deployed {
		t.Error("DeployConnector was not called")
	}
	if deletedTunnel != "" {
		t.Errorf("DeleteTunnel called (%q) on the happy path; want no rollback", deletedTunnel)
	}
	if con.ContainerID != "cid-new" || con.TunnelID != "tun-new" || !con.Default || !con.Running {
		t.Errorf("connector = %+v, want cid-new/tun-new/default/running", con)
	}
}

func TestCreateConnector_EmptyName(t *testing.T) {
	r, rctx := newRouter(&mockAPI{}, newCF(t, &cfFake{}))
	_, err := r.CreateConnector(rctx, &CreateConnectorParams{Name: "   "})
	wantStatus(t, err, 400)
}

func TestCreateConnector_CreateTunnelFails(t *testing.T) {
	var deployed bool
	m := &mockAPI{deployConnector: func(context.Context, string, string, string, bool) (string, error) {
		deployed = true
		return "", nil
	}}
	cf := newCF(t, &cfFake{createTunnel: func(string) (string, string, string) { return "", "", "quota exceeded" }})
	r, rctx := newRouter(m, cf)
	_, err := r.CreateConnector(rctx, &CreateConnectorParams{Name: "edge"})
	wantStatus(t, err, 500)
	if deployed {
		t.Error("DeployConnector must not run when CreateTunnel fails")
	}
}

// SECURITY: a failed DeployConnector must roll back (delete) the just-created
// tunnel so no orphan tunnel is left behind.
func TestCreateConnector_RollsBackTunnelOnDeployFailure(t *testing.T) {
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) { return nil, nil },
		deployConnector: func(context.Context, string, string, string, bool) (string, error) {
			return "", errors.New("image pull failed")
		},
	}
	var deleted string
	cf := newCF(t, &cfFake{
		createTunnel: func(string) (string, string, string) { return "tun-orphan", "tok", "" },
		deleteTunnel: func(id string) string { deleted = id; return "" },
	})
	r, rctx := newRouter(m, cf)
	_, err := r.CreateConnector(rctx, &CreateConnectorParams{Name: "edge"})
	wantStatus(t, err, 500)
	if deleted != "tun-orphan" {
		t.Errorf("rollback DeleteTunnel = %q, want tun-orphan (orphan tunnel not cleaned up)", deleted)
	}
}

// ── RenameConnector ────────────────────────────────────────────────────────

func TestRenameConnector(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	var renamed string
	cf := newCF(t, &cfFake{renameTunnel: func(id, name string) string {
		if id != "tun1" {
			t.Errorf("rename id = %q, want tun1", id)
		}
		renamed = name
		return ""
	}})
	r, rctx := newRouter(m, cf)
	res, err := r.RenameConnector(rctx, &RenameConnectorParams{ID: "cid1", Name: "  new-name  "})
	if err != nil {
		t.Fatalf("RenameConnector: %v", err)
	}
	if !res.OK {
		t.Error("OK = false")
	}
	if renamed != "new-name" {
		t.Errorf("renamed to %q, want trimmed new-name", renamed)
	}
}

func TestRenameConnector_Validation(t *testing.T) {
	// empty name
	r, rctx := newRouter(&mockAPI{}, newCF(t, &cfFake{}))
	_, err := r.RenameConnector(rctx, &RenameConnectorParams{ID: "cid1", Name: " "})
	wantStatus(t, err, 400)
	// connector not found
	r, rctx = newRouter(&mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return nil, nil
	}}, newCF(t, &cfFake{}))
	_, err = r.RenameConnector(rctx, &RenameConnectorParams{ID: "nope", Name: "x"})
	wantStatus(t, err, 404)
}

func TestRenameConnector_CFError(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{renameTunnel: func(string, string) string { return "denied" }})
	r, rctx := newRouter(m, cf)
	_, err := r.RenameConnector(rctx, &RenameConnectorParams{ID: "cid1", Name: "x"})
	wantStatus(t, err, 500)
}

// ── RemoveConnector ────────────────────────────────────────────────────────

func TestRemoveConnector_NoDelete(t *testing.T) {
	var removed string
	var deletedTunnel bool
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
		},
		remove: func(_ context.Context, id string) error { removed = id; return nil },
	}
	cf := newCF(t, &cfFake{deleteTunnel: func(string) string { deletedTunnel = true; return "" }})
	r, rctx := newRouter(m, cf)
	res, err := r.RemoveConnector(rctx, &RemoveConnectorParams{ID: "cid1", DeleteTunnel: false})
	if err != nil {
		t.Fatalf("RemoveConnector: %v", err)
	}
	if !res.OK || removed != "cid1" {
		t.Errorf("OK=%v removed=%q, want true/cid1", res.OK, removed)
	}
	if deletedTunnel {
		t.Error("DeleteTunnel called though DeleteTunnel=false")
	}
}

func TestRemoveConnector_WithDelete(t *testing.T) {
	var deleted string
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{deleteTunnel: func(id string) string { deleted = id; return "" }})
	r, rctx := newRouter(m, cf)
	res, err := r.RemoveConnector(rctx, &RemoveConnectorParams{ID: "cid1", DeleteTunnel: true})
	if err != nil {
		t.Fatalf("RemoveConnector: %v", err)
	}
	if !res.OK || deleted != "tun1" {
		t.Errorf("OK=%v deleted=%q, want true/tun1", res.OK, deleted)
	}
}

func TestRemoveConnector_RemoveFails(t *testing.T) {
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
		},
		remove: func(context.Context, string) error { return errors.New("still running") },
	}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.RemoveConnector(rctx, &RemoveConnectorParams{ID: "cid1"})
	wantStatus(t, err, 500)
}

func TestRemoveConnector_TunnelDeleteFailsIsSoft(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{deleteTunnel: func(string) string { return "has connections" }})
	r, rctx := newRouter(m, cf)
	res, err := r.RemoveConnector(rctx, &RemoveConnectorParams{ID: "cid1", DeleteTunnel: true})
	if err != nil {
		t.Fatalf("expected soft failure, got err %v", err)
	}
	if res.OK || !strings.Contains(res.Error, "tunnel delete failed") {
		t.Errorf("res = %+v, want OK=false with a tunnel-delete-failed message", res)
	}
}

func TestRemoveConnector_NotFound(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) { return nil, nil }}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.RemoveConnector(rctx, &RemoveConnectorParams{ID: "ghost"})
	wantStatus(t, err, 404)
}

// SECURITY: teardown runs on a context detached from the request, so a client
// disconnect mid-op (which cancels the request ctx) can't leave the container
// stopped-not-removed or the tunnel orphaned. We cancel the request ctx up front
// and assert the ctx handed to Remove/DeleteTunnel is NOT cancelled.
func TestRemoveConnector_DetachesFromRequestCtx(t *testing.T) {
	var removeCtxErr, deleteCtxErr error
	sawRemove, sawDelete := false, false
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
		},
		remove: func(ctx context.Context, id string) error {
			sawRemove, removeCtxErr = true, ctx.Err()
			return nil
		},
	}
	cf := newCF(t, &cfFake{deleteTunnel: func(string) string { sawDelete = true; return "" }})

	hs := hosts.New(m, true, nil)
	r := NewTunnelsRouter(hs, cf, nil, nil)
	base, cancel := context.WithCancel(hosts.WithTarget(context.Background(), hosts.LocalID))
	rctx := rpc.NewContext(base)
	cancel() // simulate the operator's connection dropping mid-request

	res, err := r.RemoveConnector(rctx, &RemoveConnectorParams{ID: "cid1", DeleteTunnel: true})
	if err != nil {
		t.Fatalf("RemoveConnector on cancelled ctx: %v", err)
	}
	if !res.OK {
		t.Errorf("res.OK = false, want the teardown to complete despite cancellation")
	}
	if !sawRemove || removeCtxErr != nil {
		t.Errorf("Remove: saw=%v ctxErr=%v, want it called on a non-cancelled (detached) ctx", sawRemove, removeCtxErr)
	}
	if !sawDelete {
		t.Error("DeleteTunnel not called")
	}
	_ = deleteCtxErr
}

// ── AddTunnel ──────────────────────────────────────────────────────────────

func TestAddTunnel_Happy(t *testing.T) {
	var attachedNet string
	var putRules []cloudflare.IngressRule
	var createdDNS cloudflare.DNSRecord
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
		},
		stacks: func(context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{
				Project:    "blog",
				Containers: []docker.ContainerSummary{{ID: "web1", Name: "web-1", Service: "web"}},
			}}, nil
		},
		containerNetworks: func(_ context.Context, id string) ([]string, error) {
			if id != "web1" {
				t.Errorf("ContainerNetworks id = %q, want web1", id)
			}
			return []string{"appnet"}, nil
		},
		attachNetwork: func(_ context.Context, cid, net string, aliases []string) error {
			if cid == "cid1" {
				attachedNet = net
			}
			return nil
		},
	}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) { return nil, "" },
		putConfig:    func(_ string, rules []cloudflare.IngressRule) string { putRules = rules; return "" },
		zones:        func() ([]cloudflare.Zone, string) { return []cloudflare.Zone{{ID: "z1", Name: "example.com"}}, "" },
		listDNS:      func(string, string) ([]cloudflare.DNSRecord, string) { return nil, "" },
		createDNS: func(_ string, rec cloudflare.DNSRecord) (cloudflare.DNSRecord, string) {
			createdDNS = rec
			rec.ID = "rec-1"
			return rec, ""
		},
	})
	r, rctx := newRouter(m, cf)
	res, err := r.AddTunnel(rctx, &AddTunnelParams{
		Hostname: "App.Example.com", Port: "8080", Connector: "cid1", Project: "blog", Service: "web",
	})
	if err != nil {
		t.Fatalf("AddTunnel: %v", err)
	}
	if !res.OK || res.Origin != "web-1" {
		t.Errorf("res = %+v, want OK origin web-1", res)
	}
	if attachedNet != "appnet" {
		t.Errorf("connector attached to %q, want appnet", attachedNet)
	}
	// PutTunnelConfig appends the catch-all before sending, so it's on the wire.
	want := []cloudflare.IngressRule{rule("app.example.com", "", "http://web-1:8080"), rule("", "", "http_status:404")}
	if !reflect.DeepEqual(putRules, want) {
		t.Errorf("put ingress = %+v, want %+v (host lowercased)", putRules, want)
	}
	if createdDNS.Type != "CNAME" || createdDNS.Name != "app.example.com" || createdDNS.Content != "tun1.cfargotunnel.com" || !createdDNS.Proxied {
		t.Errorf("created DNS = %+v, want proxied CNAME app.example.com -> tun1.cfargotunnel.com", createdDNS)
	}
}

func TestAddTunnel_Validation(t *testing.T) {
	cf := newCF(t, &cfFake{})
	// missing hostname
	r, rctx := newRouter(&mockAPI{}, cf)
	_, err := r.AddTunnel(rctx, &AddTunnelParams{Hostname: "  ", Port: "80", Connector: "c"})
	wantStatus(t, err, 400)
	// missing port
	_, err = r.AddTunnel(rctx, &AddTunnelParams{Hostname: "a.com", Port: "", Connector: "c"})
	wantStatus(t, err, 400)
	// connector not found
	r, rctx = newRouter(&mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return nil, nil
	}}, cf)
	_, err = r.AddTunnel(rctx, &AddTunnelParams{Hostname: "a.com", Port: "80", Connector: "ghost"})
	wantStatus(t, err, 404)
}

// resolveOrigin failure (no matching service) surfaces as a 400.
func TestAddTunnel_ResolveOriginFails(t *testing.T) {
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
		},
		stacks: func(context.Context) ([]docker.StackSummary, error) { return nil, nil }, // no members
	}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.AddTunnel(rctx, &AddTunnelParams{Hostname: "a.com", Port: "80", Connector: "cid1", Project: "blog", Service: "web"})
	wantStatus(t, err, 400)
}

// DNS failure after the route is written is reported softly (OK=false), not as an
// error — the ingress is already in place.
func TestAddTunnel_DNSFailsIsSoft(t *testing.T) {
	m := &mockAPI{
		connectors: func(context.Context) ([]docker.Connector, error) {
			return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
		},
		stacks: func(context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "blog", Containers: []docker.ContainerSummary{{ID: "web1", Name: "web-1", Service: "web"}}}}, nil
		},
		containerNetworks: func(context.Context, string) ([]string, error) { return []string{"appnet"}, nil },
	}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) { return nil, "" },
		putConfig:    func(string, []cloudflare.IngressRule) string { return "" },
		zones:        func() ([]cloudflare.Zone, string) { return []cloudflare.Zone{{ID: "z1", Name: "example.com"}}, "" },
		// An existing A record blocks the CNAME -> ensureDNS returns an error.
		listDNS: func(string, string) ([]cloudflare.DNSRecord, string) {
			return []cloudflare.DNSRecord{{ID: "a1", Type: "A", Content: "1.2.3.4"}}, ""
		},
	})
	r, rctx := newRouter(m, cf)
	res, err := r.AddTunnel(rctx, &AddTunnelParams{Hostname: "app.example.com", Port: "80", Connector: "cid1", Project: "blog", Service: "web"})
	if err != nil {
		t.Fatalf("expected soft DNS failure, got err %v", err)
	}
	if res.OK || !strings.Contains(res.Error, "DNS failed") {
		t.Errorf("res = %+v, want OK=false with a DNS-failed message", res)
	}
}

// ── RemoveTunnel ───────────────────────────────────────────────────────────

func TestRemoveTunnel_RemainingKeepsDNS(t *testing.T) {
	var putRules []cloudflare.IngressRule
	var dnsDeleted bool
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{
				rule("app.example.com", "/api", "http://x:1"),
				rule("app.example.com", "", "http://x:2"),
				rule("", "", "http_status:404"),
			}, ""
		},
		putConfig: func(_ string, rules []cloudflare.IngressRule) string { putRules = rules; return "" },
		deleteDNS: func(string, string) string { dnsDeleted = true; return "" },
	})
	r, rctx := newRouter(m, cf)
	res, err := r.RemoveTunnel(rctx, &RemoveTunnelParams{Hostname: "app.example.com", Path: "/api"})
	if err != nil {
		t.Fatalf("RemoveTunnel: %v", err)
	}
	if !res.OK {
		t.Error("OK = false")
	}
	if dnsDeleted {
		t.Error("DNS deleted though another rule for the host remains")
	}
	want := []cloudflare.IngressRule{rule("app.example.com", "", "http://x:2"), rule("", "", "http_status:404")}
	if !reflect.DeepEqual(putRules, want) {
		t.Errorf("kept rules = %+v, want %+v", putRules, want)
	}
}

func TestRemoveTunnel_LastRuleDeletesDNS(t *testing.T) {
	var deletedRec string
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{rule("app.example.com", "", "http://x:1"), rule("", "", "http_status:404")}, ""
		},
		putConfig: func(string, []cloudflare.IngressRule) string { return "" },
		zones:     func() ([]cloudflare.Zone, string) { return []cloudflare.Zone{{ID: "z1", Name: "example.com"}}, "" },
		listDNS: func(string, string) ([]cloudflare.DNSRecord, string) {
			return []cloudflare.DNSRecord{{ID: "rec-9", Type: "CNAME", Content: "tun1.cfargotunnel.com"}}, ""
		},
		deleteDNS: func(_ string, recID string) string { deletedRec = recID; return "" },
	})
	r, rctx := newRouter(m, cf)
	res, err := r.RemoveTunnel(rctx, &RemoveTunnelParams{Hostname: "app.example.com"})
	if err != nil {
		t.Fatalf("RemoveTunnel: %v", err)
	}
	if !res.OK || deletedRec != "rec-9" {
		t.Errorf("OK=%v deletedRec=%q, want true/rec-9 (only cfargotunnel CNAME removed)", res.OK, deletedRec)
	}
}

func TestRemoveTunnel_NotFound(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
		return []cloudflare.IngressRule{rule("other.com", "", "http://x:1")}, ""
	}})
	r, rctx := newRouter(m, cf)
	_, err := r.RemoveTunnel(rctx, &RemoveTunnelParams{Hostname: "app.example.com"})
	wantStatus(t, err, 404)
}

func TestRemoveTunnel_DockerError(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) { return nil, errors.New("down") }}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.RemoveTunnel(rctx, &RemoveTunnelParams{Hostname: "app.example.com"})
	wantStatus(t, err, 500)
}

func TestRemoveTunnel_DNSDeleteFailsIsSoft(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{rule("app.example.com", "", "http://x:1"), rule("", "", "http_status:404")}, ""
		},
		putConfig: func(string, []cloudflare.IngressRule) string { return "" },
		// No matching zone -> deleteDNS's ZoneForHost errors.
		zones: func() ([]cloudflare.Zone, string) { return []cloudflare.Zone{{ID: "z1", Name: "other.net"}}, "" },
	})
	r, rctx := newRouter(m, cf)
	res, err := r.RemoveTunnel(rctx, &RemoveTunnelParams{Hostname: "app.example.com"})
	if err != nil {
		t.Fatalf("expected soft DNS-delete failure, got err %v", err)
	}
	if res.OK || !strings.Contains(res.Error, "DNS delete failed") {
		t.Errorf("res = %+v, want OK=false with a DNS-delete-failed message", res)
	}
}

// ── MoveRoute ──────────────────────────────────────────────────────────────

func TestMoveRoute_Up(t *testing.T) {
	var putRules []cloudflare.IngressRule
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{rule("a.com", "", "s1"), rule("b.com", "", "s2"), rule("", "", "http_status:404")}, ""
		},
		putConfig: func(_ string, rules []cloudflare.IngressRule) string { putRules = rules; return "" },
	})
	r, rctx := newRouter(m, cf)
	res, err := r.MoveRoute(rctx, &MoveRouteParams{Connector: "cid1", Hostname: "b.com", Dir: "up"})
	if err != nil {
		t.Fatalf("MoveRoute: %v", err)
	}
	if !res.OK {
		t.Error("OK = false")
	}
	want := []cloudflare.IngressRule{rule("b.com", "", "s2"), rule("a.com", "", "s1"), rule("", "", "http_status:404")}
	if !reflect.DeepEqual(putRules, want) {
		t.Errorf("reordered = %+v, want b before a", putRules)
	}
}

func TestMoveRoute_EdgeNoOp(t *testing.T) {
	putCalled := false
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{rule("a.com", "", "s1"), rule("b.com", "", "s2")}, ""
		},
		putConfig: func(string, []cloudflare.IngressRule) string { putCalled = true; return "" },
	})
	r, rctx := newRouter(m, cf)
	res, err := r.MoveRoute(rctx, &MoveRouteParams{Connector: "cid1", Hostname: "a.com", Dir: "up"})
	if err != nil {
		t.Fatalf("MoveRoute: %v", err)
	}
	if !res.OK {
		t.Error("OK = false")
	}
	if putCalled {
		t.Error("PutTunnelConfig called for an at-the-edge no-op move")
	}
}

func TestMoveRoute_RouteNotFound(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
		return []cloudflare.IngressRule{rule("a.com", "", "s1")}, ""
	}})
	r, rctx := newRouter(m, cf)
	_, err := r.MoveRoute(rctx, &MoveRouteParams{Connector: "cid1", Hostname: "zzz.com", Dir: "up"})
	wantStatus(t, err, 404)
}

func TestMoveRoute_ConnectorNotFound(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) { return nil, nil }}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.MoveRoute(rctx, &MoveRouteParams{Connector: "ghost", Hostname: "a.com", Dir: "up"})
	wantStatus(t, err, 404)
}

// ── ReorderRoutes ──────────────────────────────────────────────────────────

func TestReorderRoutes(t *testing.T) {
	var putRules []cloudflare.IngressRule
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{
		tunnelConfig: func(string) ([]cloudflare.IngressRule, string) {
			return []cloudflare.IngressRule{
				rule("a.com", "", "s1"), rule("b.com", "", "s2"), rule("c.com", "", "s3"), rule("", "", "http_status:404"),
			}, ""
		},
		putConfig: func(_ string, rules []cloudflare.IngressRule) string { putRules = rules; return "" },
	})
	r, rctx := newRouter(m, cf)
	// Ask for c, a explicitly; b is unnamed and must be appended (not dropped).
	res, err := r.ReorderRoutes(rctx, &ReorderRoutesParams{
		Connector: "cid1",
		Order:     `[{"hostname":"c.com"},{"hostname":"a.com"}]`,
	})
	if err != nil {
		t.Fatalf("ReorderRoutes: %v", err)
	}
	if !res.OK {
		t.Error("OK = false")
	}
	want := []cloudflare.IngressRule{rule("c.com", "", "s3"), rule("a.com", "", "s1"), rule("b.com", "", "s2"), rule("", "", "http_status:404")}
	if !reflect.DeepEqual(putRules, want) {
		t.Errorf("reordered = %+v, want c,a,b (unnamed appended)", putRules)
	}
}

func TestReorderRoutes_BadJSON(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid1", TunnelID: "tun1"}}, nil
	}}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.ReorderRoutes(rctx, &ReorderRoutesParams{Connector: "cid1", Order: "not json"})
	wantStatus(t, err, 400)
}

func TestReorderRoutes_ConnectorNotFound(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) { return nil, nil }}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.ReorderRoutes(rctx, &ReorderRoutesParams{Connector: "ghost", Order: "[]"})
	wantStatus(t, err, 404)
}

// ── Connector (single, by id) ──────────────────────────────────────────────

func TestConnector_ByID(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) {
		return []docker.Connector{{ContainerID: "cid-abc123", Name: "conn", TunnelID: "tun1"}}, nil
	}}
	cf := newCF(t, &cfFake{
		tunnelStatus: func(id string) (cloudflare.TunnelDetail, string) {
			return cloudflare.TunnelDetail{ID: id, Name: "prod", Status: "degraded"}, ""
		},
	})
	r, rctx := newRouter(m, cf)
	// prefix match on the id
	v, err := r.Connector(rctx, &ConnectorParams{ID: "cid-abc"})
	if err != nil {
		t.Fatalf("Connector: %v", err)
	}
	if v.ID != "cid-abc123" || v.TunnelID != "tun1" || v.Status != "degraded" || !v.Online {
		t.Errorf("view = %+v, want cid-abc123/tun1/degraded/online", v)
	}
}

func TestConnector_NotFound(t *testing.T) {
	m := &mockAPI{connectors: func(context.Context) ([]docker.Connector, error) { return nil, nil }}
	r, rctx := newRouter(m, newCF(t, &cfFake{}))
	_, err := r.Connector(rctx, &ConnectorParams{ID: "ghost"})
	wantStatus(t, err, 404)
}

// ── ensureDNS (in-package, direct) ─────────────────────────────────────────

func TestEnsureDNS_AlreadyPointed(t *testing.T) {
	updated, created := false, false
	cf := newCF(t, &cfFake{
		zones: func() ([]cloudflare.Zone, string) { return []cloudflare.Zone{{ID: "z1", Name: "example.com"}}, "" },
		listDNS: func(string, string) ([]cloudflare.DNSRecord, string) {
			return []cloudflare.DNSRecord{{ID: "r1", Type: "CNAME", Content: "tun1.cfargotunnel.com"}}, ""
		},
		updateDNS: func(string, string, string) string { updated = true; return "" },
		createDNS: func(_ string, rec cloudflare.DNSRecord) (cloudflare.DNSRecord, string) {
			created = true
			return rec, ""
		},
	})
	r, rctx := newRouter(&mockAPI{}, cf)
	if err := r.ensureDNS(rctx, "app.example.com", "tun1"); err != nil {
		t.Fatalf("ensureDNS: %v", err)
	}
	if updated || created {
		t.Errorf("updated=%v created=%v, want neither (record already points at this tunnel)", updated, created)
	}
}

func TestEnsureDNS_RepointsExistingCNAME(t *testing.T) {
	var newContent string
	cf := newCF(t, &cfFake{
		zones: func() ([]cloudflare.Zone, string) { return []cloudflare.Zone{{ID: "z1", Name: "example.com"}}, "" },
		listDNS: func(string, string) ([]cloudflare.DNSRecord, string) {
			return []cloudflare.DNSRecord{{ID: "r1", Type: "CNAME", Content: "other-tunnel.cfargotunnel.com"}}, ""
		},
		updateDNS: func(_, recID, content string) string {
			if recID != "r1" {
				t.Errorf("update rec = %q, want r1", recID)
			}
			newContent = content
			return ""
		},
	})
	r, rctx := newRouter(&mockAPI{}, cf)
	if err := r.ensureDNS(rctx, "app.example.com", "tun1"); err != nil {
		t.Fatalf("ensureDNS: %v", err)
	}
	if newContent != "tun1.cfargotunnel.com" {
		t.Errorf("repointed to %q, want tun1.cfargotunnel.com", newContent)
	}
}

func TestEnsureDNS_NoZoneErrors(t *testing.T) {
	cf := newCF(t, &cfFake{zones: func() ([]cloudflare.Zone, string) {
		return []cloudflare.Zone{{ID: "z1", Name: "other.net"}}, ""
	}})
	r, rctx := newRouter(&mockAPI{}, cf)
	if err := r.ensureDNS(rctx, "app.example.com", "tun1"); err == nil {
		t.Fatal("ensureDNS with no matching zone: want an error")
	}
}

// ── resolveOrigin (in-package, direct) ─────────────────────────────────────

func TestResolveOrigin_LooseContainer_NoNetworks(t *testing.T) {
	var attached struct {
		id, net string
	}
	m := &mockAPI{
		containerNetworks: func(context.Context, string) ([]string, error) { return nil, nil },
		originIndex: func(context.Context) (map[string]docker.OriginRef, error) {
			return map[string]docker.OriginRef{"box": {ContainerID: "ctr-abc123", Name: "box"}}, nil
		},
		ensureTunnelsNet: func(context.Context) (string, error) { return "hope-tunnels", nil },
		attachNetwork: func(_ context.Context, id, net string, _ []string) error {
			attached.id, attached.net = id, net
			return nil
		},
	}
	r, rctx := newRouter(m, nil)
	origin, netName, reattached, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{Container: "ctr-abc"})
	if err != nil {
		t.Fatalf("resolveOrigin: %v", err)
	}
	if origin != "box" || netName != "hope-tunnels" || reattached {
		t.Errorf("got origin=%q net=%q reattached=%v, want box/hope-tunnels/false", origin, netName, reattached)
	}
	if attached.id != "ctr-abc" || attached.net != "hope-tunnels" {
		t.Errorf("attached %q to %q, want the loose container onto the ensured net", attached.id, attached.net)
	}
}

func TestResolveOrigin_LooseContainer_ExistingNetwork(t *testing.T) {
	m := &mockAPI{
		containerNetworks: func(context.Context, string) ([]string, error) { return []string{"mynet"}, nil },
		originIndex: func(context.Context) (map[string]docker.OriginRef, error) {
			return map[string]docker.OriginRef{"box": {ContainerID: "ctr-abc", Name: "box"}}, nil
		},
	}
	r, rctx := newRouter(m, nil)
	origin, netName, _, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{Container: "ctr-abc"})
	if err != nil {
		t.Fatalf("resolveOrigin: %v", err)
	}
	if origin != "box" || netName != "mynet" {
		t.Errorf("got %q/%q, want box/mynet", origin, netName)
	}
}

func TestResolveOrigin_LooseContainer_NotIndexed(t *testing.T) {
	m := &mockAPI{
		containerNetworks: func(context.Context, string) ([]string, error) { return []string{"mynet"}, nil },
		originIndex:       func(context.Context) (map[string]docker.OriginRef, error) { return map[string]docker.OriginRef{}, nil },
	}
	r, rctx := newRouter(m, nil)
	_, _, _, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{Container: "ctr-abc"})
	if !errors.Is(err, errNoContainer) {
		t.Errorf("err = %v, want errNoContainer", err)
	}
}

func TestResolveOrigin_NoTarget(t *testing.T) {
	r, rctx := newRouter(&mockAPI{}, nil)
	_, _, _, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{}) // no container, no project/service
	if !errors.Is(err, errNoTarget) {
		t.Errorf("err = %v, want errNoTarget", err)
	}
}

func TestResolveOrigin_ComposeNoNetwork(t *testing.T) {
	m := &mockAPI{
		stacks: func(context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "blog", Containers: []docker.ContainerSummary{{ID: "web1", Service: "web"}}}}, nil
		},
		containerNetworks: func(context.Context, string) ([]string, error) { return nil, nil }, // no networks
	}
	r, rctx := newRouter(m, nil)
	_, _, _, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{Project: "blog", Service: "web"})
	if !errors.Is(err, errNoNetwork) {
		t.Errorf("err = %v, want errNoNetwork", err)
	}
}

func TestResolveOrigin_SingleReplica(t *testing.T) {
	m := &mockAPI{
		stacks: func(context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "blog", Containers: []docker.ContainerSummary{{ID: "web1", Name: "web-1", Service: "web"}}}}, nil
		},
		containerNetworks: func(context.Context, string) ([]string, error) { return []string{"appnet"}, nil },
	}
	r, rctx := newRouter(m, nil)
	origin, netName, reattached, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{Project: "blog", Service: "web"})
	if err != nil {
		t.Fatalf("resolveOrigin: %v", err)
	}
	if origin != "web-1" || netName != "appnet" || reattached {
		t.Errorf("got %q/%q/%v, want web-1/appnet/false", origin, netName, reattached)
	}
}

func TestResolveOrigin_MultiReplica_Aliases(t *testing.T) {
	var attaches []struct {
		id      string
		aliases []string
	}
	m := &mockAPI{
		stacks: func(context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "blog", Containers: []docker.ContainerSummary{
				{ID: "web1", Name: "web-1", Service: "web"},
				{ID: "web2", Name: "web-2", Service: "web"},
			}}}, nil
		},
		containerNetworks: func(context.Context, string) ([]string, error) { return []string{"appnet"}, nil },
		attachNetwork: func(_ context.Context, id, _ string, aliases []string) error {
			attaches = append(attaches, struct {
				id      string
				aliases []string
			}{id, aliases})
			return nil
		},
	}
	r, rctx := newRouter(m, nil)
	origin, netName, reattached, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{Project: "blog", Service: "web"})
	if err != nil {
		t.Fatalf("resolveOrigin: %v", err)
	}
	wantAlias := docker.ReplicaAlias("blog", "web")
	if origin != wantAlias || netName != "appnet" || !reattached {
		t.Errorf("got %q/%q/%v, want %q/appnet/true", origin, netName, reattached, wantAlias)
	}
	if len(attaches) != 2 {
		t.Fatalf("attach count = %d, want 2 (one per replica)", len(attaches))
	}
	for _, a := range attaches {
		if len(a.aliases) != 1 || a.aliases[0] != wantAlias {
			t.Errorf("replica %s attached with aliases %v, want [%s]", a.id, a.aliases, wantAlias)
		}
	}
}

// SECURITY: if the alias re-attach fails mid-loop, the replica must be re-attached
// WITHOUT the alias so it isn't stranded off its only network.
func TestResolveOrigin_MultiReplica_ReattachesOnFailure(t *testing.T) {
	var attaches []struct {
		id      string
		aliases []string
	}
	m := &mockAPI{
		stacks: func(context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "blog", Containers: []docker.ContainerSummary{
				{ID: "web1", Name: "web-1", Service: "web"},
				{ID: "web2", Name: "web-2", Service: "web"},
			}}}, nil
		},
		containerNetworks: func(context.Context, string) ([]string, error) { return []string{"appnet"}, nil },
		attachNetwork: func(_ context.Context, id, _ string, aliases []string) error {
			attaches = append(attaches, struct {
				id      string
				aliases []string
			}{id, aliases})
			if len(aliases) > 0 { // the aliased attach fails
				return errors.New("attach failed")
			}
			return nil // the bare re-attach succeeds
		},
	}
	r, rctx := newRouter(m, nil)
	_, _, _, err := r.resolveOrigin(rctx, docker.Connector{}, &AddTunnelParams{Project: "blog", Service: "web"})
	if err == nil {
		t.Fatal("expected an error from the failed alias attach")
	}
	if len(attaches) != 2 {
		t.Fatalf("attach calls = %d, want 2 (failed aliased attach + bare re-attach)", len(attaches))
	}
	if len(attaches[0].aliases) != 1 {
		t.Errorf("first attach aliases = %v, want the aliased attempt", attaches[0].aliases)
	}
	if len(attaches[1].aliases) != 0 || attaches[1].id != "web1" {
		t.Errorf("second attach = %+v, want a bare (no-alias) re-attach of web1 so it isn't stranded", attaches[1])
	}
}
