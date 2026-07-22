package containers

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/stackspec"
)

// mockAPI embeds docker.API (a nil interface) so only the methods a test wires
// exist; every other method is promoted from the nil interface and panics if
// called. Each overridden method carries a nil-guard that fails the test with a
// clear message when the router reaches the daemon on a path it should not.
type mockAPI struct {
	docker.API
	t *testing.T

	inspect         func(ctx context.Context, id string) (any, error)
	top             func(ctx context.Context, id string) (docker.TopResult, error)
	containerSpecOf func(ctx context.Context, id string) (*stackspec.ContainerSpec, error)
	start           func(ctx context.Context, id string) error
	stop            func(ctx context.Context, id string) error
	restart         func(ctx context.Context, id string) error
	kill            func(ctx context.Context, id string) error
	remove          func(ctx context.Context, id string) error
	containerName   func(ctx context.Context, id string) (string, error)
	containerImage  func(ctx context.Context, id string) (string, error)
	pullImage       func(ctx context.Context, ref string) error
	refreshImage    func(ctx context.Context, ref string)
	recreateManaged func(ctx context.Context, id string) error
}

func (m *mockAPI) Inspect(ctx context.Context, id string) (any, error) {
	if m.inspect == nil {
		m.t.Fatalf("unexpected Inspect(%q)", id)
	}
	return m.inspect(ctx, id)
}

func (m *mockAPI) Top(ctx context.Context, id string) (docker.TopResult, error) {
	if m.top == nil {
		m.t.Fatalf("unexpected Top(%q)", id)
	}
	return m.top(ctx, id)
}

func (m *mockAPI) ContainerSpecOf(ctx context.Context, id string) (*stackspec.ContainerSpec, error) {
	if m.containerSpecOf == nil {
		m.t.Fatalf("unexpected ContainerSpecOf(%q)", id)
	}
	return m.containerSpecOf(ctx, id)
}

func (m *mockAPI) Start(ctx context.Context, id string) error {
	if m.start == nil {
		m.t.Fatalf("unexpected Start(%q)", id)
	}
	return m.start(ctx, id)
}

func (m *mockAPI) Stop(ctx context.Context, id string) error {
	if m.stop == nil {
		m.t.Fatalf("unexpected Stop(%q)", id)
	}
	return m.stop(ctx, id)
}

func (m *mockAPI) Restart(ctx context.Context, id string) error {
	if m.restart == nil {
		m.t.Fatalf("unexpected Restart(%q)", id)
	}
	return m.restart(ctx, id)
}

func (m *mockAPI) Kill(ctx context.Context, id string) error {
	if m.kill == nil {
		m.t.Fatalf("unexpected Kill(%q)", id)
	}
	return m.kill(ctx, id)
}

func (m *mockAPI) Remove(ctx context.Context, id string) error {
	if m.remove == nil {
		m.t.Fatalf("unexpected Remove(%q)", id)
	}
	return m.remove(ctx, id)
}

func (m *mockAPI) ContainerName(ctx context.Context, id string) (string, error) {
	if m.containerName == nil {
		return id, nil // incidental audit-name lookup; tests that care wire containerName
	}
	return m.containerName(ctx, id)
}

// ContainerMatchInfo backs the audit engine's stack (compose project) lookup on a
// lifecycle op. These tests don't assert the audited project, so return empty.
func (m *mockAPI) ContainerMatchInfo(ctx context.Context, id string) (string, map[string]string, error) {
	return "", nil, nil
}

func (m *mockAPI) ContainerImage(ctx context.Context, id string) (string, error) {
	if m.containerImage == nil {
		m.t.Fatalf("unexpected ContainerImage(%q)", id)
	}
	return m.containerImage(ctx, id)
}

func (m *mockAPI) PullImage(ctx context.Context, ref string) error {
	if m.pullImage == nil {
		m.t.Fatalf("unexpected PullImage(%q)", ref)
	}
	return m.pullImage(ctx, ref)
}

func (m *mockAPI) RefreshImageStatus(ctx context.Context, ref string) {
	if m.refreshImage == nil {
		m.t.Fatalf("unexpected RefreshImageStatus(%q)", ref)
	}
	m.refreshImage(ctx, ref)
}

func (m *mockAPI) RecreateManaged(ctx context.Context, id string) error {
	if m.recreateManaged == nil {
		m.t.Fatalf("unexpected RecreateManaged(%q)", id)
	}
	return m.recreateManaged(ctx, id)
}

// newTestRouter wires a ContainersRouter to the mock through the hosts seam. A
// real bus is returned so happy-path tests can subscribe and assert the
// lifecycle event; error/validation paths never publish (Publish is nil-safe
// anyway).
func newTestRouter(t *testing.T, m *mockAPI) (*ContainersRouter, *rpc.Context, *events.Bus) {
	t.Helper()
	m.t = t
	bus := events.New()
	set := hosts.New(m, true, nil)
	r := NewContainersRouter(set, bus, nil)
	rctx := rpc.NewContext(hosts.WithTarget(context.Background(), hosts.LocalID))
	return r, rctx, bus
}

// wantStatus asserts err is an *rpc.Error with the given HTTP status.
func wantStatus(t *testing.T, err error, status int) {
	t.Helper()
	if err == nil {
		t.Fatalf("error = nil; want *rpc.Error with status %d", status)
	}
	var re *rpc.Error
	if !errors.As(err, &re) {
		t.Fatalf("error = %v (%T); want *rpc.Error", err, err)
	}
	if re.Status != status {
		t.Fatalf("status = %d; want %d (err=%q)", re.Status, status, re.Message)
	}
}

// nextEvent reads one event off the subscriber channel, failing if none arrives.
func nextEvent(t *testing.T, ch <-chan events.Event) events.Event {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("no event published")
		return events.Event{}
	}
}

func TestInspect(t *testing.T) {
	t.Run("happy", func(t *testing.T) {
		want := map[string]any{"Id": "abc123", "State": "running"}
		m := &mockAPI{inspect: func(_ context.Context, id string) (any, error) {
			if id != "abc123" {
				t.Fatalf("Inspect id = %q; want abc123", id)
			}
			return want, nil
		}}
		r, ctx, _ := newTestRouter(t, m)
		got, err := r.Inspect(ctx, &IDParams{ID: "abc123"})
		if err != nil {
			t.Fatalf("Inspect() error = %v", err)
		}
		gotMap, ok := got.(map[string]any)
		if !ok || gotMap["Id"] != "abc123" {
			t.Fatalf("Inspect() = %#v; want the raw inspect payload", got)
		}
	})

	t.Run("error is NotFound", func(t *testing.T) {
		m := &mockAPI{inspect: func(_ context.Context, _ string) (any, error) {
			return nil, errors.New("no such container")
		}}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Inspect(ctx, &IDParams{ID: "gone"})
		wantStatus(t, err, 404)
	})
}

func TestTop(t *testing.T) {
	t.Run("happy", func(t *testing.T) {
		want := docker.TopResult{Titles: []string{"PID", "CMD"}, Processes: [][]string{{"1", "nginx"}}}
		m := &mockAPI{top: func(_ context.Context, id string) (docker.TopResult, error) {
			if id != "c1" {
				t.Fatalf("Top id = %q; want c1", id)
			}
			return want, nil
		}}
		r, ctx, _ := newTestRouter(t, m)
		got, err := r.Top(ctx, &IDParams{ID: "c1"})
		if err != nil {
			t.Fatalf("Top() error = %v", err)
		}
		if got == nil || len(got.Titles) != 2 || got.Processes[0][1] != "nginx" {
			t.Fatalf("Top() = %#v; want the process list", got)
		}
	})

	t.Run("error is BadRequest", func(t *testing.T) {
		m := &mockAPI{top: func(_ context.Context, _ string) (docker.TopResult, error) {
			return docker.TopResult{}, errors.New("container not running")
		}}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Top(ctx, &IDParams{ID: "stopped"})
		wantStatus(t, err, 400)
	})
}

func TestSpec(t *testing.T) {
	t.Run("happy", func(t *testing.T) {
		want := &stackspec.ContainerSpec{Name: "web", Image: "nginx:latest"}
		m := &mockAPI{containerSpecOf: func(_ context.Context, id string) (*stackspec.ContainerSpec, error) {
			if id != "c1" {
				t.Fatalf("ContainerSpecOf id = %q; want c1", id)
			}
			return want, nil
		}}
		r, ctx, _ := newTestRouter(t, m)
		got, err := r.Spec(ctx, &IDParams{ID: "c1"})
		if err != nil {
			t.Fatalf("Spec() error = %v", err)
		}
		if got == nil || got.Image != "nginx:latest" {
			t.Fatalf("Spec() = %#v; want the reconstructed spec", got)
		}
	})

	t.Run("error is NotFound", func(t *testing.T) {
		m := &mockAPI{containerSpecOf: func(_ context.Context, _ string) (*stackspec.ContainerSpec, error) {
			return nil, errors.New("no such container")
		}}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Spec(ctx, &IDParams{ID: "gone"})
		wantStatus(t, err, 404)
	})
}

// lifecycleOps drives the five act()-backed lifecycle methods through one table.
// bind assigns the failing/succeeding fn to the right mock method; call invokes
// the router method under test via a method expression.
type lifecycleOp struct {
	name   string
	action string
	kind   events.Kind
	bind   func(m *mockAPI, fn func(context.Context, string) error)
	call   func(r *ContainersRouter, ctx *rpc.Context, p *IDParams) (*CtrResult, error)
}

var lifecycleOps = []lifecycleOp{
	{"Start", "started", events.KindContainerState,
		func(m *mockAPI, fn func(context.Context, string) error) { m.start = fn },
		(*ContainersRouter).Start},
	{"Stop", "stopped", events.KindContainerState,
		func(m *mockAPI, fn func(context.Context, string) error) { m.stop = fn },
		(*ContainersRouter).Stop},
	{"Restart", "restarted", events.KindContainerState,
		func(m *mockAPI, fn func(context.Context, string) error) { m.restart = fn },
		(*ContainersRouter).Restart},
	{"Kill", "killed", events.KindContainerState,
		func(m *mockAPI, fn func(context.Context, string) error) { m.kill = fn },
		(*ContainersRouter).Kill},
	{"Remove", "removed", events.KindContainerRemoved,
		func(m *mockAPI, fn func(context.Context, string) error) { m.remove = fn },
		(*ContainersRouter).Remove},
}

func TestLifecycleHappy(t *testing.T) {
	for _, op := range lifecycleOps {
		t.Run(op.name, func(t *testing.T) {
			var gotID string
			m := &mockAPI{
				containerName: func(_ context.Context, _ string) (string, error) { return "web", nil },
			}
			op.bind(m, func(_ context.Context, id string) error { gotID = id; return nil })
			r, ctx, bus := newTestRouter(t, m)
			ch, cancel := bus.Subscribe(0)
			defer cancel()

			res, err := op.call(r, ctx, &IDParams{ID: "deadbeefcafe01"})
			if err != nil {
				t.Fatalf("%s() error = %v", op.name, err)
			}
			if res == nil || !res.OK {
				t.Fatalf("%s() = %#v; want OK", op.name, res)
			}
			if gotID != "deadbeefcafe01" {
				t.Fatalf("daemon fn got id %q; want deadbeefcafe01", gotID)
			}
			e := nextEvent(t, ch)
			if e.Kind != op.kind {
				t.Fatalf("event kind = %q; want %q", e.Kind, op.kind)
			}
			if len(e.IDs) != 1 || e.IDs[0] != "deadbeefcafe01" {
				t.Fatalf("event IDs = %v; want [deadbeefcafe01]", e.IDs)
			}
			if e.Host != hosts.LocalID {
				t.Fatalf("event Host = %q; want %q", e.Host, hosts.LocalID)
			}
			var data map[string]string
			if err := json.Unmarshal(e.Data, &data); err != nil {
				t.Fatalf("decode event data: %v", err)
			}
			if data["action"] != op.action || data["name"] != "web" {
				t.Fatalf("event data = %v; want action=%q name=web", data, op.action)
			}
		})
	}
}

// TestLifecycleNameFallback covers act()'s fallback: when ContainerName fails,
// the completion notice falls back to the short id (shortID leaves an already-short
// id untouched). The action still succeeds.
func TestLifecycleNameFallback(t *testing.T) {
	m := &mockAPI{
		start:         func(_ context.Context, _ string) error { return nil },
		containerName: func(_ context.Context, _ string) (string, error) { return "", errors.New("already gone") },
	}
	r, ctx, bus := newTestRouter(t, m)
	ch, cancel := bus.Subscribe(0)
	defer cancel()

	res, err := r.Start(ctx, &IDParams{ID: "shortid"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if res == nil || !res.OK {
		t.Fatalf("Start() = %#v; want OK", res)
	}
	e := nextEvent(t, ch)
	var data map[string]string
	if err := json.Unmarshal(e.Data, &data); err != nil {
		t.Fatalf("decode event data: %v", err)
	}
	if data["name"] != "shortid" { // shortID("shortid") == "shortid"
		t.Fatalf("event name = %q; want the short id fallback", data["name"])
	}
}

func TestLifecycleValidation(t *testing.T) {
	for _, op := range lifecycleOps {
		t.Run(op.name, func(t *testing.T) {
			m := &mockAPI{} // no fn wired: any daemon call fails via nil-guard
			// Wire the lifecycle fn to a fatal so a call proves the guard fired.
			op.bind(m, func(_ context.Context, id string) error {
				t.Fatalf("daemon reached with empty id via %s", op.name)
				return nil
			})
			r, ctx, _ := newTestRouter(t, m)
			_, err := op.call(r, ctx, &IDParams{ID: ""})
			wantStatus(t, err, 400)
		})
	}
}

func TestLifecycleError(t *testing.T) {
	for _, op := range lifecycleOps {
		t.Run(op.name, func(t *testing.T) {
			m := &mockAPI{} // ContainerName must NOT be reached on the error path.
			op.bind(m, func(_ context.Context, _ string) error { return errors.New("daemon boom") })
			r, ctx, _ := newTestRouter(t, m)
			_, err := op.call(r, ctx, &IDParams{ID: "c1"})
			wantStatus(t, err, 500)
		})
	}
}

func TestPull(t *testing.T) {
	t.Run("validation empty id", func(t *testing.T) {
		m := &mockAPI{} // ContainerImage must not be reached.
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Pull(ctx, &IDParams{ID: ""})
		wantStatus(t, err, 400)
	})

	t.Run("happy pulls and refreshes", func(t *testing.T) {
		var pulled, refreshed string
		m := &mockAPI{
			containerImage: func(_ context.Context, id string) (string, error) {
				if id != "c1" {
					t.Fatalf("ContainerImage id = %q; want c1", id)
				}
				return "nginx:latest", nil
			},
			pullImage:    func(_ context.Context, ref string) error { pulled = ref; return nil },
			refreshImage: func(_ context.Context, ref string) { refreshed = ref },
		}
		r, ctx, bus := newTestRouter(t, m)
		ch, cancel := bus.Subscribe(0)
		defer cancel()

		res, err := r.Pull(ctx, &IDParams{ID: "c1"})
		if err != nil {
			t.Fatalf("Pull() error = %v", err)
		}
		if res == nil || !res.OK {
			t.Fatalf("Pull() = %#v; want OK", res)
		}
		if pulled != "nginx:latest" {
			t.Fatalf("PullImage ref = %q; want nginx:latest", pulled)
		}
		if refreshed != "nginx:latest" {
			t.Fatalf("RefreshImageStatus ref = %q; want nginx:latest", refreshed)
		}
		e := nextEvent(t, ch)
		if e.Kind != events.KindImageCurrent || len(e.IDs) != 1 || e.IDs[0] != "c1" {
			t.Fatalf("event = %+v; want image.current for c1", e)
		}
	})

	t.Run("image lookup error is NotFound", func(t *testing.T) {
		m := &mockAPI{containerImage: func(_ context.Context, _ string) (string, error) {
			return "", errors.New("no such container")
		}}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Pull(ctx, &IDParams{ID: "gone"})
		wantStatus(t, err, 404)
	})

	t.Run("pull error is Internal", func(t *testing.T) {
		m := &mockAPI{
			containerImage: func(_ context.Context, _ string) (string, error) { return "nginx:latest", nil },
			pullImage:      func(_ context.Context, _ string) error { return errors.New("registry down") },
		}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Pull(ctx, &IDParams{ID: "c1"})
		wantStatus(t, err, 500)
	})
}

func TestRedeploy(t *testing.T) {
	t.Run("validation empty id", func(t *testing.T) {
		m := &mockAPI{}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Redeploy(ctx, &IDParams{ID: ""})
		wantStatus(t, err, 400)
	})

	t.Run("happy pulls, recreates, refreshes", func(t *testing.T) {
		var recreated, refreshed string
		m := &mockAPI{
			containerImage:  func(_ context.Context, _ string) (string, error) { return "nginx:latest", nil },
			pullImage:       func(_ context.Context, _ string) error { return nil },
			recreateManaged: func(_ context.Context, id string) error { recreated = id; return nil },
			refreshImage:    func(_ context.Context, ref string) { refreshed = ref },
		}
		r, ctx, bus := newTestRouter(t, m)
		ch, cancel := bus.Subscribe(0)
		defer cancel()

		res, err := r.Redeploy(ctx, &IDParams{ID: "c1"})
		if err != nil {
			t.Fatalf("Redeploy() error = %v", err)
		}
		if res == nil || !res.OK {
			t.Fatalf("Redeploy() = %#v; want OK", res)
		}
		if recreated != "c1" {
			t.Fatalf("RecreateManaged id = %q; want c1", recreated)
		}
		if refreshed != "nginx:latest" {
			t.Fatalf("RefreshImageStatus ref = %q; want nginx:latest", refreshed)
		}
		e := nextEvent(t, ch)
		if e.Kind != events.KindImageCurrent || len(e.IDs) != 1 || e.IDs[0] != "c1" {
			t.Fatalf("event = %+v; want image.current for c1", e)
		}
	})

	t.Run("image lookup error is NotFound", func(t *testing.T) {
		m := &mockAPI{containerImage: func(_ context.Context, _ string) (string, error) {
			return "", errors.New("no such container")
		}}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Redeploy(ctx, &IDParams{ID: "gone"})
		wantStatus(t, err, 404)
	})

	t.Run("pull error is Internal", func(t *testing.T) {
		m := &mockAPI{
			containerImage: func(_ context.Context, _ string) (string, error) { return "nginx:latest", nil },
			pullImage:      func(_ context.Context, _ string) error { return errors.New("registry down") },
		}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Redeploy(ctx, &IDParams{ID: "c1"})
		wantStatus(t, err, 500)
	})

	t.Run("recreate error is Internal", func(t *testing.T) {
		m := &mockAPI{
			containerImage:  func(_ context.Context, _ string) (string, error) { return "nginx:latest", nil },
			pullImage:       func(_ context.Context, _ string) error { return nil },
			recreateManaged: func(_ context.Context, _ string) error { return errors.New("recreate failed") },
		}
		r, ctx, _ := newTestRouter(t, m)
		_, err := r.Redeploy(ctx, &IDParams{ID: "c1"})
		wantStatus(t, err, 500)
	})
}
