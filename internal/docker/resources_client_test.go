package docker

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/toyz/hope/internal/stackspec"
)

// These exercise the daemon-bound resource create/list/exists paths against the
// fake-daemon harness (see fake_test.go). They lock the Engine-API wiring: the
// exact endpoint each method hits and the request body / response shape it maps.

// TestNetworkExists proves the name-filter match: a listed network whose Name
// equals the query counts as present; a near-miss does not.
func TestNetworkExists(t *testing.T) {
	cases := []struct {
		name   string
		listed []map[string]any
		query  string
		want   bool
	}{
		{"exact match", []map[string]any{{"Name": "app_default", "Id": "n1"}}, "app_default", true},
		{"no match (prefix only)", []map[string]any{{"Name": "app_default_extra", "Id": "n1"}}, "app_default", false},
		{"empty list", nil, "app_default", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks") {
					writeJSON(w, tc.listed)
					return
				}
				w.WriteHeader(http.StatusNotFound)
			})
			got, err := c.NetworkExists(t.Context(), tc.query)
			if err != nil {
				t.Fatalf("NetworkExists err: %v", err)
			}
			if got != tc.want {
				t.Errorf("NetworkExists(%q) = %v; want %v", tc.query, got, tc.want)
			}
		})
	}
}

// TestVolumeExists mirrors TestNetworkExists for the volume list endpoint.
func TestVolumeExists(t *testing.T) {
	cases := []struct {
		name   string
		listed []map[string]any
		query  string
		want   bool
	}{
		{"exact match", []map[string]any{{"Name": "data", "Driver": "local"}}, "data", true},
		{"no match", []map[string]any{{"Name": "other", "Driver": "local"}}, "data", false},
		{"empty list", nil, "data", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/volumes") {
					writeJSON(w, volume.ListResponse{Volumes: toVolPtrs(tc.listed)})
					return
				}
				w.WriteHeader(http.StatusNotFound)
			})
			got, err := c.VolumeExists(t.Context(), tc.query)
			if err != nil {
				t.Fatalf("VolumeExists err: %v", err)
			}
			if got != tc.want {
				t.Errorf("VolumeExists(%q) = %v; want %v", tc.query, got, tc.want)
			}
		})
	}
}

func toVolPtrs(ms []map[string]any) []*volume.Volume {
	out := make([]*volume.Volume, 0, len(ms))
	for _, m := range ms {
		v := &volume.Volume{Name: m["Name"].(string)}
		if d, ok := m["Driver"].(string); ok {
			v.Driver = d
		}
		out = append(out, v)
	}
	return out
}

// TestCreateNetwork proves the create body is built from the spec: the driver
// defaults to bridge, WithManaged stamps LabelManaged, EnableIPv6 is a pointer,
// and an IPAM pool is attached only when a subnet/gateway is set. The daemon's
// returned id is passed through.
func TestCreateNetwork(t *testing.T) {
	t.Run("defaults + managed label", func(t *testing.T) {
		var body network.CreateRequest
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/networks/create") {
				_ = json.NewDecoder(r.Body).Decode(&body)
				writeJSON(w, network.CreateResponse{ID: "newnetid"})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		id, err := c.CreateNetwork(t.Context(), stackspec.NetworkSpec{Name: "app_default"})
		if err != nil {
			t.Fatalf("CreateNetwork err: %v", err)
		}
		if id != "newnetid" {
			t.Errorf("CreateNetwork id = %q; want newnetid", id)
		}
		if body.Name != "app_default" {
			t.Errorf("create body Name = %q; want app_default", body.Name)
		}
		if body.Driver != "bridge" {
			t.Errorf("create body Driver = %q; want bridge (default)", body.Driver)
		}
		if body.Labels[LabelManaged] != "1" {
			t.Errorf("create body missing %s=1: %v", LabelManaged, body.Labels)
		}
		if body.EnableIPv6 == nil {
			t.Error("create body EnableIPv6 should be a non-nil pointer")
		}
		if body.IPAM != nil {
			t.Errorf("no subnet/gateway => IPAM should be nil, got %+v", body.IPAM)
		}
	})

	t.Run("explicit driver + IPAM pool", func(t *testing.T) {
		var body network.CreateRequest
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/networks/create") {
				_ = json.NewDecoder(r.Body).Decode(&body)
				writeJSON(w, network.CreateResponse{ID: "id2"})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		_, err := c.CreateNetwork(t.Context(), stackspec.NetworkSpec{
			Name:    "custom",
			Driver:  "macvlan",
			Subnet:  "10.0.0.0/24",
			Gateway: "10.0.0.1",
			Labels:  map[string]string{"team": "infra"},
		})
		if err != nil {
			t.Fatalf("CreateNetwork err: %v", err)
		}
		if body.Driver != "macvlan" {
			t.Errorf("Driver = %q; want macvlan", body.Driver)
		}
		if body.Labels["team"] != "infra" || body.Labels[LabelManaged] != "1" {
			t.Errorf("labels = %v; want team=infra + managed=1", body.Labels)
		}
		if body.IPAM == nil || len(body.IPAM.Config) != 1 {
			t.Fatalf("IPAM = %+v; want one config", body.IPAM)
		}
		if body.IPAM.Config[0].Subnet != "10.0.0.0/24" || body.IPAM.Config[0].Gateway != "10.0.0.1" {
			t.Errorf("IPAM pool = %+v; want subnet/gateway set", body.IPAM.Config[0])
		}
	})
}

// TestCreateVolume proves the create body defaults the driver to local, carries
// the managed label, and the returned name is passed through.
func TestCreateVolume(t *testing.T) {
	var body volume.CreateOptions
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/volumes/create") {
			_ = json.NewDecoder(r.Body).Decode(&body)
			writeJSON(w, volume.Volume{Name: "data"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	name, err := c.CreateVolume(t.Context(), stackspec.VolumeSpec{Name: "data", Labels: map[string]string{"team": "infra"}})
	if err != nil {
		t.Fatalf("CreateVolume err: %v", err)
	}
	if name != "data" {
		t.Errorf("CreateVolume name = %q; want data", name)
	}
	if body.Name != "data" {
		t.Errorf("create body Name = %q; want data", body.Name)
	}
	if body.Driver != "local" {
		t.Errorf("create body Driver = %q; want local (default)", body.Driver)
	}
	if body.Labels[LabelManaged] != "1" || body.Labels["team"] != "infra" {
		t.Errorf("create body Labels = %v; want managed=1 + team=infra", body.Labels)
	}
}

// TestEnsureSystemBridge covers both EnsurePluginNetwork and EnsureTunnelsNetwork
// (same helper): when the bridge already exists no create is issued; when absent a
// bridge is created carrying BOTH the managed and system labels so hope refuses to
// delete it.
func TestEnsureSystemBridge(t *testing.T) {
	cases := []struct {
		name       string
		ensure     func(c *Client) error
		wantNet    string
		exists     bool
		wantCreate bool
	}{
		{"plugin bridge already exists", func(c *Client) error { return c.EnsurePluginNetwork(t.Context()) }, PluginNetwork, true, false},
		{"plugin bridge missing => create", func(c *Client) error { return c.EnsurePluginNetwork(t.Context()) }, PluginNetwork, false, true},
		{"tunnels bridge missing => create", func(c *Client) error {
			_, err := c.EnsureTunnelsNetwork(t.Context())
			return err
		}, hopeTunnelsNetwork, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			created := false
			var body network.CreateRequest
			c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks"):
					if tc.exists {
						writeJSON(w, []map[string]any{{"Name": tc.wantNet, "Id": "existing"}})
					} else {
						writeJSON(w, []map[string]any{})
					}
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/networks/create"):
					created = true
					_ = json.NewDecoder(r.Body).Decode(&body)
					writeJSON(w, network.CreateResponse{ID: "created"})
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})
			if err := tc.ensure(c); err != nil {
				t.Fatalf("ensure err: %v", err)
			}
			if created != tc.wantCreate {
				t.Errorf("created = %v; want %v", created, tc.wantCreate)
			}
			if tc.wantCreate {
				if body.Name != tc.wantNet {
					t.Errorf("create Name = %q; want %q", body.Name, tc.wantNet)
				}
				if body.Driver != "bridge" {
					t.Errorf("create Driver = %q; want bridge", body.Driver)
				}
				if body.Labels[LabelManaged] != "1" || body.Labels[LabelSystem] != "1" {
					t.Errorf("create Labels = %v; want managed=1 AND system=1", body.Labels)
				}
			}
		})
	}
}

// TestEnsureSystemBridgeConcurrentCreate proves the idempotent tolerance: a create
// that races another and fails with "already exists" is swallowed, not surfaced.
func TestEnsureSystemBridgeConcurrentCreate(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks"):
			writeJSON(w, []map[string]any{}) // absent -> triggers create
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/networks/create"):
			w.WriteHeader(http.StatusConflict)
			writeJSON(w, map[string]any{"message": "network with name ink-plugins already exists"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if err := c.EnsurePluginNetwork(t.Context()); err != nil {
		t.Errorf("EnsurePluginNetwork over a racing create = %v; want nil (already-exists tolerated)", err)
	}
}

// TestNetworks proves the reverse "who's on this network" mapping, the []-init of
// an empty user set (never nil so it serializes as [] not null), the IPAM
// subnet/gateway pick, Created.Unix(), and the busiest-first sort.
func TestNetworks(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks"):
			writeJSON(w, []map[string]any{
				{
					"Name": "app_default", "Id": "netA", "Driver": "bridge", "Scope": "local",
					"Created": "2021-01-01T00:00:00Z",
					"IPAM":    map[string]any{"Config": []map[string]any{{"Subnet": "172.20.0.0/16", "Gateway": "172.20.0.1"}}},
					"Labels":  map[string]string{LabelManaged: "1"},
				},
				{"Name": "empty", "Id": "netB", "Driver": "bridge", "Created": "2021-01-01T00:00:00Z"},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, []map[string]any{
				{"Id": "c1", "Names": []string{"/app-web-1"}, "Labels": map[string]string{labelService: "web", labelProject: "app"},
					"NetworkSettings": map[string]any{"Networks": map[string]any{"app_default": map[string]any{}}}},
				{"Id": "c2", "Names": []string{"/app-db-1"}, "Labels": map[string]string{labelService: "db", labelProject: "app"},
					"NetworkSettings": map[string]any{"Networks": map[string]any{"app_default": map[string]any{}}}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	nets, err := c.Networks(t.Context())
	if err != nil {
		t.Fatalf("Networks err: %v", err)
	}
	if len(nets) != 2 {
		t.Fatalf("Networks = %d entries; want 2", len(nets))
	}
	// Busiest first: app_default (2 users) before empty (0).
	if nets[0].Name != "app_default" {
		t.Errorf("nets[0].Name = %q; want app_default (busiest first)", nets[0].Name)
	}
	if len(nets[0].UsedBy) != 2 {
		t.Errorf("app_default UsedBy = %d; want 2", len(nets[0].UsedBy))
	}
	if nets[0].Subnet != "172.20.0.0/16" || nets[0].Gateway != "172.20.0.1" {
		t.Errorf("app_default subnet/gateway = %q/%q; want 172.20.0.0/16 / 172.20.0.1", nets[0].Subnet, nets[0].Gateway)
	}
	if nets[0].Created != 1609459200 {
		t.Errorf("app_default Created = %d; want 1609459200 (Unix of 2021-01-01Z)", nets[0].Created)
	}
	if nets[1].Name != "empty" {
		t.Errorf("nets[1].Name = %q; want empty", nets[1].Name)
	}
	if nets[1].UsedBy == nil || len(nets[1].UsedBy) != 0 {
		t.Errorf("empty UsedBy = %v; want a non-nil empty slice", nets[1].UsedBy)
	}
}

// TestVolumes proves the reverse mount mapping, the per-volume size join from
// `system df` (with -1 for a volume df didn't report), the []-init of an empty
// user set, and the busiest-first sort.
func TestVolumes(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/system/df"):
			writeJSON(w, map[string]any{
				"Volumes": []map[string]any{{"Name": "data", "Driver": "local", "UsageData": map[string]any{"Size": 1024, "RefCount": 1}}},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/volumes"):
			writeJSON(w, map[string]any{
				"Volumes": []map[string]any{
					{"Name": "data", "Driver": "local", "Mountpoint": "/var/lib/docker/volumes/data/_data"},
					{"Name": "logs", "Driver": "local"},
				},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, []map[string]any{
				{"Id": "c1", "Names": []string{"/app-web-1"}, "Labels": map[string]string{labelService: "web", labelProject: "app"},
					"Mounts": []map[string]any{{"Type": "volume", "Name": "data", "Destination": "/data"}}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	vols, err := c.Volumes(t.Context())
	if err != nil {
		t.Fatalf("Volumes err: %v", err)
	}
	if len(vols) != 2 {
		t.Fatalf("Volumes = %d; want 2", len(vols))
	}
	// Busiest first: data (1 user) before logs (0).
	if vols[0].Name != "data" {
		t.Errorf("vols[0].Name = %q; want data (busiest first)", vols[0].Name)
	}
	if len(vols[0].UsedBy) != 1 || vols[0].UsedBy[0].Service != "web" {
		t.Errorf("data UsedBy = %+v; want one user (service web)", vols[0].UsedBy)
	}
	if vols[0].Size != 1024 {
		t.Errorf("data Size = %d; want 1024 (from df)", vols[0].Size)
	}
	if vols[1].Name != "logs" {
		t.Errorf("vols[1].Name = %q; want logs", vols[1].Name)
	}
	if vols[1].Size != -1 {
		t.Errorf("logs Size = %d; want -1 (df didn't report it)", vols[1].Size)
	}
	if vols[1].UsedBy == nil || len(vols[1].UsedBy) != 0 {
		t.Errorf("logs UsedBy = %v; want a non-nil empty slice", vols[1].UsedBy)
	}
}
