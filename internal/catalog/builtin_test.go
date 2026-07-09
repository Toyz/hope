package catalog

import (
	"encoding/json"
	"testing"
)

// TestBuiltinsInstallable locks that the two shipped first-party entries are complete
// enough to install (image + a required, secret connection env) and that a service with
// no remote repos serves exactly them.
func TestBuiltinsInstallable(t *testing.T) {
	svc := New(nil, 0, nil) // no repos, no cache
	entries := svc.Entries()
	if len(entries) != 3 {
		t.Fatalf("want 3 built-in entries, got %d", len(entries))
	}
	byID := map[string]CatalogEntry{}
	for _, e := range entries {
		byID[e.ID] = e
		if e.Image == "" {
			t.Errorf("%s: missing image", e.ID)
		}
		if e.Source != SourceBuiltin {
			t.Errorf("%s: source = %q, want builtin", e.ID, e.Source)
		}
		if e.PortOrDefault() == 0 || e.PathOrDefault() == "" {
			t.Errorf("%s: bad port/path", e.ID)
		}
	}
	for _, id := range []string{"hope-postgres", "hope-redis", "hope-nats"} {
		e, ok := byID[id]
		if !ok {
			t.Fatalf("built-in %s missing", id)
		}
		var reqSecret bool
		for _, f := range e.Env {
			if f.Required && f.Kind == "secret" {
				reqSecret = true
			}
		}
		if !reqSecret {
			t.Errorf("%s: expected a required secret connection env field", id)
		}
	}
}

// TestManifestRoundTrip confirms the remote-manifest wire (typed env with select
// options + volumes + setting seeds) decodes into the catalog types.
func TestManifestRoundTrip(t *testing.T) {
	raw := `{"version":1,"entries":[{
		"id":"acme-mongo","title":"MongoDB","image":"ghcr.io/toyz/hope-mongo:1",
		"env":[
			{"key":"MONGO_URI","label":"URI","kind":"secret","required":true},
			{"key":"TLS","label":"TLS","kind":"select","options":[{"label":"On","value":"on"},{"label":"Off","value":"off"}]}
		],
		"volumes":[{"target":"/data"}],
		"settings":[{"key":"page_size","value":"50"}]
	}]}`
	var m Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if len(m.Entries) != 1 {
		t.Fatalf("want 1 entry, got %d", len(m.Entries))
	}
	e := m.Entries[0]
	if len(e.Env) != 2 || e.Env[1].Kind != "select" || len(e.Env[1].Options) != 2 {
		t.Errorf("env select options not decoded: %+v", e.Env)
	}
	if len(e.Volumes) != 1 || e.Volumes[0].Target != "/data" {
		t.Errorf("volumes not decoded: %+v", e.Volumes)
	}
	if len(e.Settings) != 1 || e.Settings[0].Value != "50" {
		t.Errorf("setting seeds not decoded: %+v", e.Settings)
	}
}
