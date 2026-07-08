// Package config loads hope's configuration from a TOML file via viper.
// The file is the source of truth; env vars (HOPE_*) override individual
// keys for container deploys. See config.example.toml for the full shape.
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config is the fully-resolved hope configuration.
type Config struct {
	Server      ServerConfig      `mapstructure:"server"`
	Auth        AuthConfig        `mapstructure:"auth"`
	Docker      DockerConfig      `mapstructure:"docker"`
	Compose     ComposeConfig     `mapstructure:"compose"`
	SocketProxy SocketProxyConfig `mapstructure:"socketproxy"`
	Log         LogConfig         `mapstructure:"log"`
	Updates     UpdatesConfig     `mapstructure:"updates"`
	Registries  []RegistryConfig  `mapstructure:"registry"`
	Agent       AgentConfig       `mapstructure:"agent"`
	Cloudflare  CloudflareConfig  `mapstructure:"cloudflare"`
	Store       StoreConfig       `mapstructure:"store"`
	Plugins     PluginsConfig     `mapstructure:"plugins"`
}

// PluginsConfig gates the container-plugin system: hope discovers containers that
// declare a JSON-RPC endpoint (labels hope.plugin.*) and renders their capabilities
// in the UI. A single capability flag; everything else (which plugins are trusted)
// lives in the UI + the embedded store. Default off. Requires the store mounted to
// persist approvals across restarts.
type PluginsConfig struct {
	Enabled bool `mapstructure:"enabled"`
	// Limits are the per-plugin safety caps that isolate the control plane from a
	// bad or hostile plugin. These are hope-owned (a plugin must NOT be able to
	// raise its own DoS ceiling) but operator-tunable here; zero fields fall back to
	// built-in defaults (see plugins.Limits.WithDefaults).
	Limits PluginLimitsConfig `mapstructure:"limits"`
	// AutoReapprove trusts a plugin's schema/image changes automatically: instead of
	// disabling an enabled plugin when its capabilities change (the default, secure
	// behaviour — a swapped container must be re-approved), hope silently re-records
	// the new fingerprint and keeps it enabled. For DEV loops where you iterate on your
	// OWN plugin and re-approving on every redeploy is pure friction. Leave off in prod.
	AutoReapprove bool `mapstructure:"auto_reapprove"`
	// Catalog configures the plugin marketplace: the built-in first-party plugins are
	// always installable; a remote manifest URL extends/overrides them.
	Catalog PluginCatalogConfig `mapstructure:"catalog"`
}

// PluginCatalogConfig configures the installable-plugin catalog. The built-in
// first-party entries need no config; each Repo points at a remote JSON manifest (same
// schema) that is fetched, cached, and merged over the built-ins — so the catalog is
// extensible from one or more upstream repos (like package sources) without shipping a
// new hope build. Later repos override earlier ones (and the built-ins) by entry id.
type PluginCatalogConfig struct {
	Repos []CatalogRepo `mapstructure:"repo"`
	// Refresh is how often to re-fetch every repo (0 = fetch once at boot + on-demand
	// only). Shared across repos.
	Refresh time.Duration `mapstructure:"refresh"`
}

// CatalogRepo is one remote catalog source.
type CatalogRepo struct {
	Name string `mapstructure:"name"` // display/source label (defaults to the URL)
	URL  string `mapstructure:"url"`  // JSON manifest URL
	// Trust allows THIS repo's entries to name images outside the first-party prefix.
	// Off by default: an untrusted repo's entry whose image isn't a trusted prefix is
	// dropped, so a compromised third-party manifest can't offer a hostile image.
	Trust bool `mapstructure:"trust_images"`
}

// PluginLimitsConfig is the operator-tunable safety envelope applied per plugin.
// Distinct from anything the plugin declares — presentation (page size, etc.) is
// plugin-level; these caps are the operator's control-plane protection.
type PluginLimitsConfig struct {
	MaxConcurrentCalls   int `mapstructure:"max_concurrent_calls"`
	MaxConcurrentStreams int `mapstructure:"max_concurrent_streams"`
	CallRatePerSec       int `mapstructure:"call_rate_per_sec"`
	CallBurst            int `mapstructure:"call_burst"`
	MaxFrameBytes        int `mapstructure:"max_frame_bytes"`
	MaxFramesPerSec      int `mapstructure:"max_frames_per_sec"`
}

// StoreConfig points at hope's optional embedded state db (bbolt). Empty Path =
// disabled: state isn't retained across a restart and everything still works.
// Mount it (e.g. "/data/hope.db") to persist the agent roster, freshness cache,
// deploy specs, and UI-added registry credentials in one file. Secret-bearing
// (registry creds are stored encrypted with token_secret) — written 0600.
type StoreConfig struct {
	Path string `mapstructure:"path"`
}

// AgentConfig is the hub side: hope listens here for hope-agents dialing in
// from remote Docker hosts. Empty Listen disables the hub.
type AgentConfig struct {
	// Token is the shared enrollment secret an agent must present. Setting it
	// enables the agent hub: a WebSocket endpoint (WSPath) on hope's main port
	// so agents can dial in over 443 through Cloudflare with no extra port.
	Token string `mapstructure:"token"`
	// WSPath is the path of that WebSocket endpoint (default "/agent/connect").
	WSPath string `mapstructure:"ws_path"`
	// Listen optionally also runs a RAW TCP hub listener on this address (e.g.
	// ":9443") for agents on a trusted LAN/overlay. Empty = WebSocket only.
	Listen string `mapstructure:"listen"`
	// Use, when set, makes hope drive a connected agent's Docker as its PRIMARY
	// source instead of the local socket — hope waits for that host-id to dial
	// in at boot. (Single-host for now; the multi-host switcher comes next.)
	Use string `mapstructure:"use"`
}

// RegistryConfig is an explicit registry credential. hope only reads inline
// `auth` from a docker config.json (credential helpers / credsStore keep secrets
// outside the file and aren't runnable in hope's minimal container), so this is
// the reliable way to authenticate pulls — e.g. a Docker Hub account + access
// token to avoid anonymous rate limits.
type RegistryConfig struct {
	Server   string `mapstructure:"server"` // "docker.io", "ghcr.io", "registry.example.com:5000"
	Username string `mapstructure:"username"`
	Password string `mapstructure:"password"` // password or access token / PAT
}

// UpdatesConfig controls the background image-freshness crawler that powers the
// dashboard "updates" section.
type UpdatesConfig struct {
	// Enabled toggles the crawler. Disabled = the updates section stays empty
	// (avoids registry traffic / rate limits if you don't want it).
	Enabled bool `mapstructure:"enabled"`
	// Interval between cluster-wide crawls. Mind Docker Hub anonymous rate
	// limits; a few hours is sensible.
	Interval time.Duration `mapstructure:"interval"`
}

// LogConfig configures the request logger.
type LogConfig struct {
	JSON  bool `mapstructure:"json"`  // structured JSON lines instead of text
	Color bool `mapstructure:"color"` // ANSI colors (terminals)
}

// ServerConfig is the HTTP listener for the API + embedded SPA.
type ServerConfig struct {
	Addr string `mapstructure:"addr"`
}

// AuthConfig holds the single login credential and token-signing secret.
// Password may be a bcrypt hash ("$2a$...") or, for v1 convenience, plaintext.
type AuthConfig struct {
	Username    string        `mapstructure:"username"`
	Password    string        `mapstructure:"password"`
	TokenSecret string        `mapstructure:"token_secret"`
	TokenTTL    time.Duration `mapstructure:"token_ttl"`
	// Cloudflare Access SSO (optional). When both are set, a request that
	// already passed Access (carrying a valid Cf-Access-Jwt-Assertion) is
	// signed straight into hope — no second login. The password login stays as
	// the fallback for LAN/ZeroTier where Access isn't in front.
	AccessTeam string `mapstructure:"access_team"` // the <team>.cloudflareaccess.com subdomain, e.g. "yourteam"
	AccessAUD  string `mapstructure:"access_aud"`  // the Access application's AUD tag
	// APIKeys are static secrets for headless RPC access. A request presenting one
	// as its bearer token is authenticated (as subject "api") without logging in —
	// for scripts/CI. Empty = the API stays login-only. Keep these secret.
	APIKeys []string `mapstructure:"api_keys"`
}

// DockerConfig points hope's Docker client at an endpoint. A unix socket
// (mounted into the container) or a remote tcp:// daemon both work.
type DockerConfig struct {
	Host string `mapstructure:"host"`
	// Config is the path to a docker config.json for private-registry pull
	// credentials. Empty resolves to $DOCKER_CONFIG or ~/.docker/config.json.
	Config string `mapstructure:"config"`
}

// ComposeConfig optionally restricts which on-disk compose project roots
// hope will operate on. Empty Roots = trust the compose labels as-is.
type ComposeConfig struct {
	Roots []string `mapstructure:"roots"`
}

// CloudflareConfig enables the opt-in tunnels domain: hope manages a
// remotely-managed Cloudflare tunnel's ingress + the matching DNS records via
// the Cloudflare API, so public routes can be added/removed per stack without
// touching the dashboard. hope does NOT run cloudflared — you run one connector
// (labeled ink.hope.tunnel=<tunnel-id>) and hope manages its routes.
type CloudflareConfig struct {
	Enabled bool `mapstructure:"enabled"`
	// APIToken needs two policies: Account -> Cloudflare Tunnel: Edit, and
	// All zones -> DNS: Edit + Zone: Read. A secret — never logged.
	APIToken string `mapstructure:"api_token"`
	// AccountID is the Cloudflare account the tunnel lives under.
	AccountID string `mapstructure:"account_id"`
}

// SocketProxyConfig configures the opt-in LAN-facing reverse proxy that
// forwards the Docker API to the unix socket behind a method/path allowlist.
type SocketProxyConfig struct {
	Enabled      bool     `mapstructure:"enabled"`
	Listen       string   `mapstructure:"listen"`
	AllowMethods []string `mapstructure:"allow_methods"`
	AllowPaths   []string `mapstructure:"allow_paths"`
}

// Load reads the TOML file at path (extension optional), applies HOPE_*
// env overrides, fills defaults, and validates required fields.
func Load(path string) (*Config, error) {
	v := viper.New()
	v.SetConfigFile(path)
	v.SetConfigType("toml")

	setDefaults(v)

	v.SetEnvPrefix("HOPE")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("read config %q: %w", path, err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("server.addr", ":8080")
	v.SetDefault("docker.host", "unix:///var/run/docker.sock")
	v.SetDefault("auth.token_ttl", "24h")
	v.SetDefault("log.color", true)
	v.SetDefault("updates.enabled", true)
	v.SetDefault("updates.interval", "6h")
	v.SetDefault("plugins.catalog.refresh", "12h")
	v.SetDefault("socketproxy.enabled", false)
	v.SetDefault("socketproxy.listen", ":2375")
	v.SetDefault("socketproxy.allow_methods", []string{"GET", "HEAD"})
	v.SetDefault("socketproxy.allow_paths", []string{
		"/_ping", "/version", "/info",
		"/v1.*/containers/*", "/v1.*/images/*",
	})
}

func (c *Config) validate() error {
	if c.Auth.Username == "" || c.Auth.Password == "" {
		return fmt.Errorf("config: auth.username and auth.password are required")
	}
	if c.Auth.TokenSecret == "" {
		return fmt.Errorf("config: auth.token_secret is required (HMAC signing key)")
	}
	if c.Auth.TokenTTL <= 0 {
		c.Auth.TokenTTL = 24 * time.Hour
	}
	if c.Docker.Host == "" {
		return fmt.Errorf("config: docker.host is required")
	}
	if c.Updates.Interval <= 0 {
		c.Updates.Interval = 6 * time.Hour
	}
	if c.Cloudflare.Enabled {
		if c.Cloudflare.APIToken == "" || c.Cloudflare.AccountID == "" {
			return fmt.Errorf("config: cloudflare.api_token and cloudflare.account_id are required when cloudflare.enabled")
		}
	}
	return nil
}
