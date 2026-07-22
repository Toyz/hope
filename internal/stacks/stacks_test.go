package stacks

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/compose"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// mockAPI embeds docker.API (nil) so only the wired methods exist; unset ones
// panic via the nil-guard, proving the router did not reach the daemon on a path
// it should have short-circuited.
type mockAPI struct {
	docker.API
	t *testing.T

	stacks               func(ctx context.Context) ([]docker.StackSummary, error)
	start                func(ctx context.Context, id string) error
	stop                 func(ctx context.Context, id string) error
	restart              func(ctx context.Context, id string) error
	projectContainerIDs  func(ctx context.Context, project string) ([]string, error)
	imagesForProject     func(ctx context.Context, project string) ([]string, error)
	pullImage            func(ctx context.Context, ref string) error
	recreateManaged      func(ctx context.Context, id string) error
	refreshProjectStatus func(ctx context.Context, project string)
	projectStats         func(ctx context.Context, project string) ([]docker.ContainerStat, error)
	projectUpdates       func(ctx context.Context, project string) ([]docker.ImageUpdate, error)
}

func (m *mockAPI) Stacks(ctx context.Context) ([]docker.StackSummary, error) {
	if m.stacks == nil {
		m.t.Fatalf("unexpected Stacks()")
	}
	return m.stacks(ctx)
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

func (m *mockAPI) ProjectContainerIDs(ctx context.Context, project string) ([]string, error) {
	if m.projectContainerIDs == nil {
		m.t.Fatalf("unexpected ProjectContainerIDs(%q)", project)
	}
	return m.projectContainerIDs(ctx, project)
}

func (m *mockAPI) ImagesForProject(ctx context.Context, project string) ([]string, error) {
	if m.imagesForProject == nil {
		m.t.Fatalf("unexpected ImagesForProject(%q)", project)
	}
	return m.imagesForProject(ctx, project)
}

func (m *mockAPI) PullImage(ctx context.Context, ref string) error {
	if m.pullImage == nil {
		m.t.Fatalf("unexpected PullImage(%q)", ref)
	}
	return m.pullImage(ctx, ref)
}

func (m *mockAPI) RecreateManaged(ctx context.Context, id string) error {
	if m.recreateManaged == nil {
		m.t.Fatalf("unexpected RecreateManaged(%q)", id)
	}
	return m.recreateManaged(ctx, id)
}

func (m *mockAPI) RefreshProjectStatus(ctx context.Context, project string) {
	if m.refreshProjectStatus == nil {
		m.t.Fatalf("unexpected RefreshProjectStatus(%q)", project)
	}
	m.refreshProjectStatus(ctx, project)
}

func (m *mockAPI) ProjectStats(ctx context.Context, project string) ([]docker.ContainerStat, error) {
	if m.projectStats == nil {
		m.t.Fatalf("unexpected ProjectStats(%q)", project)
	}
	return m.projectStats(ctx, project)
}

func (m *mockAPI) ProjectUpdates(ctx context.Context, project string) ([]docker.ImageUpdate, error) {
	if m.projectUpdates == nil {
		m.t.Fatalf("unexpected ProjectUpdates(%q)", project)
	}
	return m.projectUpdates(ctx, project)
}

// newTestRouter wires a StacksRouter to the mock through the hosts seam. The
// compose manager is used only by ComposeFile; other tests pass nil.
func newTestRouter(t *testing.T, m *mockAPI, c *compose.Manager) (*StacksRouter, *rpc.Context) {
	t.Helper()
	m.t = t
	set := hosts.New(m, true, nil)
	r := NewStacksRouter(set, c, nil)
	rctx := rpc.NewContext(hosts.WithTarget(context.Background(), hosts.LocalID))
	return r, rctx
}

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

func TestList(t *testing.T) {
	t.Run("happy", func(t *testing.T) {
		want := []docker.StackSummary{{Project: "web", Running: 2, Total: 2}}
		m := &mockAPI{stacks: func(_ context.Context) ([]docker.StackSummary, error) { return want, nil }}
		r, ctx := newTestRouter(t, m, nil)
		got, err := r.List(ctx)
		if err != nil {
			t.Fatalf("List() error = %v", err)
		}
		if len(got) != 1 || got[0].Project != "web" {
			t.Fatalf("List() = %#v; want the stack summaries", got)
		}
	})

	t.Run("error is surfaced raw", func(t *testing.T) {
		sentinel := errors.New("list containers failed")
		m := &mockAPI{stacks: func(_ context.Context) ([]docker.StackSummary, error) { return nil, sentinel }}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.List(ctx)
		if !errors.Is(err, sentinel) {
			t.Fatalf("List() error = %v; want the raw daemon error (List does not wrap)", err)
		}
	})
}

// eachContainerOp drives the three eachContainer-backed methods through one table.
type eachContainerOp struct {
	name string
	verb string
	bind func(m *mockAPI, fn func(context.Context, string) error)
	call func(r *StacksRouter, ctx *rpc.Context, p *ProjectParams) (*StackResult, error)
}

var eachContainerOps = []eachContainerOp{
	{"Start", "start",
		func(m *mockAPI, fn func(context.Context, string) error) { m.start = fn },
		(*StacksRouter).Start},
	{"Stop", "stop",
		func(m *mockAPI, fn func(context.Context, string) error) { m.stop = fn },
		(*StacksRouter).Stop},
	{"Restart", "restart",
		func(m *mockAPI, fn func(context.Context, string) error) { m.restart = fn },
		(*StacksRouter).Restart},
}

func TestEachContainerHappy(t *testing.T) {
	for _, op := range eachContainerOps {
		t.Run(op.name, func(t *testing.T) {
			var seen []string
			m := &mockAPI{
				projectContainerIDs: func(_ context.Context, project string) ([]string, error) {
					if project != "web" {
						t.Fatalf("project = %q; want web", project)
					}
					return []string{"id1", "id2"}, nil
				},
			}
			op.bind(m, func(_ context.Context, id string) error { seen = append(seen, id); return nil })
			r, ctx := newTestRouter(t, m, nil)
			res, err := op.call(r, ctx, &ProjectParams{Project: "web"})
			if err != nil {
				t.Fatalf("%s() error = %v", op.name, err)
			}
			if res == nil || !res.OK {
				t.Fatalf("%s() = %#v; want OK", op.name, res)
			}
			if len(seen) != 2 || seen[0] != "id1" || seen[1] != "id2" {
				t.Fatalf("fn applied to %v; want [id1 id2]", seen)
			}
			if !strings.Contains(res.Output, "2 container(s)") {
				t.Fatalf("Output = %q; want a 2-container summary", res.Output)
			}
		})
	}
}

func TestEachContainerValidation(t *testing.T) {
	for _, op := range eachContainerOps {
		t.Run(op.name, func(t *testing.T) {
			m := &mockAPI{} // ProjectContainerIDs and fn must not be reached.
			op.bind(m, func(_ context.Context, _ string) error {
				t.Fatalf("daemon reached with empty project via %s", op.name)
				return nil
			})
			r, ctx := newTestRouter(t, m, nil)
			_, err := op.call(r, ctx, &ProjectParams{Project: ""})
			wantStatus(t, err, 400)
		})
	}
}

func TestEachContainerListError(t *testing.T) {
	for _, op := range eachContainerOps {
		t.Run(op.name, func(t *testing.T) {
			m := &mockAPI{projectContainerIDs: func(_ context.Context, _ string) ([]string, error) {
				return nil, errors.New("boom")
			}}
			// fn must never run when the id listing fails.
			op.bind(m, func(_ context.Context, _ string) error {
				t.Fatalf("fn reached despite ProjectContainerIDs error")
				return nil
			})
			r, ctx := newTestRouter(t, m, nil)
			_, err := op.call(r, ctx, &ProjectParams{Project: "web"})
			wantStatus(t, err, 500)
		})
	}
}

func TestEachContainerFnError(t *testing.T) {
	for _, op := range eachContainerOps {
		t.Run(op.name, func(t *testing.T) {
			m := &mockAPI{projectContainerIDs: func(_ context.Context, _ string) ([]string, error) {
				return []string{"deadbeefcafe99"}, nil // >=12 chars for id[:12] in the error msg
			}}
			op.bind(m, func(_ context.Context, _ string) error { return errors.New("stopped short") })
			r, ctx := newTestRouter(t, m, nil)
			// A per-container failure is reported in the result, not as a top-level error.
			res, err := op.call(r, ctx, &ProjectParams{Project: "web"})
			if err != nil {
				t.Fatalf("%s() error = %v; want the failure inside StackResult", op.name, err)
			}
			if res == nil || res.OK || !strings.Contains(res.Error, op.verb) {
				t.Fatalf("%s() = %#v; want OK=false with a %q error", op.name, res, op.verb)
			}
		})
	}
}

func TestStacksPull(t *testing.T) {
	t.Run("validation empty project", func(t *testing.T) {
		m := &mockAPI{}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Pull(ctx, &ProjectParams{Project: ""})
		wantStatus(t, err, 400)
	})

	t.Run("happy pulls each image and refreshes", func(t *testing.T) {
		var pulled []string
		var refreshed bool
		m := &mockAPI{
			imagesForProject:     func(_ context.Context, _ string) ([]string, error) { return []string{"nginx", "redis"}, nil },
			pullImage:            func(_ context.Context, ref string) error { pulled = append(pulled, ref); return nil },
			refreshProjectStatus: func(_ context.Context, _ string) { refreshed = true },
		}
		r, ctx := newTestRouter(t, m, nil)
		res, err := r.Pull(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("Pull() error = %v", err)
		}
		if res == nil || !res.OK {
			t.Fatalf("Pull() = %#v; want OK", res)
		}
		if len(pulled) != 2 || pulled[0] != "nginx" || pulled[1] != "redis" {
			t.Fatalf("pulled = %v; want [nginx redis]", pulled)
		}
		if !refreshed {
			t.Fatalf("RefreshProjectStatus not called after a successful pull")
		}
		if !strings.Contains(res.Output, "pull nginx") || !strings.Contains(res.Output, "pull redis") {
			t.Fatalf("Output = %q; want a pull log per image", res.Output)
		}
	})

	t.Run("images lookup error is Internal", func(t *testing.T) {
		m := &mockAPI{imagesForProject: func(_ context.Context, _ string) ([]string, error) {
			return nil, errors.New("boom")
		}}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Pull(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 500)
	})

	t.Run("pull image failure reported in result", func(t *testing.T) {
		m := &mockAPI{
			imagesForProject: func(_ context.Context, _ string) ([]string, error) { return []string{"nginx"}, nil },
			pullImage:        func(_ context.Context, _ string) error { return errors.New("registry down") },
			// pull() returns a nil top-level error on an image failure, so Pull()
			// still runs RefreshProjectStatus — wire it so the nil-guard doesn't fire.
			refreshProjectStatus: func(_ context.Context, _ string) {},
		}
		r, ctx := newTestRouter(t, m, nil)
		res, err := r.Pull(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("Pull() error = %v; want the failure inside StackResult", err)
		}
		if res == nil || res.OK || res.Error == "" {
			t.Fatalf("Pull() = %#v; want OK=false with an error", res)
		}
	})
}

func TestStacksRedeploy(t *testing.T) {
	t.Run("validation empty project", func(t *testing.T) {
		m := &mockAPI{}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Redeploy(ctx, &ProjectParams{Project: ""})
		wantStatus(t, err, 400)
	})

	t.Run("happy pulls, recreates each, refreshes", func(t *testing.T) {
		var recreated []string
		var refreshed bool
		m := &mockAPI{
			imagesForProject:     func(_ context.Context, _ string) ([]string, error) { return []string{"nginx"}, nil },
			pullImage:            func(_ context.Context, _ string) error { return nil },
			projectContainerIDs:  func(_ context.Context, _ string) ([]string, error) { return []string{"id1", "id2"}, nil },
			recreateManaged:      func(_ context.Context, id string) error { recreated = append(recreated, id); return nil },
			refreshProjectStatus: func(_ context.Context, _ string) { refreshed = true },
		}
		r, ctx := newTestRouter(t, m, nil)
		res, err := r.Redeploy(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("Redeploy() error = %v", err)
		}
		if res == nil || !res.OK {
			t.Fatalf("Redeploy() = %#v; want OK", res)
		}
		if len(recreated) != 2 || recreated[0] != "id1" || recreated[1] != "id2" {
			t.Fatalf("recreated = %v; want [id1 id2]", recreated)
		}
		if !refreshed {
			t.Fatalf("RefreshProjectStatus not called")
		}
		if !strings.Contains(res.Output, "pull nginx") || !strings.Contains(res.Output, "recreated 2 container(s)") {
			t.Fatalf("Output = %q; want pull + recreate log", res.Output)
		}
	})

	t.Run("images lookup error is Internal", func(t *testing.T) {
		m := &mockAPI{imagesForProject: func(_ context.Context, _ string) ([]string, error) {
			return nil, errors.New("boom")
		}}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Redeploy(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 500)
	})

	t.Run("pull image failure short-circuits before recreate", func(t *testing.T) {
		m := &mockAPI{
			imagesForProject: func(_ context.Context, _ string) ([]string, error) { return []string{"nginx"}, nil },
			pullImage:        func(_ context.Context, _ string) error { return errors.New("registry down") },
			// projectContainerIDs / recreateManaged must NOT be reached.
		}
		r, ctx := newTestRouter(t, m, nil)
		res, err := r.Redeploy(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("Redeploy() error = %v; want the failure inside StackResult", err)
		}
		if res == nil || res.OK || res.Error == "" {
			t.Fatalf("Redeploy() = %#v; want OK=false with an error", res)
		}
	})

	t.Run("container id listing error is Internal", func(t *testing.T) {
		m := &mockAPI{
			imagesForProject:    func(_ context.Context, _ string) ([]string, error) { return []string{"nginx"}, nil },
			pullImage:           func(_ context.Context, _ string) error { return nil },
			projectContainerIDs: func(_ context.Context, _ string) ([]string, error) { return nil, errors.New("boom") },
		}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Redeploy(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 500)
	})

	t.Run("recreate failure reported in result", func(t *testing.T) {
		m := &mockAPI{
			imagesForProject:    func(_ context.Context, _ string) ([]string, error) { return []string{"nginx"}, nil },
			pullImage:           func(_ context.Context, _ string) error { return nil },
			projectContainerIDs: func(_ context.Context, _ string) ([]string, error) { return []string{"id1"}, nil },
			recreateManaged:     func(_ context.Context, _ string) error { return errors.New("recreate boom") },
		}
		r, ctx := newTestRouter(t, m, nil)
		res, err := r.Redeploy(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("Redeploy() error = %v; want the failure inside StackResult", err)
		}
		if res == nil || res.OK || !strings.Contains(res.Error, "recreate failed") {
			t.Fatalf("Redeploy() = %#v; want OK=false with a recreate-failed error", res)
		}
	})
}

func TestStats(t *testing.T) {
	t.Run("validation empty project", func(t *testing.T) {
		m := &mockAPI{}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Stats(ctx, &ProjectParams{Project: ""})
		wantStatus(t, err, 400)
	})

	t.Run("happy", func(t *testing.T) {
		want := []docker.ContainerStat{{ID: "c1", CPUPercent: 1.5, MemUsed: 100}}
		m := &mockAPI{projectStats: func(_ context.Context, project string) ([]docker.ContainerStat, error) {
			if project != "web" {
				t.Fatalf("project = %q; want web", project)
			}
			return want, nil
		}}
		r, ctx := newTestRouter(t, m, nil)
		got, err := r.Stats(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("Stats() error = %v", err)
		}
		if len(got) != 1 || got[0].ID != "c1" {
			t.Fatalf("Stats() = %#v; want the snapshot", got)
		}
	})

	t.Run("error is Internal", func(t *testing.T) {
		m := &mockAPI{projectStats: func(_ context.Context, _ string) ([]docker.ContainerStat, error) {
			return nil, errors.New("boom")
		}}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Stats(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 500)
	})
}

func TestUpdates(t *testing.T) {
	t.Run("validation empty project", func(t *testing.T) {
		m := &mockAPI{}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Updates(ctx, &ProjectParams{Project: ""})
		wantStatus(t, err, 400)
	})

	t.Run("happy", func(t *testing.T) {
		want := []docker.ImageUpdate{{ID: "c1", Image: "nginx", Status: "outdated"}}
		m := &mockAPI{projectUpdates: func(_ context.Context, _ string) ([]docker.ImageUpdate, error) { return want, nil }}
		r, ctx := newTestRouter(t, m, nil)
		got, err := r.Updates(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("Updates() error = %v", err)
		}
		if len(got) != 1 || got[0].Status != "outdated" {
			t.Fatalf("Updates() = %#v; want the freshness rows", got)
		}
	})

	t.Run("error is Internal", func(t *testing.T) {
		m := &mockAPI{projectUpdates: func(_ context.Context, _ string) ([]docker.ImageUpdate, error) {
			return nil, errors.New("boom")
		}}
		r, ctx := newTestRouter(t, m, nil)
		_, err := r.Updates(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 500)
	})
}

func TestComposeFile(t *testing.T) {
	// No compose roots => authorize passes and only file readability gates.
	mgr := compose.NewManager("", nil)

	t.Run("happy reads the compose file", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "docker-compose.yml")
		content := "services:\n  web:\n    image: nginx\n"
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatalf("write temp compose file: %v", err)
		}
		m := &mockAPI{stacks: func(_ context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "web", WorkingDir: dir, ConfigFiles: []string{file}}}, nil
		}}
		r, ctx := newTestRouter(t, m, mgr)
		got, err := r.ComposeFile(ctx, &ProjectParams{Project: "web"})
		if err != nil {
			t.Fatalf("ComposeFile() error = %v", err)
		}
		if got == nil || got.Project != "web" || got.Content != content {
			t.Fatalf("ComposeFile() = %#v; want the file contents", got)
		}
	})

	t.Run("project not found is NotFound", func(t *testing.T) {
		m := &mockAPI{stacks: func(_ context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "other"}}, nil
		}}
		r, ctx := newTestRouter(t, m, mgr)
		_, err := r.ComposeFile(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 404)
	})

	t.Run("no config files is BadRequest", func(t *testing.T) {
		m := &mockAPI{stacks: func(_ context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "web", ConfigFiles: nil}}, nil
		}}
		r, ctx := newTestRouter(t, m, mgr)
		_, err := r.ComposeFile(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 400)
	})

	t.Run("stacks lookup error is Internal", func(t *testing.T) {
		m := &mockAPI{stacks: func(_ context.Context) ([]docker.StackSummary, error) {
			return nil, errors.New("boom")
		}}
		r, ctx := newTestRouter(t, m, mgr)
		_, err := r.ComposeFile(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 500)
	})

	t.Run("unreadable file is BadRequest", func(t *testing.T) {
		dir := t.TempDir()
		missing := filepath.Join(dir, "does-not-exist.yml")
		m := &mockAPI{stacks: func(_ context.Context) ([]docker.StackSummary, error) {
			return []docker.StackSummary{{Project: "web", WorkingDir: dir, ConfigFiles: []string{missing}}}, nil
		}}
		r, ctx := newTestRouter(t, m, mgr)
		_, err := r.ComposeFile(ctx, &ProjectParams{Project: "web"})
		wantStatus(t, err, 400)
	})
}
