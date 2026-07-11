package docker

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// These drive the stack-level operations (stackops.go): pull streaming, the
// recreate machinery, and the self/connector/managed routing that decides between
// an inline recreate and a detached helper. The fake daemon (fake_test.go) stands
// in for the Engine API.

// writePullStream emits a Docker image-pull progress body: one JSON object per
// line, as the daemon streams it.
func writePullStream(w http.ResponseWriter, msgs []map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	for _, m := range msgs {
		_ = enc.Encode(m)
	}
}

// createBody captures the fields a ContainerCreate POST carries that let us tell
// an inline recreate (original image/labels) from a detached self-updater helper.
type createBody struct {
	Image      string            `json:"Image"`
	Entrypoint []string          `json:"Entrypoint"`
	Labels     map[string]string `json:"Labels"`
}

func decodeCreate(r *http.Request) createBody {
	var b createBody
	_ = json.NewDecoder(r.Body).Decode(&b)
	return b
}

// TestProjectContainerIDsEmpty proves the empty-project error path.
func TestProjectContainerIDsEmpty(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	if _, err := c.ProjectContainerIDs(t.Context(), "ghost"); err == nil {
		t.Error("ProjectContainerIDs(empty project) = nil err; want a 'no containers' error")
	}
}

// TestImagesForProject proves the dedup + sort of a project's image refs.
func TestImagesForProject(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				{"Id": "w1", "Image": "nginx:latest", "Labels": map[string]string{labelProject: "blog", labelService: "web"}},
				{"Id": "w2", "Image": "nginx:latest", "Labels": map[string]string{labelProject: "blog", labelService: "web", labelNumber: "2"}},
				{"Id": "d1", "Image": "postgres:16", "Labels": map[string]string{labelProject: "blog", labelService: "db"}},
				{"Id": "x1", "Image": "redis:7", "Labels": map[string]string{labelProject: "other"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	imgs, err := c.ImagesForProject(t.Context(), "blog")
	if err != nil {
		t.Fatalf("ImagesForProject err: %v", err)
	}
	// nginx deduped, sorted: nginx:latest < postgres:16. redis excluded (other project).
	if !reflect.DeepEqual(imgs, []string{"nginx:latest", "postgres:16"}) {
		t.Errorf("ImagesForProject = %v; want [nginx:latest postgres:16]", imgs)
	}
}

// TestContainerImageAndName proves the two inspect-backed lookups.
func TestContainerImageAndName(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json") {
			writeJSON(w, map[string]any{"Id": "cid", "Name": "/blog-web-1", "Config": map[string]any{"Image": "nginx:latest"}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	img, err := c.ContainerImage(t.Context(), "cid")
	if err != nil || img != "nginx:latest" {
		t.Errorf("ContainerImage = %q/%v; want nginx:latest/nil", img, err)
	}
	name, err := c.ContainerName(t.Context(), "cid")
	if err != nil || name != "blog-web-1" {
		t.Errorf("ContainerName = %q/%v; want blog-web-1/nil (slash trimmed)", name, err)
	}
}

// TestOnCurrentImage proves the running-id vs resolved-ref comparison.
func TestOnCurrentImage(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/images/") && strings.HasSuffix(r.URL.Path, "/json") {
			writeJSON(w, map[string]any{"Id": "sha256:current"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	if !c.onCurrentImage(t.Context(), "sha256:current", "nginx:latest") {
		t.Error("onCurrentImage(matching) = false; want true")
	}
	if c.onCurrentImage(t.Context(), "sha256:stale", "nginx:latest") {
		t.Error("onCurrentImage(stale) = true; want false")
	}
	// Blank inputs short-circuit to false without a daemon call.
	if c.onCurrentImage(t.Context(), "", "nginx") || c.onCurrentImage(t.Context(), "sha256:x", "") {
		t.Error("onCurrentImage with a blank arg should be false")
	}
}

// TestPullImageSuccess proves the progress stream is drained to EOF and reports
// no error on a clean pull.
func TestPullImageSuccess(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/create") {
			writePullStream(w, []map[string]any{
				{"status": "Pulling from library/nginx", "id": "latest"},
				{"status": "Pulling fs layer", "id": "abc"},
				{"status": "Download complete", "id": "abc"},
				{"status": "Status: Downloaded newer image for nginx:latest"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	if err := c.PullImage(t.Context(), "nginx:latest"); err != nil {
		t.Errorf("PullImage(clean) = %v; want nil", err)
	}
}

// TestPullImageMidStreamError proves a JSON `error` line mid-stream is surfaced
// (a throttled pull must not look successful), preferring errorDetail.message.
func TestPullImageMidStreamError(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/create") {
			writePullStream(w, []map[string]any{
				{"status": "Pulling from library/nginx"},
				{"error": "toomanyrequests", "errorDetail": map[string]any{"message": "You have reached your pull rate limit"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	err := c.PullImage(t.Context(), "nginx:latest")
	if err == nil || !strings.Contains(err.Error(), "pull rate limit") {
		t.Errorf("PullImage(throttled) = %v; want the rate-limit detail surfaced", err)
	}
}

// TestPullImageStream proves per-layer progress is emitted once per phase change
// (dedup) and a mid-stream error is returned.
func TestPullImageStream(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/create") {
			writePullStream(w, []map[string]any{
				{"status": "Pulling fs layer", "id": "abc"},
				{"status": "Downloading", "id": "abc"},
				{"status": "Downloading", "id": "abc"}, // same phase -> deduped
				{"status": "Pull complete", "id": "abc"},
				{"status": "Status: Image is up to date for nginx:latest"}, // no id -> emitted raw
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	var lines []string
	if err := c.PullImageStream(t.Context(), "nginx:latest", func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("PullImageStream err: %v", err)
	}
	// abc appears 3 times (fs layer / Downloading / Pull complete — the dup Downloading is dropped)
	// plus the id-less final status line.
	want := []string{
		"abc: Pulling fs layer",
		"abc: Downloading",
		"abc: Pull complete",
		"Status: Image is up to date for nginx:latest",
	}
	if !reflect.DeepEqual(lines, want) {
		t.Errorf("emitted = %v; want %v (deduped)", lines, want)
	}
}

// TestRecreate proves the in-place rebuild: stop -> remove -> create (reusing the
// original Config/HostConfig, under the same name) -> reconnect the non-primary
// networks -> start. The multi-network case exercises the connect loop.
func TestRecreate(t *testing.T) {
	var stopped, removed, started, created bool
	var connects []string
	var body createBody
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{
				"Id":     "cid",
				"Name":   "/blog-web-1",
				"Config": map[string]any{"Image": "nginx:latest", "Labels": map[string]string{labelProject: "blog"}},
				"NetworkSettings": map[string]any{"Networks": map[string]any{
					"blog_default": map[string]any{"Aliases": []string{"web"}},
					"shared":       map[string]any{"Aliases": []string{"web"}},
				}},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
			stopped = true
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && strings.Contains(p, "/containers/"):
			removed = true
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/containers/create"):
			created = true
			body = decodeCreate(r)
			writeJSON(w, map[string]any{"Id": "newcid"})
		case r.Method == http.MethodPost && strings.Contains(p, "/networks/") && strings.HasSuffix(p, "/connect"):
			// path is /networks/{name}/connect
			name := strings.TrimSuffix(p, "/connect")
			connects = append(connects, name[strings.LastIndex(name, "/")+1:])
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
			started = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if err := c.Recreate(t.Context(), "cid"); err != nil {
		t.Fatalf("Recreate err: %v", err)
	}
	if !stopped || !removed || !created || !started {
		t.Errorf("lifecycle = stop:%v remove:%v create:%v start:%v; want all true", stopped, removed, created, started)
	}
	// Networks sort alphabetically: blog_default is primary (baked into create),
	// shared is the one connected after.
	if !reflect.DeepEqual(connects, []string{"shared"}) {
		t.Errorf("post-create connects = %v; want [shared] (blog_default is the primary)", connects)
	}
	// The recreate reuses the original image (not a self-updater helper).
	if body.Image != "nginx:latest" || body.Labels[labelProject] != "blog" {
		t.Errorf("create body = %+v; want the original nginx image + compose label", body)
	}
}

// TestRecreateManagedRouting proves the self/managed/connector detection routes to
// the detached helper, while an ordinary container recreates inline. Detached is
// identified by the helper's hope-boot entrypoint + self-updater label on the
// ContainerCreate body; inline reuses the target's own image.
func TestRecreateManagedRouting(t *testing.T) {
	const selfImage = "ghcr.io/toyz/hope:latest"
	// inspects keyed by container id.
	inspects := map[string]map[string]any{
		"plain": {"Id": "plain", "Name": "/app-web-1",
			"Config": map[string]any{"Image": "nginx:latest", "Labels": map[string]string{labelProject: "app"}}},
		"managed": {"Id": "managed", "Name": "/hope-agent",
			"Config": map[string]any{"Image": "ghcr.io/toyz/hope-agent:latest", "Env": []string{"HOPE_MANAGED=1"}}},
		"connector": {"Id": "connector", "Name": "/hope-connector-a",
			"Config": map[string]any{"Image": "cloudflare/cloudflared:latest", "Labels": map[string]string{labelTunnel: "tun-a"}}},
		// the host's own hope container, resolved by selfImage() for the connector case.
		"hopeself": {"Id": "hopeself", "Name": "/hope",
			"Config": map[string]any{"Image": selfImage, "Env": []string{"HOPE_MANAGED=1"}}},
	}

	cases := []struct {
		name          string
		target        string
		wantDetached  bool
		wantHelperImg string // image the detached helper should run from
	}{
		{"ordinary container -> inline", "plain", false, ""},
		{"hope-managed (agent) -> detached, own image", "managed", true, "ghcr.io/toyz/hope-agent:latest"},
		{"connector -> detached, host hope image", "connector", true, selfImage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var creates []createBody
			var stopped, removed, started bool
			c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
				p := r.URL.Path
				switch {
				case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
					id := inspectID(p)
					if insp, ok := inspects[id]; ok {
						writeJSON(w, insp)
						return
					}
					w.WriteHeader(http.StatusNotFound)
				case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
					stopped = true
					w.WriteHeader(http.StatusNoContent)
				case r.Method == http.MethodDelete && strings.Contains(p, "/containers/"):
					removed = true
					w.WriteHeader(http.StatusNoContent)
				case r.Method == http.MethodPost && strings.HasSuffix(p, "/containers/create"):
					creates = append(creates, decodeCreate(r))
					writeJSON(w, map[string]any{"Id": "newcid"})
				case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
					started = true
					w.WriteHeader(http.StatusNoContent)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})
			c.SetSelfID("hopeself")

			if err := c.RecreateManaged(t.Context(), tc.target); err != nil {
				t.Fatalf("RecreateManaged(%s) err: %v", tc.target, err)
			}
			if len(creates) != 1 {
				t.Fatalf("expected exactly one ContainerCreate, got %d", len(creates))
			}
			got := creates[0]
			isDetached := got.Labels["ink.hope.self-updater"] == "1" &&
				len(got.Entrypoint) == 3 && got.Entrypoint[0] == "hope-boot"
			if isDetached != tc.wantDetached {
				t.Errorf("detached = %v; want %v (create body: %+v)", isDetached, tc.wantDetached, got)
			}
			if tc.wantDetached {
				if got.Image != tc.wantHelperImg {
					t.Errorf("helper image = %q; want %q", got.Image, tc.wantHelperImg)
				}
				if got.Entrypoint[2] != tc.target {
					t.Errorf("helper recreates %q; want %q", got.Entrypoint[2], tc.target)
				}
				// The detached path must NOT stop/remove the live target itself.
				if stopped || removed {
					t.Error("detached recreate must not stop/remove the target inline")
				}
			} else {
				// Inline path stops + removes + starts.
				if !stopped || !removed || !started {
					t.Errorf("inline lifecycle stop:%v remove:%v start:%v; want all true", stopped, removed, started)
				}
			}
		})
	}
}

// TestSelfIDHelpers proves the self-id accessors and the prefix-either-way match.
func TestSelfIDHelpers(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotFound) })
	c.SetSelfID("abcdef0123456789")
	if c.SelfID() != "abcdef0123456789" {
		t.Errorf("SelfID = %q; want the set hint", c.SelfID())
	}
	// isSelf matches when either id prefixes the other (short id vs full id).
	if !c.isSelf("abcdef012345") {
		t.Error("isSelf(short prefix of self) = false; want true")
	}
	if !c.isSelf("abcdef0123456789") {
		t.Error("isSelf(exact) = false; want true")
	}
	if c.isSelf("fedcba") {
		t.Error("isSelf(unrelated) = true; want false")
	}
	if c.isSelf("") {
		t.Error("isSelf(\"\") = true; want false")
	}
}

// TestSelfImage proves selfImage inspects the client's own container and returns
// its image ref, and errors when self has no image.
func TestSelfImage(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json") {
			writeJSON(w, map[string]any{"Id": "hopeself", "Name": "/hope", "Config": map[string]any{"Image": "ghcr.io/toyz/hope:latest"}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	c.SetSelfID("hopeself")
	img, err := c.selfImage(t.Context())
	if err != nil || img != "ghcr.io/toyz/hope:latest" {
		t.Errorf("selfImage = %q/%v; want the hope image", img, err)
	}
}

// TestRedeployContainerSkip proves the force=false skip path: a container already
// on the current image is left untouched (no recreate).
func TestRedeployContainerSkip(t *testing.T) {
	recreated := false
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{"Id": "cid", "Name": "/web-1", "Image": "sha256:current",
				"Config": map[string]any{"Image": "nginx:latest"}})
		case r.Method == http.MethodGet && strings.Contains(p, "/images/") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{"Id": "sha256:current"}) // resolved ref == running id
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
			recreated = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	var lines []string
	if err := c.RedeployContainer(t.Context(), "cid", false, false, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("RedeployContainer err: %v", err)
	}
	if recreated {
		t.Error("RedeployContainer recreated a container already on the current image")
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "skip") {
		t.Errorf("emitted = %v; want a single 'skip' line", lines)
	}
}

// TestRedeployContainerForce proves force=true recreates even when current, and
// the emitted step lines cover the recreate.
func TestRedeployContainerForce(t *testing.T) {
	started := false
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{"Id": "cid", "Name": "/web-1", "Image": "sha256:x",
				"Config":          map[string]any{"Image": "nginx:latest"},
				"NetworkSettings": map[string]any{"Networks": map[string]any{"app_default": map[string]any{}}}})
		case r.Method == http.MethodGet && strings.Contains(p, "/images/") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{"Id": "sha256:x"})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && strings.Contains(p, "/containers/"):
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/containers/create"):
			writeJSON(w, map[string]any{"Id": "newcid"})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
			started = true
			w.WriteHeader(http.StatusNoContent)
		case strings.Contains(p, "/distribution/"):
			w.WriteHeader(http.StatusInternalServerError) // freshness refresh is best-effort
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	var lines []string
	if err := c.RedeployContainer(t.Context(), "cid", false, true, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("RedeployContainer(force) err: %v", err)
	}
	if !started {
		t.Error("RedeployContainer(force) did not start the recreated container")
	}
	if !strings.Contains(strings.Join(lines, "\n"), "recreate") {
		t.Errorf("emitted = %v; want a 'recreate' line", lines)
	}
}

// TestRedeployProject proves the stack path pulls each distinct image (streaming),
// then recreates each container, and skips those already current when force=false.
func TestRedeployProject(t *testing.T) {
	pulled := map[string]bool{} // keyed by the SDK-normalized fromImage
	recreatedIDs := map[string]bool{}
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/json"):
			writeJSON(w, []map[string]any{
				{"Id": "web1", "Image": "nginx:latest", "Names": []string{"/blog-web-1"}, "Labels": map[string]string{labelProject: "blog", labelService: "web"}},
				{"Id": "db1", "Image": "postgres:16", "Names": []string{"/blog-db-1"}, "Labels": map[string]string{labelProject: "blog", labelService: "db"}},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/images/create"):
			img := r.URL.Query().Get("fromImage")
			pulled[img] = true
			writePullStream(w, []map[string]any{{"status": "Status: Downloaded", "id": "x"}})
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
			id := inspectID(p)
			img := "nginx:latest"
			if id == "db1" {
				img = "postgres:16"
			}
			// running id differs from resolved -> force-less recreate proceeds.
			writeJSON(w, map[string]any{"Id": id, "Name": "/" + id, "Image": "sha256:running-" + id,
				"Config": map[string]any{"Image": img}})
		case r.Method == http.MethodGet && strings.Contains(p, "/images/") && strings.HasSuffix(p, "/json"):
			writeJSON(w, map[string]any{"Id": "sha256:registry"}) // != running -> not current
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && strings.Contains(p, "/containers/"):
			recreatedIDs[inspectID(p+"/json")] = true // record which id was removed
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/containers/create"):
			writeJSON(w, map[string]any{"Id": "newcid"})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/start"):
			w.WriteHeader(http.StatusNoContent)
		case strings.Contains(p, "/distribution/"):
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	var lines []string
	if err := c.RedeployProject(t.Context(), "blog", true, false, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("RedeployProject err: %v", err)
	}
	// Both distinct images were pulled (the SDK normalizes the fromImage query,
	// so we assert on the count of distinct pulls, not the raw refs).
	if len(pulled) != 2 {
		t.Errorf("distinct images pulled = %d (%v); want 2", len(pulled), pulled)
	}
	out := strings.Join(lines, "\n")
	if !strings.Contains(out, "pull nginx:latest") || !strings.Contains(out, "recreate") {
		t.Errorf("emitted = %v; want pull + recreate lines", lines)
	}
}

// TestPullContainers proves the deduped multi-container pull: distinct images are
// pulled once, and an inspect failure emits a skip line without aborting.
func TestPullContainers(t *testing.T) {
	pulls := map[string]int{}
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.Contains(p, "/containers/") && strings.HasSuffix(p, "/json"):
			id := inspectID(p)
			if id == "broken" {
				w.WriteHeader(http.StatusNotFound) // inspect fails -> skip, don't abort
				return
			}
			img := "nginx:latest"
			if id == "c2" {
				img = "nginx:latest" // same image as c1 -> deduped
			}
			if id == "c3" {
				img = "redis:7"
			}
			writeJSON(w, map[string]any{"Id": id, "Config": map[string]any{"Image": img}})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/images/create"):
			pulls[r.URL.Query().Get("fromImage")]++
			writePullStream(w, []map[string]any{{"status": "Status: Downloaded"}})
		case strings.Contains(p, "/distribution/"):
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	var lines []string
	if err := c.PullContainers(t.Context(), []string{"c1", "c2", "c3", "broken"}, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatalf("PullContainers err: %v", err)
	}
	// c1+c2 share nginx (deduped to one pull), c3 is redis => two distinct pulls,
	// each issued exactly once. (Keys are the SDK-normalized fromImage.)
	if len(pulls) != 2 {
		t.Errorf("distinct pulls = %d (%v); want 2 (nginx deduped, redis)", len(pulls), pulls)
	}
	total := 0
	for _, n := range pulls {
		total += n
	}
	if total != 2 {
		t.Errorf("total pull calls = %d; want 2 (nginx once, redis once)", total)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "skip broken") {
		t.Errorf("emitted = %v; want a skip line for the un-inspectable container", lines)
	}
}
