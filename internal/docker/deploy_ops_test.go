package docker

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/toyz/hope/internal/stackspec"
)

// These drive the write-path container ops (deploy.go): create-from-spec (with the
// primary/extra-network split) and the in-place recreate-from-spec that preserves
// internal compose/hope labels under an edit.

// fullCreateBody captures the create request fields we assert on.
type fullCreateBody struct {
	Image  string            `json:"Image"`
	Env    []string          `json:"Env"`
	Labels map[string]string `json:"Labels"`
}

// TestCreateContainer proves the spec->create translation: the config carries
// image/env/labels, the first network is baked into the create and the rest are
// connected after, and the container is started. A missing image is rejected.
func TestCreateContainer(t *testing.T) {
	var body fullCreateBody
	var connects []string
	started := false
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/containers/create"):
			_ = json.NewDecoder(r.Body).Decode(&body)
			writeJSON(w, map[string]any{"Id": "newid"})
		case r.Method == http.MethodPost && strings.Contains(p, "/networks/") && strings.HasSuffix(p, "/connect"):
			n := strings.TrimSuffix(p, "/connect")
			connects = append(connects, n[strings.LastIndex(n, "/")+1:])
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
			started = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	spec := stackspec.ContainerSpec{
		Name:     "web",
		Image:    "nginx:latest",
		Env:      map[string]string{"A": "1"},
		Labels:   map[string]string{"tier": "front"},
		Networks: []string{"zeta_net", "app_default"}, // sorted -> app_default is primary
	}
	id, err := c.CreateContainer(t.Context(), "app-web-1", spec, false, nil)
	if err != nil {
		t.Fatalf("CreateContainer err: %v", err)
	}
	if id != "newid" {
		t.Errorf("CreateContainer id = %q; want newid", id)
	}
	if body.Image != "nginx:latest" || body.Labels["tier"] != "front" {
		t.Errorf("create body = %+v; want nginx image + tier label", body)
	}
	if len(body.Env) != 1 || body.Env[0] != "A=1" {
		t.Errorf("create Env = %v; want [A=1]", body.Env)
	}
	// app_default sorts first => primary (baked in); zeta_net connected after.
	if len(connects) != 1 || connects[0] != "zeta_net" {
		t.Errorf("post-create connects = %v; want [zeta_net] (app_default is primary)", connects)
	}
	if !started {
		t.Error("CreateContainer did not start the container")
	}

	// A blank image is rejected before any daemon call.
	if _, err := c.CreateContainer(t.Context(), "x", stackspec.ContainerSpec{Name: "x"}, false, nil); err == nil {
		t.Error("CreateContainer(no image) = nil err; want a required-image error")
	}
}

// TestRecreateFromSpec proves the in-place edit: the live container's internal
// compose/hope labels are preserved and merged UNDER the spec's user labels, then
// the container is removed and recreated under the same name.
func TestRecreateFromSpec(t *testing.T) {
	var createLabels map[string]string
	removed, created := false, false
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{
				"Id":   "cid",
				"Name": "/blog-web-1",
				"Config": map[string]any{"Image": "nginx:1", "Labels": map[string]string{
					"com.docker.compose.project": "blog",
					"ink.hope.managed":           "1",
					"stale":                      "drop-me", // a non-internal live label: not preserved
				}},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && strings.Contains(p, "/containers/"):
			removed = true
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/containers/create"):
			created = true
			var b fullCreateBody
			_ = json.NewDecoder(r.Body).Decode(&b)
			createLabels = b.Labels
			writeJSON(w, map[string]any{"Id": "newcid"})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	spec := stackspec.ContainerSpec{
		Name:     "web",
		Image:    "nginx:2", // the edited image
		Labels:   map[string]string{"tier": "front"},
		Networks: []string{"blog_default"}, // the edit form seeds networks from the live container
	}
	if err := c.RecreateFromSpec(t.Context(), "cid", spec, false, nil); err != nil {
		t.Fatalf("RecreateFromSpec err: %v", err)
	}
	if !removed || !created {
		t.Errorf("remove/create = %v/%v; want both true", removed, created)
	}
	// Internal compose/hope labels preserved; the user label applied; the arbitrary
	// live label dropped (only internal namespaces are carried over).
	if createLabels["com.docker.compose.project"] != "blog" || createLabels["ink.hope.managed"] != "1" {
		t.Errorf("labels lost internal keys: %v", createLabels)
	}
	if createLabels["tier"] != "front" {
		t.Errorf("labels missing the edit's user label: %v", createLabels)
	}
	if _, ok := createLabels["stale"]; ok {
		t.Errorf("labels kept a non-internal live label; want it dropped: %v", createLabels)
	}
}

// TestRemoveVolume proves the DELETE reaches /volumes/{name} with the force flag.
func TestRemoveVolume(t *testing.T) {
	var gotForce, gotName string
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/volumes/") {
			gotForce = r.URL.Query().Get("force")
			gotName = r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	if err := c.RemoveVolume(t.Context(), "data", true); err != nil {
		t.Fatalf("RemoveVolume err: %v", err)
	}
	if gotName != "data" || gotForce != "1" {
		t.Errorf("RemoveVolume hit name=%q force=%q; want data/1", gotName, gotForce)
	}
}
