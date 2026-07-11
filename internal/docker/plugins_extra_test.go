package docker

import (
	"net/http"
	"strings"
	"testing"
)

// TestSelfContainerID covers both resolution paths in plugins.go: the recorded
// self-hint (verified by an inspect) and the fallback scan for a HOPE_MANAGED
// container when the hint doesn't resolve.
func TestSelfContainerID(t *testing.T) {
	t.Run("resolves the verified self hint", func(t *testing.T) {
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/selfc") && strings.HasSuffix(r.URL.Path, "/json") {
				writeJSON(w, map[string]any{"Id": "selfc", "Name": "/hope", "Config": map[string]any{"Image": "hope"}})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		c.SetSelfID("selfc")
		if got := c.SelfContainerID(t.Context()); got != "selfc" {
			t.Errorf("SelfContainerID = %q; want selfc (verified hint)", got)
		}
	})

	t.Run("falls back to the HOPE_MANAGED scan", func(t *testing.T) {
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			p := r.URL.Path
			switch {
			case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/json"):
				writeJSON(w, []map[string]any{{"Id": "mgd"}, {"Id": "plain"}})
			case r.Method == http.MethodGet && strings.Contains(p, "/containers/mgd/") && strings.HasSuffix(p, "/json"):
				writeJSON(w, map[string]any{"Id": "mgd", "Config": map[string]any{"Env": []string{"HOPE_MANAGED=1"}}})
			case r.Method == http.MethodGet && strings.Contains(p, "/containers/plain/") && strings.HasSuffix(p, "/json"):
				writeJSON(w, map[string]any{"Id": "plain", "Config": map[string]any{"Env": []string{"PATH=/bin"}}})
			default:
				// Anything else (incl. the unresolvable "ghost-host" self hint) is absent.
				w.WriteHeader(http.StatusNotFound)
			}
		})
		// A self hint that will NOT inspect-resolve (returns 404 above), forcing the scan.
		c.SetSelfID("ghost-host")
		if got := c.SelfContainerID(t.Context()); got != "mgd" {
			t.Errorf("SelfContainerID = %q; want mgd (HOPE_MANAGED fallback)", got)
		}
	})
}
