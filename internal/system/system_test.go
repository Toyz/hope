package system

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/store"
)

// mockAPI embeds docker.API (a nil interface): only the methods a test wires up
// exist; any un-overridden method promotes to the nil interface and panics if
// called — so a test that reaches an unexpected daemon call fails loudly rather
// than silently. Every override delegates to a per-test func field.
type mockAPI struct {
	docker.API
	stacks           func(ctx context.Context) ([]docker.StackSummary, error)
	allUpdates       func(ctx context.Context) ([]docker.ClusterUpdate, time.Time, error)
	refreshUpdates   func(ctx context.Context)
	images           func(ctx context.Context) ([]docker.ImageInfo, error)
	imageByRef       func(ctx context.Context, ref string) (*docker.ImageInfo, error)
	history          func(ctx context.Context, id string) ([]docker.ImageLayer, error)
	networks         func(ctx context.Context) ([]docker.NetworkInfo, error)
	volumes          func(ctx context.Context) ([]docker.VolumeInfo, error)
	info             func(ctx context.Context) (any, error)
	networkByRef     func(ctx context.Context, ref string) (*docker.NetworkInfo, error)
	removeNetwork    func(ctx context.Context, id string) error
	removeVolume     func(ctx context.Context, name string, force bool) error
	imageInUse       func(ctx context.Context, id string) (bool, []docker.ImageUser, error)
	removeImage      func(ctx context.Context, id string, force bool) error
	pruneImages      func(ctx context.Context, all bool) (docker.PruneResult, error)
	pruneBuildCache  func(ctx context.Context) (uint64, error)
	diskUsageCached  func() (any, time.Time)
	refreshDiskUsage func(ctx context.Context) (any, time.Time, error)
	registryList     func() []docker.RegistryEntry
	isConfigReg      func(server string) bool
	verifyRegistry   func(ctx context.Context, server, user, pass string) error

	// call trackers (synchronous callers only)
	refreshUpdatesCalled bool
	removeImageCalled    bool
	removeVolumeForce    bool
	addedCreds           []regCall
	removedCreds         []string
}

type regCall struct {
	server, user, pass string
	source             docker.RegistrySource
}

func (m *mockAPI) Stacks(ctx context.Context) ([]docker.StackSummary, error) { return m.stacks(ctx) }
func (m *mockAPI) AllUpdates(ctx context.Context) ([]docker.ClusterUpdate, time.Time, error) {
	return m.allUpdates(ctx)
}
func (m *mockAPI) RefreshUpdates(ctx context.Context) {
	m.refreshUpdatesCalled = true
	if m.refreshUpdates != nil {
		m.refreshUpdates(ctx)
	}
}
func (m *mockAPI) Images(ctx context.Context) ([]docker.ImageInfo, error) { return m.images(ctx) }
func (m *mockAPI) ImageByRef(ctx context.Context, ref string) (*docker.ImageInfo, error) {
	return m.imageByRef(ctx, ref)
}
func (m *mockAPI) History(ctx context.Context, id string) ([]docker.ImageLayer, error) {
	return m.history(ctx, id)
}
func (m *mockAPI) Networks(ctx context.Context) ([]docker.NetworkInfo, error) { return m.networks(ctx) }
func (m *mockAPI) Volumes(ctx context.Context) ([]docker.VolumeInfo, error)   { return m.volumes(ctx) }
func (m *mockAPI) Info(ctx context.Context) (any, error)                      { return m.info(ctx) }
func (m *mockAPI) NetworkByRef(ctx context.Context, ref string) (*docker.NetworkInfo, error) {
	return m.networkByRef(ctx, ref)
}
func (m *mockAPI) RemoveNetwork(ctx context.Context, id string) error {
	return m.removeNetwork(ctx, id)
}
func (m *mockAPI) RemoveVolume(ctx context.Context, name string, force bool) error {
	m.removeVolumeForce = force
	return m.removeVolume(ctx, name, force)
}
func (m *mockAPI) ImageInUse(ctx context.Context, id string) (bool, []docker.ImageUser, error) {
	return m.imageInUse(ctx, id)
}
func (m *mockAPI) RemoveImage(ctx context.Context, id string, force bool) error {
	m.removeImageCalled = true
	return m.removeImage(ctx, id, force)
}
func (m *mockAPI) PruneImages(ctx context.Context, all bool) (docker.PruneResult, error) {
	return m.pruneImages(ctx, all)
}
func (m *mockAPI) PruneBuildCache(ctx context.Context) (uint64, error) { return m.pruneBuildCache(ctx) }
func (m *mockAPI) DiskUsageCached() (any, time.Time)                   { return m.diskUsageCached() }
func (m *mockAPI) RefreshDiskUsage(ctx context.Context) (any, time.Time, error) {
	return m.refreshDiskUsage(ctx)
}
func (m *mockAPI) RegistryList() []docker.RegistryEntry { return m.registryList() }
func (m *mockAPI) IsConfigRegistry(server string) bool  { return m.isConfigReg(server) }
func (m *mockAPI) VerifyRegistry(ctx context.Context, server, user, pass string) error {
	return m.verifyRegistry(ctx, server, user, pass)
}
func (m *mockAPI) AddRegistryCreds(server, user, pass string, source docker.RegistrySource) {
	m.addedCreds = append(m.addedCreds, regCall{server, user, pass, source})
}
func (m *mockAPI) RemoveRegistryCreds(server string) bool {
	m.removedCreds = append(m.removedCreds, server)
	return true
}

// --- helpers ---------------------------------------------------------------

// newRouter wires a router over a local-only host set (reg=nil): ActiveFor
// resolves to m, and All() yields a single-host [{local, m}] fan-out.
func newRouter(m docker.API, localUp bool, apiEnabled, pluginsOn bool, st *store.Store) *SystemRouter {
	return NewSystemRouter(hosts.New(m, localUp, nil), "tok", "/agent/ws", apiEnabled, pluginsOn, st, m)
}

// ctxLocal builds an rpc.Context whose per-request target is the local host so
// dock(ctx)=ActiveFor(ctx) resolves to the mock.
func ctxLocal() *rpc.Context {
	return rpc.NewContext(hosts.WithTarget(context.Background(), hosts.LocalID))
}

func disabledStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open("")
	if err != nil {
		t.Fatalf("open disabled store: %v", err)
	}
	return st
}

func realStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	st.SetSecret("test-secret")
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// wantErr asserts err is an *rpc.Error carrying the given Code.
func wantErr(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want *rpc.Error %s, got nil", code)
	}
	var re *rpc.Error
	if !errors.As(err, &re) {
		t.Fatalf("want *rpc.Error, got %T: %v", err, err)
	}
	if re.Code != code {
		t.Errorf("error code = %q; want %q (msg: %s)", re.Code, code, re.Message)
	}
}

var errBoom = errors.New("boom")

// --- flags / enrollment / hosts (no daemon) --------------------------------

func TestFeatures(t *testing.T) {
	tests := []struct {
		name                string
		apiEnabled, plugins bool
		st                  func(*testing.T) *store.Store
		wantAPI, wantStore  bool
		wantPlugins         bool
	}{
		{"all off, store disabled", false, false, disabledStore, false, false, false},
		{"api+plugins on, store disabled", true, true, disabledStore, true, false, true},
		{"store enabled", false, false, realStore, false, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRouter(&mockAPI{}, true, tt.apiEnabled, tt.plugins, tt.st(t))
			got, err := r.Features(ctxLocal())
			if err != nil {
				t.Fatalf("Features: %v", err)
			}
			if got.APIEnabled != tt.wantAPI || got.PluginsEnabled != tt.wantPlugins || got.StoreEnabled != tt.wantStore {
				t.Errorf("Features = %+v; want api=%v plugins=%v store=%v", got, tt.wantAPI, tt.wantPlugins, tt.wantStore)
			}
			if got.StoreEphemeral {
				t.Errorf("StoreEphemeral = true; want false (native/temp file is not ephemeral)")
			}
		})
	}
}

func TestAgentEnroll(t *testing.T) {
	tests := []struct {
		name        string
		token, path string
		wantEnabled bool
		wantPath    string
	}{
		{"token + custom path", "secret", "/custom/ws", true, "/custom/ws"},
		{"empty token, default path", "", "", false, "/agent/connect"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewSystemRouter(hosts.New(&mockAPI{}, true, nil), tt.token, tt.path, false, false, disabledStore(t), &mockAPI{})
			got, err := r.AgentEnroll(ctxLocal())
			if err != nil {
				t.Fatalf("AgentEnroll: %v", err)
			}
			if got.Enabled != tt.wantEnabled || got.Token != tt.token || got.WSPath != tt.wantPath {
				t.Errorf("AgentEnroll = %+v; want enabled=%v token=%q ws=%q", got, tt.wantEnabled, tt.token, tt.wantPath)
			}
		})
	}
}

func TestHosts(t *testing.T) {
	r := newRouter(&mockAPI{}, true, false, false, disabledStore(t))
	got, err := r.Hosts(ctxLocal())
	if err != nil {
		t.Fatalf("Hosts: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("Hosts len = %d; want 1 (local only)", len(got))
	}
	h := got[0]
	if h.ID != hosts.LocalID || h.Kind != "local" || !h.Connected || !h.Active {
		t.Errorf("Hosts[0] = %+v; want local/active/connected", h)
	}
}

func TestSetActiveHost(t *testing.T) {
	t.Run("local resolves", func(t *testing.T) {
		r := newRouter(&mockAPI{}, true, false, false, disabledStore(t))
		res, err := r.SetActiveHost(ctxLocal(), &SetActiveHostParams{ID: hosts.LocalID})
		if err != nil {
			t.Fatalf("SetActiveHost: %v", err)
		}
		if m, ok := res.(map[string]string); !ok || m["active"] != hosts.LocalID {
			t.Errorf("SetActiveHost = %v; want {active: local}", res)
		}
	})
	t.Run("unknown host -> BadRequest", func(t *testing.T) {
		r := newRouter(&mockAPI{}, true, false, false, disabledStore(t))
		_, err := r.SetActiveHost(ctxLocal(), &SetActiveHostParams{ID: "ghost"})
		wantErr(t, err, "BAD_REQUEST")
	})
}

// --- Info / Updates --------------------------------------------------------

func TestInfo(t *testing.T) {
	t.Run("happy", func(t *testing.T) {
		want := map[string]any{"ServerVersion": "27.0"}
		r := newRouter(&mockAPI{info: func(context.Context) (any, error) { return want, nil }}, true, false, false, disabledStore(t))
		got, err := r.Info(ctxLocal())
		if err != nil {
			t.Fatalf("Info: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Info = %v; want %v", got, want)
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		r := newRouter(&mockAPI{info: func(context.Context) (any, error) { return nil, errBoom }}, true, false, false, disabledStore(t))
		_, err := r.Info(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

func TestUpdates(t *testing.T) {
	at := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	ups := []docker.ClusterUpdate{
		{ID: "a", Status: "outdated"},
		{ID: "b", Status: "current"},
		{ID: "c", Status: "outdated"},
	}
	t.Run("happy aggregates outdated count", func(t *testing.T) {
		r := newRouter(&mockAPI{allUpdates: func(context.Context) ([]docker.ClusterUpdate, time.Time, error) {
			return ups, at, nil
		}}, true, false, false, disabledStore(t))
		got, err := r.Updates(ctxLocal())
		if err != nil {
			t.Fatalf("Updates: %v", err)
		}
		if got.Outdated != 2 {
			t.Errorf("Outdated = %d; want 2", got.Outdated)
		}
		if len(got.Updates) != 3 {
			t.Errorf("Updates len = %d; want 3 (all rows returned)", len(got.Updates))
		}
		if got.CheckedAt != stamp(at) {
			t.Errorf("CheckedAt = %q; want %q", got.CheckedAt, stamp(at))
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		r := newRouter(&mockAPI{allUpdates: func(context.Context) ([]docker.ClusterUpdate, time.Time, error) {
			return nil, time.Time{}, errBoom
		}}, true, false, false, disabledStore(t))
		_, err := r.Updates(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

func TestRefreshUpdates(t *testing.T) {
	at := time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)
	t.Run("triggers crawl then reports", func(t *testing.T) {
		m := &mockAPI{allUpdates: func(context.Context) ([]docker.ClusterUpdate, time.Time, error) {
			return []docker.ClusterUpdate{{Status: "outdated"}}, at, nil
		}}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.RefreshUpdates(ctxLocal())
		if err != nil {
			t.Fatalf("RefreshUpdates: %v", err)
		}
		if !m.refreshUpdatesCalled {
			t.Error("RefreshUpdates did not trigger a daemon recrawl")
		}
		if got.Outdated != 1 {
			t.Errorf("Outdated = %d; want 1", got.Outdated)
		}
	})
	t.Run("collect error -> Internal", func(t *testing.T) {
		m := &mockAPI{allUpdates: func(context.Context) ([]docker.ClusterUpdate, time.Time, error) {
			return nil, time.Time{}, errBoom
		}}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.RefreshUpdates(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

// --- Fleet fan-out ---------------------------------------------------------

func TestFleet(t *testing.T) {
	at := time.Date(2026, 7, 3, 8, 0, 0, 0, time.UTC)
	stacks := []docker.StackSummary{{Project: "web", Total: 2, Running: 2}}
	ups := []docker.ClusterUpdate{{ID: "x", Status: "outdated"}, {ID: "y", Status: "current"}}

	t.Run("single-host fan-out aggregates", func(t *testing.T) {
		m := &mockAPI{
			stacks:     func(context.Context) ([]docker.StackSummary, error) { return stacks, nil },
			allUpdates: func(context.Context) ([]docker.ClusterUpdate, time.Time, error) { return ups, at, nil },
		}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.Fleet(ctxLocal())
		if err != nil {
			t.Fatalf("Fleet: %v", err)
		}
		if len(got) != 1 {
			t.Fatalf("Fleet len = %d; want 1", len(got))
		}
		h := got[0]
		if h.ID != hosts.LocalID || h.Kind != "local" || !h.Online {
			t.Errorf("host meta = %+v; want local/online", h)
		}
		if !reflect.DeepEqual(h.Stacks, stacks) {
			t.Errorf("Stacks = %+v; want %+v", h.Stacks, stacks)
		}
		if h.Outdated != 1 || len(h.Updates) != 1 || h.Updates[0].ID != "x" {
			t.Errorf("Updates = %+v (outdated %d); want only the outdated row 'x'", h.Updates, h.Outdated)
		}
		if h.CheckedAt != stamp(at) {
			t.Errorf("CheckedAt = %q; want %q", h.CheckedAt, stamp(at))
		}
	})

	t.Run("host error returns offline with message", func(t *testing.T) {
		m := &mockAPI{
			stacks:     func(context.Context) ([]docker.StackSummary, error) { return nil, errBoom },
			allUpdates: func(context.Context) ([]docker.ClusterUpdate, time.Time, error) { return nil, time.Time{}, nil },
		}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.Fleet(ctxLocal())
		if err != nil {
			t.Fatalf("Fleet: %v", err)
		}
		if got[0].Online || got[0].Error != "boom" {
			t.Errorf("host = %+v; want offline with error 'boom'", got[0])
		}
		if len(got[0].Stacks) != 0 {
			t.Errorf("Stacks = %+v; want empty on error", got[0].Stacks)
		}
	})

	t.Run("offline host skipped (daemon never queried)", func(t *testing.T) {
		// localUp=false -> All() marks the host offline -> collectFleet skips it.
		// The mock's Stacks/AllUpdates are nil, so a stray call would panic.
		r := newRouter(&mockAPI{}, false, false, false, disabledStore(t))
		got, err := r.Fleet(ctxLocal())
		if err != nil {
			t.Fatalf("Fleet: %v", err)
		}
		if len(got) != 1 || got[0].Online {
			t.Fatalf("got %+v; want a single offline host", got)
		}
		if got[0].Stacks == nil || len(got[0].Stacks) != 0 {
			t.Errorf("Stacks = %+v; want non-nil empty slice", got[0].Stacks)
		}
	})
}

func TestRefreshFleetUpdates(t *testing.T) {
	m := &mockAPI{
		stacks:     func(context.Context) ([]docker.StackSummary, error) { return []docker.StackSummary{}, nil },
		allUpdates: func(context.Context) ([]docker.ClusterUpdate, time.Time, error) { return nil, time.Time{}, nil },
	}
	r := newRouter(m, true, false, false, disabledStore(t))
	if _, err := r.RefreshFleetUpdates(ctxLocal()); err != nil {
		t.Fatalf("RefreshFleetUpdates: %v", err)
	}
	if !m.refreshUpdatesCalled {
		t.Error("RefreshFleetUpdates did not force a per-host recrawl")
	}
}

func TestFleetImages(t *testing.T) {
	imgs := []docker.ImageInfo{{ID: "img1", Size: 10}}
	t.Run("happy", func(t *testing.T) {
		m := &mockAPI{images: func(context.Context) ([]docker.ImageInfo, error) { return imgs, nil }}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.FleetImages(ctxLocal())
		if err != nil {
			t.Fatalf("FleetImages: %v", err)
		}
		if len(got) != 1 || !reflect.DeepEqual(got[0].Images, imgs) {
			t.Errorf("FleetImages = %+v; want images %+v", got, imgs)
		}
	})
	t.Run("error -> offline", func(t *testing.T) {
		m := &mockAPI{images: func(context.Context) ([]docker.ImageInfo, error) { return nil, errBoom }}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.FleetImages(ctxLocal())
		if err != nil {
			t.Fatalf("FleetImages: %v", err)
		}
		if got[0].Online || got[0].Error != "boom" {
			t.Errorf("host = %+v; want offline with 'boom'", got[0])
		}
	})
}

func TestFleetNetworks(t *testing.T) {
	nets := []docker.NetworkInfo{{ID: "n1", Name: "web"}}
	t.Run("happy", func(t *testing.T) {
		m := &mockAPI{networks: func(context.Context) ([]docker.NetworkInfo, error) { return nets, nil }}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.FleetNetworks(ctxLocal())
		if err != nil {
			t.Fatalf("FleetNetworks: %v", err)
		}
		if len(got) != 1 || !reflect.DeepEqual(got[0].Networks, nets) {
			t.Errorf("FleetNetworks = %+v; want %+v", got, nets)
		}
	})
	t.Run("error -> offline", func(t *testing.T) {
		m := &mockAPI{networks: func(context.Context) ([]docker.NetworkInfo, error) { return nil, errBoom }}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, _ := r.FleetNetworks(ctxLocal())
		if got[0].Online || got[0].Error != "boom" {
			t.Errorf("host = %+v; want offline with 'boom'", got[0])
		}
	})
}

func TestFleetVolumes(t *testing.T) {
	vols := []docker.VolumeInfo{{Name: "data"}}
	t.Run("happy", func(t *testing.T) {
		m := &mockAPI{volumes: func(context.Context) ([]docker.VolumeInfo, error) { return vols, nil }}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.FleetVolumes(ctxLocal())
		if err != nil {
			t.Fatalf("FleetVolumes: %v", err)
		}
		if len(got) != 1 || !reflect.DeepEqual(got[0].Volumes, vols) {
			t.Errorf("FleetVolumes = %+v; want %+v", got, vols)
		}
	})
	t.Run("error -> offline", func(t *testing.T) {
		m := &mockAPI{volumes: func(context.Context) ([]docker.VolumeInfo, error) { return nil, errBoom }}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, _ := r.FleetVolumes(ctxLocal())
		if got[0].Online || got[0].Error != "boom" {
			t.Errorf("host = %+v; want offline with 'boom'", got[0])
		}
	})
}

// --- Images ----------------------------------------------------------------

func TestImages(t *testing.T) {
	imgs := []docker.ImageInfo{{ID: "img"}}
	t.Run("happy", func(t *testing.T) {
		r := newRouter(&mockAPI{images: func(context.Context) ([]docker.ImageInfo, error) { return imgs, nil }}, true, false, false, disabledStore(t))
		got, err := r.Images(ctxLocal())
		if err != nil {
			t.Fatalf("Images: %v", err)
		}
		if !reflect.DeepEqual(got, imgs) {
			t.Errorf("Images = %+v; want %+v", got, imgs)
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		r := newRouter(&mockAPI{images: func(context.Context) ([]docker.ImageInfo, error) { return nil, errBoom }}, true, false, false, disabledStore(t))
		_, err := r.Images(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

func TestImage(t *testing.T) {
	im := &docker.ImageInfo{ID: "img", Tags: []string{"web:1"}}
	t.Run("happy", func(t *testing.T) {
		r := newRouter(&mockAPI{imageByRef: func(_ context.Context, ref string) (*docker.ImageInfo, error) {
			if ref != "web:1" {
				t.Errorf("ref = %q; want web:1", ref)
			}
			return im, nil
		}}, true, false, false, disabledStore(t))
		got, err := r.Image(ctxLocal(), &IDParam{ID: "web:1"})
		if err != nil {
			t.Fatalf("Image: %v", err)
		}
		if got != im {
			t.Errorf("Image = %+v; want %+v", got, im)
		}
	})
	t.Run("not found -> BadRequest", func(t *testing.T) {
		r := newRouter(&mockAPI{imageByRef: func(context.Context, string) (*docker.ImageInfo, error) { return nil, nil }}, true, false, false, disabledStore(t))
		_, err := r.Image(ctxLocal(), &IDParam{ID: "nope"})
		wantErr(t, err, "BAD_REQUEST")
	})
	t.Run("error -> Internal", func(t *testing.T) {
		r := newRouter(&mockAPI{imageByRef: func(context.Context, string) (*docker.ImageInfo, error) { return nil, errBoom }}, true, false, false, disabledStore(t))
		_, err := r.Image(ctxLocal(), &IDParam{ID: "x"})
		wantErr(t, err, "INTERNAL")
	})
}

func TestImageHistory(t *testing.T) {
	layers := []docker.ImageLayer{{ID: "l1", Size: 100}}
	t.Run("happy", func(t *testing.T) {
		r := newRouter(&mockAPI{history: func(context.Context, string) ([]docker.ImageLayer, error) { return layers, nil }}, true, false, false, disabledStore(t))
		got, err := r.ImageHistory(ctxLocal(), &IDParam{ID: "img"})
		if err != nil {
			t.Fatalf("ImageHistory: %v", err)
		}
		if !reflect.DeepEqual(got, layers) {
			t.Errorf("ImageHistory = %+v; want %+v", got, layers)
		}
	})
	t.Run("error -> BadRequest", func(t *testing.T) {
		r := newRouter(&mockAPI{history: func(context.Context, string) ([]docker.ImageLayer, error) { return nil, errBoom }}, true, false, false, disabledStore(t))
		_, err := r.ImageHistory(ctxLocal(), &IDParam{ID: "img"})
		wantErr(t, err, "BAD_REQUEST")
	})
}

func TestRemoveImage(t *testing.T) {
	t.Run("in use -> BadRequest, daemon remove not reached", func(t *testing.T) {
		m := &mockAPI{
			imageInUse: func(context.Context, string) (bool, []docker.ImageUser, error) {
				return true, []docker.ImageUser{{ID: "c1"}}, nil
			},
			removeImage: func(context.Context, string, bool) error { return nil },
		}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.RemoveImage(ctxLocal(), &ImageRemoveParams{ID: "img"})
		wantErr(t, err, "BAD_REQUEST")
		if m.removeImageCalled {
			t.Error("RemoveImage reached the daemon for an in-use image; must refuse first")
		}
	})
	t.Run("not in use -> removes (force passed through)", func(t *testing.T) {
		var gotForce bool
		m := &mockAPI{
			imageInUse:  func(context.Context, string) (bool, []docker.ImageUser, error) { return false, nil, nil },
			removeImage: func(_ context.Context, _ string, force bool) error { gotForce = force; return nil },
		}
		r := newRouter(m, true, false, false, disabledStore(t))
		res, err := r.RemoveImage(ctxLocal(), &ImageRemoveParams{ID: "img", Force: true})
		if err != nil {
			t.Fatalf("RemoveImage: %v", err)
		}
		if m, ok := res.(map[string]bool); !ok || !m["ok"] {
			t.Errorf("RemoveImage = %v; want {ok:true}", res)
		}
		if !gotForce {
			t.Error("Force flag not forwarded to daemon RemoveImage")
		}
	})
	t.Run("inuse-check errors -> falls through to remove", func(t *testing.T) {
		// ImageInUse error means the `err==nil && inUse` guard is false, so removal
		// proceeds rather than blocking.
		m := &mockAPI{
			imageInUse:  func(context.Context, string) (bool, []docker.ImageUser, error) { return false, nil, errBoom },
			removeImage: func(context.Context, string, bool) error { return nil },
		}
		r := newRouter(m, true, false, false, disabledStore(t))
		if _, err := r.RemoveImage(ctxLocal(), &ImageRemoveParams{ID: "img"}); err != nil {
			t.Fatalf("RemoveImage: %v", err)
		}
		if !m.removeImageCalled {
			t.Error("expected removal to proceed when the in-use probe errors")
		}
	})
	t.Run("daemon remove error -> BadRequest", func(t *testing.T) {
		m := &mockAPI{
			imageInUse:  func(context.Context, string) (bool, []docker.ImageUser, error) { return false, nil, nil },
			removeImage: func(context.Context, string, bool) error { return errBoom },
		}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.RemoveImage(ctxLocal(), &ImageRemoveParams{ID: "img"})
		wantErr(t, err, "BAD_REQUEST")
	})
}

func TestPruneImages(t *testing.T) {
	t.Run("happy forwards scope", func(t *testing.T) {
		var gotAll bool
		m := &mockAPI{pruneImages: func(_ context.Context, all bool) (docker.PruneResult, error) {
			gotAll = all
			return docker.PruneResult{Deleted: 3, Reclaimed: 999}, nil
		}}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.PruneImages(ctxLocal(), &PruneParams{All: true})
		if err != nil {
			t.Fatalf("PruneImages: %v", err)
		}
		if !gotAll {
			t.Error("All scope not forwarded")
		}
		if got.Deleted != 3 || got.Reclaimed != 999 {
			t.Errorf("PruneImages = %+v; want deleted=3 reclaimed=999", got)
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		m := &mockAPI{pruneImages: func(context.Context, bool) (docker.PruneResult, error) { return docker.PruneResult{}, errBoom }}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.PruneImages(ctxLocal(), &PruneParams{})
		wantErr(t, err, "INTERNAL")
	})
}

func TestPruneBuildCache(t *testing.T) {
	t.Run("happy reports reclaimed", func(t *testing.T) {
		m := &mockAPI{pruneBuildCache: func(context.Context) (uint64, error) { return 4096, nil }}
		r := newRouter(m, true, false, false, disabledStore(t))
		res, err := r.PruneBuildCache(ctxLocal())
		if err != nil {
			t.Fatalf("PruneBuildCache: %v", err)
		}
		mp, ok := res.(map[string]any)
		if !ok || mp["ok"] != true || mp["reclaimed"] != uint64(4096) {
			t.Errorf("PruneBuildCache = %v; want {ok:true, reclaimed:4096}", res)
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		m := &mockAPI{pruneBuildCache: func(context.Context) (uint64, error) { return 0, errBoom }}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.PruneBuildCache(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

// --- Networks / Volumes ----------------------------------------------------

func TestNetworks(t *testing.T) {
	nets := []docker.NetworkInfo{{ID: "n1", Name: "web"}}
	t.Run("happy", func(t *testing.T) {
		r := newRouter(&mockAPI{networks: func(context.Context) ([]docker.NetworkInfo, error) { return nets, nil }}, true, false, false, disabledStore(t))
		got, err := r.Networks(ctxLocal())
		if err != nil {
			t.Fatalf("Networks: %v", err)
		}
		if !reflect.DeepEqual(got, nets) {
			t.Errorf("Networks = %+v; want %+v", got, nets)
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		r := newRouter(&mockAPI{networks: func(context.Context) ([]docker.NetworkInfo, error) { return nil, errBoom }}, true, false, false, disabledStore(t))
		_, err := r.Networks(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

func TestVolumes(t *testing.T) {
	vols := []docker.VolumeInfo{{Name: "data"}}
	t.Run("happy", func(t *testing.T) {
		r := newRouter(&mockAPI{volumes: func(context.Context) ([]docker.VolumeInfo, error) { return vols, nil }}, true, false, false, disabledStore(t))
		got, err := r.Volumes(ctxLocal())
		if err != nil {
			t.Fatalf("Volumes: %v", err)
		}
		if !reflect.DeepEqual(got, vols) {
			t.Errorf("Volumes = %+v; want %+v", got, vols)
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		r := newRouter(&mockAPI{volumes: func(context.Context) ([]docker.VolumeInfo, error) { return nil, errBoom }}, true, false, false, disabledStore(t))
		_, err := r.Volumes(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

func TestNetwork(t *testing.T) {
	n := &docker.NetworkInfo{ID: "n1", Name: "web"}
	t.Run("happy", func(t *testing.T) {
		r := newRouter(&mockAPI{networkByRef: func(context.Context, string) (*docker.NetworkInfo, error) { return n, nil }}, true, false, false, disabledStore(t))
		got, err := r.Network(ctxLocal(), &IDParam{ID: "web"})
		if err != nil {
			t.Fatalf("Network: %v", err)
		}
		if got != n {
			t.Errorf("Network = %+v; want %+v", got, n)
		}
	})
	t.Run("not found -> BadRequest", func(t *testing.T) {
		r := newRouter(&mockAPI{networkByRef: func(context.Context, string) (*docker.NetworkInfo, error) { return nil, nil }}, true, false, false, disabledStore(t))
		_, err := r.Network(ctxLocal(), &IDParam{ID: "nope"})
		wantErr(t, err, "BAD_REQUEST")
	})
	t.Run("error -> Internal", func(t *testing.T) {
		r := newRouter(&mockAPI{networkByRef: func(context.Context, string) (*docker.NetworkInfo, error) { return nil, errBoom }}, true, false, false, disabledStore(t))
		_, err := r.Network(ctxLocal(), &IDParam{ID: "x"})
		wantErr(t, err, "INTERNAL")
	})
}

// TestRemoveNetwork covers system.go's delegation to the daemon. The protected-
// network *guard itself* lives in docker.Client.RemoveNetwork (proven by
// docker.TestRemoveNetworkProtection / TestProtectedNetwork); at the system
// layer the guard surfaces as an error from the client, which this asserts is
// relayed as a BadRequest. Ordinary networks delete cleanly.
func TestRemoveNetwork(t *testing.T) {
	t.Run("ordinary network deletes", func(t *testing.T) {
		var gotID string
		m := &mockAPI{removeNetwork: func(_ context.Context, id string) error { gotID = id; return nil }}
		r := newRouter(m, true, false, false, disabledStore(t))
		res, err := r.RemoveNetwork(ctxLocal(), &IDParam{ID: "my-app_default"})
		if err != nil {
			t.Fatalf("RemoveNetwork: %v", err)
		}
		if mp, ok := res.(map[string]bool); !ok || !mp["ok"] {
			t.Errorf("RemoveNetwork = %v; want {ok:true}", res)
		}
		if gotID != "my-app_default" {
			t.Errorf("removed id = %q; want my-app_default", gotID)
		}
	})
	t.Run("protected network refusal surfaces as BadRequest", func(t *testing.T) {
		m := &mockAPI{removeNetwork: func(context.Context, string) error {
			return errors.New(`network "ink-plugins" is protected by hope and can't be removed`)
		}}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.RemoveNetwork(ctxLocal(), &IDParam{ID: "ink-plugins"})
		wantErr(t, err, "BAD_REQUEST")
	})
}

func TestRemoveVolume(t *testing.T) {
	t.Run("happy force-removes", func(t *testing.T) {
		m := &mockAPI{removeVolume: func(context.Context, string, bool) error { return nil }}
		r := newRouter(m, true, false, false, disabledStore(t))
		res, err := r.RemoveVolume(ctxLocal(), &IDParam{ID: "data"})
		if err != nil {
			t.Fatalf("RemoveVolume: %v", err)
		}
		if mp, ok := res.(map[string]bool); !ok || !mp["ok"] {
			t.Errorf("RemoveVolume = %v; want {ok:true}", res)
		}
		if !m.removeVolumeForce {
			t.Error("RemoveVolume should force-remove (force=true)")
		}
	})
	t.Run("error -> BadRequest", func(t *testing.T) {
		m := &mockAPI{removeVolume: func(context.Context, string, bool) error { return errBoom }}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.RemoveVolume(ctxLocal(), &IDParam{ID: "data"})
		wantErr(t, err, "BAD_REQUEST")
	})
}

// --- Disk usage ------------------------------------------------------------

func TestDiskUsage(t *testing.T) {
	at := time.Date(2026, 7, 4, 6, 0, 0, 0, time.UTC)
	usage := map[string]any{"LayersSize": int64(123)}
	m := &mockAPI{diskUsageCached: func() (any, time.Time) { return usage, at }}
	r := newRouter(m, true, false, false, disabledStore(t))
	got, err := r.DiskUsage(ctxLocal())
	if err != nil {
		t.Fatalf("DiskUsage: %v", err)
	}
	if !reflect.DeepEqual(got.Usage, usage) || got.CheckedAt != stamp(at) {
		t.Errorf("DiskUsage = %+v; want usage %+v at %q", got, usage, stamp(at))
	}
}

func TestRefreshDiskUsage(t *testing.T) {
	at := time.Date(2026, 7, 5, 6, 0, 0, 0, time.UTC)
	usage := map[string]any{"LayersSize": int64(456)}
	t.Run("happy", func(t *testing.T) {
		m := &mockAPI{refreshDiskUsage: func(context.Context) (any, time.Time, error) { return usage, at, nil }}
		r := newRouter(m, true, false, false, disabledStore(t))
		got, err := r.RefreshDiskUsage(ctxLocal())
		if err != nil {
			t.Fatalf("RefreshDiskUsage: %v", err)
		}
		if !reflect.DeepEqual(got.Usage, usage) || got.CheckedAt != stamp(at) {
			t.Errorf("RefreshDiskUsage = %+v; want usage %+v at %q", got, usage, stamp(at))
		}
	})
	t.Run("error -> Internal", func(t *testing.T) {
		m := &mockAPI{refreshDiskUsage: func(context.Context) (any, time.Time, error) { return nil, time.Time{}, errBoom }}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.RefreshDiskUsage(ctxLocal())
		wantErr(t, err, "INTERNAL")
	})
}

// --- Registries ------------------------------------------------------------

func TestRegistries(t *testing.T) {
	entries := []docker.RegistryEntry{
		{Server: "ghcr.io", Username: "cfg", HasPassword: true, Source: docker.RegistrySourceConfig},
		{Server: "docker.io", Username: "usr", HasPassword: true, Source: docker.RegistrySourceDB},
	}
	m := &mockAPI{registryList: func() []docker.RegistryEntry { return entries }}
	r := newRouter(m, true, false, false, disabledStore(t))
	got, err := r.Registries(ctxLocal())
	if err != nil {
		t.Fatalf("Registries: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("Registries len = %d; want 2", len(got))
	}
	// config source is read-only; db source is editable.
	if got[0].Source != "config" || got[0].Editable {
		t.Errorf("config entry = %+v; want source=config editable=false", got[0])
	}
	if got[1].Source != "db" || !got[1].Editable {
		t.Errorf("db entry = %+v; want source=db editable=true", got[1])
	}
}

func TestAddRegistry(t *testing.T) {
	t.Run("config registry rejected before verify", func(t *testing.T) {
		m := &mockAPI{isConfigReg: func(string) bool { return true }} // verifyRegistry nil: must not be reached
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.AddRegistry(ctxLocal(), &AddRegistryParams{Server: "ghcr.io", Username: "u", Password: "p"})
		wantErr(t, err, "BAD_REQUEST")
		if len(m.addedCreds) != 0 {
			t.Error("config registry must not apply creds")
		}
	})
	t.Run("verify failure -> BadRequest", func(t *testing.T) {
		m := &mockAPI{
			isConfigReg:    func(string) bool { return false },
			verifyRegistry: func(context.Context, string, string, string) error { return errBoom },
		}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.AddRegistry(ctxLocal(), &AddRegistryParams{Server: "docker.io", Username: "u", Password: "bad"})
		wantErr(t, err, "BAD_REQUEST")
		if len(m.addedCreds) != 0 {
			t.Error("failed verify must not apply creds")
		}
	})
	t.Run("happy applies creds; persisted reflects store", func(t *testing.T) {
		tests := []struct {
			name          string
			st            func(*testing.T) *store.Store
			wantPersisted bool
		}{
			{"disabled store -> session only", disabledStore, false},
			{"real store -> persisted", realStore, true},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				m := &mockAPI{
					isConfigReg:    func(string) bool { return false },
					verifyRegistry: func(context.Context, string, string, string) error { return nil },
				}
				r := newRouter(m, true, false, false, tt.st(t))
				res, err := r.AddRegistry(ctxLocal(), &AddRegistryParams{Server: "docker.io", Username: "u", Password: "p"})
				if err != nil {
					t.Fatalf("AddRegistry: %v", err)
				}
				mp, ok := res.(map[string]any)
				if !ok || mp["ok"] != true || mp["persisted"] != tt.wantPersisted {
					t.Errorf("AddRegistry = %v; want {ok:true, persisted:%v}", res, tt.wantPersisted)
				}
				if len(m.addedCreds) != 1 {
					t.Fatalf("addedCreds = %d; want 1 (applied fleet-wide)", len(m.addedCreds))
				}
				c := m.addedCreds[0]
				if c.server != "docker.io" || c.user != "u" || c.pass != "p" || c.source != docker.RegistrySourceDB {
					t.Errorf("applied creds = %+v; want docker.io/u/p/db", c)
				}
			})
		}
	})
}

func TestRemoveRegistry(t *testing.T) {
	t.Run("config registry rejected", func(t *testing.T) {
		m := &mockAPI{isConfigReg: func(string) bool { return true }}
		r := newRouter(m, true, false, false, disabledStore(t))
		_, err := r.RemoveRegistry(ctxLocal(), &IDParam{ID: "ghcr.io"})
		wantErr(t, err, "BAD_REQUEST")
		if len(m.removedCreds) != 0 {
			t.Error("config registry must not touch live creds")
		}
	})
	t.Run("happy removes fleet-wide", func(t *testing.T) {
		m := &mockAPI{isConfigReg: func(string) bool { return false }}
		r := newRouter(m, true, false, false, realStore(t))
		res, err := r.RemoveRegistry(ctxLocal(), &IDParam{ID: "docker.io"})
		if err != nil {
			t.Fatalf("RemoveRegistry: %v", err)
		}
		if mp, ok := res.(map[string]bool); !ok || !mp["ok"] {
			t.Errorf("RemoveRegistry = %v; want {ok:true}", res)
		}
		if len(m.removedCreds) != 1 || m.removedCreds[0] != "docker.io" {
			t.Errorf("removedCreds = %v; want [docker.io]", m.removedCreds)
		}
	})
}

// --- Agents (store-backed, offline roster) ---------------------------------

// With reg=nil there are no connected agents, so AgentHosts() is empty and only
// the persisted (offline) roster is folded in. The live-agent branch needs a
// connected agent registry and is exercised via integration, not here.
func TestAgents(t *testing.T) {
	t.Run("disabled store -> empty", func(t *testing.T) {
		r := newRouter(&mockAPI{}, true, false, false, disabledStore(t))
		got, err := r.Agents(ctxLocal())
		if err != nil {
			t.Fatalf("Agents: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("Agents = %+v; want empty", got)
		}
	})
	t.Run("folds known offline agents from roster", func(t *testing.T) {
		st := realStore(t)
		seen := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
		if err := st.PutAgent(store.AgentRecord{ID: "a1", Remote: "1.2.3.4", Version: "1.0", LastSeen: seen}); err != nil {
			t.Fatalf("PutAgent: %v", err)
		}
		if err := st.PutAgent(store.AgentRecord{ID: "a2", Remote: "5.6.7.8", Version: "2.0", LastSeen: seen}); err != nil {
			t.Fatalf("PutAgent: %v", err)
		}
		r := newRouter(&mockAPI{}, true, false, false, st)
		got, err := r.Agents(ctxLocal())
		if err != nil {
			t.Fatalf("Agents: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("Agents len = %d; want 2", len(got))
		}
		for _, a := range got {
			if a.Online {
				t.Errorf("agent %s Online=true; want false (offline roster)", a.ID)
			}
			if a.LastSeen != stamp(seen) {
				t.Errorf("agent %s LastSeen = %q; want %q", a.ID, a.LastSeen, stamp(seen))
			}
		}
	})
}

// ForgetAgent's "reject while online" branch needs a connected agent (registry);
// here reg=nil so no host is online and the delete path runs.
func TestForgetAgent(t *testing.T) {
	st := realStore(t)
	if err := st.PutAgent(store.AgentRecord{ID: "a1", Remote: "1.2.3.4"}); err != nil {
		t.Fatalf("PutAgent: %v", err)
	}
	r := newRouter(&mockAPI{}, true, false, false, st)
	res, err := r.ForgetAgent(ctxLocal(), &IDParam{ID: "a1"})
	if err != nil {
		t.Fatalf("ForgetAgent: %v", err)
	}
	if mp, ok := res.(map[string]bool); !ok || !mp["ok"] {
		t.Errorf("ForgetAgent = %v; want {ok:true}", res)
	}
	if recs, _ := st.Agents(); len(recs) != 0 {
		t.Errorf("roster after forget = %+v; want empty", recs)
	}
}

// --- stamp helper ----------------------------------------------------------

func TestStamp(t *testing.T) {
	if got := stamp(time.Time{}); got != "" {
		t.Errorf("stamp(zero) = %q; want empty", got)
	}
	at := time.Date(2026, 7, 6, 15, 4, 5, 0, time.UTC)
	if got := stamp(at); got != "2026-07-06T15:04:05Z" {
		t.Errorf("stamp = %q; want RFC3339 UTC", got)
	}
}
