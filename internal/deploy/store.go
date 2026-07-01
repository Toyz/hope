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
)

// Store persists authored StackSpecs as JSON under a per-host directory, so a
// stack deployed through hope can be reopened in the editor. It mirrors the
// updates cache: when the directory is unset the store is a no-op (deploy still
// works, the spec just isn't retained), and writes go through a temp-rename.
type Store struct {
	dir string
}

// NewStore returns a spec store rooted at dir. An empty dir disables retention.
func NewStore(dir string) *Store { return &Store{dir: strings.TrimSpace(dir)} }

// Enabled reports whether specs are retained on disk.
func (s *Store) Enabled() bool { return s.dir != "" }

func (s *Store) path(host, project string) string {
	return filepath.Join(s.dir, sanitize(host), sanitize(project)+".json")
}

// Save writes the authored spec for a stack on a host (best-effort atomic).
// Files may carry secrets (env values), so they are written 0600.
func (s *Store) Save(host, project string, spec *stackspec.StackSpec) error {
	if !s.Enabled() {
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
	if !s.Enabled() {
		return nil, nil
	}
	data, err := os.ReadFile(s.path(host, project))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var spec stackspec.StackSpec
	if err := json.Unmarshal(data, &spec); err != nil {
		return nil, fmt.Errorf("decode stored spec: %w", err)
	}
	return &spec, nil
}

// Delete removes a stored spec (no error if absent or disabled).
func (s *Store) Delete(host, project string) error {
	if !s.Enabled() {
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
	if !s.Enabled() {
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
