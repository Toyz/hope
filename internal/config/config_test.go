package config

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// writeConfig writes contents to a temp .toml file and returns its path.
func writeConfig(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hope.toml")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

// The minimal set of required keys for validate() to pass.
const validAuth = `
[auth]
username = "admin"
password = "s3cret"
token_secret = "hmac-signing-key"
`

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(writeConfig(t, validAuth))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// Defaults from setDefaults + validate.
	checks := []struct {
		name string
		got  any
		want any
	}{
		{"server.addr", cfg.Server.Addr, ":8080"},
		{"docker.host", cfg.Docker.Host, "unix:///var/run/docker.sock"},
		{"auth.token_ttl", cfg.Auth.TokenTTL, 24 * time.Hour},
		{"log.color", cfg.Log.Color, true},
		{"updates.enabled", cfg.Updates.Enabled, true},
		{"updates.interval", cfg.Updates.Interval, 6 * time.Hour},
		{"plugins.catalog.refresh", cfg.Plugins.Catalog.Refresh, 12 * time.Hour},
		{"socketproxy.enabled", cfg.SocketProxy.Enabled, false},
		{"socketproxy.listen", cfg.SocketProxy.Listen, ":2375"},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}
	if want := []string{"GET", "HEAD"}; !slices.Equal(cfg.SocketProxy.AllowMethods, want) {
		t.Errorf("socketproxy.allow_methods = %v, want %v", cfg.SocketProxy.AllowMethods, want)
	}
	if len(cfg.SocketProxy.AllowPaths) == 0 {
		t.Error("socketproxy.allow_paths default is empty")
	}
}

func TestLoadParsesValues(t *testing.T) {
	cfg, err := Load(writeConfig(t, validAuth+`
[server]
addr = ":9000"

[docker]
host = "tcp://10.0.0.1:2376"

[updates]
enabled = false
interval = "2h"

[[registry]]
server = "ghcr.io"
username = "bob"
password = "pat-token"

[plugins]
enabled = true
auto_reapprove = true

[plugins.catalog]
refresh = "30m"

[[plugins.catalog.repo]]
name = "extra"
url = "https://example.com/catalog.json"
trust_images = true

[agent]
token = "enroll"
ws_path = "/agent/connect"
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.Addr != ":9000" {
		t.Errorf("server.addr = %q", cfg.Server.Addr)
	}
	if cfg.Docker.Host != "tcp://10.0.0.1:2376" {
		t.Errorf("docker.host = %q", cfg.Docker.Host)
	}
	if cfg.Updates.Enabled {
		t.Error("updates.enabled should be false")
	}
	if cfg.Updates.Interval != 2*time.Hour {
		t.Errorf("updates.interval = %v, want 2h", cfg.Updates.Interval)
	}
	if len(cfg.Registries) != 1 || cfg.Registries[0].Server != "ghcr.io" || cfg.Registries[0].Password != "pat-token" {
		t.Errorf("registry = %+v", cfg.Registries)
	}
	if !cfg.Plugins.Enabled || !cfg.Plugins.AutoReapprove {
		t.Errorf("plugins flags = %+v", cfg.Plugins)
	}
	if cfg.Plugins.Catalog.Refresh != 30*time.Minute {
		t.Errorf("catalog.refresh = %v, want 30m", cfg.Plugins.Catalog.Refresh)
	}
	if len(cfg.Plugins.Catalog.Repos) != 1 {
		t.Fatalf("catalog repos = %+v", cfg.Plugins.Catalog.Repos)
	}
	repo := cfg.Plugins.Catalog.Repos[0]
	if repo.Name != "extra" || repo.URL != "https://example.com/catalog.json" || !repo.Trust {
		t.Errorf("catalog repo = %+v", repo)
	}
	if cfg.Agent.Token != "enroll" || cfg.Agent.WSPath != "/agent/connect" {
		t.Errorf("agent = %+v", cfg.Agent)
	}
}

func TestLoadErrors(t *testing.T) {
	cases := []struct {
		name    string
		toml    string
		path    string // if set, use this path instead of writing toml
		wantErr string
	}{
		{
			name:    "missing file",
			path:    filepath.Join(t.TempDir(), "does-not-exist.toml"),
			wantErr: "read config",
		},
		{
			name:    "malformed toml",
			toml:    "[auth\nusername = ",
			wantErr: "read config",
		},
		{
			name:    "missing username and password",
			toml:    "[auth]\ntoken_secret = \"k\"\n",
			wantErr: "auth.username and auth.password are required",
		},
		{
			name:    "missing password",
			toml:    "[auth]\nusername = \"admin\"\ntoken_secret = \"k\"\n",
			wantErr: "auth.username and auth.password are required",
		},
		{
			name:    "missing token_secret",
			toml:    "[auth]\nusername = \"admin\"\npassword = \"p\"\n",
			wantErr: "auth.token_secret is required",
		},
		{
			name:    "empty docker.host",
			toml:    validAuth + "\n[docker]\nhost = \"\"\n",
			wantErr: "docker.host is required",
		},
		{
			name:    "cloudflare enabled without token",
			toml:    validAuth + "\n[cloudflare]\nenabled = true\naccount_id = \"acct\"\n",
			wantErr: "cloudflare.api_token and cloudflare.account_id are required",
		},
		{
			name:    "cloudflare enabled without account",
			toml:    validAuth + "\n[cloudflare]\nenabled = true\napi_token = \"tok\"\n",
			wantErr: "cloudflare.api_token and cloudflare.account_id are required",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := c.path
			if path == "" {
				path = writeConfig(t, c.toml)
			}
			_, err := Load(path)
			if err == nil {
				t.Fatalf("Load succeeded, want error containing %q", c.wantErr)
			}
			if !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("Load error = %q, want containing %q", err.Error(), c.wantErr)
			}
		})
	}
}

// validate() coerces non-positive durations to their defaults rather than erroring.
func TestValidateCoercesNonPositiveDurations(t *testing.T) {
	cfg, err := Load(writeConfig(t, `
[auth]
username = "admin"
password = "s3cret"
token_secret = "hmac-signing-key"
token_ttl = "0s"

[updates]
interval = "-1s"
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Auth.TokenTTL != 24*time.Hour {
		t.Errorf("token_ttl = %v, want coerced to 24h", cfg.Auth.TokenTTL)
	}
	if cfg.Updates.Interval != 6*time.Hour {
		t.Errorf("updates.interval = %v, want coerced to 6h", cfg.Updates.Interval)
	}
}

func TestCloudflareEnabledValid(t *testing.T) {
	cfg, err := Load(writeConfig(t, validAuth+`
[cloudflare]
enabled = true
api_token = "tok"
account_id = "acct"
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Cloudflare.Enabled || cfg.Cloudflare.APIToken != "tok" || cfg.Cloudflare.AccountID != "acct" {
		t.Errorf("cloudflare = %+v", cfg.Cloudflare)
	}
}

// A HOPE_* env var overrides the corresponding key (keys carry a default so they
// are known to viper's AutomaticEnv).
func TestEnvOverride(t *testing.T) {
	t.Setenv("HOPE_SERVER_ADDR", ":7777")
	cfg, err := Load(writeConfig(t, validAuth+`
[server]
addr = ":9000"
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.Addr != ":7777" {
		t.Errorf("server.addr = %q, want env override :7777", cfg.Server.Addr)
	}
}
