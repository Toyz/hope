package deploy

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/toyz/hope/internal/stackspec"
	"github.com/toyz/hope/internal/store"
)

func TestStoreDisabled(t *testing.T) {
	s := NewStore("", nil)
	if s.Enabled() {
		t.Fatal("empty dir + nil db should be disabled")
	}
	if err := s.Save("h", "p", &stackspec.StackSpec{Name: "p"}); err != nil {
		t.Fatalf("Save on disabled: %v", err)
	}
	if spec, err := s.Load("h", "p"); err != nil || spec != nil {
		t.Fatalf("Load on disabled = %v, %v; want nil, nil", spec, err)
	}
}

func TestStoreDBBackend(t *testing.T) {
	db := openDB(t)
	s := NewStore("", db)
	if !s.Enabled() {
		t.Fatal("db-backed store should be enabled")
	}
	want := &stackspec.StackSpec{Name: "web"}
	if err := s.Save("hostA", "web", want); err != nil {
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

func TestStoreMigrateFromDir(t *testing.T) {
	dir := t.TempDir()
	// Seed two legacy per-file specs under host dirs.
	writeSpec(t, dir, "hostA", "web")
	writeSpec(t, dir, "hostB", "cache")

	db := openDB(t)
	s := NewStore(dir, db)
	n, err := s.MigrateFromDir()
	if err != nil {
		t.Fatalf("MigrateFromDir: %v", err)
	}
	if n != 2 {
		t.Fatalf("migrated %d, want 2", n)
	}
	// The db backend now serves the imported specs.
	if got, _ := s.Load("hostA", "web"); got == nil || got.Name != "web" {
		t.Fatalf("imported spec not loadable: %v", got)
	}
	// Legacy files are left in place as a rollback path.
	if _, err := os.Stat(filepath.Join(dir, "hostA", "web.json")); err != nil {
		t.Fatalf("legacy file should remain: %v", err)
	}
	// A second run is a no-op (bucket already populated).
	if n, err := s.MigrateFromDir(); err != nil || n != 0 {
		t.Fatalf("second MigrateFromDir = %d, %v; want 0, nil", n, err)
	}
}

func writeSpec(t *testing.T, dir, host, project string) {
	t.Helper()
	hd := filepath.Join(dir, host)
	if err := os.MkdirAll(hd, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hd, project+".json"), []byte(`{"name":"`+project+`"}`), 0o600); err != nil {
		t.Fatal(err)
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
