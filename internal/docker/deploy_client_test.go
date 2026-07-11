package docker

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/strslice"
	"github.com/docker/go-connections/nat"
	"github.com/toyz/hope/internal/stackspec"
)

// containerID picks the container id out of an inspect path /vX/containers/{id}/json.
func inspectID(path string) string {
	p := strings.TrimSuffix(path, "/json")
	return p[strings.LastIndex(p, "/")+1:]
}

// TestSpecFromInspect locks the inspect -> ContainerSpec translation directly (a
// pure function): config/hostconfig/mounts/networks map across, live IPs and the
// auto DNS aliases (service name, container name, short id) are stripped so only
// USER aliases survive, and compose/hope-internal labels are filtered out.
func TestSpecFromInspect(t *testing.T) {
	p80, _ := nat.NewPort("tcp", "80")
	info := container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{
			ID:   "abcdef0123456789abcdef",
			Name: "/myproj-web-1",
			HostConfig: &container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyAlways},
				Privileged:    true,
				CapAdd:        strslice.StrSlice{"NET_ADMIN"},
				ExtraHosts:    []string{"host.internal:1.2.3.4"},
				PortBindings:  nat.PortMap{p80: []nat.PortBinding{{HostIP: "0.0.0.0", HostPort: "8080"}}},
			},
		},
		Config: &container.Config{
			Image:      "nginx:latest",
			Entrypoint: strslice.StrSlice{"/docker-entrypoint.sh"},
			Cmd:        strslice.StrSlice{"nginx", "-g", "daemon off;"},
			Env:        []string{"A=1", "B=2"},
			User:       "www-data",
			WorkingDir: "/app",
			Labels: map[string]string{
				"com.docker.compose.project": "myproj",
				"com.docker.compose.service": "web",
				"ink.hope.managed":           "1",
				"tier":                       "frontend",
			},
			Healthcheck: &container.HealthConfig{Test: []string{"CMD", "curl", "-f", "localhost"}, Interval: 5 * time.Second, Retries: 3},
		},
		NetworkSettings: &container.NetworkSettings{
			Networks: map[string]*network.EndpointSettings{
				// auto aliases (svc, container name, short id) must be dropped; only "vip" survives.
				"myproj_default": {Aliases: []string{"web", "myproj-web-1", "abcdef012345", "vip"}},
				"bridge":         {}, // predefined net filtered out entirely
			},
		},
		Mounts: []container.MountPoint{
			{Type: mount.TypeVolume, Name: "data", Destination: "/var/lib/data", RW: true},
			{Type: mount.TypeBind, Source: "/host/conf", Destination: "/etc/conf", RW: false},
			{Type: mount.TypeVolume, Name: "anon", Destination: "", RW: true}, // no target -> dropped
		},
	}

	cs := specFromInspect(info, "web")

	if cs.Name != "web" || cs.Image != "nginx:latest" || cs.User != "www-data" || cs.WorkingDir != "/app" {
		t.Errorf("basics = %+v; want name web / nginx:latest / www-data / /app", cs)
	}
	if !reflect.DeepEqual(cs.Entrypoint, []string{"/docker-entrypoint.sh"}) {
		t.Errorf("Entrypoint = %v", cs.Entrypoint)
	}
	if !reflect.DeepEqual(cs.Command, []string{"nginx", "-g", "daemon off;"}) {
		t.Errorf("Command = %v", cs.Command)
	}
	if !reflect.DeepEqual(cs.Env, map[string]string{"A": "1", "B": "2"}) {
		t.Errorf("Env = %v", cs.Env)
	}
	// compose + hope labels dropped, user label kept.
	if !reflect.DeepEqual(cs.Labels, map[string]string{"tier": "frontend"}) {
		t.Errorf("Labels = %v; want only tier=frontend", cs.Labels)
	}
	if cs.Restart != "always" || !cs.Privileged {
		t.Errorf("Restart/Privileged = %q/%v; want always/true", cs.Restart, cs.Privileged)
	}
	if !reflect.DeepEqual(cs.CapAdd, []string{"NET_ADMIN"}) || !reflect.DeepEqual(cs.ExtraHosts, []string{"host.internal:1.2.3.4"}) {
		t.Errorf("CapAdd/ExtraHosts = %v/%v", cs.CapAdd, cs.ExtraHosts)
	}
	// health round-trips to the string form.
	if cs.Health == nil || cs.Health.Interval != "5s" || cs.Health.Retries != 3 {
		t.Errorf("Health = %+v; want interval 5s retries 3", cs.Health)
	}
	// ports.
	wantPorts := []stackspec.PortMap{{Host: "8080", HostIP: "0.0.0.0", Container: "80", Protocol: "tcp"}}
	if !reflect.DeepEqual(cs.Ports, wantPorts) {
		t.Errorf("Ports = %+v; want %+v", cs.Ports, wantPorts)
	}
	// mounts: volume uses Name as source, bind uses Source, ReadOnly = !RW, anon dropped.
	wantMounts := []stackspec.MountSpec{
		{Type: "volume", Source: "data", Target: "/var/lib/data", ReadOnly: false},
		{Type: "bind", Source: "/host/conf", Target: "/etc/conf", ReadOnly: true},
	}
	if !reflect.DeepEqual(cs.Mounts, wantMounts) {
		t.Errorf("Mounts = %+v; want %+v", cs.Mounts, wantMounts)
	}
	// networks: bridge filtered; only the user net remains with just the custom alias.
	if !reflect.DeepEqual(cs.Networks, []string{"myproj_default"}) {
		t.Errorf("Networks = %v; want [myproj_default]", cs.Networks)
	}
	if !reflect.DeepEqual(cs.Aliases, map[string][]string{"myproj_default": {"vip"}}) {
		t.Errorf("Aliases = %v; want myproj_default->[vip] (auto aliases stripped)", cs.Aliases)
	}
}

// TestContainerSpecOf proves the daemon path: name resolves to the compose service
// when labelled (else the container name), then specFromInspect fills the rest.
func TestContainerSpecOf(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json") {
			writeJSON(w, map[string]any{
				"Id":     "web1",
				"Name":   "/blog-web-1",
				"Config": map[string]any{"Image": "nginx:latest", "Labels": map[string]string{labelService: "web", labelProject: "blog"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	cs, err := c.ContainerSpecOf(t.Context(), "web1")
	if err != nil {
		t.Fatalf("ContainerSpecOf err: %v", err)
	}
	if cs.Name != "web" { // the compose service label wins over the container name
		t.Errorf("Name = %q; want web (service label)", cs.Name)
	}
	if cs.Image != "nginx:latest" {
		t.Errorf("Image = %q; want nginx:latest", cs.Image)
	}
}

// TestContainerSpecOfNameFallback proves that with no service label the container
// name (minus the leading slash) is used as the spec name.
func TestContainerSpecOfNameFallback(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/json") {
			writeJSON(w, map[string]any{"Id": "loose", "Name": "/loner", "Config": map[string]any{"Image": "redis"}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	cs, err := c.ContainerSpecOf(t.Context(), "loose")
	if err != nil {
		t.Fatalf("ContainerSpecOf err: %v", err)
	}
	if cs.Name != "loner" {
		t.Errorf("Name = %q; want loner (name fallback)", cs.Name)
	}
}

// TestProjectSpec proves stack reconstruction from live containers: containers are
// selected by project label, replicas of a service collapse to one entry, services
// sort by name, and every referenced network/volume is emitted as an External spec.
func TestProjectSpec(t *testing.T) {
	// container list (projectList filters by project label); "other" is a decoy.
	list := []map[string]any{
		{"Id": "web1", "Names": []string{"/blog-web-1"}, "Labels": map[string]string{labelProject: "blog", labelService: "web", labelNumber: "1"}},
		{"Id": "web2", "Names": []string{"/blog-web-2"}, "Labels": map[string]string{labelProject: "blog", labelService: "web", labelNumber: "2"}},
		{"Id": "db1", "Names": []string{"/blog-db-1"}, "Labels": map[string]string{labelProject: "blog", labelService: "db", labelNumber: "1"}},
		{"Id": "other1", "Names": []string{"/shop-web-1"}, "Labels": map[string]string{labelProject: "shop", labelService: "web"}},
	}
	inspects := map[string]map[string]any{
		"web1": {"Id": "web1", "Name": "/blog-web-1",
			"Config":          map[string]any{"Image": "nginx", "Labels": map[string]string{labelService: "web", labelProject: "blog"}},
			"NetworkSettings": map[string]any{"Networks": map[string]any{"blog_default": map[string]any{}}},
			"Mounts":          []map[string]any{{"Type": "volume", "Name": "webdata", "Destination": "/data", "RW": true}}},
		"web2": {"Id": "web2", "Name": "/blog-web-2",
			"Config": map[string]any{"Image": "nginx", "Labels": map[string]string{labelService: "web", labelProject: "blog"}}},
		"db1": {"Id": "db1", "Name": "/blog-db-1",
			"Config":          map[string]any{"Image": "postgres", "Labels": map[string]string{labelService: "db", labelProject: "blog"}},
			"NetworkSettings": map[string]any{"Networks": map[string]any{"blog_default": map[string]any{}}},
			"Mounts":          []map[string]any{{"Type": "volume", "Name": "dbdata", "Destination": "/var/lib", "RW": true}}},
	}

	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			writeJSON(w, list)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json"):
			id := inspectID(r.URL.Path)
			if insp, ok := inspects[id]; ok {
				writeJSON(w, insp)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	spec, err := c.ProjectSpec(t.Context(), "blog")
	if err != nil {
		t.Fatalf("ProjectSpec err: %v", err)
	}
	if spec.Name != "blog" {
		t.Errorf("spec.Name = %q; want blog", spec.Name)
	}
	// two services (web's replica collapsed), sorted by name: db, web.
	if len(spec.Services) != 2 {
		t.Fatalf("Services = %d; want 2 (db, web — replica collapsed)", len(spec.Services))
	}
	if spec.Services[0].Name != "db" || spec.Services[1].Name != "web" {
		t.Errorf("service order = [%s %s]; want [db web]", spec.Services[0].Name, spec.Services[1].Name)
	}
	// the shared network is emitted once as External.
	if len(spec.Networks) != 1 || spec.Networks[0].Name != "blog_default" || !spec.Networks[0].External {
		t.Errorf("Networks = %+v; want one External blog_default", spec.Networks)
	}
	// both volumes emitted, sorted, External.
	wantVols := []stackspec.VolumeSpec{{Name: "dbdata", External: true}, {Name: "webdata", External: true}}
	if !reflect.DeepEqual(spec.Volumes, wantVols) {
		t.Errorf("Volumes = %+v; want %+v", spec.Volumes, wantVols)
	}
}
