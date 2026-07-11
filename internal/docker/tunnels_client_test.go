package docker

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// These cover the tunnel/connector helpers (tunnels.go): the pure name helpers and
// the daemon-bound network attach/detach/inspect + connector deploy.

func TestReplicaAlias(t *testing.T) {
	if got := ReplicaAlias("blog", "web"); got != "hope-blog-web" {
		t.Errorf("ReplicaAlias = %q; want hope-blog-web", got)
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"My Tunnel!":   "my-tunnel",
		"  keep_this ": "keep_this",
		"a.b/c":        "a-b-c",
		"---":          "cf", // trims to empty -> fallback
		"":             "cf",
		"UPPER":        "upper",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q; want %q", in, got, want)
		}
	}
}

// TestContainerNetworks proves the user-network filter (bridge/host/none dropped)
// and the sort, read off a container inspect.
func TestContainerNetworks(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json") {
			writeJSON(w, map[string]any{"Id": "cid", "Name": "/web",
				"NetworkSettings": map[string]any{"Networks": map[string]any{
					"bridge": map[string]any{}, "zeta": map[string]any{}, "app_default": map[string]any{},
				}}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	nets, err := c.ContainerNetworks(t.Context(), "cid")
	if err != nil {
		t.Fatalf("ContainerNetworks err: %v", err)
	}
	if !reflect.DeepEqual(nets, []string{"app_default", "zeta"}) {
		t.Errorf("ContainerNetworks = %v; want [app_default zeta] (bridge dropped, sorted)", nets)
	}
}

// TestOriginIndex proves the reverse index maps container name, each per-network
// alias, and the reconstructed replica alias back to the same origin.
func TestOriginIndex(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				{"Id": "web1", "Names": []string{"/blog-web-1"}, "Labels": map[string]string{labelProject: "blog", labelService: "web"},
					"NetworkSettings": map[string]any{"Networks": map[string]any{
						"blog_default": map[string]any{"Aliases": []string{"vip"}},
						"bridge":       map[string]any{"Aliases": []string{"ignored"}},
					}}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	idx, err := c.OriginIndex(t.Context())
	if err != nil {
		t.Fatalf("OriginIndex err: %v", err)
	}
	// name, user-net alias, and the reconstructed replica alias all resolve.
	for _, key := range []string{"blog-web-1", "vip", ReplicaAlias("blog", "web")} {
		ref, ok := idx[key]
		if !ok || ref.ContainerID != "web1" {
			t.Errorf("idx[%q] = %+v (ok=%v); want the web1 origin", key, ref, ok)
		}
	}
	// bridge alias must NOT be indexed (it's a predefined net).
	if _, ok := idx["ignored"]; ok {
		t.Error("bridge-net alias should not be indexed")
	}
}

// TestAttachDetachNetwork proves the connect/disconnect wrappers, including the
// idempotent tolerance of "already exists" / "not connected".
func TestAttachDetachNetwork(t *testing.T) {
	t.Run("attach success + already-exists tolerated", func(t *testing.T) {
		exists := false
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/connect") {
				if exists {
					w.WriteHeader(http.StatusForbidden)
					writeJSON(w, map[string]any{"message": "endpoint already exists in network"})
					return
				}
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		if err := c.AttachNetwork(t.Context(), "cid", "app_default", []string{"vip"}); err != nil {
			t.Errorf("AttachNetwork(fresh) = %v; want nil", err)
		}
		exists = true
		if err := c.AttachNetwork(t.Context(), "cid", "app_default", nil); err != nil {
			t.Errorf("AttachNetwork(already exists) = %v; want nil (tolerated)", err)
		}
	})
	t.Run("detach success + not-connected tolerated", func(t *testing.T) {
		connected := true
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/disconnect") {
				if !connected {
					w.WriteHeader(http.StatusForbidden)
					writeJSON(w, map[string]any{"message": "container is not connected to network"})
					return
				}
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		if err := c.DetachNetwork(t.Context(), "cid", "app_default"); err != nil {
			t.Errorf("DetachNetwork(connected) = %v; want nil", err)
		}
		connected = false
		if err := c.DetachNetwork(t.Context(), "cid", "app_default"); err != nil {
			t.Errorf("DetachNetwork(not connected) = %v; want nil (tolerated)", err)
		}
	})
}

// TestDeployConnector proves the connector rollout: cloudflared is pulled, the
// container is created with the tunnel labels + a sanitized name, and started.
func TestDeployConnector(t *testing.T) {
	var body createBody
	var name string
	started := false
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/images/create"):
			writePullStream(w, []map[string]any{{"status": "Status: Downloaded"}})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/containers/create"):
			body = decodeCreate(r)
			name = r.URL.Query().Get("name")
			writeJSON(w, map[string]any{"Id": "connid"})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
			started = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	id, err := c.DeployConnector(t.Context(), "My Tunnel", "tun-123", "the-token", true)
	if err != nil {
		t.Fatalf("DeployConnector err: %v", err)
	}
	if id != "connid" {
		t.Errorf("DeployConnector id = %q; want connid", id)
	}
	if body.Labels[labelTunnel] != "tun-123" || body.Labels[labelConnectorTitle] != "My Tunnel" || body.Labels[labelConnectorFirst] != "1" {
		t.Errorf("connector labels = %v; want tunnel/title/default set", body.Labels)
	}
	if body.Image != connectorImage {
		t.Errorf("connector image = %q; want %q", body.Image, connectorImage)
	}
	if name != "hope-connector-my-tunnel" {
		t.Errorf("connector name = %q; want hope-connector-my-tunnel (sanitized)", name)
	}
	if !started {
		t.Error("DeployConnector did not start the connector")
	}
}
