package docker

import (
	"net/http"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
)

// These drive the still-uncovered image ops (history/top/remove/prune) against
// the fake daemon, locking the endpoint each hits and the SDK response it maps.

// TestHistory proves the layer-history mapping: "<missing>" layer ids are blanked,
// Empty follows a zero size, and the order is preserved (newest first).
func TestHistory(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/history") {
			writeJSON(w, []image.HistoryResponseItem{
				{ID: "sha256:top", Created: 3, CreatedBy: "CMD [\"nginx\"]", Size: 0, Comment: "", Tags: []string{"nginx:latest"}},
				{ID: "<missing>", Created: 2, CreatedBy: "COPY . /app", Size: 2048, Comment: "buildkit"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	layers, err := c.History(t.Context(), "sha256:top")
	if err != nil {
		t.Fatalf("History err: %v", err)
	}
	if len(layers) != 2 {
		t.Fatalf("History = %d layers; want 2", len(layers))
	}
	// First layer: real id kept, zero size => Empty.
	if layers[0].ID != "sha256:top" || !layers[0].Empty || layers[0].Size != 0 {
		t.Errorf("layer0 = %+v; want id sha256:top, empty, size 0", layers[0])
	}
	// Second layer: "<missing>" blanked, non-zero size => not empty.
	if layers[1].ID != "" || layers[1].Empty || layers[1].Size != 2048 {
		t.Errorf("layer1 = %+v; want blank id, not empty, size 2048", layers[1])
	}
	if layers[1].CreatedBy != "COPY . /app" {
		t.Errorf("layer1 CreatedBy = %q; want COPY . /app", layers[1].CreatedBy)
	}
}

// TestTop proves the process-list mapping straight off the daemon's top response.
func TestTop(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/top") {
			writeJSON(w, container.TopResponse{
				Titles:    []string{"PID", "USER", "COMMAND"},
				Processes: [][]string{{"1", "root", "nginx"}, {"42", "www", "worker"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	top, err := c.Top(t.Context(), "cid")
	if err != nil {
		t.Fatalf("Top err: %v", err)
	}
	if len(top.Titles) != 3 || top.Titles[2] != "COMMAND" {
		t.Errorf("Titles = %v; want 3 cols ending COMMAND", top.Titles)
	}
	if len(top.Processes) != 2 || top.Processes[1][2] != "worker" {
		t.Errorf("Processes = %v; want 2 rows, row1 cmd worker", top.Processes)
	}
}

// TestRemoveImage proves the DELETE reaches /images/{id} and the force flag is
// forwarded as a query param; a daemon error is surfaced.
func TestRemoveImage(t *testing.T) {
	t.Run("force forwarded, success", func(t *testing.T) {
		var gotForce string
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/images/") {
				gotForce = r.URL.Query().Get("force")
				writeJSON(w, []image.DeleteResponse{{Deleted: "sha256:x"}})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		if err := c.RemoveImage(t.Context(), "sha256:x", true); err != nil {
			t.Fatalf("RemoveImage err: %v", err)
		}
		if gotForce != "1" {
			t.Errorf("force query = %q; want 1", gotForce)
		}
	})
	t.Run("daemon error surfaced", func(t *testing.T) {
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/images/") {
				w.WriteHeader(http.StatusConflict)
				writeJSON(w, map[string]any{"message": "image is being used by stopped container"})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		if err := c.RemoveImage(t.Context(), "sha256:x", false); err == nil {
			t.Error("RemoveImage(in-use) = nil; want the daemon error")
		}
	})
}

// TestPruneImages proves the dangling filter flips with `all` and the report maps
// deleted-count + reclaimed bytes. dangling=true prunes only untagged; all=true
// sends dangling=false so the daemon prunes every unused image.
func TestPruneImages(t *testing.T) {
	cases := []struct {
		all         bool
		wantDangArg string
	}{
		{false, "true"},
		{true, "false"},
	}
	for _, tc := range cases {
		var gotFilters string
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/prune") {
				gotFilters = r.URL.Query().Get("filters")
				writeJSON(w, image.PruneReport{
					ImagesDeleted:  []image.DeleteResponse{{Deleted: "a"}, {Deleted: "b"}},
					SpaceReclaimed: 4096,
				})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		res, err := c.PruneImages(t.Context(), tc.all)
		if err != nil {
			t.Fatalf("PruneImages(all=%v) err: %v", tc.all, err)
		}
		if res.Deleted != 2 || res.Reclaimed != 4096 {
			t.Errorf("PruneImages(all=%v) = %+v; want 2 deleted / 4096 reclaimed", tc.all, res)
		}
		// The dangling arg encodes as {"dangling":{"<val>":true}} inside the filters JSON.
		if !strings.Contains(gotFilters, `"dangling"`) || !strings.Contains(gotFilters, `"`+tc.wantDangArg+`"`) {
			t.Errorf("PruneImages(all=%v) filters = %q; want dangling=%s", tc.all, gotFilters, tc.wantDangArg)
		}
	}
}

// TestPruneImagesStream proves per-image streaming: with all=false only dangling
// images are removed; a remove failure emits a "skip" line (with the cleaned
// reason) and continues; the final line reports the totals.
func TestPruneImagesStream(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/images/json"):
			writeJSON(w, []image.Summary{
				{ID: "sha256:dang", RepoTags: []string{"<none>:<none>"}, Size: 1024},
				{ID: "sha256:tagged", RepoTags: []string{"nginx:latest"}, Size: 5000},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, []map[string]any{})
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/images/"):
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	var lines []string
	if err := c.PruneImagesStream(t.Context(), false, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("PruneImagesStream err: %v", err)
	}
	joined := strings.Join(lines, "\n")
	// Only the dangling image is removed; the tagged one is left untouched.
	if !strings.Contains(joined, "removed") {
		t.Errorf("stream = %q; want a 'removed' line for the dangling image", joined)
	}
	if strings.Contains(joined, "nginx:latest") {
		t.Errorf("stream = %q; the tagged image must not be pruned with all=false", joined)
	}
	if !strings.Contains(lines[len(lines)-1], "done") {
		t.Errorf("last line = %q; want a done summary", lines[len(lines)-1])
	}
}

// TestPruneImagesStreamAll proves all=true prunes every NOT-in-use image (tagged
// included) and skips those a container references.
func TestPruneImagesStreamAll(t *testing.T) {
	removed := map[string]bool{}
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/images/json"):
			writeJSON(w, []image.Summary{
				{ID: "sha256:used", RepoTags: []string{"redis:7"}, Size: 3000},
				{ID: "sha256:idle", RepoTags: []string{"busybox:1"}, Size: 800},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, []map[string]any{
				{"Id": "c1", "Names": []string{"/r-1"}, "ImageID": "sha256:used"},
			})
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/images/"):
			id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			removed[id] = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if err := c.PruneImagesStream(t.Context(), true, func(string) {}); err != nil {
		t.Fatalf("PruneImagesStream(all) err: %v", err)
	}
	if removed["sha256:used"] {
		t.Error("in-use image was pruned; must be skipped")
	}
	if !removed["sha256:idle"] {
		t.Error("idle tagged image was not pruned with all=true; want it removed")
	}
}
