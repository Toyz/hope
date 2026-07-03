// Package deploy is hope's write path: it turns a StackSpec into running
// containers (create, or diff-apply against the live stack), creates the
// networks/volumes a deploy needs, and persists the authored spec so a stack can
// be reopened and edited. Everything runs through the active host's Docker
// client, so it targets local or a tunneled agent transparently.
package deploy

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/toyz/hope/internal/stackspec"
	"github.com/toyz/hope/internal/store"
)

// Store persists authored StackSpecs so a stack deployed through hope can be
// reopened in the editor. It has two interchangeable backends: the embedded
// state db (bbolt, when mounted) or, for back-compat, one JSON file per stack
// under a per-host directory. When neither is configured the store is a no-op
// (deploy still works, the spec just isn't retained).
type Store struct {
	dir string       // legacy per-file backend (empty = off)
	db  *store.Store // preferred backend (nil/disabled = off) — takes precedence
}

// NewStore returns a spec store. db (when Enabled) is the preferred backend; dir
// is the legacy per-file fallback kept for back-compat. Empty/disabled both =
// retention off.
func NewStore(dir string, db *store.Store) *Store {
	return &Store{dir: strings.TrimSpace(dir), db: db}
}

// usingDB reports whether the bbolt backend is active (it wins over the dir).
func (s *Store) usingDB() bool { return s.db != nil && s.db.Enabled() }

// Enabled reports whether specs are retained anywhere.
func (s *Store) Enabled() bool { return s.usingDB() || s.dir != "" }

func (s *Store) path(host, project string) string {
	return filepath.Join(s.dir, sanitize(host), sanitize(project)+".json")
}

// key is the bbolt bucket key for a stack: "host/project" (both sanitized).
func key(host, project string) string { return sanitize(host) + "/" + sanitize(project) }

// Save writes the authored spec for a stack on a host (best-effort atomic on the
// file backend). Specs may carry secrets (env values); files are written 0600
// and the db file is 0600 too.
func (s *Store) Save(host, project string, spec *stackspec.StackSpec) error {
	if s.usingDB() {
		data, err := json.Marshal(spec)
		if err != nil {
			return err
		}
		return s.db.Put(store.BucketStacks, key(host, project), data)
	}
	if s.dir == "" {
		return nil
	}
	data, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	p := s.path(host, project)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Load returns the stored spec for a stack, or (nil, nil) when the store is
// disabled or the stack has no stored spec.
func (s *Store) Load(host, project string) (*stackspec.StackSpec, error) {
	if s.usingDB() {
		data := s.db.Get(store.BucketStacks, key(host, project))
		if data == nil {
			return nil, nil
		}
		return decodeSpec(data)
	}
	if s.dir == "" {
		return nil, nil
	}
	data, err := os.ReadFile(s.path(host, project))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return decodeSpec(data)
}

func decodeSpec(data []byte) (*stackspec.StackSpec, error) {
	var spec stackspec.StackSpec
	if err := json.Unmarshal(data, &spec); err != nil {
		return nil, fmt.Errorf("decode stored spec: %w", err)
	}
	return &spec, nil
}

// Delete removes a stored spec (no error if absent or disabled).
func (s *Store) Delete(host, project string) error {
	if s.usingDB() {
		return s.db.Delete(store.BucketStacks, key(host, project))
	}
	if s.dir == "" {
		return nil
	}
	err := os.Remove(s.path(host, project))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// List returns the project names with a stored spec on a host.
func (s *Store) List(host string) ([]string, error) {
	if s.usingDB() {
		prefix := sanitize(host) + "/"
		var out []string
		err := s.db.ForEach(store.BucketStacks, func(k, _ []byte) error {
			if ks := string(k); strings.HasPrefix(ks, prefix) {
				out = append(out, strings.TrimPrefix(ks, prefix))
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		sort.Strings(out)
		return out, nil
	}
	if s.dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(filepath.Join(s.dir, sanitize(host)))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		out = append(out, strings.TrimSuffix(e.Name(), ".json"))
	}
	sort.Strings(out)
	return out, nil
}

// MigrateFromDir does a one-time import of legacy per-file specs into the db when
// both a db and a dir are configured and the stacks bucket is still empty. The
// files are left in place (untouched) as a rollback path. Returns the number of
// specs imported.
func (s *Store) MigrateFromDir() (int, error) {
	if !s.usingDB() || s.dir == "" {
		return 0, nil
	}
	empty := true
	if err := s.db.ForEach(store.BucketStacks, func(_, _ []byte) error {
		empty = false
		return nil
	}); err != nil {
		return 0, err
	}
	if !empty {
		return 0, nil // already populated — don't re-import
	}
	hosts, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	n := 0
	for _, h := range hosts {
		if !h.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(s.dir, h.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(s.dir, h.Name(), f.Name()))
			if err != nil {
				continue
			}
			project := strings.TrimSuffix(f.Name(), ".json")
			if err := s.db.Put(store.BucketStacks, h.Name()+"/"+project, data); err == nil {
				n++
			}
		}
	}
	return n, nil
}

// sanitize keeps a host/project usable as a single path segment and blocks
// traversal (no separators, no "..").
func sanitize(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.ReplaceAll(b.String(), "..", "-")
	if out == "" {
		return "_"
	}
	return out
}
