package deploy

import (
	"reflect"
	"testing"

	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
)

// composeLabels stamps the four compose/hope labels and copies user labels on
// top (so a user label can override an injected one).
func TestComposeLabels(t *testing.T) {
	tests := []struct {
		name    string
		user    map[string]string
		project string
		service string
		want    map[string]string
	}{
		{
			name:    "nil user labels",
			user:    nil,
			project: "web",
			service: "api",
			want: map[string]string{
				docker.LabelProject: "web",
				docker.LabelService: "api",
				docker.LabelNumber:  "1",
				docker.LabelManaged: "1",
			},
		},
		{
			name:    "user labels merged on top",
			user:    map[string]string{"team": "core"},
			project: "web",
			service: "api",
			want: map[string]string{
				docker.LabelProject: "web",
				docker.LabelService: "api",
				docker.LabelNumber:  "1",
				docker.LabelManaged: "1",
				"team":              "core",
			},
		},
		{
			name:    "user label overrides an injected one",
			user:    map[string]string{docker.LabelNumber: "5"},
			project: "web",
			service: "api",
			want: map[string]string{
				docker.LabelProject: "web",
				docker.LabelService: "api",
				docker.LabelNumber:  "5", // user wins (maps.Copy applies user last)
				docker.LabelManaged: "1",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := composeLabels(tt.user, tt.project, tt.service)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("composeLabels = %v; want %v", got, tt.want)
			}
			// The helper must not alias/mutate the caller's map.
			if tt.user != nil {
				if _, ok := tt.user[docker.LabelProject]; ok {
					t.Errorf("composeLabels mutated the input map: %v", tt.user)
				}
			}
		})
	}
}

// withProject stamps only project+managed and copies user labels on top.
func TestWithProject(t *testing.T) {
	got := withProject(nil, "web")
	want := map[string]string{docker.LabelProject: "web", docker.LabelManaged: "1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("withProject(nil) = %v; want %v", got, want)
	}

	got = withProject(map[string]string{"env": "prod"}, "web")
	want = map[string]string{docker.LabelProject: "web", docker.LabelManaged: "1", "env": "prod"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("withProject(user) = %v; want %v", got, want)
	}
}

// resolveService maps declared short net/vol names to their compose names,
// re-keys aliases, remaps volume mount sources, and always stamps compose labels.
func TestResolveService(t *testing.T) {
	e := &Engine{} // resolveService does not touch engine state
	project := "proj"
	netName := map[string]string{"frontend": "proj_frontend", "backend": "proj_backend"}
	volName := map[string]string{"data": "proj_data"}

	t.Run("network remap + external passthrough + sorted", func(t *testing.T) {
		svc := stackspec.ContainerSpec{
			Name:     "api",
			Image:    "nginx",
			Networks: []string{"frontend", "shared-external"}, // shared-external not declared -> passthrough
		}
		out := e.resolveService(svc, project, netName, volName)
		// remap frontend->proj_frontend, passthrough shared-external, sorted.
		want := []string{"proj_frontend", "shared-external"}
		if !reflect.DeepEqual(out.Networks, want) {
			t.Errorf("Networks = %v; want %v", out.Networks, want)
		}
	})

	t.Run("aliases re-keyed to actual network names", func(t *testing.T) {
		svc := stackspec.ContainerSpec{
			Name:     "api",
			Image:    "nginx",
			Networks: []string{"frontend"},
			Aliases:  map[string][]string{"frontend": {"web", "www"}},
		}
		out := e.resolveService(svc, project, netName, volName)
		want := map[string][]string{"proj_frontend": {"web", "www"}}
		if !reflect.DeepEqual(out.Aliases, want) {
			t.Errorf("Aliases = %v; want %v", out.Aliases, want)
		}
	})

	t.Run("volume mount source remapped, bind untouched", func(t *testing.T) {
		svc := stackspec.ContainerSpec{
			Name:  "api",
			Image: "nginx",
			Mounts: []stackspec.MountSpec{
				{Type: "volume", Source: "data", Target: "/data"},   // -> proj_data
				{Type: "volume", Source: "extern", Target: "/e"},     // not declared -> passthrough
				{Type: "bind", Source: "/host/path", Target: "/hp"},  // bind never remapped
			},
		}
		out := e.resolveService(svc, project, netName, volName)
		if out.Mounts[0].Source != "proj_data" {
			t.Errorf("volume mount source = %q; want proj_data", out.Mounts[0].Source)
		}
		if out.Mounts[1].Source != "extern" {
			t.Errorf("undeclared volume source = %q; want passthrough extern", out.Mounts[1].Source)
		}
		if out.Mounts[2].Source != "/host/path" {
			t.Errorf("bind mount source = %q; want /host/path", out.Mounts[2].Source)
		}
	})

	t.Run("labels always stamped; no networks stays empty", func(t *testing.T) {
		svc := stackspec.ContainerSpec{Name: "api", Image: "nginx"}
		out := e.resolveService(svc, project, netName, volName)
		if out.Networks != nil {
			t.Errorf("Networks = %v; want nil (no networks declared)", out.Networks)
		}
		if out.Labels[docker.LabelProject] != project || out.Labels[docker.LabelService] != "api" {
			t.Errorf("labels not stamped: %v", out.Labels)
		}
		if out.Labels[docker.LabelManaged] != "1" {
			t.Errorf("managed label missing: %v", out.Labels)
		}
	})

	t.Run("does not mutate the input service", func(t *testing.T) {
		svc := stackspec.ContainerSpec{
			Name:     "api",
			Image:    "nginx",
			Networks: []string{"frontend"},
			Aliases:  map[string][]string{"frontend": {"web"}},
		}
		_ = e.resolveService(svc, project, netName, volName)
		if svc.Networks[0] != "frontend" {
			t.Errorf("input Networks mutated: %v", svc.Networks)
		}
		if _, ok := svc.Aliases["frontend"]; !ok {
			t.Errorf("input Aliases re-keyed in place: %v", svc.Aliases)
		}
	})
}

// The apply-diff decides "unchanged" via stackspec.Hash. A live-reconstructed
// spec (no compose/hope labels) must hash the SAME as the resolved authored spec
// so an untouched service is left alone; a real content change must differ.
func TestResolveServiceDiffHash(t *testing.T) {
	e := &Engine{}
	netName := map[string]string{"net1": "proj_net1"}
	svc := stackspec.ContainerSpec{
		Name:     "app",
		Image:    "nginx:1",
		Networks: []string{"net1"},
		Labels:   map[string]string{"team": "core"}, // user label
	}
	resolved := e.resolveService(svc, "proj", netName, nil)

	// Reconstructed live spec: actual (mapped) network, user labels only.
	live := stackspec.ContainerSpec{
		Name:     "app",
		Image:    "nginx:1",
		Networks: []string{"proj_net1"},
		Labels:   map[string]string{"team": "core"},
	}
	if stackspec.Hash(resolved) != stackspec.Hash(live) {
		t.Fatalf("unchanged service should hash equal: resolved=%s live=%s",
			stackspec.Hash(resolved), stackspec.Hash(live))
	}

	// Adding compose/hope labels to the live spec must NOT change its hash.
	liveWithInjected := live
	liveWithInjected.Labels = map[string]string{
		"team":              "core",
		docker.LabelProject: "proj",
		docker.LabelManaged: "1",
	}
	if stackspec.Hash(resolved) != stackspec.Hash(liveWithInjected) {
		t.Fatalf("injected labels must be ignored by Hash")
	}

	// A real change (image) must produce a different hash -> recreate.
	changed := live
	changed.Image = "nginx:2"
	if stackspec.Hash(resolved) == stackspec.Hash(changed) {
		t.Fatalf("changed image should hash differently")
	}
}

func TestSanitizeName(t *testing.T) {
	tests := []struct{ in, want string }{
		{"web", "web"},
		{"  hello world  ", "hello-world"},   // trim spaces, space -> '-'
		{"a/b:c", "a-b-c"},                    // separators -> '-'
		{"web.api_1", "web.api_1"},            // . _ - digits kept
		{"@@@", ""},                            // all invalid -> trimmed to empty
		{"-lead-trail-", "lead-trail"},        // leading/trailing dashes trimmed
		{"", ""},
	}
	for _, tt := range tests {
		if got := sanitizeName(tt.in); got != tt.want {
			t.Errorf("sanitizeName(%q) = %q; want %q", tt.in, got, tt.want)
		}
	}
}

func TestContainerName(t *testing.T) {
	if got := containerName("web", "api"); got != "web-api-1" {
		t.Errorf("containerName = %q; want web-api-1", got)
	}
	// project/service run through sanitizeName as one string.
	if got := containerName("my proj", "the/svc"); got != "my-proj-the-svc-1" {
		t.Errorf("containerName = %q; want my-proj-the-svc-1", got)
	}
}

func TestUpsertBy(t *testing.T) {
	key := func(c stackspec.ContainerSpec) string { return c.Name }
	list := []stackspec.ContainerSpec{
		{Name: "a", Image: "img-a"},
		{Name: "b", Image: "img-b"},
	}

	// Upsert existing -> replaced in place, length unchanged.
	got := upsertBy(list, stackspec.ContainerSpec{Name: "b", Image: "img-b2"}, key)
	if len(got) != 2 || got[1].Image != "img-b2" {
		t.Fatalf("upsert existing = %v; want b replaced with img-b2", got)
	}

	// Upsert new -> appended.
	got = upsertBy(got, stackspec.ContainerSpec{Name: "c", Image: "img-c"}, key)
	if len(got) != 3 || got[2].Name != "c" {
		t.Fatalf("upsert new = %v; want c appended", got)
	}
}

// mergeStoredSpec folds an additive fragment into the project's stored spec by
// name. Targeting the reserved "local" host short-circuits host resolution so a
// zero hosts.Set is enough; the DB-backed store carries the merge.
func TestMergeStoredSpec(t *testing.T) {
	e := &Engine{hosts: &hosts.Set{}, store: NewStore(openDB(t))}
	ctx := hosts.WithTarget(t.Context(), hosts.LocalID)

	t.Run("no stored base is a no-op", func(t *testing.T) {
		frag := &stackspec.StackSpec{Name: "ghost", Services: []stackspec.ContainerSpec{{Name: "x", Image: "i"}}}
		if err := e.mergeStoredSpec(ctx, "ghost", frag); err != nil {
			t.Fatalf("mergeStoredSpec (no base): %v", err)
		}
		if got, _ := e.store.Load(hosts.LocalID, "ghost"); got != nil {
			t.Fatalf("no base should stay absent; got %v", got)
		}
	})

	t.Run("upsert service/network/volume into existing base", func(t *testing.T) {
		base := &stackspec.StackSpec{
			Name:     "stack",
			Services: []stackspec.ContainerSpec{{Name: "web", Image: "web:1"}, {Name: "db", Image: "db:1"}},
			Networks: []stackspec.NetworkSpec{{Name: "net"}},
			Volumes:  []stackspec.VolumeSpec{{Name: "vol"}},
		}
		if err := e.store.Save(hosts.LocalID, "stack", base); err != nil {
			t.Fatalf("seed base: %v", err)
		}
		frag := &stackspec.StackSpec{
			Name:     "stack",
			Services: []stackspec.ContainerSpec{{Name: "db", Image: "db:2"}, {Name: "plugin", Image: "p:1"}},
			Networks: []stackspec.NetworkSpec{{Name: "net2"}},
			Volumes:  []stackspec.VolumeSpec{{Name: "vol"}}, // existing vol -> replace
		}
		if err := e.mergeStoredSpec(ctx, "stack", frag); err != nil {
			t.Fatalf("mergeStoredSpec: %v", err)
		}
		got, err := e.store.Load(hosts.LocalID, "stack")
		if err != nil || got == nil {
			t.Fatalf("Load merged = %v, %v", got, err)
		}
		// web kept, db upserted (db:2), plugin appended.
		if len(got.Services) != 3 {
			t.Fatalf("services = %v; want 3 (web, db, plugin)", got.Services)
		}
		if db, ok := got.ServiceByName("db"); !ok || db.Image != "db:2" {
			t.Errorf("db not upserted: %+v (ok=%v)", db, ok)
		}
		if _, ok := got.ServiceByName("web"); !ok {
			t.Errorf("web dropped from merged spec")
		}
		if _, ok := got.ServiceByName("plugin"); !ok {
			t.Errorf("plugin not appended to merged spec")
		}
		if len(got.Networks) != 2 {
			t.Errorf("networks = %v; want net + net2", got.Networks)
		}
		if len(got.Volumes) != 1 {
			t.Errorf("volumes = %v; want vol upserted (still 1)", got.Volumes)
		}
	})
}
