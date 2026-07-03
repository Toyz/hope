package store

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestNoopStore(t *testing.T) {
	s, err := Open("")
	if err != nil {
		t.Fatalf("Open(\"\"): %v", err)
	}
	defer s.Close()
	if s.Enabled() {
		t.Fatal("empty path should be a disabled store")
	}
	// Every method is a safe no-op — no panics, reads nothing.
	if err := s.Put(BucketRegistries, "k", []byte("v")); err != nil {
		t.Fatalf("Put on no-op: %v", err)
	}
	if got := s.Get(BucketRegistries, "k"); got != nil {
		t.Fatalf("Get on no-op = %q, want nil", got)
	}
	if err := s.Delete(BucketRegistries, "k"); err != nil {
		t.Fatalf("Delete on no-op: %v", err)
	}
	if err := s.ForEach(BucketRegistries, func(_, _ []byte) error {
		t.Fatal("ForEach on no-op called fn")
		return nil
	}); err != nil {
		t.Fatalf("ForEach on no-op: %v", err)
	}
}

func TestPutGetRoundTrip(t *testing.T) {
	s := openTemp(t)
	want := []byte("registry.example.com")
	if err := s.Put(BucketRegistries, "srv", want); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got := s.Get(BucketRegistries, "srv")
	if !bytes.Equal(got, want) {
		t.Fatalf("Get = %q, want %q", got, want)
	}
	// Returned slice must be a copy, not a live bolt view.
	got[0] = 'X'
	if again := s.Get(BucketRegistries, "srv"); !bytes.Equal(again, want) {
		t.Fatalf("Get mutated underlying value: %q", again)
	}
	if err := s.Delete(BucketRegistries, "srv"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got := s.Get(BucketRegistries, "srv"); got != nil {
		t.Fatalf("Get after Delete = %q, want nil", got)
	}
}

func TestForEach(t *testing.T) {
	s := openTemp(t)
	seed := map[string]string{"a": "1", "b": "2", "c": "3"}
	for k, v := range seed {
		if err := s.Put(BucketStacks, k, []byte(v)); err != nil {
			t.Fatalf("Put %s: %v", k, err)
		}
	}
	seen := map[string]string{}
	if err := s.ForEach(BucketStacks, func(k, v []byte) error {
		seen[string(k)] = string(v)
		return nil
	}); err != nil {
		t.Fatalf("ForEach: %v", err)
	}
	if len(seen) != len(seed) {
		t.Fatalf("ForEach saw %d keys, want %d", len(seen), len(seed))
	}
	for k, v := range seed {
		if seen[k] != v {
			t.Fatalf("ForEach[%s] = %q, want %q", k, seen[k], v)
		}
	}
}

func TestSealUnseal(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("a-token-secret")
	plain := []byte("hunter2")
	sealed, err := s.Seal(plain)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if bytes.Contains(sealed, plain) {
		t.Fatal("sealed value contains plaintext")
	}
	out, err := s.Unseal(sealed)
	if err != nil {
		t.Fatalf("Unseal: %v", err)
	}
	if !bytes.Equal(out, plain) {
		t.Fatalf("Unseal = %q, want %q", out, plain)
	}
	// A different secret must fail to decrypt.
	other := openTemp(t)
	other.SetSecret("different-secret")
	if _, err := other.Unseal(sealed); err == nil {
		t.Fatal("Unseal with wrong key succeeded, want error")
	}
	// A too-short blob is rejected, not a panic.
	if _, err := s.Unseal([]byte("x")); err == nil {
		t.Fatal("Unseal of short blob succeeded, want error")
	}
}

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "hope.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
