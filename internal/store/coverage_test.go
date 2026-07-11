package store

import (
	"bytes"
	"sort"
	"testing"
	"time"
)

// ── agents roster CRUD ──────────────────────────────────────────────────────

func TestAgentRosterCRUD(t *testing.T) {
	s := openTemp(t)
	now := time.Now().UTC().Truncate(time.Second)
	rec := AgentRecord{
		ID:          "agent-1",
		Remote:      "10.0.0.5:7777",
		Version:     "1.2.3",
		Revision:    "abcdef",
		GoVersion:   "go1.24",
		Platform:    "linux/amd64",
		BuildTime:   "2026-01-01",
		ContainerID: "deadbeef",
		LastSeen:    now,
	}
	if err := s.PutAgent(rec); err != nil {
		t.Fatalf("PutAgent: %v", err)
	}
	// A second agent so Agents() returns more than one.
	if err := s.PutAgent(AgentRecord{ID: "agent-2", Version: "9.9.9"}); err != nil {
		t.Fatalf("PutAgent 2: %v", err)
	}

	all, err := s.Agents()
	if err != nil {
		t.Fatalf("Agents: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("Agents() len = %d, want 2", len(all))
	}
	byID := map[string]AgentRecord{}
	for _, a := range all {
		byID[a.ID] = a
	}
	got := byID["agent-1"]
	if got.ID != "agent-1" || got.Remote != rec.Remote || got.Version != rec.Version ||
		got.Platform != rec.Platform || got.ContainerID != rec.ContainerID || !got.LastSeen.Equal(now) {
		t.Fatalf("agent-1 round-trip mismatch: %+v", got)
	}

	// PutAgent updates in place (same id).
	rec.Version = "2.0.0"
	if err := s.PutAgent(rec); err != nil {
		t.Fatalf("PutAgent update: %v", err)
	}
	if all, _ = s.Agents(); len(all) != 2 {
		t.Fatalf("update should not add a record: len=%d", len(all))
	}

	// DeleteAgent forgets one; a missing id is a safe no-op.
	if err := s.DeleteAgent("agent-1"); err != nil {
		t.Fatalf("DeleteAgent: %v", err)
	}
	if err := s.DeleteAgent("nope"); err != nil {
		t.Fatalf("DeleteAgent(missing): %v", err)
	}
	all, _ = s.Agents()
	if len(all) != 1 || all[0].ID != "agent-2" {
		t.Fatalf("after delete, Agents() = %+v", all)
	}
}

// A record is plain JSON (holds no secrets); a corrupt one is skipped, not fatal.
func TestAgentsSkipsCorrupt(t *testing.T) {
	s := openTemp(t)
	if err := s.PutAgent(AgentRecord{ID: "good", Version: "1"}); err != nil {
		t.Fatalf("PutAgent: %v", err)
	}
	if err := s.Put(BucketAgents, "bad", []byte("{not json")); err != nil {
		t.Fatalf("seed corrupt: %v", err)
	}
	all, err := s.Agents()
	if err != nil {
		t.Fatalf("Agents: %v", err)
	}
	if len(all) != 1 || all[0].ID != "good" {
		t.Fatalf("corrupt record not skipped: %+v", all)
	}
}

func TestAgentNoop(t *testing.T) {
	s, _ := Open("")
	defer s.Close()
	if err := s.PutAgent(AgentRecord{ID: "x"}); err != nil {
		t.Errorf("PutAgent on no-op: %v", err)
	}
	if all, err := s.Agents(); err != nil || all != nil {
		t.Errorf("Agents on no-op = (%v, %v)", all, err)
	}
	if err := s.DeleteAgent("x"); err != nil {
		t.Errorf("DeleteAgent on no-op: %v", err)
	}
}

// ── audit log ───────────────────────────────────────────────────────────────

func TestAuditAppendAndList(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("audit-secret")

	entries := []AuditEntry{
		{Actor: "alice", Plugin: "hostA/proj/svc", Host: "hostA", Method: "Deploy", Danger: true, OK: true, Millis: 12},
		{Actor: "bob", Plugin: "hostB/proj/svc", Host: "hostB", Method: "Remove", OK: false, Err: "boom", Millis: 3},
		{Actor: "carol", Plugin: "hostA/proj/svc", Host: "hostA", Method: "Scale", OK: true, Millis: 7},
	}
	for _, e := range entries {
		if err := s.AppendAudit(e); err != nil {
			t.Fatalf("AppendAudit: %v", err)
		}
	}

	// Sealed at rest: no plaintext field (actor/method/err) leaks into raw bytes.
	if err := s.ForEach(BucketAudit, func(_, raw []byte) error {
		for _, secret := range []string{"alice", "Deploy", "boom", "carol"} {
			if bytes.Contains(raw, []byte(secret)) {
				t.Fatalf("audit entry stored in plaintext (%q leaked)", secret)
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("ForEach: %v", err)
	}

	// AuditLog is newest-first, unfiltered.
	all, err := s.AuditLog("", 0)
	if err != nil {
		t.Fatalf("AuditLog: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("AuditLog len = %d, want 3", len(all))
	}
	if all[0].Actor != "carol" || all[2].Actor != "alice" {
		t.Fatalf("AuditLog not newest-first: %+v", all)
	}
	if all[2].Time.IsZero() {
		t.Fatal("AppendAudit did not stamp a zero Time")
	}

	// Filter to one plugin key.
	filtered, err := s.AuditLog("hostA/proj/svc", 0)
	if err != nil {
		t.Fatalf("AuditLog(filter): %v", err)
	}
	if len(filtered) != 2 {
		t.Fatalf("filtered len = %d, want 2 (carol+alice)", len(filtered))
	}
	for _, e := range filtered {
		if e.Plugin != "hostA/proj/svc" {
			t.Fatalf("filter leaked a foreign plugin: %+v", e)
		}
	}

	// A positive limit caps the result (newest kept).
	one, err := s.AuditLog("", 1)
	if err != nil {
		t.Fatalf("AuditLog(limit=1): %v", err)
	}
	if len(one) != 1 || one[0].Actor != "carol" {
		t.Fatalf("limit=1 wrong: %+v", one)
	}
}

// A pre-set Time is preserved (not overwritten) and keys still sort chronologically.
func TestAuditPreservesTime(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("k")
	ts := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := s.AppendAudit(AuditEntry{Actor: "z", Time: ts}); err != nil {
		t.Fatalf("AppendAudit: %v", err)
	}
	all, _ := s.AuditLog("", 0)
	if len(all) != 1 || !all[0].Time.Equal(ts) {
		t.Fatalf("preset Time not preserved: %+v", all)
	}
}

// A raw value that won't unseal is skipped rather than aborting the whole read.
func TestAuditLogSkipsUndecryptable(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("k")
	if err := s.AppendAudit(AuditEntry{Actor: "good", Plugin: "p"}); err != nil {
		t.Fatalf("AppendAudit: %v", err)
	}
	// Inject a bogus (unsealable) entry: too short to unseal -> skipped.
	if err := s.Put(BucketAudit, "00000000000000000000ffffff", []byte("garbage")); err != nil {
		t.Fatalf("seed garbage: %v", err)
	}
	// Inject a sealed-but-not-JSON entry: unseals fine, Unmarshal fails -> skipped.
	badJSON, err := s.Seal([]byte("{not json"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if err := s.Put(BucketAudit, "00000000000000000000fffffe", badJSON); err != nil {
		t.Fatalf("seed badjson: %v", err)
	}
	all, err := s.AuditLog("", 0)
	if err != nil {
		t.Fatalf("AuditLog: %v", err)
	}
	if len(all) != 1 || all[0].Actor != "good" {
		t.Fatalf("undecryptable/corrupt entry not skipped: %+v", all)
	}
}

// pruneAudit drops the oldest entries beyond auditCap on append.
func TestAuditPrunesToCapacity(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("k")
	total := auditCap + 5
	for i := 0; i < total; i++ {
		if err := s.AppendAudit(AuditEntry{Actor: "a", Plugin: "p", Millis: int64(i)}); err != nil {
			t.Fatalf("AppendAudit %d: %v", i, err)
		}
	}
	all, err := s.AuditLog("", 0)
	if err != nil {
		t.Fatalf("AuditLog: %v", err)
	}
	if len(all) != auditCap {
		t.Fatalf("after pruning, len = %d, want %d", len(all), auditCap)
	}
	// Newest (Millis=total-1) is kept; the 5 oldest (Millis 0..4) are gone.
	if all[0].Millis != int64(total-1) {
		t.Fatalf("newest entry Millis = %d, want %d", all[0].Millis, total-1)
	}
	oldest := all[len(all)-1].Millis
	if oldest < 5 {
		t.Fatalf("oldest surviving Millis = %d, want >= 5 (overflow pruned)", oldest)
	}
}

func TestAuditNoop(t *testing.T) {
	s, _ := Open("")
	defer s.Close()
	if err := s.AppendAudit(AuditEntry{Actor: "x"}); err != nil {
		t.Errorf("AppendAudit on no-op: %v", err)
	}
	if all, err := s.AuditLog("", 0); err != nil || all != nil {
		t.Errorf("AuditLog on no-op = (%v, %v)", all, err)
	}
}

// ── plugin KV ───────────────────────────────────────────────────────────────

func TestPluginKV(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("kv-secret")

	const pA, pB = "hostA/proj/svc", "hostB/proj/svc"
	if err := s.PutPluginKV(pA, "greeting", []byte("hello-secret")); err != nil {
		t.Fatalf("PutPluginKV: %v", err)
	}
	if err := s.PutPluginKV(pA, "config:db", []byte("dsn")); err != nil {
		t.Fatalf("PutPluginKV: %v", err)
	}
	if err := s.PutPluginKV(pB, "greeting", []byte("other")); err != nil {
		t.Fatalf("PutPluginKV pB: %v", err)
	}

	// Sealed at rest: the value doesn't appear verbatim in the raw bucket.
	if err := s.ForEach(BucketPluginKV, func(_, raw []byte) error {
		if bytes.Contains(raw, []byte("hello-secret")) {
			t.Fatal("plugin KV value stored in plaintext")
		}
		return nil
	}); err != nil {
		t.Fatalf("ForEach: %v", err)
	}

	// Get round-trips through the seal.
	v, err := s.GetPluginKV(pA, "greeting")
	if err != nil {
		t.Fatalf("GetPluginKV: %v", err)
	}
	if !bytes.Equal(v, []byte("hello-secret")) {
		t.Fatalf("GetPluginKV = %q, want hello-secret", v)
	}
	// A missing key returns (nil, nil).
	if v, err := s.GetPluginKV(pA, "absent"); err != nil || v != nil {
		t.Fatalf("GetPluginKV(absent) = (%q, %v)", v, err)
	}

	// List is namespaced and prefix-filtered, with the namespace stripped.
	keys, err := s.ListPluginKV(pA, "")
	if err != nil {
		t.Fatalf("ListPluginKV: %v", err)
	}
	sort.Strings(keys)
	if len(keys) != 2 || keys[0] != "config:db" || keys[1] != "greeting" {
		t.Fatalf("ListPluginKV(all) = %v", keys)
	}
	pref, err := s.ListPluginKV(pA, "config:")
	if err != nil {
		t.Fatalf("ListPluginKV(prefix): %v", err)
	}
	if len(pref) != 1 || pref[0] != "config:db" {
		t.Fatalf("ListPluginKV(prefix) = %v", pref)
	}

	// Delete removes one key; the sibling namespace is untouched.
	if err := s.DeletePluginKV(pA, "greeting"); err != nil {
		t.Fatalf("DeletePluginKV: %v", err)
	}
	if v, _ := s.GetPluginKV(pA, "greeting"); v != nil {
		t.Fatalf("DeletePluginKV left a value: %q", v)
	}
	if v, _ := s.GetPluginKV(pB, "greeting"); !bytes.Equal(v, []byte("other")) {
		t.Fatalf("DeletePluginKV crossed namespaces: %q", v)
	}

	// DeletePluginKVAll wipes one whole namespace, leaving the other.
	if err := s.DeletePluginKVAll(pA); err != nil {
		t.Fatalf("DeletePluginKVAll: %v", err)
	}
	if left, _ := s.ListPluginKV(pA, ""); len(left) != 0 {
		t.Fatalf("DeletePluginKVAll left keys: %v", left)
	}
	if left, _ := s.ListPluginKV(pB, ""); len(left) != 1 {
		t.Fatalf("DeletePluginKVAll wiped the wrong namespace: %v", left)
	}
}

func TestPluginKVNoop(t *testing.T) {
	s, _ := Open("")
	defer s.Close()
	if err := s.PutPluginKV("p", "k", []byte("v")); err != nil {
		t.Errorf("PutPluginKV on no-op: %v", err)
	}
	if v, err := s.GetPluginKV("p", "k"); err != nil || v != nil {
		t.Errorf("GetPluginKV on no-op = (%q, %v)", v, err)
	}
	if err := s.DeletePluginKV("p", "k"); err != nil {
		t.Errorf("DeletePluginKV on no-op: %v", err)
	}
	if keys, err := s.ListPluginKV("p", ""); err != nil || keys != nil {
		t.Errorf("ListPluginKV on no-op = (%v, %v)", keys, err)
	}
	if err := s.DeletePluginKVAll("p"); err != nil {
		t.Errorf("DeletePluginKVAll on no-op: %v", err)
	}
}

// ── plugin record decrypt/skip branches ─────────────────────────────────────

// Plugin surfaces a decrypt/parse error for a corrupt record; Plugins skips it.
// (The happy path lives in TestPluginRecordRoundTrip; this covers the error arms.)
func TestPluginRecordCorrupt(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("secret")

	// A valid record so Plugins() has something to return alongside the junk.
	if err := s.PutPlugin(PluginRecord{Key: "good", Name: "ok", Enabled: true}); err != nil {
		t.Fatalf("PutPlugin: %v", err)
	}
	// Too short to unseal.
	if err := s.Put(BucketPlugins, "short", []byte("x")); err != nil {
		t.Fatalf("seed short: %v", err)
	}
	// Unseals fine, but isn't valid JSON.
	badJSON, err := s.Seal([]byte("{not json"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if err := s.Put(BucketPlugins, "badjson", badJSON); err != nil {
		t.Fatalf("seed badjson: %v", err)
	}

	if _, err := s.Plugin("short"); err == nil {
		t.Fatal("Plugin(short) should surface an unseal error")
	}
	if _, err := s.Plugin("badjson"); err == nil {
		t.Fatal("Plugin(badjson) should surface a JSON error")
	}
	all, err := s.Plugins()
	if err != nil {
		t.Fatalf("Plugins: %v", err)
	}
	if len(all) != 1 || all[0].Key != "good" {
		t.Fatalf("Plugins() should skip corrupt records: %+v", all)
	}
}

// ── low-level store branches ────────────────────────────────────────────────

// Open on a path whose parent directory doesn't exist surfaces the bolt error.
func TestOpenError(t *testing.T) {
	if s, err := Open("/no/such/parent/dir/hope.db"); err == nil {
		_ = s.Close()
		t.Fatal("Open of an unwritable path should error")
	}
}

// Get/Delete/ForEach on a bucket that was never created hit the nil-bucket guards.
func TestMissingBucketGuards(t *testing.T) {
	s := openTemp(t)
	const missing = "no-such-bucket"
	if v := s.Get(missing, "k"); v != nil {
		t.Fatalf("Get(missing bucket) = %q, want nil", v)
	}
	if err := s.Delete(missing, "k"); err != nil {
		t.Fatalf("Delete(missing bucket): %v", err)
	}
	if err := s.ForEach(missing, func(_, _ []byte) error {
		t.Fatal("ForEach(missing bucket) called fn")
		return nil
	}); err != nil {
		t.Fatalf("ForEach(missing bucket): %v", err)
	}
}

// ── registry credentials ────────────────────────────────────────────────────

func TestRegistryPersistLoadDelete(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("registry-secret")

	if err := s.PutRegistry("registry.example.com", "user", "hunter2"); err != nil {
		t.Fatalf("PutRegistry: %v", err)
	}
	if err := s.PutRegistry("ghcr.io", "bot", "s3kr3t"); err != nil {
		t.Fatalf("PutRegistry 2: %v", err)
	}

	// Sealed at rest: neither the password nor the username is in the raw value.
	raw := s.Get(BucketRegistries, "registry.example.com")
	if raw == nil {
		t.Fatal("registry not persisted")
	}
	if bytes.Contains(raw, []byte("hunter2")) || bytes.Contains(raw, []byte("user")) {
		t.Fatal("registry credential stored in plaintext")
	}

	regs, err := s.Registries()
	if err != nil {
		t.Fatalf("Registries: %v", err)
	}
	if len(regs) != 2 {
		t.Fatalf("Registries len = %d, want 2", len(regs))
	}
	byServer := map[string]RegistryRecord{}
	for _, r := range regs {
		byServer[r.Server] = r
	}
	got := byServer["registry.example.com"]
	if got.Server != "registry.example.com" || got.Username != "user" || got.Password != "hunter2" {
		t.Fatalf("registry round-trip mismatch: %+v", got)
	}

	// Delete removes one; a missing server is a safe no-op.
	if err := s.DeleteRegistry("registry.example.com"); err != nil {
		t.Fatalf("DeleteRegistry: %v", err)
	}
	if err := s.DeleteRegistry("nope"); err != nil {
		t.Fatalf("DeleteRegistry(missing): %v", err)
	}
	regs, _ = s.Registries()
	if len(regs) != 1 || regs[0].Server != "ghcr.io" {
		t.Fatalf("after delete, Registries = %+v", regs)
	}
}

// A record that won't decrypt (wrong secret / corrupt) is skipped, not fatal.
func TestRegistriesSkipsUndecryptable(t *testing.T) {
	s := openTemp(t)
	s.SetSecret("secret")
	if err := s.PutRegistry("good.io", "u", "p"); err != nil {
		t.Fatalf("PutRegistry: %v", err)
	}
	// A value that isn't a valid sealed blob (Unseal fails) is skipped.
	if err := s.Put(BucketRegistries, "bad.io", []byte("not-sealed")); err != nil {
		t.Fatalf("seed bad: %v", err)
	}
	// A sealed-but-not-JSON value is also skipped (Unseal ok, Unmarshal fails).
	badJSON, err := s.Seal([]byte("{not json"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if err := s.Put(BucketRegistries, "badjson.io", badJSON); err != nil {
		t.Fatalf("seed badjson: %v", err)
	}
	regs, err := s.Registries()
	if err != nil {
		t.Fatalf("Registries: %v", err)
	}
	if len(regs) != 1 || regs[0].Server != "good.io" {
		t.Fatalf("undecryptable/corrupt not skipped: %+v", regs)
	}
}

func TestRegistryNoop(t *testing.T) {
	s, _ := Open("")
	defer s.Close()
	if err := s.PutRegistry("srv", "u", "p"); err != nil {
		t.Errorf("PutRegistry on no-op: %v", err)
	}
	if regs, err := s.Registries(); err != nil || regs != nil {
		t.Errorf("Registries on no-op = (%v, %v)", regs, err)
	}
	if err := s.DeleteRegistry("srv"); err != nil {
		t.Errorf("DeleteRegistry on no-op: %v", err)
	}
}
