package catalog

import "testing"

func TestMergeOverrideAndExtend(t *testing.T) {
	builtins := []CatalogEntry{
		{ID: "hope-redis", Title: "Redis", Image: "ghcr.io/toyz/hope-redis:latest"},
		{ID: "hope-postgres", Title: "Postgres", Image: "ghcr.io/toyz/hope-postgres:latest"},
	}
	remote := []CatalogEntry{
		{ID: "hope-redis", Title: "Redis (custom)", Image: "ghcr.io/toyz/hope-redis:pinned"}, // override
		{ID: "acme-mongo", Title: "MongoDB", Image: "ghcr.io/toyz/hope-mongo:1.0.0"},         // extend (trusted prefix)
	}

	got := Merge(builtins, []SourceEntries{{Name: "community", Entries: remote, Trust: false}})
	if len(got) != 3 {
		t.Fatalf("want 3 entries, got %d", len(got))
	}
	// sorted by ID: acme-mongo, hope-postgres, hope-redis
	if got[0].ID != "acme-mongo" || got[0].Source != "community" {
		t.Errorf("entry[0] = %+v; want acme-mongo/community", got[0])
	}
	byID := map[string]CatalogEntry{}
	for _, e := range got {
		byID[e.ID] = e
	}
	if r := byID["hope-redis"]; r.Title != "Redis (custom)" || r.Source != "community" {
		t.Errorf("hope-redis not overridden by remote: %+v", r)
	}
	if p := byID["hope-postgres"]; p.Source != SourceBuiltin {
		t.Errorf("hope-postgres should stay builtin: %+v", p)
	}
}

func TestMergeUntrustedImageDropped(t *testing.T) {
	builtins := []CatalogEntry{{ID: "hope-redis", Title: "Redis", Image: "ghcr.io/toyz/hope-redis:latest"}}
	remote := []CatalogEntry{
		{ID: "evil", Title: "Evil", Image: "docker.io/attacker/backdoor:latest"}, // untrusted → dropped
		{ID: "hope-redis", Title: "Hijacked", Image: "docker.io/attacker/x:1"},   // untrusted override → dropped, builtin kept
	}

	// untrusted repo: untrusted images dropped; builtin hope-redis survives.
	got := Merge(builtins, []SourceEntries{{Name: "community", Entries: remote, Trust: false}})
	if len(got) != 1 || got[0].ID != "hope-redis" || got[0].Title != "Redis" || got[0].Source != SourceBuiltin {
		t.Fatalf("untrusted images should be dropped and builtin kept; got %+v", got)
	}

	// trusted repo: untrusted images now allowed through.
	got = Merge(builtins, []SourceEntries{{Name: "community", Entries: remote, Trust: true}})
	if len(got) != 2 {
		t.Fatalf("a trusted repo should admit its images; got %d", len(got))
	}
}

func TestMergeSkipsMalformed(t *testing.T) {
	remote := []CatalogEntry{
		{ID: "", Image: "ghcr.io/toyz/x:1"}, // no id
		{ID: "y", Image: ""},                // no image
	}
	if got := Merge(nil, []SourceEntries{{Name: "r", Entries: remote, Trust: true}}); len(got) != 0 {
		t.Fatalf("malformed entries should be skipped; got %+v", got)
	}
}
