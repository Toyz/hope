package docker

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/system"
)

// These cover the thin single-container control wrappers (docker.go) and the
// self-tolerance logic, against the fake daemon.

// TestContainerLifecycle drives the start/stop/restart/kill/remove wrappers and
// asserts each reaches its Engine-API endpoint without error.
func TestContainerLifecycle(t *testing.T) {
	var hits []string
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
			hits = append(hits, "start")
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
			hits = append(hits, "stop")
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/restart"):
			hits = append(hits, "restart")
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/kill"):
			hits = append(hits, "kill")
		case r.Method == http.MethodDelete && strings.Contains(p, "/containers/"):
			hits = append(hits, "remove")
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	ctx := t.Context()
	if err := c.Start(ctx, "cid"); err != nil {
		t.Errorf("Start err: %v", err)
	}
	if err := c.Stop(ctx, "cid"); err != nil {
		t.Errorf("Stop err: %v", err)
	}
	if err := c.Restart(ctx, "cid"); err != nil {
		t.Errorf("Restart err: %v", err)
	}
	if err := c.Kill(ctx, "cid"); err != nil {
		t.Errorf("Kill err: %v", err)
	}
	if err := c.Remove(ctx, "cid"); err != nil {
		t.Errorf("Remove err: %v", err)
	}
	// Remove does a best-effort stop then a force remove.
	joined := strings.Join(hits, ",")
	for _, want := range []string{"start", "stop", "restart", "kill", "remove"} {
		if !strings.Contains(joined, want) {
			t.Errorf("lifecycle hits = %v; missing %q", hits, want)
		}
	}
}

// TestTolerateSelf proves the self-connection-drop swallow: a dropped connection
// on hope's OWN container is a success (the op executed — that's why it dropped);
// every other combination passes the error through.
func TestTolerateSelf(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotFound) })
	c.SetSelfID("selfcontainer")

	connDrop := errors.New("Error response from daemon: unexpected EOF")
	daemonErr := errors.New("Error response from daemon: no such container")

	if err := c.tolerateSelf("selfcontainer", connDrop); err != nil {
		t.Errorf("self + conn-drop = %v; want nil (tolerated)", err)
	}
	if err := c.tolerateSelf("selfcontainer", daemonErr); err == nil {
		t.Error("self + real daemon error = nil; want passthrough")
	}
	if err := c.tolerateSelf("other", connDrop); err == nil {
		t.Error("non-self + conn-drop = nil; want passthrough")
	}
	if err := c.tolerateSelf("selfcontainer", nil); err != nil {
		t.Errorf("nil error must stay nil, got %v", err)
	}
}

// TestInspectExistsInfoPing covers the read-only daemon wrappers.
func TestInspectExistsInfoPing(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/present") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{"Id": "present", "Name": "/web", "Config": map[string]any{"Image": "nginx"}})
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
			w.WriteHeader(http.StatusNotFound) // any other id: absent
		case r.Method == http.MethodGet && strings.HasSuffix(p, "/info"):
			writeJSON(w, system.Info{ServerVersion: "27.0.0", Containers: 2})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	ctx := t.Context()

	insp, err := c.Inspect(ctx, "present")
	if err != nil || insp == nil {
		t.Errorf("Inspect(present) = %v/%v; want the inspect json", insp, err)
	}
	if _, err := c.Inspect(ctx, "ghost"); err == nil {
		t.Error("Inspect(ghost) = nil err; want a not-found error")
	}
	if !c.Exists(ctx, "present") {
		t.Error("Exists(present) = false; want true")
	}
	if c.Exists(ctx, "ghost") {
		t.Error("Exists(ghost) = true; want false")
	}
	info, err := c.Info(ctx)
	if err != nil || info == nil {
		t.Errorf("Info = %v/%v; want the daemon info", info, err)
	}
	if err := c.Ping(ctx); err != nil {
		t.Errorf("Ping err: %v", err)
	}
	if c.SDK() == nil {
		t.Error("SDK() = nil; want the live handle")
	}
}
