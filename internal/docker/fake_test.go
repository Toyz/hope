package docker

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeDaemon spins an httptest server that speaks just enough of the Docker Engine
// API to exercise a *Client method without a real daemon. routes maps a path
// substring (e.g. "/networks/") to a handler; the harness answers the API-version
// ping itself. This is what lets the daemon-bound methods be unit-tested.
func fakeDaemon(t *testing.T, route func(w http.ResponseWriter, r *http.Request)) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Api-Version", "1.45")
		if strings.HasSuffix(r.URL.Path, "/_ping") {
			w.WriteHeader(http.StatusOK)
			return
		}
		route(w, r)
	}))
	t.Cleanup(srv.Close)
	c, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("build client against fake daemon: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// TestRemoveNetworkProtection proves the fake-daemon harness AND the guard: a
// protected network (by name or ink.hope.system label) is refused before any
// DELETE reaches the daemon; an ordinary one is deleted.
func TestRemoveNetworkProtection(t *testing.T) {
	cases := []struct {
		name        string
		netName     string
		labels      map[string]string
		wantRefused bool
	}{
		{"predefined bridge", "bridge", nil, true},
		{"hope plugin bridge by name", PluginNetwork, nil, true},
		{"labelled system net", "renamed-infra", map[string]string{LabelSystem: "1"}, true},
		{"ordinary user net", "my-app_default", map[string]string{LabelManaged: "1"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deleted := false
			c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/networks/"):
					writeJSON(w, map[string]any{"Id": "netid", "Name": tc.netName, "Labels": tc.labels})
				case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/networks/"):
					deleted = true
					w.WriteHeader(http.StatusNoContent)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})
			err := c.RemoveNetwork(t.Context(), "netid")
			if tc.wantRefused {
				if err == nil {
					t.Errorf("RemoveNetwork(%s) = nil; want a protection error", tc.netName)
				}
				if deleted {
					t.Errorf("RemoveNetwork(%s) issued a DELETE; a protected net must never reach the daemon", tc.netName)
				}
			} else {
				if err != nil {
					t.Errorf("RemoveNetwork(%s) = %v; want nil (deletable)", tc.netName, err)
				}
				if !deleted {
					t.Errorf("RemoveNetwork(%s) did not DELETE; an ordinary net should be removed", tc.netName)
				}
			}
		})
	}
}
