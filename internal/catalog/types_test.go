package catalog

import (
	"encoding/json"
	"testing"
)

// TestPortOrDefault covers both the explicit and the default branch.
func TestPortOrDefault(t *testing.T) {
	cases := []struct {
		port int
		want int
	}{
		{0, DefaultPort},
		{-1, DefaultPort}, // non-positive falls back
		{8080, 8080},
		{9090, 9090},
	}
	for _, c := range cases {
		if got := (CatalogEntry{Port: c.port}).PortOrDefault(); got != c.want {
			t.Errorf("PortOrDefault(%d) = %d, want %d", c.port, got, c.want)
		}
	}
}

// TestPathOrDefault covers both the explicit and the default branch.
func TestPathOrDefault(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"", DefaultPath},
		{"/__hope", "/__hope"},
		{"/rpc", "/rpc"},
	}
	for _, c := range cases {
		if got := (CatalogEntry{Path: c.path}).PathOrDefault(); got != c.want {
			t.Errorf("PathOrDefault(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

// TestManifestMarshalRoundTrip marshals a fully-populated manifest and unmarshals it,
// confirming every catalog shape (EnvField+Option, VolumeMount, SettingSeed,
// CatalogPermission, Labels) survives the wire round-trip byte-stable.
func TestManifestMarshalRoundTrip(t *testing.T) {
	orig := Manifest{
		Version: 2,
		Entries: []CatalogEntry{{
			ID:          "acme-mongo",
			Title:       "MongoDB",
			Icon:        "database",
			Description: "browse mongo",
			Image:       "ghcr.io/toyz/hope-mongo:1",
			Port:        9090,
			Path:        "/rpc",
			Env: []EnvField{
				{Key: "MONGO_URI", Label: "URI", Kind: "secret", Required: true, Placeholder: "mongodb://", Hint: "dsn"},
				{Key: "TLS", Label: "TLS", Kind: "select", Default: "on", Options: []Option{{Label: "On", Value: "on"}, {Label: "Off", Value: "off"}}},
			},
			Volumes:  []VolumeMount{{Target: "/data", Name: "d", Type: "bind", ReadOnly: true, Hint: "host path"}},
			Settings: []SettingSeed{{Key: "page_size", Value: "50"}},
			Labels:   map[string]string{"team": "db"},
			Permissions: []CatalogPermission{
				{Scope: "storage", Reason: "save rules"},
			},
			Source: "builtin",
		}},
	}

	raw, err := json.Marshal(orig)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Manifest
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Re-marshal both and compare bytes — a stable round trip.
	rawGot, _ := json.Marshal(got)
	if string(raw) != string(rawGot) {
		t.Fatalf("round trip not byte-stable:\n orig=%s\n got =%s", raw, rawGot)
	}

	e := got.Entries[0]
	if e.Env[1].Kind != "select" || len(e.Env[1].Options) != 2 || e.Env[1].Options[0].Value != "on" {
		t.Errorf("select env option lost: %+v", e.Env[1])
	}
	if e.Volumes[0].Type != "bind" || !e.Volumes[0].ReadOnly {
		t.Errorf("volume mount fields lost: %+v", e.Volumes[0])
	}
	if e.Settings[0].Key != "page_size" || e.Settings[0].Value != "50" {
		t.Errorf("setting seed lost: %+v", e.Settings[0])
	}
	if e.Permissions[0].Scope != "storage" || e.Labels["team"] != "db" {
		t.Errorf("permissions/labels lost: %+v / %+v", e.Permissions, e.Labels)
	}
}

// TestOmitEmptyFields confirms optional zero-value fields drop out of the JSON so a
// minimal entry stays compact on the wire.
func TestOmitEmptyFields(t *testing.T) {
	raw, err := json.Marshal(CatalogEntry{ID: "x", Title: "X", Image: "img"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, k := range []string{"icon", "port", "path", "env", "volumes", "settings", "labels", "permissions", "source"} {
		if containsKey(raw, k) {
			t.Errorf("expected %q to be omitted from %s", k, raw)
		}
	}
	// Required fields are always present.
	for _, k := range []string{"id", "title", "image"} {
		if !containsKey(raw, k) {
			t.Errorf("required key %q missing from %s", k, raw)
		}
	}
}

func containsKey(raw []byte, key string) bool {
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	_, ok := m[key]
	return ok
}

// TestTrustedImage locks the allowlist prefix contract used by Merge.
func TestTrustedImage(t *testing.T) {
	trusted := []string{"ghcr.io/toyz/hope-redis:latest", "ghcr.io/toyz/anything"}
	for _, ref := range trusted {
		if !trustedImage(ref) {
			t.Errorf("trustedImage(%q) = false, want true", ref)
		}
	}
	untrusted := []string{"docker.io/toyz/x", "ghcr.io/other/x", "", "gHcr.io/toyz/x", "xghcr.io/toyz/x"}
	for _, ref := range untrusted {
		if trustedImage(ref) {
			t.Errorf("trustedImage(%q) = true, want false", ref)
		}
	}
}
