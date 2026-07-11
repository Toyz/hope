package catalog

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeCache is an in-memory CacheStore for exercising persistence + load paths.
type fakeCache struct {
	mu  sync.Mutex
	m   map[string][]byte
	put int
}

func (c *fakeCache) Get(key string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.m[key]
}

func (c *fakeCache) Put(key string, value []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string][]byte{}
	}
	c.m[key] = append([]byte(nil), value...)
	c.put++
	return nil
}

const sampleManifest = `{"version":1,"entries":[{
	"id":"acme-mongo","title":"MongoDB","image":"ghcr.io/toyz/hope-mongo:1",
	"port":9090,"path":"/rpc",
	"env":[{"key":"MONGO_URI","label":"URI","kind":"secret","required":true}],
	"volumes":[{"target":"/data"}],
	"settings":[{"key":"page_size","value":"50"}]
}]}`

// TestNewDefaultsSourceName covers New's name-defaulting loop: a source with an empty
// Name is labeled by its URL (used as both the cache key and display origin).
func TestNewDefaultsSourceName(t *testing.T) {
	s := New([]Source{{URL: "https://example.test/catalog.json"}, {Name: "keep", URL: "u"}}, 0, nil)
	if s.sources[0].Name != "https://example.test/catalog.json" {
		t.Errorf("empty source name should default to URL, got %q", s.sources[0].Name)
	}
	if s.sources[1].Name != "keep" {
		t.Errorf("explicit source name should be preserved, got %q", s.sources[1].Name)
	}
}

// TestFetchAndEntries drives fetch (via Refresh) against an httptest server serving a
// well-formed manifest, then confirms the remote entry merges over the built-ins and
// Entry(id) resolves it. Also confirms the raw body was persisted to the cache.
func TestFetchAndEntries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept header = %q, want application/json", got)
		}
		_, _ = w.Write([]byte(sampleManifest))
	}))
	defer srv.Close()

	cache := &fakeCache{}
	s := New([]Source{{Name: "community", URL: srv.URL, Trust: false}}, 0, cache)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	entries := s.Entries()
	if len(entries) != len(Builtins())+1 {
		t.Fatalf("want builtins+1 entries, got %d", len(entries))
	}
	e, ok := s.Entry("acme-mongo")
	if !ok {
		t.Fatal("Entry(acme-mongo) not found after fetch")
	}
	if e.Source != "community" {
		t.Errorf("remote entry Source = %q, want community", e.Source)
	}
	if e.PortOrDefault() != 9090 || e.PathOrDefault() != "/rpc" {
		t.Errorf("port/path not decoded: %d %q", e.PortOrDefault(), e.PathOrDefault())
	}
	if len(e.Env) != 1 || !e.Env[0].Required {
		t.Errorf("env not decoded: %+v", e.Env)
	}
	// Best-effort persist happened.
	if cache.put == 0 || len(cache.Get("community")) == 0 {
		t.Errorf("fetch should persist the raw body to the cache")
	}
	// A missing id yields (zero,false).
	if _, ok := s.Entry("nope"); ok {
		t.Error("Entry(nope) should be false")
	}
}

// TestFetchBadJSON: a decode failure returns an error and leaves the catalog as just
// the built-ins (a bad repo doesn't blank the list).
func TestFetchBadJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{not json`))
	}))
	defer srv.Close()

	s := New([]Source{{Name: "bad", URL: srv.URL, Trust: true}}, 0, nil)
	if err := s.Refresh(t.Context()); err == nil {
		t.Fatal("expected decode error")
	}
	if len(s.Entries()) != len(Builtins()) {
		t.Errorf("bad repo should leave only built-ins, got %d", len(s.Entries()))
	}
}

// TestFetchBadStatus: a non-200 is an error (and again keeps built-ins).
func TestFetchBadStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	s := New([]Source{{Name: "err", URL: srv.URL, Trust: true}}, 0, nil)
	err := s.Refresh(t.Context())
	if err == nil || !strings.Contains(err.Error(), "unexpected status") {
		t.Fatalf("want unexpected-status error, got %v", err)
	}
}

// TestFetch2MiBLimit: the body is capped at 2 MiB, so a manifest larger than that is
// truncated mid-JSON and fails to decode — the cap can't be defeated by a huge body.
func TestFetch2MiBLimit(t *testing.T) {
	huge := `{"version":1,"entries":[{"id":"x","image":"ghcr.io/toyz/x:1","description":"` +
		strings.Repeat("A", 3<<20) + `"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(huge))
	}))
	defer srv.Close()

	s := New([]Source{{Name: "big", URL: srv.URL, Trust: true}}, 0, nil)
	if err := s.Refresh(t.Context()); err == nil {
		t.Fatal("expected a decode error from the truncated (capped) body")
	}
	if _, ok := s.Entry("x"); ok {
		t.Error("truncated manifest must not yield an entry")
	}
}

// TestFetchEmptyURL: a source with no URL is a silent no-op (covers the early return).
func TestFetchEmptyURL(t *testing.T) {
	s := New(nil, 0, nil)
	if err := s.fetch(t.Context(), Source{Name: "x"}); err != nil {
		t.Fatalf("empty-URL fetch should be a no-op, got %v", err)
	}
}

// TestRedirectPinning: a cross-host redirect is refused (SSRF guard), while a
// same-host redirect is followed to the manifest.
func TestRedirectPinning(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleManifest))
	}))
	defer other.Close()

	// Cross-host: redirect to a DIFFERENT host must be refused.
	crossMux := http.NewServeMux()
	crossMux.HandleFunc("/away", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/", http.StatusFound)
	})
	cross := httptest.NewServer(crossMux)
	defer cross.Close()

	s := New([]Source{{Name: "x", URL: cross.URL + "/away", Trust: true}}, 0, nil)
	if err := s.Refresh(t.Context()); err == nil {
		t.Fatal("cross-host redirect should be refused")
	}

	// Same-host: a redirect within the same host is allowed and reaches the manifest.
	sameMux := http.NewServeMux()
	sameMux.HandleFunc("/start", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/manifest", http.StatusFound)
	})
	sameMux.HandleFunc("/manifest", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleManifest))
	})
	same := httptest.NewServer(sameMux)
	defer same.Close()

	s2 := New([]Source{{Name: "y", URL: same.URL + "/start", Trust: true}}, 0, nil)
	if err := s2.Refresh(t.Context()); err != nil {
		t.Fatalf("same-host redirect should be followed: %v", err)
	}
	if _, ok := s2.Entry("acme-mongo"); !ok {
		t.Error("same-host redirect should have loaded the manifest")
	}
}

// TestRedirectTooMany: a redirect loop trips the 5-hop cap.
func TestRedirectTooMany(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := n.Add(1)
		http.Redirect(w, r, "/hop"+string(rune('0'+int(i%10))), http.StatusFound)
	}))
	defer srv.Close()

	s := New([]Source{{Name: "loop", URL: srv.URL, Trust: true}}, 0, nil)
	if err := s.Refresh(t.Context()); err == nil {
		t.Fatal("a redirect loop should error out")
	}
}

// TestLoadCache seeds a repo's entries from a persisted manifest with no network.
func TestLoadCache(t *testing.T) {
	cache := &fakeCache{}
	_ = cache.Put("cached-repo", []byte(sampleManifest))

	s := New([]Source{{Name: "cached-repo", URL: "", Trust: true}}, 0, cache)
	s.loadCache()
	if _, ok := s.Entry("acme-mongo"); !ok {
		t.Fatal("loadCache should seed entries from the persisted manifest")
	}

	// A nil cache is a no-op (doesn't panic).
	New(nil, 0, nil).loadCache()
	// A cached entry that fails to decode is skipped silently.
	bad := &fakeCache{}
	_ = bad.Put("r", []byte("{bad"))
	sb := New([]Source{{Name: "r", URL: "", Trust: true}}, 0, bad)
	sb.loadCache()
	if len(sb.Entries()) != len(Builtins()) {
		t.Error("undecodable cache should be ignored")
	}
}

// TestStartNoSources: Start with no repos loads cache and returns without a goroutine.
func TestStartNoSources(t *testing.T) {
	s := New(nil, 0, nil)
	s.Start(t.Context())
	if len(s.Entries()) != len(Builtins()) {
		t.Errorf("no-source service should serve exactly the built-ins")
	}
}

// TestStartFetchesAndTicks: Start fetches once immediately and then re-fetches on the
// refresh ticker; cancelling the context stops the loop.
func TestStartFetchesAndTicks(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(sampleManifest))
	}))
	defer srv.Close()

	s := New([]Source{{Name: "community", URL: srv.URL, Trust: false}}, 20*time.Millisecond, nil)
	s.Start(t.Context())

	// Wait for the initial fetch + at least one ticker-driven refetch.
	deadline := time.Now().Add(3 * time.Second)
	for hits.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("Start did not re-fetch on the ticker (hits=%d)", hits.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok := s.Entry("acme-mongo"); !ok {
		t.Error("Start should have loaded the remote entry")
	}
}
