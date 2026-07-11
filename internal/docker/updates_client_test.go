package docker

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types/image"
)

// These drive the image-freshness machinery (updates.go) against the fake daemon:
// the digest comparison, the per-project / cluster crawls, the copy-on-write cache
// merge + hook, and the on-disk / k-v persistence.

// imgFresh describes how the fake answers a freshness lookup for one image ref.
// A ref is identified by a unique substring of its URL path; local/remote are the
// sha bodies (equal => current, differ => outdated). An empty local => the image
// reports no repo digest (unknown); an empty remote => the registry is unreachable.
type imgFresh struct {
	match  string
	local  string
	remote string
}

// serveFreshness answers ImageInspect (/images/{ref}/json) and DistributionInspect
// (/distribution/{ref}/json). Returns true when it handled the request.
func serveFreshness(w http.ResponseWriter, r *http.Request, imgs []imgFresh) bool {
	p := r.URL.Path
	switch {
	case strings.Contains(p, "/distribution/") && strings.HasSuffix(p, "/json"):
		for _, im := range imgs {
			if strings.Contains(p, im.match) {
				if im.remote == "" {
					w.WriteHeader(http.StatusInternalServerError)
					return true
				}
				writeJSON(w, map[string]any{"Descriptor": map[string]any{"digest": "sha256:" + im.remote}})
				return true
			}
		}
	case strings.Contains(p, "/images/") && !strings.HasSuffix(p, "/images/json") && strings.HasSuffix(p, "/json"):
		for _, im := range imgs {
			if strings.Contains(p, im.match) {
				digests := []string{}
				if im.local != "" {
					digests = []string{im.match + "@sha256:" + im.local}
				}
				writeJSON(w, image.InspectResponse{ID: "sha256:" + im.match, RepoDigests: digests})
				return true
			}
		}
	}
	return false
}

// TestImageStatus locks the four verdicts of the digest comparison.
func TestImageStatus(t *testing.T) {
	imgs := []imgFresh{
		{match: "current-img", local: "same", remote: "same"},
		{match: "outdated-img", local: "old", remote: "new"},
		{match: "nodigest-img", local: "", remote: "irrelevant"},
		{match: "noreg-img", local: "have", remote: ""},
	}
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	cases := []struct {
		ref        string
		wantStatus string
	}{
		{"current-img:1", "current"},
		{"outdated-img:1", "outdated"},
		{"nodigest-img:1", "unknown"}, // local image has no repo digest
		{"noreg-img:1", "unknown"},    // registry unreachable
		{"missing-img:1", "unknown"},  // not found locally (404)
	}
	for _, tc := range cases {
		st, _ := c.imageStatus(t.Context(), tc.ref)
		if st != tc.wantStatus {
			t.Errorf("imageStatus(%q) = %q; want %q", tc.ref, st, tc.wantStatus)
		}
	}
}

// TestProjectUpdates proves the per-project scan: distinct refs are checked, the
// verdicts are returned per container, merged into the shared cache, and the hook
// fires when a ref newly flips to outdated.
func TestProjectUpdates(t *testing.T) {
	imgs := []imgFresh{
		{match: "nginx", local: "same", remote: "same"},
		{match: "redis", local: "old", remote: "new"},
	}
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				{"Id": "c1", "Image": "nginx:latest", "Labels": map[string]string{labelProject: "blog"}},
				{"Id": "c2", "Image": "redis:7", "Labels": map[string]string{labelProject: "blog"}},
			})
			return
		}
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	hookFired := false
	c.SetUpdateHook(func() { hookFired = true })

	ups, err := c.ProjectUpdates(t.Context(), "blog")
	if err != nil {
		t.Fatalf("ProjectUpdates err: %v", err)
	}
	byID := map[string]ImageUpdate{}
	for _, u := range ups {
		byID[u.ID] = u
	}
	if byID["c1"].Status != "current" {
		t.Errorf("c1 status = %q; want current", byID["c1"].Status)
	}
	if byID["c2"].Status != "outdated" {
		t.Errorf("c2 status = %q; want outdated", byID["c2"].Status)
	}
	// The verdicts landed in the shared cache (read by the rail's AllUpdates).
	if c.CachedStatus("nginx:latest") != "current" || c.CachedStatus("redis:7") != "outdated" {
		t.Errorf("cache = nginx:%s redis:%s; want current/outdated", c.CachedStatus("nginx:latest"), c.CachedStatus("redis:7"))
	}
	if !hookFired {
		t.Error("update hook did not fire on a new outdated flip")
	}
	// A ref never crawled reads as unknown; empty ref is unknown.
	if c.CachedStatus("ghost:1") != "unknown" || c.CachedStatus("") != "unknown" {
		t.Error("CachedStatus of an uncrawled/empty ref should be unknown")
	}
}

// TestCrawlUpdatesAndAllUpdates proves the cluster crawl fills the cache (with a
// timestamp), fires the hook once on a flip, and AllUpdates joins live containers
// to the cached verdicts (unknown for a ref the crawl didn't see).
func TestCrawlUpdatesAndAllUpdates(t *testing.T) {
	imgs := []imgFresh{
		{match: "web", local: "v1", remote: "v2"}, // outdated
		{match: "cache", local: "x", remote: "x"}, // current
	}
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				{"Id": "w1", "Names": []string{"/app-web-1"}, "Image": "web:1", "Labels": map[string]string{labelProject: "app", labelService: "web"}},
				{"Id": "k1", "Names": []string{"/app-cache-1"}, "Image": "cache:1", "Labels": map[string]string{labelProject: "app", labelService: "cache"}},
				// This container's image is never resolvable by the freshness helper
				// (no matching substring) so its digest stays uncrawled => unknown.
				{"Id": "u1", "Names": []string{"/lone"}, "Image": "unmatched-ref:1"},
			})
			return
		}
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	hookFired := false
	c.SetUpdateHook(func() { hookFired = true })

	c.crawlUpdates(t.Context())
	if !hookFired {
		t.Error("crawlUpdates hook did not fire on the outdated flip")
	}

	rows, at, err := c.AllUpdates(t.Context())
	if err != nil {
		t.Fatalf("AllUpdates err: %v", err)
	}
	if at.IsZero() {
		t.Error("AllUpdates timestamp is zero; crawlUpdates should have stamped updAt")
	}
	byID := map[string]ClusterUpdate{}
	for _, u := range rows {
		byID[u.ID] = u
	}
	if byID["w1"].Status != "outdated" || byID["w1"].Project != "app" || byID["w1"].Service != "web" || byID["w1"].Name != "app-web-1" {
		t.Errorf("w1 row = %+v; want outdated/app/web/app-web-1", byID["w1"])
	}
	if byID["k1"].Status != "current" {
		t.Errorf("k1 status = %q; want current", byID["k1"].Status)
	}
	// unmatched-ref:1 resolves to 404 image-inspect => "unknown" is cached; either
	// way an uncrawlable ref reads unknown.
	if byID["u1"].Status != "unknown" {
		t.Errorf("u1 status = %q; want unknown (never resolved)", byID["u1"].Status)
	}
}

// TestRefreshImageStatusAndProject proves a single-ref refresh updates the cache
// and fires the hook on a flip, and the project-wide refresh does the same for
// every distinct ref in a project.
func TestRefreshImageStatusAndProject(t *testing.T) {
	imgs := []imgFresh{
		{match: "alpha", local: "1", remote: "2"}, // outdated
		{match: "beta", local: "9", remote: "9"},  // current
	}
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				{"Id": "a1", "Image": "alpha:1", "Labels": map[string]string{labelProject: "proj"}},
				{"Id": "b1", "Image": "beta:1", "Labels": map[string]string{labelProject: "proj"}},
			})
			return
		}
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	flips := 0
	c.SetUpdateHook(func() { flips++ })

	// Single-ref: alpha flips to outdated => hook fires.
	c.RefreshImageStatus(t.Context(), "alpha:1")
	if c.CachedStatus("alpha:1") != "outdated" {
		t.Errorf("alpha cached = %q; want outdated", c.CachedStatus("alpha:1"))
	}
	if flips != 1 {
		t.Errorf("hook fired %d times; want 1 after the alpha flip", flips)
	}
	// Empty ref is a no-op.
	c.RefreshImageStatus(t.Context(), "")

	// Project-wide: beta gets checked too (already-outdated alpha won't re-flip).
	c.RefreshProjectStatus(t.Context(), "proj")
	if c.CachedStatus("beta:1") != "current" {
		t.Errorf("beta cached = %q; want current", c.CachedStatus("beta:1"))
	}
}

// memStore is an in-memory UpdateCacheStore for the persistence test.
type memStore struct {
	mu sync.Mutex
	m  map[string][]byte
}

func newMemStore() *memStore { return &memStore{m: map[string][]byte{}} }
func (s *memStore) Get(key string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[key]
}
func (s *memStore) Put(key string, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = append([]byte(nil), value...)
	return nil
}

// TestUpdateCacheStorePersistence proves SetUpdateCache routes save/load through a
// k/v store: a refreshed verdict survives into a brand-new client via loadUpdateCache.
func TestUpdateCacheStorePersistence(t *testing.T) {
	imgs := []imgFresh{{match: "keep", local: "1", remote: "2"}} // outdated
	route := func(w http.ResponseWriter, r *http.Request) {
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}
	store := newMemStore()

	c1 := fakeDaemon(t, route)
	c1.SetUpdateCache(store, "host-1")
	c1.RefreshImageStatus(t.Context(), "keep:1")
	if len(store.Get("host-1")) == 0 {
		t.Fatal("saveUpdateCache wrote nothing to the store")
	}

	// A fresh client loads the persisted verdict.
	c2 := fakeDaemon(t, route)
	c2.SetUpdateCache(store, "host-1")
	c2.loadUpdateCache()
	if c2.CachedStatus("keep:1") != "outdated" {
		t.Errorf("loaded cache status = %q; want outdated (persisted)", c2.CachedStatus("keep:1"))
	}
}

// TestUpdateCacheFilePersistence proves the on-disk JSON path round-trips: a saved
// cache file is rehydrated by a new client's loadUpdateCache.
func TestUpdateCacheFilePersistence(t *testing.T) {
	imgs := []imgFresh{{match: "disk", local: "a", remote: "a"}} // current
	route := func(w http.ResponseWriter, r *http.Request) {
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}
	path := t.TempDir() + "/nested/cache.json" // MkdirAll must create the parent

	c1 := fakeDaemon(t, route)
	c1.updPath = path
	c1.RefreshImageStatus(t.Context(), "disk:1")

	c2 := fakeDaemon(t, route)
	c2.updPath = path
	c2.loadUpdateCache()
	if c2.CachedStatus("disk:1") != "current" {
		t.Errorf("loaded file cache status = %q; want current", c2.CachedStatus("disk:1"))
	}
}

// TestRefreshUpdates proves the user-triggered immediate crawl fills the cache.
func TestRefreshUpdates(t *testing.T) {
	imgs := []imgFresh{{match: "now", local: "1", remote: "2"}} // outdated
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{{"Id": "n1", "Image": "now:1"}})
			return
		}
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	c.RefreshUpdates(t.Context())
	if c.CachedStatus("now:1") != "outdated" {
		t.Errorf("RefreshUpdates cache = %q; want outdated", c.CachedStatus("now:1"))
	}
}

// TestStartUpdateCrawler proves the crawler loads the cache, runs an immediate
// crawl on launch, and stamps the cache.
func TestStartUpdateCrawler(t *testing.T) {
	imgs := []imgFresh{{match: "boot", local: "1", remote: "1"}}
	hit := make(chan struct{}, 1)
	var once sync.Once
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			once.Do(func() { close(hit) })
			writeJSON(w, []map[string]any{{"Id": "x1", "Image": "boot:1"}})
			return
		}
		if serveFreshness(w, r, imgs) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	c.StartUpdateCrawler(t.Context(), time.Hour, "")
	select {
	case <-hit:
	case <-time.After(2 * time.Second):
		t.Fatal("StartUpdateCrawler never issued the initial container list")
	}
	deadline := time.Now().Add(time.Second)
	for {
		if c.CachedStatus("boot:1") == "current" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("crawler ran but cache never became current: %q", c.CachedStatus("boot:1"))
		}
		time.Sleep(5 * time.Millisecond)
	}
}
