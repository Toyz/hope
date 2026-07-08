package pluginhost

import (
	"testing"

	"github.com/toyz/hope/internal/docker"
)

// TestInstallKeyMatchesIdentity locks the token invariant: the installer computes the
// identity key as host|project/service to derive HOPE_PLUGIN_TOKEN and inject it as
// env; discovery must later compute the SAME key from the deployed container's compose
// labels, or hope's token wouldn't match the plugin's pinned one.
func TestInstallKeyMatchesIdentity(t *testing.T) {
	host, project, service := "local", "tools", "redis-mon"
	installKey := host + "|" + project + "/" + service
	pc := docker.PluginContainer{Project: project, Service: service}
	if got := pluginIdentity(host, pc); got != installKey {
		t.Fatalf("install key %q != discovered identity %q — the injected token would not match", installKey, got)
	}
}

// TestReservedLabel locks the identity-spoofing defense: a catalog entry must never be
// able to set hope's plugin/compose/management labels (which the container identity +
// its bearer token derive from).
func TestReservedLabel(t *testing.T) {
	reserved := []string{
		"hope.plugin", "hope.plugin.port", "hope.plugin.title", "hope.plugin.icon",
		"com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.container-number",
		"io.podman.compose.project", "io.podman.compose.service", // podman identity fallback
		"ink.hope.managed", "ink.hope.tunnel",
	}
	for _, k := range reserved {
		if !reservedLabel(k) {
			t.Errorf("reservedLabel(%q) = false; want true (must be blocked from catalog entries)", k)
		}
	}
	allowed := []string{"app", "maintainer", "org.opencontainers.image.source", "team", "tier"}
	for _, k := range allowed {
		if reservedLabel(k) {
			t.Errorf("reservedLabel(%q) = true; want false (a normal user label)", k)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"Redis Mon":    "redis-mon",
		"  My_App  ":   "my_app",
		"a/b:c":        "a-b-c",
		"--trim--":     "trim",
		"Postgres 15!": "postgres-15",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q; want %q", in, got, want)
		}
	}
}
