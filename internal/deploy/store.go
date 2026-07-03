// Package deploy is hope's write path: it turns a StackSpec into running
// containers (create, or diff-apply against the live stack), creates the
// networks/volumes a deploy needs, and persists the authored spec so a stack can
// be reopened and edited. Everything runs through the active host's Docker
// client, so it targets local or a tunneled agent transparently.
package deploy

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/toyz/hope/internal/stackspec"
	"github.com/toyz/hope/internal/store"
)

// Store persists authored StackSpecs (so a stack deployed through hope can be
// reopened in the editor) in the embedded state db, bucket "stacks", keyed
// "host/project". When no state db is mounted it's a no-op — deploy still works,
// the spec just isn't retained across a recreate.
type Store struct {
	db *store.Store
}

// NewStore returns a spec store backed by the state db (nil/disabled = no-op).
func NewStore(db *store.Store) *Store { return &Store{db: db} }

// Enabled reports whether specs are retained (a state db is mounted).
func (s *Store) Enabled() bool { return s.db != nil && s.db.Enabled() }

// key is the bucket key for a stack: "host/project" (both sanitized).
func key(host, project string) string { return sanitize(host) + "/" + sanitize(project) }

// Save writes the authored spec for a stack on a host. Specs may carry secrets
// (env values); the db file is 0600.
func (s *Store) Save(host, project string, spec *stackspec.StackSpec) error {
	if !s.Enabled() {
		return nil
	}
	data, err := json.Marshal(spec)
	if err != nil {
		return err
	}
	return s.db.Put(store.BucketStacks, key(host, project), data)
}

// Load returns the stored spec for a stack, or (nil, nil) when absent / no store.
func (s *Store) Load(host, project string) (*stackspec.StackSpec, error) {
	if !s.Enabled() {
		return nil, nil
	}
	data := s.db.Get(store.BucketStacks, key(host, project))
	if data == nil {
		return nil, nil
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
	return s.db.Delete(store.BucketStacks, key(host, project))
}

// List returns the project names with a stored spec on a host.
func (s *Store) List(host string) ([]string, error) {
	if !s.Enabled() {
		return nil, nil
	}
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

// sanitize keeps a host/project usable as a single key segment and blocks
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
