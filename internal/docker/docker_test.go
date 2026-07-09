package docker

import (
	"reflect"
	"testing"

	"github.com/docker/docker/api/types/container"
)

// TestProjectServiceLabel locks compose-identity resolution, including the podman
// fallback: discovery + the plugin token key are built from these, so the docker
// label must win and podman's namespace must fill in when docker's is absent.
func TestProjectServiceLabel(t *testing.T) {
	if got := projectLabel(map[string]string{labelProject: "myapp"}); got != "myapp" {
		t.Errorf("projectLabel(docker) = %q; want myapp", got)
	}
	if got := projectLabel(map[string]string{podmanLabelProject: "pod"}); got != "pod" {
		t.Errorf("projectLabel(podman fallback) = %q; want pod", got)
	}
	if got := projectLabel(map[string]string{labelProject: "myapp", podmanLabelProject: "pod"}); got != "myapp" {
		t.Errorf("projectLabel = %q; docker must win over podman", got)
	}
	if got := projectLabel(nil); got != "" {
		t.Errorf("projectLabel(nil) = %q; want empty", got)
	}
	if got := serviceLabel(map[string]string{labelService: "svc"}); got != "svc" {
		t.Errorf("serviceLabel(docker) = %q; want svc", got)
	}
	if got := serviceLabel(map[string]string{podmanLabelService: "psvc"}); got != "psvc" {
		t.Errorf("serviceLabel(podman fallback) = %q; want psvc", got)
	}
}

// TestFormatPorts exercises the container.Port SDK type (bump-sensitive): dedupe +
// stable sort, published vs unpublished rendering.
func TestFormatPorts(t *testing.T) {
	ports := []container.Port{
		{PrivatePort: 8080, Type: "tcp"}, // unpublished
		{IP: "0.0.0.0", PublicPort: 80, PrivatePort: 8080, Type: "tcp"},
		{IP: "0.0.0.0", PublicPort: 80, PrivatePort: 8080, Type: "tcp"}, // duplicate of prev
	}
	got := formatPorts(ports)
	want := []string{"0.0.0.0:80->8080/tcp", "8080/tcp"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("formatPorts = %v; want %v", got, want)
	}
	if got := formatPorts(nil); len(got) != 0 {
		t.Errorf("formatPorts(nil) = %v; want empty", got)
	}
}

func TestHealthFromStatus(t *testing.T) {
	cases := map[string]string{
		"Up 2 hours (healthy)":            "healthy",
		"Up (unhealthy)":                  "unhealthy",
		"Up 5 seconds (health: starting)": "starting",
		"Up 3 days":                       "",
		"Exited (0) 1 hour ago":           "",
	}
	for in, want := range cases {
		if got := healthFromStatus(in); got != want {
			t.Errorf("healthFromStatus(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestSplitConfigFiles(t *testing.T) {
	got := splitConfigFiles("a.yml, b.yml ,,c.yml")
	want := []string{"a.yml", "b.yml", "c.yml"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitConfigFiles = %v; want %v", got, want)
	}
	if splitConfigFiles("") != nil {
		t.Error("splitConfigFiles(\"\") should be nil")
	}
}

func TestTruthy(t *testing.T) {
	for _, s := range []string{"true", "1", "yes", "on", " TRUE ", "On"} {
		if !truthy(s) {
			t.Errorf("truthy(%q) = false; want true", s)
		}
	}
	for _, s := range []string{"false", "0", "no", "off", "", "maybe"} {
		if truthy(s) {
			t.Errorf("truthy(%q) = true; want false", s)
		}
	}
}

func TestPluginNetAlias(t *testing.T) {
	// The dial name is the 12-char short id docker auto-registers on a user network —
	// no prefix, so a plain NetworkConnect resolves it.
	long := "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	if got := PluginNetAlias(long); got != "abcdef012345" {
		t.Errorf("PluginNetAlias(long) = %q; want abcdef012345", got)
	}
	if got := PluginNetAlias("abc"); got != "abc" {
		t.Errorf("PluginNetAlias(short) = %q; want abc", got)
	}
}

func TestWithManaged(t *testing.T) {
	if got := WithManaged(nil); !reflect.DeepEqual(got, map[string]string{LabelManaged: "1"}) {
		t.Errorf("WithManaged(nil) = %v; want just the managed label", got)
	}
	in := map[string]string{"app": "web"}
	got := WithManaged(in)
	if got[LabelManaged] != "1" || got["app"] != "web" {
		t.Errorf("WithManaged = %v; want managed=1 + app=web", got)
	}
	if _, ok := in[LabelManaged]; ok {
		t.Error("WithManaged must not mutate the caller's map")
	}
}

func TestRegistryHostFromImage(t *testing.T) {
	cases := map[string]string{
		"nginx":                          "docker.io",
		"library/nginx":                  "docker.io", // first segment has no dot/colon
		"ghcr.io/toyz/hope-redis:latest": "ghcr.io",
		"localhost:5000/img":             "localhost:5000",
		"registry-1.docker.io/x":         "docker.io", // folded to docker.io
		"GHCR.IO/toyz/img":               "ghcr.io",   // host case-folded (DNS is case-insensitive)
		"LOCALHOST/img":                  "localhost", // bare uppercase localhost still a registry host
	}
	for in, want := range cases {
		if got := registryHostFromImage(in); got != want {
			t.Errorf("registryHostFromImage(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestNormalizeRegistry(t *testing.T) {
	for _, in := range []string{"https://index.docker.io/v1/", "index.docker.io", "registry-1.docker.io", "docker.io", "Index.Docker.IO"} {
		if got := normalizeRegistry(in); got != "docker.io" {
			t.Errorf("normalizeRegistry(%q) = %q; want docker.io", in, got)
		}
	}
	// non-hub host is returned lowercased (case-insensitive DNS), not dropped
	if got := normalizeRegistry("GHCR.IO"); got != "ghcr.io" {
		t.Errorf("normalizeRegistry(GHCR.IO) = %q; want ghcr.io (lowercased)", got)
	}
}

// TestProtectedNetwork locks the delete guard: daemon-predefined nets and hope's own
// infrastructure bridges are undeletable; ordinary user + hope-managed STACK networks
// stay removable (the LabelSystem marker, not LabelManaged, is what protects).
func TestProtectedNetwork(t *testing.T) {
	for _, name := range []string{"bridge", "host", "none", "podman", PluginNetwork, hopeTunnelsNetwork} {
		if !protectedNetwork(name, nil) {
			t.Errorf("protectedNetwork(%q) = false; want true (undeletable)", name)
		}
	}
	// The label protects regardless of name (survives a rename / future infra net).
	if !protectedNetwork("anything", map[string]string{LabelSystem: "1"}) {
		t.Error("a network with LabelSystem must be protected")
	}
	// Deletable: user nets and hope's STACK networks (LabelManaged but NOT LabelSystem).
	cases := []struct {
		name   string
		labels map[string]string
	}{
		{"custom", nil},
		{"myapp_default", map[string]string{LabelManaged: "1"}},
	}
	for _, tc := range cases {
		if protectedNetwork(tc.name, tc.labels) {
			t.Errorf("protectedNetwork(%q, %v) = true; want false (should be deletable)", tc.name, tc.labels)
		}
	}
}
