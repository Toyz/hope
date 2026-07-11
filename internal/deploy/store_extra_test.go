package deploy

import (
	"reflect"
	"testing"

	"github.com/toyz/hope/internal/stackspec"
)

// sanitize keeps a host/project usable as a single key segment and blocks
// traversal (no separators, no "..").
func TestSanitize(t *testing.T) {
	tests := []struct{ in, want string }{
		{"local", "local"},
		{"host.example.com", "host.example.com"}, // dots kept
		{"a/b", "a-b"},                            // separator -> '-'
		{"..", "-"},                               // traversal collapsed (".." -> "-")
		{"../etc", "--etc"},                       // '/' -> '-' first, then leading ".." -> '-'
		{"a..b", "a-b"},                           // embedded ".." collapsed
		{"", "_"},                                 // empty -> "_"
		{"   ", "_"},                              // whitespace trimmed then empty -> "_"
		{"weird name!", "weird-name-"},            // space + '!' -> '-'
	}
	for _, tt := range tests {
		if got := sanitize(tt.in); got != tt.want {
			t.Errorf("sanitize(%q) = %q; want %q", tt.in, got, tt.want)
		}
	}
}

// key composes the bucket key "host/project" from sanitized parts.
func TestKey(t *testing.T) {
	if got := key("hostA", "web"); got != "hostA/web" {
		t.Errorf("key = %q; want hostA/web", got)
	}
	// Both segments are sanitized; a traversal attempt can't escape its segment.
	if got := key("a/b", "../x"); got != "a-b/--x" {
		t.Errorf("key = %q; want a-b/--x", got)
	}
}

// A round-tripped spec must preserve nested fields (services, ports, mounts,
// networks, env) through the JSON encode/decode in the store.
func TestStoreFullSpecRoundTrip(t *testing.T) {
	s := NewStore(openDB(t))
	spec := &stackspec.StackSpec{
		Name: "app",
		Services: []stackspec.ContainerSpec{{
			Name:     "web",
			Image:    "nginx:1.27",
			Env:      map[string]string{"KEY": "val"},
			Ports:    []stackspec.PortMap{{Host: "8080", Container: "80", Protocol: "tcp"}},
			Mounts:   []stackspec.MountSpec{{Type: "volume", Source: "data", Target: "/data"}},
			Networks: []string{"frontend"},
		}},
		Networks: []stackspec.NetworkSpec{{Name: "frontend", Driver: "bridge"}},
		Volumes:  []stackspec.VolumeSpec{{Name: "data"}},
	}
	if err := s.Save("h", "app", spec); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := s.Load("h", "app")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !reflect.DeepEqual(got, spec) {
		t.Fatalf("round-trip mismatch:\n got = %+v\nwant = %+v", got, spec)
	}
}

// List/Delete on a disabled (nil-db) store are safe no-ops.
func TestStoreDisabledListDelete(t *testing.T) {
	s := NewStore(nil)
	if list, err := s.List("h"); err != nil || list != nil {
		t.Fatalf("List on disabled = %v, %v; want nil, nil", list, err)
	}
	if err := s.Delete("h", "p"); err != nil {
		t.Fatalf("Delete on disabled: %v", err)
	}
}
