package pluginhost

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/toyz/hope/internal/catalog"
	"github.com/toyz/hope/internal/docker"
)

// TestValidateEnv exercises the required + select rules validateEnv enforces against a
// catalog entry's declared schema.
func TestValidateEnv(t *testing.T) {
	entry := catalog.CatalogEntry{
		Title: "Redis",
		Env: []catalog.EnvField{
			{Key: "URL", Label: "Connection URL", Required: true, Kind: "secret"},
			{Key: "MODE", Label: "Mode", Kind: "select", Options: []catalog.Option{{Value: "ro"}, {Value: "rw"}}},
			{Key: "OPT", Label: "Optional", Kind: "text"},
			{Key: "WITHDEF", Label: "Defaulted", Required: true, Default: "d"},
		},
	}
	cases := []struct {
		name    string
		env     map[string]string
		wantErr bool
	}{
		{"all good", map[string]string{"URL": "redis://x", "MODE": "ro"}, false},
		{"required missing", map[string]string{"MODE": "ro"}, true},
		{"required blank/whitespace", map[string]string{"URL": "   ", "MODE": "ro"}, true},
		{"select disallowed", map[string]string{"URL": "redis://x", "MODE": "nope"}, true},
		{"select allowed rw", map[string]string{"URL": "redis://x", "MODE": "rw"}, false},
		{"select empty is skipped", map[string]string{"URL": "redis://x", "MODE": ""}, false},
		{"optional empty ok", map[string]string{"URL": "redis://x"}, false},
		{"required-with-default may be empty", map[string]string{"URL": "redis://x", "WITHDEF": ""}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateEnv(entry, c.env)
			if (err != nil) != c.wantErr {
				t.Errorf("validateEnv(%v) err = %v, wantErr = %v", c.env, err, c.wantErr)
			}
		})
	}
}

// TestMergeSettings: seeds are the base, overrides win on key collision, new override
// keys are added.
func TestMergeSettings(t *testing.T) {
	seeds := []catalog.SettingSeed{{Key: "a", Value: "1"}, {Key: "b", Value: "2"}}
	got := mergeSettings(seeds, map[string]string{"b": "20", "c": "3"})
	want := map[string]string{"a": "1", "b": "20", "c": "3"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("mergeSettings = %v, want %v", got, want)
	}
	// No overrides: just the seeds.
	if got := mergeSettings(seeds, nil); !reflect.DeepEqual(got, map[string]string{"a": "1", "b": "2"}) {
		t.Errorf("mergeSettings(nil overrides) = %v", got)
	}
	// No seeds, no overrides: empty (non-nil) map.
	if got := mergeSettings(nil, nil); got == nil || len(got) != 0 {
		t.Errorf("mergeSettings(nil,nil) = %v, want empty map", got)
	}
}

// TestValidateSettings drops keys the live schema doesn't declare and rejects values
// outside a select setting's options, emitting a note for each drop.
func TestValidateSettings(t *testing.T) {
	schema := json.RawMessage(`{"settings":[
		{"key":"page_size","kind":"number"},
		{"key":"mode","kind":"select","options":[{"value":"ro"},{"value":"rw"}]},
		{"key":"free","kind":"select"}
	]}`)

	t.Run("empty settings passthrough", func(t *testing.T) {
		var notes []string
		out := validateSettings(schema, map[string]string{}, "svc", func(s string) { notes = append(notes, s) })
		if len(out) != 0 || len(notes) != 0 {
			t.Errorf("empty settings should pass through untouched: out=%v notes=%v", out, notes)
		}
	})

	t.Run("bad schema passthrough", func(t *testing.T) {
		in := map[string]string{"anything": "x"}
		out := validateSettings(json.RawMessage(`{bad`), in, "svc", func(string) {})
		if !reflect.DeepEqual(out, in) {
			t.Errorf("undecodable schema should pass settings through unchanged, got %v", out)
		}
	})

	t.Run("drops + validates", func(t *testing.T) {
		var notes []string
		in := map[string]string{
			"page_size":  "50",       // declared non-select => kept
			"mode":       "ro",       // declared select, allowed => kept
			"undeclared": "x",        // not declared => dropped
			"free":       "anything", // select with no options => kept
		}
		out := validateSettings(schema, in, "redis", func(s string) { notes = append(notes, s) })
		want := map[string]string{"page_size": "50", "mode": "ro", "free": "anything"}
		if !reflect.DeepEqual(out, want) {
			t.Errorf("validateSettings = %v, want %v", out, want)
		}
		if len(notes) != 1 {
			t.Errorf("expected exactly one drop note, got %v", notes)
		}
	})

	t.Run("rejects disallowed select value", func(t *testing.T) {
		var notes []string
		out := validateSettings(schema, map[string]string{"mode": "admin"}, "redis", func(s string) { notes = append(notes, s) })
		if len(out) != 0 {
			t.Errorf("disallowed select value should be dropped, got %v", out)
		}
		if len(notes) != 1 {
			t.Errorf("expected a drop note for the rejected option, got %v", notes)
		}
	})
}

// TestSplitCSV: trimmed, non-empty tokens; empties collapse away.
func TestSplitCSV(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"a,b,c", []string{"a", "b", "c"}},
		{" a , b ,c ", []string{"a", "b", "c"}},
		{"a,,b", []string{"a", "b"}},
		{",,", []string{}},
		{"", []string{}},
		{"   ", []string{}},
		{"solo", []string{"solo"}},
	}
	for _, c := range cases {
		if got := splitCSV(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("splitCSV(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestSlugPath: a mount target becomes a volume-name-safe slug, empty => "data".
func TestSlugPath(t *testing.T) {
	cases := map[string]string{
		"/data/cache":  "data-cache",
		"/data":        "data",
		"/":            "data",
		"":             "data",
		"/DATA/Sub":    "data-sub",
		"data":         "data",
		"/a/b/c/":      "a-b-c",
		"/weird path/": "weird-path",
	}
	for in, want := range cases {
		if got := slugPath(in); got != want {
			t.Errorf("slugPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestCompatOf compares a plugin's declared protocol against hope's.
func TestCompatOf(t *testing.T) {
	if got := compatOf(0); got != "ok" {
		t.Errorf("compatOf(0) = %q, want ok (unset)", got)
	}
	if got := compatOf(ProtocolVersion); got != "ok" {
		t.Errorf("compatOf(current) = %q, want ok", got)
	}
	if got := compatOf(ProtocolVersion + 1); got != "plugin_newer" {
		t.Errorf("compatOf(current+1) = %q, want plugin_newer", got)
	}
	// Any nonzero protocol below hope's is "plugin_older".
	if got := compatOf(-1); got != "plugin_older" {
		t.Errorf("compatOf(below current) = %q, want plugin_older", got)
	}
	if ProtocolVersion > 1 {
		if got := compatOf(ProtocolVersion - 1); got != "plugin_older" {
			t.Errorf("compatOf(current-1) = %q, want plugin_older", got)
		}
	}
}

// TestFingerprint: the enable-time trust fingerprint is the image digest.
func TestFingerprint(t *testing.T) {
	pc := docker.PluginContainer{ImageID: "sha256:abc", ContainerID: "c1"}
	if got := fingerprint(pc); got != "sha256:abc" {
		t.Errorf("fingerprint = %q, want the ImageID", got)
	}
	if got := fingerprint(docker.PluginContainer{}); got != "" {
		t.Errorf("empty ImageID fingerprint = %q, want empty", got)
	}
}

// TestHashBytes: hex sha256 of the input, stable and known.
func TestHashBytes(t *testing.T) {
	// Known sha256 vectors.
	if got := hashBytes([]byte("")); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Errorf("hashBytes(empty) = %q", got)
	}
	if got := hashBytes([]byte("abc")); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("hashBytes(abc) = %q", got)
	}
	// A different input yields a different, 64-hex-char digest.
	h := hashBytes([]byte("abd"))
	if len(h) != 64 || h == hashBytes([]byte("abc")) {
		t.Errorf("hashBytes not distinct/hex: %q", h)
	}
}

// TestPluginIdentityFallbacks extends the identity edge cases: a compose key needs BOTH
// project and service; a partial one falls back to name, then container id.
func TestPluginIdentityFallbacks(t *testing.T) {
	cases := []struct {
		name string
		pc   docker.PluginContainer
		want string
	}{
		{"project+service", docker.PluginContainer{Project: "app", Service: "pg"}, "h|app/pg"},
		{"project only falls to name", docker.PluginContainer{Project: "app", Name: "foo"}, "h|~/foo"},
		{"service only falls to name", docker.PluginContainer{Service: "pg", Name: "foo"}, "h|~/foo"},
		{"name only", docker.PluginContainer{Name: "solo"}, "h|~/solo"},
		{"id only", docker.PluginContainer{ContainerID: "abc"}, "h|id/abc"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := pluginIdentity("h", c.pc); got != c.want {
				t.Errorf("pluginIdentity = %q, want %q", got, c.want)
			}
		})
	}
	// identityKey is the exact compose format install + discovery both derive from.
	if got := identityKey("host", "proj", "svc"); got != "host|proj/svc" {
		t.Errorf("identityKey = %q, want host|proj/svc", got)
	}
}
