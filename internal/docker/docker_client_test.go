package docker

import (
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/image"
)

// These exercise the container/image listing methods against the fake-daemon
// harness. They lock the label parsing, the bridge/host/none network filtering,
// the compose grouping, and the sort orders — the logic hope layers on top of a
// raw Engine-API list.

// TestStacks proves compose grouping: containers group by project (label, else
// "(ungrouped)"), running/restarting are counted, working-dir + config-files come
// off labels, ComposeAvailable follows whether the first config file is readable,
// and both stacks and their containers sort deterministically.
func TestStacks(t *testing.T) {
	// A real, readable compose file so ComposeAvailable is deterministic.
	dir := t.TempDir()
	composePath := filepath.Join(dir, "compose.yml")
	if err := os.WriteFile(composePath, []byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				// project "blog": two services, web has a restarting replica.
				{"Id": "blogweb1", "Names": []string{"/blog-web-1"}, "State": "running", "Status": "Up 3 days",
					"Labels": map[string]string{labelProject: "blog", labelService: "web", labelNumber: "1", labelWorkingDir: "/srv/blog", labelConfigFiles: composePath}},
				{"Id": "blogdb1", "Names": []string{"/blog-db-1"}, "State": "restarting", "Status": "Restarting (1)",
					"Labels": map[string]string{labelProject: "blog", labelService: "db", labelNumber: "1", labelWorkingDir: "/srv/blog", labelConfigFiles: composePath}},
				// a bare container with no compose labels -> "(ungrouped)".
				{"Id": "loose1", "Names": []string{"/loose"}, "State": "exited", "Status": "Exited (0)"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	stacks, err := c.Stacks(t.Context())
	if err != nil {
		t.Fatalf("Stacks err: %v", err)
	}
	if len(stacks) != 2 {
		t.Fatalf("Stacks = %d; want 2 (blog + ungrouped)", len(stacks))
	}
	// Sorted by project: "(ungrouped)" < "blog" (paren sorts before letters).
	byProj := map[string]StackSummary{}
	for _, s := range stacks {
		byProj[s.Project] = s
	}
	blog, ok := byProj["blog"]
	if !ok {
		t.Fatal("no blog stack")
	}
	if blog.Total != 2 || blog.Running != 1 {
		t.Errorf("blog Total/Running = %d/%d; want 2/1", blog.Total, blog.Running)
	}
	if !blog.Restarting {
		t.Error("blog Restarting = false; want true (db is restarting)")
	}
	if blog.WorkingDir != "/srv/blog" {
		t.Errorf("blog WorkingDir = %q; want /srv/blog", blog.WorkingDir)
	}
	if !blog.ComposeAvailable {
		t.Error("blog ComposeAvailable = false; want true (config file is readable)")
	}
	// Containers sorted by service: db before web.
	if blog.Containers[0].Service != "db" || blog.Containers[1].Service != "web" {
		t.Errorf("blog container order = [%s %s]; want [db web]", blog.Containers[0].Service, blog.Containers[1].Service)
	}
	ung, ok := byProj[ungrouped]
	if !ok {
		t.Fatalf("no %s stack", ungrouped)
	}
	if ung.Total != 1 || ung.ComposeAvailable {
		t.Errorf("ungrouped Total=%d ComposeAvailable=%v; want 1/false", ung.Total, ung.ComposeAvailable)
	}
}

// TestPluginContainers proves plugin discovery: only truthy-labelled containers
// with a valid port survive; path defaults to /__hope; title falls back to name;
// bridge/host/none networks are filtered out; project/service identity is read off
// labels; output sorts by name.
func TestPluginContainers(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				// valid, fully specified — later name so we can prove the sort.
				{"Id": "zeta", "Names": []string{"/zeta-plugin"}, "State": "running", "Image": "z/plug:1", "ImageID": "sha256:zzz",
					"Labels": map[string]string{
						labelPlugin: "true", labelPluginPort: "8080", labelPluginPath: "/rpc",
						labelPluginTitle: "Zeta", labelPluginIcon: "star",
						labelProject: "proj", labelService: "svc",
					},
					"NetworkSettings": map[string]any{"Networks": map[string]any{
						"bridge": map[string]any{}, "proj_default": map[string]any{}, "shared": map[string]any{},
					}}},
				// valid, minimal — earlier name, defaults exercised (path, title).
				{"Id": "alpha", "Names": []string{"/alpha"}, "State": "exited",
					"Labels": map[string]string{labelPlugin: "1", labelPluginPort: "9000"}},
				// label explicitly off -> dropped.
				{"Id": "off", "Names": []string{"/off"}, "Labels": map[string]string{labelPlugin: "false", labelPluginPort: "8080"}},
				// unusable port -> dropped.
				{"Id": "badport", "Names": []string{"/badport"}, "Labels": map[string]string{labelPlugin: "true", labelPluginPort: "notaport"}},
				// out-of-range port -> dropped.
				{"Id": "hiport", "Names": []string{"/hiport"}, "Labels": map[string]string{labelPlugin: "true", labelPluginPort: "70000"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	plugins, err := c.PluginContainers(t.Context())
	if err != nil {
		t.Fatalf("PluginContainers err: %v", err)
	}
	if len(plugins) != 2 {
		t.Fatalf("PluginContainers = %d; want 2 (off/badport/hiport dropped)", len(plugins))
	}
	// Sorted by name: alpha before zeta.
	alpha, zeta := plugins[0], plugins[1]
	if alpha.Name != "alpha" || zeta.Name != "zeta-plugin" {
		t.Fatalf("order = [%s %s]; want [alpha zeta-plugin]", alpha.Name, zeta.Name)
	}
	// alpha: default path, title falls back to name, not running.
	if alpha.Port != 9000 {
		t.Errorf("alpha Port = %d; want 9000", alpha.Port)
	}
	if alpha.Path != defaultPluginPath {
		t.Errorf("alpha Path = %q; want %q (default)", alpha.Path, defaultPluginPath)
	}
	if alpha.Title != "alpha" {
		t.Errorf("alpha Title = %q; want alpha (name fallback)", alpha.Title)
	}
	if alpha.Running {
		t.Error("alpha Running = true; want false (exited)")
	}
	// zeta: explicit fields, networks filtered (bridge dropped) and sorted, identity.
	if zeta.Port != 8080 || zeta.Path != "/rpc" || zeta.Title != "Zeta" || zeta.Icon != "star" {
		t.Errorf("zeta fields = %+v; want port 8080/path /rpc/title Zeta/icon star", zeta)
	}
	if zeta.Project != "proj" || zeta.Service != "svc" {
		t.Errorf("zeta identity = %q/%q; want proj/svc", zeta.Project, zeta.Service)
	}
	if !reflect.DeepEqual(zeta.Networks, []string{"proj_default", "shared"}) {
		t.Errorf("zeta Networks = %v; want [proj_default shared] (bridge filtered, sorted)", zeta.Networks)
	}
	if zeta.Image != "z/plug:1" || zeta.ImageID != "sha256:zzz" || !zeta.Running {
		t.Errorf("zeta image/running = %q/%q/%v; want z/plug:1 / sha256:zzz / true", zeta.Image, zeta.ImageID, zeta.Running)
	}
}

// TestConnectors proves cloudflared discovery: tunnel id + friendly title (name
// fallback), the default flag, project + filtered networks, and the sort that
// floats the default connector to the top then orders by name.
func TestConnectors(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json") {
			writeJSON(w, []map[string]any{
				// non-default, has explicit title, on a user net + bridge.
				{"Id": "cf2", "Names": []string{"/hope-connector-b"}, "State": "running", "Image": "cloudflare/cloudflared:latest",
					"Labels":          map[string]string{labelTunnel: "tun-b", labelConnectorTitle: "Bravo", labelProject: "proj"},
					"NetworkSettings": map[string]any{"Networks": map[string]any{"bridge": map[string]any{}, "proj_default": map[string]any{}}}},
				// the default connector, no title -> name fallback.
				{"Id": "cf1", "Names": []string{"/hope-connector-a"}, "State": "exited", "Image": "cloudflare/cloudflared:latest",
					"Labels": map[string]string{labelTunnel: "tun-a", labelConnectorFirst: "1"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	conns, err := c.Connectors(t.Context())
	if err != nil {
		t.Fatalf("Connectors err: %v", err)
	}
	if len(conns) != 2 {
		t.Fatalf("Connectors = %d; want 2", len(conns))
	}
	// Default first regardless of name.
	def, other := conns[0], conns[1]
	if !def.Default || def.TunnelID != "tun-a" {
		t.Errorf("conns[0] = %+v; want the default (tun-a) first", def)
	}
	if def.Title != "hope-connector-a" {
		t.Errorf("default Title = %q; want name fallback hope-connector-a", def.Title)
	}
	if def.Running {
		t.Error("default Running = true; want false (exited)")
	}
	if other.Title != "Bravo" || other.Project != "proj" || other.TunnelID != "tun-b" {
		t.Errorf("other = %+v; want title Bravo / project proj / tunnel tun-b", other)
	}
	if !reflect.DeepEqual(other.Networks, []string{"proj_default"}) {
		t.Errorf("other Networks = %v; want [proj_default] (bridge filtered)", other.Networks)
	}
}

// TestImages proves the used-by reverse mapping (keyed by ImageID), the dangling
// detection + []-init of tags, registry derivation, and the largest-first sort.
func TestImages(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/images/json"):
			writeJSON(w, []image.Summary{
				{ID: "sha256:small", RepoTags: []string{"ghcr.io/toyz/app:latest"}, Size: 100, Created: 1},
				{ID: "sha256:big", RepoTags: []string{"nginx:latest"}, Size: 9000, Created: 2},
				{ID: "sha256:dangling", RepoTags: []string{"<none>:<none>"}, Size: 50, Created: 3},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, []map[string]any{
				{"Id": "c1", "Names": []string{"/nginx-1"}, "ImageID": "sha256:big",
					"Labels": map[string]string{labelService: "web", labelProject: "site"}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	imgs, err := c.Images(t.Context())
	if err != nil {
		t.Fatalf("Images err: %v", err)
	}
	if len(imgs) != 3 {
		t.Fatalf("Images = %d; want 3", len(imgs))
	}
	// Largest first: big (9000) > small (100) > dangling (50).
	if imgs[0].ID != "sha256:big" {
		t.Errorf("imgs[0].ID = %q; want sha256:big (largest first)", imgs[0].ID)
	}
	// big is in use by the nginx container.
	if !imgs[0].InUse || len(imgs[0].UsedBy) != 1 || imgs[0].UsedBy[0].Service != "web" {
		t.Errorf("big InUse/UsedBy = %v/%+v; want in-use by service web", imgs[0].InUse, imgs[0].UsedBy)
	}
	if imgs[0].Registry != "docker.io" {
		t.Errorf("big Registry = %q; want docker.io (nginx)", imgs[0].Registry)
	}
	// small: unused, ghcr registry, non-nil empty UsedBy.
	small := imgs[1]
	if small.ID != "sha256:small" || small.InUse || small.Registry != "ghcr.io" {
		t.Errorf("small = %+v; want unused ghcr.io image", small)
	}
	if small.UsedBy == nil || len(small.UsedBy) != 0 {
		t.Errorf("small UsedBy = %v; want a non-nil empty slice", small.UsedBy)
	}
	// dangling: untagged -> Dangling, Tags is [] (never nil).
	dang := imgs[2]
	if !dang.Dangling {
		t.Errorf("dangling Dangling = false; want true")
	}
	if dang.Tags == nil || len(dang.Tags) != 0 {
		t.Errorf("dangling Tags = %v; want a non-nil empty slice", dang.Tags)
	}
}
