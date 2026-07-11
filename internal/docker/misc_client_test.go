package docker

import (
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/system"
)

// ── pure helpers (images.go / docker.go) ────────────────────────────────────

func TestShortImageID(t *testing.T) {
	cases := map[string]string{
		"sha256:abcdef0123456789": "abcdef012345", // sha256: stripped, then 12 chars
		"abcdef0123456789":        "abcdef012345",
		"short":                   "short", // <12 returned whole
		"sha256:tiny":             "tiny",
	}
	for in, want := range cases {
		if got := shortImageID(in); got != want {
			t.Errorf("shortImageID(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestCleanDaemonErr(t *testing.T) {
	if got := cleanDaemonErr(errors.New("Error response from daemon: no such image")); got != "no such image" {
		t.Errorf("cleanDaemonErr = %q; want the bare message", got)
	}
	if got := cleanDaemonErr(errors.New("plain error")); got != "plain error" {
		t.Errorf("cleanDaemonErr(no prefix) = %q; want passthrough", got)
	}
}

func TestHumanBytes(t *testing.T) {
	// NB: the MB branch fires only below 1 MiB (so it always renders "0 MB"); at or
	// above 1 MiB the code jumps straight to GB. These assert the real behavior.
	cases := map[int64]string{
		0:                      "0 B",
		-5:                     "0 B",
		512 * 1024:             "0 MB", // sub-1MiB
		1536 * 1024 * 1024:     "1.50 GB",
		2 * 1024 * 1024 * 1024: "2.00 GB",
	}
	for in, want := range cases {
		if got := humanBytes(in); got != want {
			t.Errorf("humanBytes(%d) = %q; want %q", in, got, want)
		}
	}
}

func TestIsConnDropped(t *testing.T) {
	for _, s := range []string{"unexpected EOF", "connection reset by peer", "broken pipe", "use of closed network connection", "server closed"} {
		if !isConnDropped(errors.New(s)) {
			t.Errorf("isConnDropped(%q) = false; want true", s)
		}
	}
	if isConnDropped(nil) {
		t.Error("isConnDropped(nil) = true; want false")
	}
	if isConnDropped(errors.New("no such container")) {
		t.Error("isConnDropped(daemon error) = true; want false")
	}
}

// TestDaemonHostIP covers daemonHostIP + IsLocalSocket without a live daemon:
// only a remote tcp:// host with a real hostname is non-local.
func TestDaemonHostIP(t *testing.T) {
	cases := []struct {
		host      string
		wantIP    string
		wantLocal bool
	}{
		{"tcp://10.0.0.5:2375", "10.0.0.5", false},
		{"tcp://localhost:2375", "", true},
		{"tcp://127.0.0.1:2375", "", true},
		{"unix:///var/run/docker.sock", "", true},
	}
	for _, tc := range cases {
		c, err := New(tc.host, "")
		if err != nil {
			t.Fatalf("New(%q): %v", tc.host, err)
		}
		if got := c.daemonHostIP(); got != tc.wantIP {
			t.Errorf("daemonHostIP(%q) = %q; want %q", tc.host, got, tc.wantIP)
		}
		if got := c.IsLocalSocket(); got != tc.wantLocal {
			t.Errorf("IsLocalSocket(%q) = %v; want %v", tc.host, got, tc.wantLocal)
		}
		_ = c.Close()
	}
}

// ── daemon-bound lookups built on Networks/Images ───────────────────────────

// TestNetworkByRef proves the flexible match: exact id, exact name, or an
// >=8-char id prefix all resolve; a miss returns (nil, nil).
func TestNetworkByRef(t *testing.T) {
	route := func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks"):
			writeJSON(w, []map[string]any{
				{"Name": "app_default", "Id": "abcdef0123456789", "Driver": "bridge", "Created": "2021-01-01T00:00:00Z"},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, []map[string]any{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
	c := fakeDaemon(t, route)
	for _, ref := range []string{"abcdef0123456789", "app_default", "abcdef01"} {
		n, err := c.NetworkByRef(t.Context(), ref)
		if err != nil {
			t.Fatalf("NetworkByRef(%q) err: %v", ref, err)
		}
		if n == nil || n.Name != "app_default" {
			t.Errorf("NetworkByRef(%q) = %+v; want app_default", ref, n)
		}
	}
	n, err := c.NetworkByRef(t.Context(), "nope")
	if err != nil {
		t.Fatalf("NetworkByRef(miss) err: %v", err)
	}
	if n != nil {
		t.Errorf("NetworkByRef(miss) = %+v; want nil", n)
	}
}

// TestImageByRef proves resolution by full id, short id, sha256-trimmed prefix,
// exact tag, and repo digest; a miss returns (nil, nil).
func TestImageByRef(t *testing.T) {
	route := func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/images/json"):
			writeJSON(w, []image.Summary{
				{ID: "sha256:abcdef0123456789", RepoTags: []string{"nginx:latest"}, RepoDigests: []string{"nginx@sha256:deadbeef"}, Size: 100},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, []map[string]any{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
	c := fakeDaemon(t, route)
	for _, ref := range []string{"sha256:abcdef0123456789", "abcdef012345", "abcdef0123456789", "nginx:latest", "nginx@sha256:deadbeef"} {
		im, err := c.ImageByRef(t.Context(), ref)
		if err != nil {
			t.Fatalf("ImageByRef(%q) err: %v", ref, err)
		}
		if im == nil || im.ID != "sha256:abcdef0123456789" {
			t.Errorf("ImageByRef(%q) = %+v; want the nginx image", ref, im)
		}
	}
	im, err := c.ImageByRef(t.Context(), "ghost")
	if err != nil {
		t.Fatalf("ImageByRef(miss) err: %v", err)
	}
	if im != nil {
		t.Errorf("ImageByRef(miss) = %+v; want nil", im)
	}
}

// TestImageInUse proves the by-ImageID match and the returned user list.
func TestImageInUse(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				{"Id": "c1", "Names": []string{"/web-1"}, "ImageID": "sha256:used",
					"Labels": map[string]string{labelService: "web", labelProject: "site"}},
				{"Id": "c2", "Names": []string{"/db-1"}, "ImageID": "sha256:other"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	inUse, users, err := c.ImageInUse(t.Context(), "sha256:used")
	if err != nil {
		t.Fatalf("ImageInUse err: %v", err)
	}
	if !inUse || len(users) != 1 || users[0].Service != "web" {
		t.Errorf("ImageInUse(used) = %v/%+v; want in-use by service web", inUse, users)
	}
	inUse, users, err = c.ImageInUse(t.Context(), "sha256:unreferenced")
	if err != nil {
		t.Fatalf("ImageInUse err: %v", err)
	}
	if inUse || users != nil {
		t.Errorf("ImageInUse(unreferenced) = %v/%+v; want false/nil", inUse, users)
	}
}

// TestProjectContainers proves the project + optional service filter and the
// name resolution (container name, else short id).
func TestProjectContainers(t *testing.T) {
	route := func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				{"Id": "web1id000000extra", "Names": []string{"/blog-web-1"}, "Labels": map[string]string{labelProject: "blog", labelService: "web", labelNumber: "1"}},
				{"Id": "db1id0000000extra", "Names": []string{"/blog-db-1"}, "Labels": map[string]string{labelProject: "blog", labelService: "db", labelNumber: "1"}},
				{"Id": "otherid00000extra", "Names": []string{"/shop-x-1"}, "Labels": map[string]string{labelProject: "shop", labelService: "x"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}
	c := fakeDaemon(t, route)
	// no service filter -> both blog containers.
	all, err := c.ProjectContainers(t.Context(), "blog", "")
	if err != nil {
		t.Fatalf("ProjectContainers err: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("ProjectContainers(blog) = %d; want 2", len(all))
	}
	// service filter -> just web.
	web, err := c.ProjectContainers(t.Context(), "blog", "web")
	if err != nil {
		t.Fatalf("ProjectContainers err: %v", err)
	}
	if len(web) != 1 || web[0].Name != "blog-web-1" || web[0].Service != "web" {
		t.Errorf("ProjectContainers(blog, web) = %+v; want [blog-web-1/web]", web)
	}
}

// TestRemoveManagedResources proves the teardown removes both the managed networks
// and volumes of a project and counts them; a remove error is non-fatal (kept, not
// counted).
func TestRemoveManagedResources(t *testing.T) {
	var removedNets, removedVols []string
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks"):
			writeJSON(w, []map[string]any{
				{"Name": "blog_default", "Id": "netok"},
				{"Name": "blog_stuck", "Id": "netbad"},
			})
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/networks/"):
			id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			if id == "netbad" {
				w.WriteHeader(http.StatusConflict) // still in use -> kept
				writeJSON(w, map[string]any{"message": "network in use"})
				return
			}
			removedNets = append(removedNets, id)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/volumes"):
			writeJSON(w, map[string]any{"Volumes": []map[string]any{{"Name": "blog_data", "Driver": "local"}}})
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/volumes/"):
			removedVols = append(removedVols, r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:])
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	n, err := c.RemoveManagedResources(t.Context(), "blog", nil)
	if err != nil {
		t.Fatalf("RemoveManagedResources err: %v", err)
	}
	// one network removed (the other errored), one volume removed => 2.
	if n != 2 {
		t.Errorf("removed count = %d; want 2 (1 net + 1 vol; stuck net kept)", n)
	}
	if !reflect.DeepEqual(removedNets, []string{"netok"}) {
		t.Errorf("removed nets = %v; want [netok]", removedNets)
	}
	if !reflect.DeepEqual(removedVols, []string{"blog_data"}) {
		t.Errorf("removed vols = %v; want [blog_data]", removedVols)
	}
}

// TestServerInfo proves the typed slice of the daemon /info response.
func TestServerInfo(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/info") {
			writeJSON(w, system.Info{ServerVersion: "27.1.0", Containers: 5, ContainersRunning: 3, Images: 12})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	si, err := c.ServerInfo(t.Context())
	if err != nil {
		t.Fatalf("ServerInfo err: %v", err)
	}
	want := ServerInfo{Version: "27.1.0", Containers: 5, Running: 3, Images: 12}
	if si != want {
		t.Errorf("ServerInfo = %+v; want %+v", si, want)
	}
}
