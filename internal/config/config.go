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
}

// AgentConfig is the hub side: hope listens here for hope-agents dialing in
// from remote Docker hosts. Empty Listen disables the hub.
type AgentConfig struct {
	Listen string `mapstructure:"listen"` // hub address for incoming agents, e.g. ":9443"
	Token  string `mapstructure:"token"`  // shared enrollment secret an agent must present
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
	// CachePath optionally persists the freshness cache to disk so it survives
	// restarts. Empty = in-memory only. Mount this path to keep it across
	// container recreates (e.g. "/data/updates.json").
	CachePath string `mapstructure:"cache_path"`
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
	AccessTeam string `mapstructure:"access_team"` // the <team>.cloudflareaccess.com subdomain, e.g. "helba"
	AccessAUD  string `mapstructure:"access_aud"`  // the Access application's AUD tag
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
	return nil
}
