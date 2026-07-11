package deploy

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"

	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/stackspec"
)

// ApplyStack full reconciliation: creates declared + default networks, skips an
// unchanged service, recreates a changed one, creates a new one, removes a gone
// one, and persists the authored spec. Asserts the mock is driven with the right
// specs and that unchanged is left completely alone.
func TestApplyStackReconcile(t *testing.T) {
	var (
		createdNets []stackspec.NetworkSpec
		createdCts  = map[string]stackspec.ContainerSpec{}
		removedIDs  []string
		rmServices  []string
	)
	m := &mockAPI{
		networkExists: func(_ context.Context, name string) (bool, error) { return false, nil }, // nothing pre-exists
		createNetwork: func(_ context.Context, spec stackspec.NetworkSpec) (string, error) {
			createdNets = append(createdNets, spec)
			return spec.Name, nil
		},
		projectSpec: func(_ context.Context, project string) (*stackspec.StackSpec, error) {
			// Live stack: api unchanged, db changed (redis:2), old is gone.
			return &stackspec.StackSpec{Name: project, Services: []stackspec.ContainerSpec{
				{Name: "api", Image: "nginx:1", Networks: []string{"web_frontend"}},
				{Name: "db", Image: "redis:2", Networks: []string{"web_frontend"}},
				{Name: "old", Image: "busybox", Networks: []string{"web_frontend"}},
			}}, nil
		},
		projectContainers: func(_ context.Context, project, service string) ([]docker.ContainerRef, error) {
			rmServices = append(rmServices, service)
			return []docker.ContainerRef{{ID: service + "-id", Name: project + "-" + service + "-1", Service: service}}, nil
		},
		remove: func(_ context.Context, id string) error { removedIDs = append(removedIDs, id); return nil },
		createContainer: func(_ context.Context, name string, spec stackspec.ContainerSpec, pull bool, _ func(string)) (string, error) {
			if !pull {
				t.Errorf("CreateContainer(%s): pull should be true", name)
			}
			createdCts[name] = spec
			return name, nil
		},
	}
	e, ctx := engineFor(m, NewStore(openDB(t)))

	spec := &stackspec.StackSpec{
		Name:     "web",
		Networks: []stackspec.NetworkSpec{{Name: "frontend"}},
		Services: []stackspec.ContainerSpec{
			{Name: "api", Image: "nginx:1", Networks: []string{"frontend"}}, // unchanged
			{Name: "db", Image: "redis:1", Networks: []string{"frontend"}},  // changed -> recreate
			{Name: "cache", Image: "memcached:1"},                           // new, no nets -> default
		},
	}
	rec := &recorder{}
	if err := e.ApplyStack(ctx, spec, false, rec.emit); err != nil {
		t.Fatalf("ApplyStack: %v", err)
	}

	// Networks: declared web_frontend + the compose default web_default (for cache).
	gotNet := map[string]stackspec.NetworkSpec{}
	for _, n := range createdNets {
		gotNet[n.Name] = n
	}
	if _, ok := gotNet["web_frontend"]; !ok {
		t.Errorf("declared network web_frontend not created: %v", createdNets)
	}
	if fn, ok := gotNet["web_frontend"]; !ok || fn.Labels[docker.LabelProject] != "web" || fn.Labels[docker.LabelManaged] != "1" {
		t.Errorf("web_frontend missing project/managed labels: %+v", fn)
	}
	if _, ok := gotNet["web_default"]; !ok {
		t.Errorf("default network web_default not created: %v", createdNets)
	}

	// Containers: db recreated + cache created; api (unchanged) NOT touched.
	if _, ok := createdCts["web-api-1"]; ok {
		t.Errorf("unchanged service api must NOT be recreated")
	}
	db, ok := createdCts["web-db-1"]
	if !ok {
		t.Fatalf("changed service db was not recreated: %v", createdCts)
	}
	if !reflect.DeepEqual(db.Networks, []string{"web_frontend"}) {
		t.Errorf("db networks = %v; want [web_frontend] (remapped, kept)", db.Networks)
	}
	if db.Image != "redis:1" {
		t.Errorf("db image = %q; want redis:1 (desired)", db.Image)
	}
	if db.Labels[docker.LabelService] != "db" || db.Labels[docker.LabelManaged] != "1" {
		t.Errorf("db missing compose labels: %+v", db.Labels)
	}
	cache, ok := createdCts["web-cache-1"]
	if !ok {
		t.Fatalf("new service cache was not created: %v", createdCts)
	}
	if !reflect.DeepEqual(cache.Networks, []string{"web_default"}) {
		t.Errorf("cache networks = %v; want [web_default] (default bridge)", cache.Networks)
	}

	// Removals: db (recreate) + old (gone). api never removed.
	sort.Strings(rmServices)
	if !reflect.DeepEqual(rmServices, []string{"db", "old"}) {
		t.Errorf("removeService called for %v; want [db old]", rmServices)
	}
	sort.Strings(removedIDs)
	if !reflect.DeepEqual(removedIDs, []string{"db-id", "old-id"}) {
		t.Errorf("removed container ids = %v; want [db-id old-id]", removedIDs)
	}

	rec.mustHave(t,
		"network web_frontend — created",
		"network web_default — created (default)",
		"skip api — unchanged",
		"recreate db",
		"create cache",
		"remove old — no longer in stack",
		"stack web applied",
	)

	// Authored spec persisted (not the resolved one) so the stack is reopenable.
	saved, err := e.store.Load("local", "web")
	if err != nil || saved == nil {
		t.Fatalf("stored spec = %v, %v; want the authored spec", saved, err)
	}
	if len(saved.Services) != 3 {
		t.Errorf("stored spec services = %d; want 3", len(saved.Services))
	}
	if api, _ := saved.ServiceByName("api"); api.Image != "nginx:1" {
		t.Errorf("stored api image = %q; want nginx:1 (authored, unresolved)", api.Image)
	}
}

// A declared external network is never created; a pre-existing internal one is
// reported "exists" and left as-is. Volumes follow the same create/exists split.
func TestApplyStackExistingAndExternalResources(t *testing.T) {
	var createdNets []string
	var createdVols []string
	m := &mockAPI{
		networkExists: func(_ context.Context, name string) (bool, error) {
			return name == "web_pre", nil // web_pre already exists
		},
		volumeExists: func(_ context.Context, name string) (bool, error) {
			return name == "web_vpre", nil
		},
		createNetwork: func(_ context.Context, spec stackspec.NetworkSpec) (string, error) {
			createdNets = append(createdNets, spec.Name)
			return spec.Name, nil
		},
		createVolume: func(_ context.Context, spec stackspec.VolumeSpec) (string, error) {
			createdVols = append(createdVols, spec.Name)
			return spec.Name, nil
		},
		projectSpec: func(_ context.Context, project string) (*stackspec.StackSpec, error) {
			return &stackspec.StackSpec{Name: project}, nil // no live services
		},
		createContainer: func(_ context.Context, name string, spec stackspec.ContainerSpec, _ bool, _ func(string)) (string, error) {
			return name, nil
		},
	}
	e, ctx := engineFor(m, NewStore(nil)) // disabled store: persist is a no-op

	spec := &stackspec.StackSpec{
		Name: "web",
		Networks: []stackspec.NetworkSpec{
			{Name: "new"},                 // -> web_new, created
			{Name: "pre"},                 // -> web_pre, already exists
			{Name: "ext", External: true}, // external, never created, name kept
		},
		Volumes: []stackspec.VolumeSpec{
			{Name: "vnew"},                 // -> web_vnew, created
			{Name: "vpre"},                 // -> web_vpre, exists
			{Name: "vext", External: true}, // external
		},
		// One service on the external net so nothing hits the default bridge.
		Services: []stackspec.ContainerSpec{{Name: "app", Image: "nginx", Networks: []string{"ext"}}},
	}
	rec := &recorder{}
	if err := e.ApplyStack(ctx, spec, false, rec.emit); err != nil {
		t.Fatalf("ApplyStack: %v", err)
	}

	if !reflect.DeepEqual(createdNets, []string{"web_new"}) {
		t.Errorf("created networks = %v; want [web_new] only (pre exists, ext external)", createdNets)
	}
	if !reflect.DeepEqual(createdVols, []string{"web_vnew"}) {
		t.Errorf("created volumes = %v; want [web_vnew] only", createdVols)
	}
	rec.mustHave(t,
		"network web_new — created",
		"network web_pre — exists",
		"volume web_vnew — created",
		"volume web_vpre — exists",
	)
	// External net "ext" is used as-is on the service, never created/renamed.
	rec.mustNotHave(t, "network ext — created", "network web_ext — created")
}

// When ProjectSpec fails (e.g. first deploy of a brand-new project), the live
// stack is treated as empty: every service is created fresh on the default net
// and nothing is pruned.
func TestApplyStackProjectSpecError(t *testing.T) {
	var created []string
	m := &mockAPI{
		networkExists: func(_ context.Context, _ string) (bool, error) { return false, nil },
		createNetwork: func(_ context.Context, spec stackspec.NetworkSpec) (string, error) { return spec.Name, nil },
		projectSpec: func(_ context.Context, _ string) (*stackspec.StackSpec, error) {
			return nil, errors.New("no such project")
		},
		createContainer: func(_ context.Context, name string, _ stackspec.ContainerSpec, _ bool, _ func(string)) (string, error) {
			created = append(created, name)
			return name, nil
		},
	}
	e, ctx := engineFor(m, NewStore(nil))
	spec := &stackspec.StackSpec{Name: "fresh", Services: []stackspec.ContainerSpec{{Name: "app", Image: "nginx"}}}
	rec := &recorder{}
	if err := e.ApplyStack(ctx, spec, false, rec.emit); err != nil {
		t.Fatalf("ApplyStack: %v", err)
	}
	if !reflect.DeepEqual(created, []string{"fresh-app-1"}) {
		t.Errorf("created = %v; want [fresh-app-1] as a new service", created)
	}
	rec.mustHave(t, "create app", "network fresh_default — created (default)", "stack fresh applied")
}

// Store() exposes the engine's spec store to the router's read paths.
func TestEngineStore(t *testing.T) {
	st := NewStore(nil)
	if e := NewEngine(nil, st, nil); e.Store() != st {
		t.Errorf("Store() = %v; want the wired store", e.Store())
	}
}

// Additive mode: only creates the fragment's services, does NOT prune services
// missing from the fragment, and merges (not overwrites) the stored spec.
func TestApplyStackAdditive(t *testing.T) {
	var created []string
	m := &mockAPI{
		networkExists: func(_ context.Context, _ string) (bool, error) { return false, nil },
		createNetwork: func(_ context.Context, spec stackspec.NetworkSpec) (string, error) { return spec.Name, nil },
		createContainer: func(_ context.Context, name string, _ stackspec.ContainerSpec, _ bool, _ func(string)) (string, error) {
			created = append(created, name)
			return name, nil
		},
		projectSpec: func(_ context.Context, project string) (*stackspec.StackSpec, error) {
			// Live stack already has web + db; the fragment must NOT prune them.
			return &stackspec.StackSpec{Name: project, Services: []stackspec.ContainerSpec{
				{Name: "web", Image: "web:1", Networks: []string{"host_default"}},
				{Name: "db", Image: "db:1", Networks: []string{"host_default"}},
			}}, nil
		},
	}
	store := NewStore(openDB(t))
	// Seed an existing stored spec so mergeStoredSpec has a base to fold into.
	base := &stackspec.StackSpec{Name: "host", Services: []stackspec.ContainerSpec{
		{Name: "web", Image: "web:1"}, {Name: "db", Image: "db:1"},
	}}
	if err := store.Save("local", "host", base); err != nil {
		t.Fatalf("seed base: %v", err)
	}
	e, ctx := engineFor(m, store)

	frag := &stackspec.StackSpec{Name: "host", Services: []stackspec.ContainerSpec{
		{Name: "plugin", Image: "plugin:1"}, // new service merged INTO the stack
	}}
	rec := &recorder{}
	if err := e.ApplyStack(ctx, frag, true, rec.emit); err != nil {
		t.Fatalf("ApplyStack additive: %v", err)
	}

	if !reflect.DeepEqual(created, []string{"host-plugin-1"}) {
		t.Errorf("additive created %v; want [host-plugin-1] only", created)
	}
	// No pruning of web/db even though they're absent from the fragment.
	rec.mustNotHave(t, "remove web — no longer in stack", "remove db — no longer in stack")

	// Stored spec is MERGED: keeps web+db, gains plugin.
	got, err := store.Load("local", "host")
	if err != nil || got == nil {
		t.Fatalf("Load merged = %v, %v", got, err)
	}
	if len(got.Services) != 3 {
		t.Errorf("merged services = %d; want 3 (web, db, plugin)", len(got.Services))
	}
	if _, ok := got.ServiceByName("plugin"); !ok {
		t.Errorf("plugin not merged into stored spec")
	}
}

// ApplyStack rejects an invalid spec before touching the daemon, and an empty
// name (single service passes Validate) trips the explicit name guard.
func TestApplyStackValidation(t *testing.T) {
	m := &mockAPI{} // every method panics -> proves the daemon is never touched
	e, ctx := engineFor(m, NewStore(nil))

	t.Run("invalid spec", func(t *testing.T) {
		err := e.ApplyStack(ctx, &stackspec.StackSpec{Name: "x"}, false, nil) // no services
		if err == nil {
			t.Fatal("want validation error for a spec with no services")
		}
	})
	t.Run("empty name, single service", func(t *testing.T) {
		// Validate() tolerates an empty name for a single service; ApplyStack's own
		// guard still requires it.
		err := e.ApplyStack(ctx, &stackspec.StackSpec{Services: []stackspec.ContainerSpec{{Image: "nginx"}}}, false, nil)
		if err == nil || err.Error() != "stack name is required" {
			t.Fatalf("err = %v; want \"stack name is required\"", err)
		}
	})
}

// Daemon errors propagate out of ApplyStack (and CreateContainer failures are
// wrapped with the service name).
func TestApplyStackErrors(t *testing.T) {
	t.Run("NetworkExists error", func(t *testing.T) {
		boom := errors.New("daemon down")
		m := &mockAPI{networkExists: func(_ context.Context, _ string) (bool, error) { return false, boom }}
		e, ctx := engineFor(m, NewStore(nil))
		spec := &stackspec.StackSpec{Name: "web", Networks: []stackspec.NetworkSpec{{Name: "n"}},
			Services: []stackspec.ContainerSpec{{Name: "a", Image: "nginx"}}}
		if err := e.ApplyStack(ctx, spec, false, nil); !errors.Is(err, boom) {
			t.Fatalf("err = %v; want daemon down", err)
		}
	})
	t.Run("CreateContainer error wrapped with service", func(t *testing.T) {
		boom := errors.New("pull failed")
		m := &mockAPI{
			networkExists: func(_ context.Context, _ string) (bool, error) { return false, nil },
			createNetwork: func(_ context.Context, spec stackspec.NetworkSpec) (string, error) { return spec.Name, nil },
			projectSpec: func(_ context.Context, project string) (*stackspec.StackSpec, error) {
				return &stackspec.StackSpec{Name: project}, nil
			},
			createContainer: func(_ context.Context, _ string, _ stackspec.ContainerSpec, _ bool, _ func(string)) (string, error) {
				return "", boom
			},
		}
		e, ctx := engineFor(m, NewStore(nil))
		spec := &stackspec.StackSpec{Name: "web", Services: []stackspec.ContainerSpec{{Name: "app", Image: "nginx"}}}
		err := e.ApplyStack(ctx, spec, false, nil)
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v; want wrapped pull failed", err)
		}
		if got := err.Error(); got != "service app: pull failed" {
			t.Errorf("err = %q; want \"service app: pull failed\"", got)
		}
	})
}

// DeployContainer creates a single bare container: image required, name
// sanitized, the service alias dropped, and the managed label stamped.
func TestDeployContainer(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		var gotName string
		var gotSpec stackspec.ContainerSpec
		m := &mockAPI{createContainer: func(_ context.Context, name string, spec stackspec.ContainerSpec, pull bool, _ func(string)) (string, error) {
			gotName, gotSpec = name, spec
			if !pull {
				t.Error("pull should be true")
			}
			return name, nil
		}}
		e, ctx := engineFor(m, NewStore(nil))
		rec := &recorder{}
		err := e.DeployContainer(ctx, stackspec.ContainerSpec{Name: "my app", Image: "nginx"}, rec.emit)
		if err != nil {
			t.Fatalf("DeployContainer: %v", err)
		}
		if gotName != "my-app" {
			t.Errorf("container name = %q; want my-app (sanitized)", gotName)
		}
		if gotSpec.Name != "" {
			t.Errorf("spec.Name = %q; want empty (no service alias for a bare container)", gotSpec.Name)
		}
		if gotSpec.Labels[docker.LabelManaged] != "1" {
			t.Errorf("managed label not stamped: %+v", gotSpec.Labels)
		}
	})
	t.Run("image required", func(t *testing.T) {
		m := &mockAPI{} // CreateContainer must never be reached
		e, ctx := engineFor(m, NewStore(nil))
		if err := e.DeployContainer(ctx, stackspec.ContainerSpec{Name: "x"}, nil); err == nil {
			t.Fatal("want error for missing image")
		}
	})
	t.Run("create error propagates", func(t *testing.T) {
		boom := errors.New("no such image")
		m := &mockAPI{createContainer: func(_ context.Context, _ string, _ stackspec.ContainerSpec, _ bool, _ func(string)) (string, error) {
			return "", boom
		}}
		e, ctx := engineFor(m, NewStore(nil))
		if err := e.DeployContainer(ctx, stackspec.ContainerSpec{Image: "ghost"}, nil); !errors.Is(err, boom) {
			t.Fatalf("err = %v; want no such image", err)
		}
	})
}

// Destroy removes every project container, prunes managed resources when asked,
// and deletes the stored spec.
func TestDestroy(t *testing.T) {
	t.Run("with prune", func(t *testing.T) {
		var removed []string
		var prunedProject string
		m := &mockAPI{
			projectContainerIDs: func(_ context.Context, project string) ([]string, error) {
				return []string{"abcdef0123456789", "short"}, nil // one long id gets shortened in emit
			},
			remove: func(_ context.Context, id string) error { removed = append(removed, id); return nil },
			removeManagedResources: func(_ context.Context, project string, _ func(string)) (int, error) {
				prunedProject = project
				return 3, nil
			},
		}
		store := NewStore(openDB(t))
		if err := store.Save("local", "web", &stackspec.StackSpec{Name: "web"}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		e, ctx := engineFor(m, store)
		rec := &recorder{}
		if err := e.Destroy(ctx, "web", true, rec.emit); err != nil {
			t.Fatalf("Destroy: %v", err)
		}
		if !reflect.DeepEqual(removed, []string{"abcdef0123456789", "short"}) {
			t.Errorf("removed = %v; want both container ids", removed)
		}
		if prunedProject != "web" {
			t.Errorf("pruned project = %q; want web", prunedProject)
		}
		rec.mustHave(t,
			"remove abcdef012345", // long id truncated to 12 chars
			"remove short",
			"pruned 3 managed resource(s)",
			"stack web destroyed",
		)
		// Stored spec deleted.
		if got, _ := store.Load("local", "web"); got != nil {
			t.Errorf("stored spec should be deleted; got %v", got)
		}
	})
	t.Run("no prune skips RemoveManagedResources", func(t *testing.T) {
		m := &mockAPI{
			projectContainerIDs: func(_ context.Context, _ string) ([]string, error) { return []string{"id1"}, nil },
			remove:              func(_ context.Context, _ string) error { return nil },
			// removeManagedResources intentionally nil: must NOT be called when prune=false.
		}
		e, ctx := engineFor(m, NewStore(nil))
		if err := e.Destroy(ctx, "web", false, nil); err != nil {
			t.Fatalf("Destroy(prune=false): %v", err)
		}
	})
	t.Run("list error propagates", func(t *testing.T) {
		boom := errors.New("cannot list")
		m := &mockAPI{projectContainerIDs: func(_ context.Context, _ string) ([]string, error) { return nil, boom }}
		e, ctx := engineFor(m, NewStore(nil))
		if err := e.Destroy(ctx, "web", true, nil); !errors.Is(err, boom) {
			t.Fatalf("err = %v; want cannot list", err)
		}
	})
	t.Run("remove error wrapped", func(t *testing.T) {
		boom := errors.New("in use")
		m := &mockAPI{
			projectContainerIDs: func(_ context.Context, _ string) ([]string, error) { return []string{"deadbeefcafe00"}, nil },
			remove:              func(_ context.Context, _ string) error { return boom },
		}
		e, ctx := engineFor(m, NewStore(nil))
		err := e.Destroy(ctx, "web", false, nil)
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v; want in use", err)
		}
		if got := err.Error(); got != "remove deadbeefcafe: in use" {
			t.Errorf("err = %q; want \"remove deadbeefcafe: in use\"", got)
		}
	})
}
