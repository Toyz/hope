package deploy

import (
	"context"
	"testing"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
)

// mockAPI is a docker.API test double. It embeds the interface (nil) so any
// method the test does NOT override panics on call — surfacing an unexpected
// daemon touch. Each overridden method delegates to its func field; a nil field
// panics with the method name so an unwired-but-called method is obvious.
type mockAPI struct {
	docker.API // nil embed: un-overridden methods panic

	networkExists          func(ctx context.Context, name string) (bool, error)
	volumeExists           func(ctx context.Context, name string) (bool, error)
	createNetwork          func(ctx context.Context, spec stackspec.NetworkSpec) (string, error)
	createVolume           func(ctx context.Context, spec stackspec.VolumeSpec) (string, error)
	createContainer        func(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error)
	projectSpec            func(ctx context.Context, project string) (*stackspec.StackSpec, error)
	projectContainers      func(ctx context.Context, project, service string) ([]docker.ContainerRef, error)
	projectContainerIDs    func(ctx context.Context, project string) ([]string, error)
	remove                 func(ctx context.Context, id string) error
	removeManagedResources func(ctx context.Context, project string, emit func(string)) (int, error)
	networks               func(ctx context.Context) ([]docker.NetworkInfo, error)
	volumes                func(ctx context.Context) ([]docker.VolumeInfo, error)
}

func (m *mockAPI) NetworkExists(ctx context.Context, name string) (bool, error) {
	if m.networkExists == nil {
		panic("mockAPI.NetworkExists called but not wired")
	}
	return m.networkExists(ctx, name)
}

func (m *mockAPI) VolumeExists(ctx context.Context, name string) (bool, error) {
	if m.volumeExists == nil {
		panic("mockAPI.VolumeExists called but not wired")
	}
	return m.volumeExists(ctx, name)
}

func (m *mockAPI) CreateNetwork(ctx context.Context, spec stackspec.NetworkSpec) (string, error) {
	if m.createNetwork == nil {
		panic("mockAPI.CreateNetwork called but not wired")
	}
	return m.createNetwork(ctx, spec)
}

func (m *mockAPI) CreateVolume(ctx context.Context, spec stackspec.VolumeSpec) (string, error) {
	if m.createVolume == nil {
		panic("mockAPI.CreateVolume called but not wired")
	}
	return m.createVolume(ctx, spec)
}

func (m *mockAPI) CreateContainer(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error) {
	if m.createContainer == nil {
		panic("mockAPI.CreateContainer called but not wired")
	}
	return m.createContainer(ctx, name, spec, pull, emit)
}

func (m *mockAPI) ProjectSpec(ctx context.Context, project string) (*stackspec.StackSpec, error) {
	if m.projectSpec == nil {
		panic("mockAPI.ProjectSpec called but not wired")
	}
	return m.projectSpec(ctx, project)
}

func (m *mockAPI) ProjectContainers(ctx context.Context, project, service string) ([]docker.ContainerRef, error) {
	if m.projectContainers == nil {
		panic("mockAPI.ProjectContainers called but not wired")
	}
	return m.projectContainers(ctx, project, service)
}

func (m *mockAPI) ProjectContainerIDs(ctx context.Context, project string) ([]string, error) {
	if m.projectContainerIDs == nil {
		panic("mockAPI.ProjectContainerIDs called but not wired")
	}
	return m.projectContainerIDs(ctx, project)
}

func (m *mockAPI) Remove(ctx context.Context, id string) error {
	if m.remove == nil {
		panic("mockAPI.Remove called but not wired")
	}
	return m.remove(ctx, id)
}

func (m *mockAPI) RemoveManagedResources(ctx context.Context, project string, emit func(string)) (int, error) {
	if m.removeManagedResources == nil {
		panic("mockAPI.RemoveManagedResources called but not wired")
	}
	return m.removeManagedResources(ctx, project, emit)
}

func (m *mockAPI) Networks(ctx context.Context) ([]docker.NetworkInfo, error) {
	if m.networks == nil {
		panic("mockAPI.Networks called but not wired")
	}
	return m.networks(ctx)
}

func (m *mockAPI) Volumes(ctx context.Context) ([]docker.VolumeInfo, error) {
	if m.volumes == nil {
		panic("mockAPI.Volumes called but not wired")
	}
	return m.volumes(ctx)
}

// engineFor builds an Engine whose active host resolves to m (the reserved local
// target short-circuits host resolution), plus a target-carrying context.
func engineFor(m *mockAPI, store *Store) (*Engine, context.Context) {
	set := hosts.New(m, true, nil)
	e := NewEngine(set, store, nil) // nil bus: Publish is a no-op
	ctx := hosts.WithTarget(context.Background(), hosts.LocalID)
	return e, ctx
}

// routerFor builds a DeployRouter whose active host resolves to m, plus an
// rpc.Context carrying the local target so dock(ctx)/hostID(ctx) resolve to m.
func routerFor(m *mockAPI, store *Store) (*DeployRouter, *rpc.Context) {
	set := hosts.New(m, true, nil)
	r := NewDeployRouter(set, store)
	ctx := rpc.NewContext(hosts.WithTarget(context.Background(), hosts.LocalID))
	return r, ctx
}

// recorder collects emit() progress lines and offers a substring assertion.
type recorder struct{ lines []string }

func (r *recorder) emit(s string) { r.lines = append(r.lines, s) }

func (r *recorder) has(sub string) bool {
	for _, l := range r.lines {
		if l == sub {
			return true
		}
	}
	return false
}

func (r *recorder) mustHave(t *testing.T, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if !r.has(s) {
			t.Errorf("emit missing %q; got %v", s, r.lines)
		}
	}
}

func (r *recorder) mustNotHave(t *testing.T, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if r.has(s) {
			t.Errorf("emit unexpectedly has %q; got %v", s, r.lines)
		}
	}
}
