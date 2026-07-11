package docker

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// These drive the disk-usage cache and build-cache prune against the fake daemon.

// TestDiskUsage proves the live df call (docker.go) returns a non-nil breakdown.
func TestDiskUsage(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/system/df") {
			writeJSON(w, map[string]any{"LayersSize": 12345})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	du, err := c.DiskUsage(t.Context())
	if err != nil {
		t.Fatalf("DiskUsage err: %v", err)
	}
	if du == nil {
		t.Error("DiskUsage = nil; want a decoded breakdown")
	}
}

// TestDiskUsageCachedAndRefresh proves the cache lifecycle: empty before any
// crawl, populated by crawlDisk, and RefreshDiskUsage returns a fresh reading
// plus its timestamp.
func TestDiskUsageCachedAndRefresh(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/system/df") {
			writeJSON(w, map[string]any{"LayersSize": 999})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	// Before any crawl: no data, zero timestamp.
	if _, at := c.DiskUsageCached(); !at.IsZero() {
		t.Errorf("DiskUsageCached before crawl: at = %v; want zero", at)
	}

	// crawlDisk fills the cache.
	c.crawlDisk(t.Context())
	du, at := c.DiskUsageCached()
	if du == nil || at.IsZero() {
		t.Errorf("DiskUsageCached after crawl = %v/%v; want data + non-zero time", du, at)
	}

	// RefreshDiskUsage returns a live reading and advances the timestamp.
	du2, at2, err := c.RefreshDiskUsage(t.Context())
	if err != nil {
		t.Fatalf("RefreshDiskUsage err: %v", err)
	}
	if du2 == nil || at2.Before(at) {
		t.Errorf("RefreshDiskUsage = %v/%v; want data + advanced time", du2, at2)
	}
}

// TestRefreshDiskUsageError proves a df failure is surfaced, not cached.
func TestRefreshDiskUsageError(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	if _, _, err := c.RefreshDiskUsage(t.Context()); err == nil {
		t.Error("RefreshDiskUsage over a failing daemon = nil; want an error")
	}
}

// TestPruneBuildCache proves the build-cache prune hits /build/prune with all=1
// and returns the reclaimed bytes.
func TestPruneBuildCache(t *testing.T) {
	var gotAll string
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/build/prune") {
			gotAll = r.URL.Query().Get("all")
			writeJSON(w, map[string]any{"CachesDeleted": []string{"c1", "c2"}, "SpaceReclaimed": 8192})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	reclaimed, err := c.PruneBuildCache(t.Context())
	if err != nil {
		t.Fatalf("PruneBuildCache err: %v", err)
	}
	if reclaimed != 8192 {
		t.Errorf("PruneBuildCache = %d; want 8192", reclaimed)
	}
	if gotAll != "1" {
		t.Errorf("build prune all= %q; want 1 (prune all cache)", gotAll)
	}
}

// TestStartDiskCrawler proves the crawler runs an immediate crawl on launch and
// populates the cache; the test context cancels the goroutine on cleanup.
func TestStartDiskCrawler(t *testing.T) {
	hit := make(chan struct{}, 1)
	var once sync.Once
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/system/df") {
			once.Do(func() { close(hit) })
			writeJSON(w, map[string]any{"LayersSize": 1})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	c.StartDiskCrawler(t.Context(), time.Hour) // big interval: we only assert the immediate crawl
	select {
	case <-hit:
	case <-time.After(2 * time.Second):
		t.Fatal("StartDiskCrawler never issued the initial df call")
	}
	// Give crawlDisk a moment to store the result before asserting.
	deadline := time.Now().Add(time.Second)
	for {
		if _, at := c.DiskUsageCached(); !at.IsZero() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("crawler ran df but never populated the cache")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
