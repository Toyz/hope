package store

import (
	"bytes"
	"path/filepath"
	"testing"
	"time"
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

// TestOpenDirectory: pointing [store] path at an existing directory drops the db
// file inside it (a common "mounted a volume at /data" setup) rather than erroring.
func TestOpenDirectory(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(dir): %v", err)
	}
	defer s.Close()
	if !s.Enabled() {
		t.Fatal("Open(dir) should yield an enabled store")
	}
	// Data written survives a round-trip through the file inside the dir.
	if err := s.Put(BucketStacks, "k", []byte("v")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if got := s.Get(BucketStacks, "k"); !bytes.Equal(got, []byte("v")) {
		t.Fatalf("Get = %q, want v", got)
	}
}

// TestDeriveToken locks the per-plugin token contract: deterministic for the same
// (key, name), distinct across names, and distinct across keys — so a leaked db's
// tokens can't be forged without the secret.
func TestDeriveToken(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("secret-A")

	a1 := s.DeriveToken("plugin/one")
	a2 := s.DeriveToken("plugin/one")
	if a1 != a2 {
		t.Errorf("DeriveToken not deterministic: %q vs %q", a1, a2)
	}
	if a1 == "" {
		t.Error("DeriveToken returned empty")
	}
	if len(a1) != 64 { // hex of a 32-byte HMAC-SHA256
		t.Errorf("DeriveToken len = %d, want 64", len(a1))
	}
	if other := s.DeriveToken("plugin/two"); other == a1 {
		t.Error("DeriveToken collided across different names")
	}

	// A different secret yields a different token for the same name.
	s2 := openTemp(t)
	s2.SetSecret("secret-B")
	if s2.DeriveToken("plugin/one") == a1 {
		t.Error("DeriveToken collided across different keys")
	}
}

// TestPluginRecordRoundTrip covers PutPlugin/Plugin/Plugins plus the in-place
// Disable/Delete helpers, and that the record is sealed at rest.
func TestPluginRecordRoundTrip(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("plugin-secret")

	rec := PluginRecord{
		Key:         "host1/proj/svc",
		Host:        "host1",
		Project:     "proj",
		Service:     "svc",
		Name:        "My Plugin",
		Enabled:     true,
		Fingerprint: "sha256:abc",
		Token:       "tok-secret-value",
		EnabledAt:   time.Now().Truncate(time.Second),
		Grants:      []string{"kv.read", "kv.write"},
	}
	if err := s.PutPlugin(rec); err != nil {
		t.Fatalf("PutPlugin: %v", err)
	}

	// The stored bytes are sealed — the token must not appear in the raw value.
	if raw := s.Get(BucketPlugins, rec.Key); bytes.Contains(raw, []byte("tok-secret-value")) {
		t.Fatal("plugin record stored in plaintext (token leaked)")
	}

	got, err := s.Plugin(rec.Key)
	if err != nil || got == nil {
		t.Fatalf("Plugin: %v (nil=%v)", err, got == nil)
	}
	if got.Key != rec.Key || got.Name != rec.Name || got.Token != rec.Token || !got.Enabled {
		t.Errorf("Plugin round-trip mismatch: %+v", got)
	}
	if !got.HasGrant("kv.read") || got.HasGrant("kv.admin") {
		t.Errorf("HasGrant wrong: grants=%v", got.Grants)
	}

	// Plugins() lists it.
	all, err := s.Plugins()
	if err != nil {
		t.Fatalf("Plugins: %v", err)
	}
	if len(all) != 1 || all[0].Key != rec.Key {
		t.Fatalf("Plugins() = %+v", all)
	}

	// DisablePlugin flips Enabled in place.
	if err := s.DisablePlugin(rec.Key); err != nil {
		t.Fatalf("DisablePlugin: %v", err)
	}
	if got, _ := s.Plugin(rec.Key); got == nil || got.Enabled {
		t.Errorf("after DisablePlugin, Enabled=%v", got.Enabled)
	}
	// Disabling again is a no-op (already disabled).
	if err := s.DisablePlugin(rec.Key); err != nil {
		t.Errorf("DisablePlugin (already off): %v", err)
	}

	// DeletePlugin removes it; a missing key is a safe no-op.
	if err := s.DeletePlugin(rec.Key); err != nil {
		t.Fatalf("DeletePlugin: %v", err)
	}
	if got, _ := s.Plugin(rec.Key); got != nil {
		t.Errorf("Plugin after delete = %+v, want nil", got)
	}
	if err := s.DisablePlugin(rec.Key); err != nil {
		t.Errorf("DisablePlugin(missing): %v", err)
	}
}

// TestPluginNoop: plugin methods on a disabled store degrade to no-ops/nil.
func TestPluginNoop(t *testing.T) {
	s, err := Open("")
	if err != nil {
		t.Fatalf("Open(\"\"): %v", err)
	}
	defer s.Close()
	if err := s.PutPlugin(PluginRecord{Key: "k"}); err != nil {
		t.Errorf("PutPlugin on no-op: %v", err)
	}
	if rec, err := s.Plugin("k"); err != nil || rec != nil {
		t.Errorf("Plugin on no-op = (%v, %v)", rec, err)
	}
}

// TestInContainer: the container signal is purely HOPE_MANAGED's presence.
func TestInContainer(t *testing.T) {
	t.Setenv("HOPE_MANAGED", "")
	if inContainer() {
		t.Error("inContainer() true with HOPE_MANAGED empty")
	}
	t.Setenv("HOPE_MANAGED", "1")
	if !inContainer() {
		t.Error("inContainer() false with HOPE_MANAGED=1")
	}
}

// TestOnRootFS covers the two deterministic branches: a path whose directory is
// "/" shares "/"'s device (true), and an unstattable directory returns false
// (best-effort: never cry wolf).
func TestOnRootFS(t *testing.T) {
	if !onRootFS("/hope.db") { // dir is "/", same device as "/"
		t.Error("onRootFS(/hope.db) = false, want true")
	}
	if onRootFS("/no/such/dir/hope.db") {
		t.Error("onRootFS of unstattable dir = true, want false")
	}
}

// TestEphemeral: a non-container store is never flagged ephemeral regardless of
// where its file lives (the rootfs check is gated on being containerized).
func TestEphemeral(t *testing.T) {
	t.Setenv("HOPE_MANAGED", "") // force non-container
	s := openTemp(t)
	if !s.Enabled() {
		t.Fatal("store should be enabled")
	}
	if s.Ephemeral() {
		t.Error("non-container store flagged ephemeral")
	}
	// A disabled store is never ephemeral.
	noop, _ := Open("")
	defer noop.Close()
	if noop.Ephemeral() {
		t.Error("disabled store flagged ephemeral")
	}
}
