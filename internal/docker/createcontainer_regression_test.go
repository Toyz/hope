package docker

import (
	"net/http"
	"strings"
	"testing"

	"github.com/toyz/hope/internal/stackspec"
)

// TestCreateContainerNoNetworks is the regression guard for the nets[1:] panic:
// a spec with zero networks must create + start cleanly, not panic after create.
func TestCreateContainerNoNetworks(t *testing.T) {
	started := false
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/containers/create"):
			writeJSON(w, map[string]any{"Id": "newid"})
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/containers/newid/start"):
			started = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	spec := stackspec.ContainerSpec{Name: "loner", Image: "busybox"} // no Networks
	id, err := c.CreateContainer(t.Context(), "loner", spec, false, func(string) {})
	if err != nil {
		t.Fatalf("CreateContainer(no networks) err: %v", err)
	}
	if id != "newid" {
		t.Errorf("id = %q; want newid", id)
	}
	if !started {
		t.Error("container was not started")
	}
}
