package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/stackspec"
)

// rpcStatus extracts the HTTP status an *rpc.Error carries, so tests assert the
// status class (400/404/500) rather than message text.
func rpcStatus(t *testing.T, err error) int {
	t.Helper()
	var re *rpc.Error
	if !errors.As(err, &re) {
		t.Fatalf("err = %v (%T); want *rpc.Error", err, err)
	}
	return re.Status
}

// ImportCompose parses a compose document into a StackSpec. Pure: creates nothing
// (the mock has no wired methods, so any daemon touch would panic).
func TestImportCompose(t *testing.T) {
	r, ctx := routerFor(&mockAPI{}, NewStore(nil))

	t.Run("happy path", func(t *testing.T) {
		res, err := r.ImportCompose(ctx, &ImportComposeParams{
			Project: "blog",
			Compose: "services:\n  web:\n    image: nginx\n",
		})
		if err != nil {
			t.Fatalf("ImportCompose: %v", err)
		}
		if res.Spec == nil || res.Spec.Name != "blog" {
			t.Fatalf("spec = %+v; want name blog", res.Spec)
		}
		if len(res.Spec.Services) != 1 || res.Spec.Services[0].Image != "nginx" {
			t.Fatalf("services = %+v; want one nginx service", res.Spec.Services)
		}
	})
	t.Run("default project name", func(t *testing.T) {
		res, err := r.ImportCompose(ctx, &ImportComposeParams{Compose: "services:\n  web:\n    image: nginx\n"})
		if err != nil {
			t.Fatalf("ImportCompose: %v", err)
		}
		if res.Spec.Name != "stack" {
			t.Errorf("default project = %q; want stack", res.Spec.Name)
		}
	})
	t.Run("empty compose -> 400", func(t *testing.T) {
		_, err := r.ImportCompose(ctx, &ImportComposeParams{Compose: "   "})
		if rpcStatus(t, err) != 400 {
			t.Errorf("status = %d; want 400", rpcStatus(t, err))
		}
	})
	t.Run("malformed yaml -> 400", func(t *testing.T) {
		_, err := r.ImportCompose(ctx, &ImportComposeParams{Compose: "services: [1, 2"}) // unterminated flow seq
		if err == nil || rpcStatus(t, err) != 400 {
			t.Fatalf("err = %v; want 400 bad request", err)
		}
	})
}

// EditSpec prefers the stored authored spec, else reconstructs from live
// containers via ProjectSpec (404 when the daemon can't find the project).
func TestEditSpec(t *testing.T) {
	t.Run("empty project -> 400", func(t *testing.T) {
		r, ctx := routerFor(&mockAPI{}, NewStore(nil))
		_, err := r.EditSpec(ctx, &ProjectParams{})
		if rpcStatus(t, err) != 400 {
			t.Errorf("status = %d; want 400", rpcStatus(t, err))
		}
	})
	t.Run("returns stored spec when present", func(t *testing.T) {
		store := NewStore(openDB(t))
		stored := &stackspec.StackSpec{Name: "web", Services: []stackspec.ContainerSpec{{Name: "a", Image: "authored:1"}}}
		if err := store.Save("local", "web", stored); err != nil {
			t.Fatalf("seed: %v", err)
		}
		r, ctx := routerFor(&mockAPI{}, store) // ProjectSpec not wired: must not be called
		got, err := r.EditSpec(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("EditSpec: %v", err)
		}
		if got == nil || got.Services[0].Image != "authored:1" {
			t.Errorf("got = %+v; want the stored authored spec", got)
		}
	})
	t.Run("reconstructs from live when no stored spec", func(t *testing.T) {
		m := &mockAPI{projectSpec: func(_ context.Context, project string) (*stackspec.StackSpec, error) {
			return &stackspec.StackSpec{Name: project, Services: []stackspec.ContainerSpec{{Name: "a", Image: "live:1"}}}, nil
		}}
		r, ctx := routerFor(m, NewStore(nil)) // disabled store -> falls through to ProjectSpec
		got, err := r.EditSpec(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("EditSpec: %v", err)
		}
		if got.Services[0].Image != "live:1" {
			t.Errorf("got = %+v; want reconstructed live spec", got)
		}
	})
	t.Run("unknown project -> 404", func(t *testing.T) {
		m := &mockAPI{projectSpec: func(_ context.Context, _ string) (*stackspec.StackSpec, error) {
			return nil, errors.New("no such project")
		}}
		r, ctx := routerFor(m, NewStore(nil))
		_, err := r.EditSpec(ctx, &ProjectParams{Project: "ghost"})
		if rpcStatus(t, err) != 404 {
			t.Errorf("status = %d; want 404", rpcStatus(t, err))
		}
	})
}

// ExportCompose renders a stack's spec (stored or reconstructed) to compose YAML.
func TestExportCompose(t *testing.T) {
	t.Run("empty project -> 400", func(t *testing.T) {
		r, ctx := routerFor(&mockAPI{}, NewStore(nil))
		_, err := r.ExportCompose(ctx, &ProjectParams{})
		if rpcStatus(t, err) != 400 {
			t.Errorf("status = %d; want 400", rpcStatus(t, err))
		}
	})
	t.Run("renders stored spec to yaml", func(t *testing.T) {
		store := NewStore(openDB(t))
		spec := &stackspec.StackSpec{Name: "web", Services: []stackspec.ContainerSpec{{Name: "web", Image: "nginx:1"}}}
		if err := store.Save("local", "web", spec); err != nil {
			t.Fatalf("seed: %v", err)
		}
		r, ctx := routerFor(&mockAPI{}, store) // ProjectSpec must not be reached
		res, err := r.ExportCompose(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("ExportCompose: %v", err)
		}
		if res.Project != "web" {
			t.Errorf("project = %q; want web", res.Project)
		}
		if !strings.Contains(res.Content, "nginx:1") || !strings.Contains(res.Content, "services:") {
			t.Errorf("compose content missing expected bits:\n%s", res.Content)
		}
	})
	t.Run("falls back to live spec then 404", func(t *testing.T) {
		m := &mockAPI{projectSpec: func(_ context.Context, _ string) (*stackspec.StackSpec, error) {
			return nil, errors.New("gone")
		}}
		r, ctx := routerFor(m, NewStore(nil))
		_, err := r.ExportCompose(ctx, &ProjectParams{Project: "ghost"})
		if rpcStatus(t, err) != 404 {
			t.Errorf("status = %d; want 404", rpcStatus(t, err))
		}
	})
	t.Run("renders reconstructed live spec", func(t *testing.T) {
		m := &mockAPI{projectSpec: func(_ context.Context, project string) (*stackspec.StackSpec, error) {
			return &stackspec.StackSpec{Name: project, Services: []stackspec.ContainerSpec{{Name: "web", Image: "redis:7"}}}, nil
		}}
		r, ctx := routerFor(m, NewStore(nil))
		res, err := r.ExportCompose(ctx, &ProjectParams{Project: "cache"})
		if err != nil {
			t.Fatalf("ExportCompose: %v", err)
		}
		if !strings.Contains(res.Content, "redis:7") {
			t.Errorf("content missing live image:\n%s", res.Content)
		}
	})
}

// CreateNetwork builds a NetworkSpec from params (parsing KV options/labels),
// creates it, and returns the listing view found via findNetwork.
func TestCreateNetworkRouter(t *testing.T) {
	t.Run("empty name -> 400", func(t *testing.T) {
		r, ctx := routerFor(&mockAPI{}, NewStore(nil))
		_, err := r.CreateNetwork(ctx, &CreateNetworkParams{Name: "  "})
		if rpcStatus(t, err) != 400 {
			t.Errorf("status = %d; want 400", rpcStatus(t, err))
		}
	})
	t.Run("happy path builds spec + returns listing", func(t *testing.T) {
		var gotSpec stackspec.NetworkSpec
		m := &mockAPI{
			createNetwork: func(_ context.Context, spec stackspec.NetworkSpec) (string, error) {
				gotSpec = spec
				return "net-id", nil
			},
			networks: func(_ context.Context) ([]docker.NetworkInfo, error) {
				return []docker.NetworkInfo{{ID: "net-id", Name: "mynet", Driver: "bridge"}}, nil
			},
		}
		r, ctx := routerFor(m, NewStore(nil))
		info, err := r.CreateNetwork(ctx, &CreateNetworkParams{
			Name: "mynet", Driver: "bridge", Subnet: "10.0.0.0/24", Internal: true,
			Options: "parent=eth0", Labels: "team=core",
		})
		if err != nil {
			t.Fatalf("CreateNetwork: %v", err)
		}
		if gotSpec.Name != "mynet" || gotSpec.Driver != "bridge" || gotSpec.Subnet != "10.0.0.0/24" || !gotSpec.Internal {
			t.Errorf("spec built wrong: %+v", gotSpec)
		}
		if gotSpec.Options["parent"] != "eth0" || gotSpec.Labels["team"] != "core" {
			t.Errorf("options/labels not parsed: %+v", gotSpec)
		}
		if info == nil || info.ID != "net-id" || info.Name != "mynet" {
			t.Errorf("listing view = %+v; want the created network", info)
		}
	})
	t.Run("create error -> 500", func(t *testing.T) {
		m := &mockAPI{createNetwork: func(_ context.Context, _ stackspec.NetworkSpec) (string, error) {
			return "", errors.New("subnet overlaps")
		}}
		r, ctx := routerFor(m, NewStore(nil))
		_, err := r.CreateNetwork(ctx, &CreateNetworkParams{Name: "mynet"})
		if rpcStatus(t, err) != 500 {
			t.Errorf("status = %d; want 500", rpcStatus(t, err))
		}
	})
	t.Run("findNetwork falls back when listing fails", func(t *testing.T) {
		m := &mockAPI{
			createNetwork: func(_ context.Context, _ stackspec.NetworkSpec) (string, error) { return "id", nil },
			networks:      func(_ context.Context) ([]docker.NetworkInfo, error) { return nil, errors.New("list failed") },
		}
		r, ctx := routerFor(m, NewStore(nil))
		info, err := r.CreateNetwork(ctx, &CreateNetworkParams{Name: "mynet"})
		if err != nil {
			t.Fatalf("CreateNetwork: %v", err)
		}
		if info == nil || info.Name != "mynet" {
			t.Errorf("fallback listing = %+v; want a bare {Name: mynet}", info)
		}
	})
	t.Run("findNetwork fallback when name absent from listing", func(t *testing.T) {
		m := &mockAPI{
			createNetwork: func(_ context.Context, _ stackspec.NetworkSpec) (string, error) { return "id", nil },
			networks: func(_ context.Context) ([]docker.NetworkInfo, error) {
				return []docker.NetworkInfo{{Name: "other"}}, nil
			},
		}
		r, ctx := routerFor(m, NewStore(nil))
		info, err := r.CreateNetwork(ctx, &CreateNetworkParams{Name: "mynet"})
		if err != nil {
			t.Fatalf("CreateNetwork: %v", err)
		}
		if info.Name != "mynet" || info.ID != "" {
			t.Errorf("fallback = %+v; want bare {Name: mynet}", info)
		}
	})
}

// CreateVolume mirrors CreateNetwork: build spec, create, return findVolume view.
func TestCreateVolumeRouter(t *testing.T) {
	t.Run("empty name -> 400", func(t *testing.T) {
		r, ctx := routerFor(&mockAPI{}, NewStore(nil))
		_, err := r.CreateVolume(ctx, &CreateVolumeParams{Name: ""})
		if rpcStatus(t, err) != 400 {
			t.Errorf("status = %d; want 400", rpcStatus(t, err))
		}
	})
	t.Run("happy path builds spec + returns listing", func(t *testing.T) {
		var gotSpec stackspec.VolumeSpec
		m := &mockAPI{
			createVolume: func(_ context.Context, spec stackspec.VolumeSpec) (string, error) {
				gotSpec = spec
				return "vol", nil
			},
			volumes: func(_ context.Context) ([]docker.VolumeInfo, error) {
				return []docker.VolumeInfo{{Name: "myvol", Driver: "local"}}, nil
			},
		}
		r, ctx := routerFor(m, NewStore(nil))
		info, err := r.CreateVolume(ctx, &CreateVolumeParams{
			Name: "myvol", Driver: "local", Options: "type=nfs\ndevice=:/export", Labels: "keep=1",
		})
		if err != nil {
			t.Fatalf("CreateVolume: %v", err)
		}
		if gotSpec.Name != "myvol" || gotSpec.Driver != "local" {
			t.Errorf("spec built wrong: %+v", gotSpec)
		}
		if gotSpec.Options["type"] != "nfs" || gotSpec.Options["device"] != ":/export" || gotSpec.Labels["keep"] != "1" {
			t.Errorf("options/labels not parsed: %+v", gotSpec)
		}
		if info == nil || info.Name != "myvol" || info.Driver != "local" {
			t.Errorf("listing view = %+v; want the created volume", info)
		}
	})
	t.Run("create error -> 500", func(t *testing.T) {
		m := &mockAPI{createVolume: func(_ context.Context, _ stackspec.VolumeSpec) (string, error) {
			return "", errors.New("driver missing")
		}}
		r, ctx := routerFor(m, NewStore(nil))
		_, err := r.CreateVolume(ctx, &CreateVolumeParams{Name: "myvol"})
		if rpcStatus(t, err) != 500 {
			t.Errorf("status = %d; want 500", rpcStatus(t, err))
		}
	})
	t.Run("findVolume falls back when listing fails", func(t *testing.T) {
		m := &mockAPI{
			createVolume: func(_ context.Context, _ stackspec.VolumeSpec) (string, error) { return "v", nil },
			volumes:      func(_ context.Context) ([]docker.VolumeInfo, error) { return nil, errors.New("list failed") },
		}
		r, ctx := routerFor(m, NewStore(nil))
		info, err := r.CreateVolume(ctx, &CreateVolumeParams{Name: "myvol"})
		if err != nil {
			t.Fatalf("CreateVolume: %v", err)
		}
		if info == nil || info.Name != "myvol" {
			t.Errorf("fallback listing = %+v; want a bare {Name: myvol}", info)
		}
	})
}
