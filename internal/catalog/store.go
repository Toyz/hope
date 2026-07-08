package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// CacheStore persists a fetched manifest so it survives a restart without a re-fetch.
// Satisfied by a thin adapter over the state db (see cmd/hope/serve.go). Keyed per repo.
type CacheStore interface {
	Get(key string) []byte
	Put(key string, value []byte) error
}

// Source is one remote catalog repo.
type Source struct {
	Name  string // display/origin label (defaults to URL)
	URL   string
	Trust bool // allow images outside the trusted prefixes from this repo
}

// Service serves the installable catalog: the built-in entries always, plus every
// configured remote repo (fetched, cached, merged over the built-ins and each other in
// order). Safe for concurrent use.
type Service struct {
	sources []Source
	refresh time.Duration
	client  *http.Client
	cache   CacheStore // may be nil (no persistence)

	mu     sync.RWMutex
	remote map[string][]CatalogEntry // keyed by source name
}

// New returns a catalog service over the given repos (empty = built-ins only). refresh
// is the shared re-fetch interval. cache (optional) persists each repo's last good
// manifest under its name.
func New(sources []Source, refresh time.Duration, cache CacheStore) *Service {
	// Default each source's cache/display name to its URL.
	for i := range sources {
		if sources[i].Name == "" {
			sources[i].Name = sources[i].URL
		}
	}
	return &Service{
		sources: sources,
		refresh: refresh,
		client:  &http.Client{Timeout: 15 * time.Second},
		cache:   cache,
		remote:  map[string][]CatalogEntry{},
	}
}

// Start loads any persisted manifests, fetches every repo once, then re-fetches every
// refresh (when > 0). No-op when there are no repos. Non-blocking.
func (s *Service) Start(ctx context.Context) {
	s.loadCache()
	if len(s.sources) == 0 {
		return
	}
	go func() {
		s.refreshAll(ctx)
		if s.refresh <= 0 {
			return
		}
		t := time.NewTicker(s.refresh)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.refreshAll(ctx)
			}
		}
	}()
}

// Refresh re-fetches every repo now (user-triggered). Returns the first error, but
// still applies every repo that did fetch (a bad repo doesn't blank the catalog).
func (s *Service) Refresh(ctx context.Context) error {
	return s.refreshAll(ctx)
}

func (s *Service) refreshAll(ctx context.Context) error {
	var firstErr error
	for _, src := range s.sources {
		if err := s.fetch(ctx, src); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// fetch pulls one repo's manifest, replaces its cached entries, and persists them.
// A fetch error leaves that repo's previous entries in place.
func (s *Service) fetch(ctx context.Context, src Source) error {
	if src.URL == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch catalog %q: %w", src.Name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch catalog %q: unexpected status %d", src.Name, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20)) // 2 MiB cap
	if err != nil {
		return err
	}
	var m Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return fmt.Errorf("decode catalog %q: %w", src.Name, err)
	}
	s.setRemote(src.Name, m.Entries)
	if s.cache != nil {
		_ = s.cache.Put(src.Name, body) // best-effort persist of the raw manifest
	}
	return nil
}

// Entries returns the merged installable list (built-ins ⊕ every repo, in order).
func (s *Service) Entries() []CatalogEntry {
	s.mu.RLock()
	srcs := make([]SourceEntries, 0, len(s.sources))
	for _, src := range s.sources {
		srcs = append(srcs, SourceEntries{Name: src.Name, Entries: s.remote[src.Name], Trust: src.Trust})
	}
	s.mu.RUnlock()
	return Merge(Builtins(), srcs)
}

// Entry returns the merged entry with the given ID, or (zero, false).
func (s *Service) Entry(id string) (CatalogEntry, bool) {
	for _, e := range s.Entries() {
		if e.ID == id {
			return e, true
		}
	}
	return CatalogEntry{}, false
}

func (s *Service) setRemote(name string, entries []CatalogEntry) {
	s.mu.Lock()
	s.remote[name] = entries
	s.mu.Unlock()
}

// loadCache seeds each repo's entries from its persisted manifest (if any).
func (s *Service) loadCache() {
	if s.cache == nil {
		return
	}
	for _, src := range s.sources {
		raw := s.cache.Get(src.Name)
		if len(raw) == 0 {
			continue
		}
		var m Manifest
		if err := json.Unmarshal(raw, &m); err == nil {
			s.setRemote(src.Name, m.Entries)
		}
	}
}
