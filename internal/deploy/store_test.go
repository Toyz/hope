package deploy

import (
	"path/filepath"
	"testing"

	"github.com/toyz/hope/internal/stackspec"
	"github.com/toyz/hope/internal/store"
)

func TestStoreDisabled(t *testing.T) {
	s := NewStore(nil)
	if s.Enabled() {
		t.Fatal("nil db should be disabled")
	}
	if err := s.Save("h", "p", &stackspec.StackSpec{Name: "p"}); err != nil {
		t.Fatalf("Save on disabled: %v", err)
	}
	if spec, err := s.Load("h", "p"); err != nil || spec != nil {
		t.Fatalf("Load on disabled = %v, %v; want nil, nil", spec, err)
	}
}

func TestStoreRoundTrip(t *testing.T) {
	s := NewStore(openDB(t))
	if !s.Enabled() {
		t.Fatal("db-backed store should be enabled")
	}
	if err := s.Save("hostA", "web", &stackspec.StackSpec{Name: "web"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Save("hostA", "db", &stackspec.StackSpec{Name: "db"}); err != nil {
		t.Fatalf("Save 2: %v", err)
	}
	if err := s.Save("hostB", "web", &stackspec.StackSpec{Name: "web"}); err != nil {
		t.Fatalf("Save 3: %v", err)
	}
	got, err := s.Load("hostA", "web")
	if err != nil || got == nil || got.Name != "web" {
		t.Fatalf("Load = %v, %v", got, err)
	}
	// List is host-scoped and doesn't bleed across hosts.
	list, err := s.List("hostA")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 || list[0] != "db" || list[1] != "web" {
		t.Fatalf("List(hostA) = %v, want [db web]", list)
	}
	if err := s.Delete("hostA", "web"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := s.Load("hostA", "web"); got != nil {
		t.Fatal("Load after Delete should be nil")
	}
}

func openDB(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "hope.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}
