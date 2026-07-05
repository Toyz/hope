package docker

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/registry"
)

// RegistrySource records where a credential came from, so the UI can show
// config-loaded registries as read-only and only let the operator edit/remove
// the ones they added at runtime.
type RegistrySource string

const (
	// RegistrySourceConfig: from config.json or [[registry]] — read-only in the UI.
	RegistrySourceConfig RegistrySource = "config"
	// RegistrySourceDB: added at runtime (persisted in the state db) — editable.
	RegistrySourceDB RegistrySource = "db"
)

// regCred is an explicit registry credential (not from a credential helper).
type regCred struct {
	server, user, pass string
	source             RegistrySource
}

// RegistryEntry is the credential-free view of a known registry for the UI.
type RegistryEntry struct {
	Server      string
	Username    string
	HasPassword bool
	Source      RegistrySource
}

// Registry auth. The Docker daemon does not apply the CLI's stored credentials
// to API pulls — the CLI reads ~/.docker/config.json and forwards them as
// X-Registry-Auth. hope does the same: load a docker config.json, and attach
// the matching credential to each ImagePull.

// dockerConfig is the subset of ~/.docker/config.json we read.
type dockerConfig struct {
	Auths map[string]struct {
		Auth     string `json:"auth"`     // base64(user:pass)
		Username string `json:"username"` // some configs split it out
		Password string `json:"password"`
	} `json:"auths"`
}

// registryAuthHeader is the base64url(JSON) X-Registry-Auth value the daemon
// expects for a pull.
type registryAuthHeader struct {
	Username      string `json:"username,omitempty"`
	Password      string `json:"password,omitempty"`
	ServerAddress string `json:"serveraddress,omitempty"`
}

// resolveConfigPath resolves a docker config.json path; empty falls back to
// $DOCKER_CONFIG/config.json or ~/.docker/config.json.
func resolveConfigPath(path string) string {
	if path != "" {
		return path
	}
	if dc := os.Getenv("DOCKER_CONFIG"); dc != "" {
		return filepath.Join(dc, "config.json")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".docker", "config.json")
	}
	// scratch has no /etc/passwd and may have no $HOME, so UserHomeDir fails —
	// fall back to the conventional root path (where the socket-host's
	// config.json is usually mounted).
	return "/root/.docker/config.json"
}

// readDockerAuths parses inline credentials from a docker config.json into a
// registry-host -> X-Registry-Auth map. A missing file or a credential-helper /
// credsStore setup (secrets kept outside the file) yields an empty map.
func readDockerAuths(path string) map[string]string {
	out := map[string]string{}
	if path == "" {
		return out
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var cfg dockerConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return out
	}
	for registry, entry := range cfg.Auths {
		user, pass := entry.Username, entry.Password
		if entry.Auth != "" {
			if dec, err := base64.StdEncoding.DecodeString(entry.Auth); err == nil {
				if u, p, ok := strings.Cut(string(dec), ":"); ok {
					user, pass = u, p
				}
			}
		}
		if user == "" && pass == "" {
			continue
		}
		out[normalizeRegistry(registry)] = encodeAuth(user, pass, registry)
	}
	return out
}

func encodeAuth(user, pass, server string) string {
	hdr, _ := json.Marshal(registryAuthHeader{Username: user, Password: pass, ServerAddress: server})
	return base64.URLEncoding.EncodeToString(hdr)
}

// initAuths resolves the config path, records its checksum, and builds the
// initial merged auth map.
func (c *Client) initAuths(configPath string) {
	c.authPath = resolveConfigPath(configPath)
	if data, err := os.ReadFile(c.authPath); err == nil {
		c.authSum = sha256.Sum256(data)
	}
	c.reloadAuths()
}

// reloadAuths rebuilds the merged auth map: config.json entries first, the
// explicit [[registry]] creds layered on top (config always wins).
func (c *Client) reloadAuths() {
	configAuths := readDockerAuths(c.authPath)
	merged := make(map[string]string, len(configAuths))
	for k, v := range configAuths {
		merged[k] = v
	}
	c.authMu.RLock()
	creds := append([]regCred(nil), c.regCreds...)
	c.authMu.RUnlock()
	for _, r := range creds {
		merged[normalizeRegistry(r.server)] = encodeAuth(r.user, r.pass, r.server)
	}
	c.authMu.Lock()
	c.auths = merged
	c.configAuths = configAuths
	c.authMu.Unlock()
}

// AddRegistryCreds registers an explicit registry credential and rebuilds the
// auth map. Works without a credential helper. source tags where it came from
// (config vs runtime db) so the UI can gate editing. Re-adding the same server
// upserts (replacing any prior entry for that host).
func (c *Client) AddRegistryCreds(server, user, pass string, source RegistrySource) {
	if user == "" && pass == "" {
		return
	}
	c.authMu.Lock()
	norm := normalizeRegistry(server)
	next := c.regCreds[:0]
	for _, r := range c.regCreds {
		if normalizeRegistry(r.server) != norm {
			next = append(next, r)
		}
	}
	c.regCreds = append(next, regCred{server: server, user: user, pass: pass, source: source})
	c.authMu.Unlock()
	c.reloadAuths()
}

// VerifyRegistry checks a credential against the registry by performing a login
// (auth handshake only, no image pull), so the UI can reject bad creds at add
// time instead of failing silently on the next pull. Returns nil when the creds
// authenticate.
func (c *Client) VerifyRegistry(ctx context.Context, server, user, pass string) error {
	_, err := c.sdk().RegistryLogin(ctx, registry.AuthConfig{
		Username:      user,
		Password:      pass,
		ServerAddress: normalizeRegistry(server),
	})
	return err
}

// RemoveRegistryCreds drops a runtime (db) credential for a server and rebuilds
// the auth map. Config-sourced creds are left untouched (read-only). Reports
// whether anything was removed.
func (c *Client) RemoveRegistryCreds(server string) bool {
	norm := normalizeRegistry(server)
	c.authMu.Lock()
	removed := false
	next := c.regCreds[:0]
	for _, r := range c.regCreds {
		if r.source == RegistrySourceDB && normalizeRegistry(r.server) == norm {
			removed = true
			continue
		}
		next = append(next, r)
	}
	c.regCreds = next
	c.authMu.Unlock()
	if removed {
		c.reloadAuths()
	}
	return removed
}

// IsConfigRegistry reports whether a server's credential is config-sourced
// (config.json or [[registry]]) and therefore read-only. Used to reject UI edits
// that would shadow a config entry.
func (c *Client) IsConfigRegistry(server string) bool {
	norm := normalizeRegistry(server)
	c.authMu.RLock()
	defer c.authMu.RUnlock()
	for _, r := range c.regCreds {
		if r.source == RegistrySourceConfig && normalizeRegistry(r.server) == norm {
			return true
		}
	}
	// A host present in config.json (but not [[registry]]) is config-sourced too.
	if _, ok := c.configAuths[norm]; ok {
		return true
	}
	return false
}

// RegistryList returns the credential-free view of every known registry (config
// + runtime), sorted by server, for the UI. Passwords are never included.
func (c *Client) RegistryList() []RegistryEntry {
	c.authMu.RLock()
	defer c.authMu.RUnlock()
	byServer := map[string]RegistryEntry{}
	// config.json hosts first (source=config); a matching regCred overlays below.
	for host, hdr := range c.configAuths {
		user, hasPass := decodeAuthHeader(hdr)
		byServer[host] = RegistryEntry{Server: host, Username: user, HasPassword: hasPass, Source: RegistrySourceConfig}
	}
	for _, r := range c.regCreds {
		byServer[normalizeRegistry(r.server)] = RegistryEntry{
			Server:      normalizeRegistry(r.server),
			Username:    r.user,
			HasPassword: r.pass != "",
			Source:      r.source,
		}
	}
	out := make([]RegistryEntry, 0, len(byServer))
	for _, e := range byServer {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Server < out[j].Server })
	return out
}

// decodeAuthHeader pulls the username and password-presence out of an encoded
// X-Registry-Auth header (best-effort; empty on any decode failure).
func decodeAuthHeader(hdr string) (user string, hasPassword bool) {
	raw, err := base64.URLEncoding.DecodeString(hdr)
	if err != nil {
		return "", false
	}
	var h registryAuthHeader
	if err := json.Unmarshal(raw, &h); err != nil {
		return "", false
	}
	return h.Username, h.Password != ""
}

// StartCredWatcher polls the config.json checksum and reloads credentials when
// it changes, so a fresh `docker login` takes effect without restarting hope.
func (c *Client) StartCredWatcher(ctx context.Context, every time.Duration) {
	if c.authPath == "" {
		return
	}
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				var sum [sha256.Size]byte
				if data, err := os.ReadFile(c.authPath); err == nil {
					sum = sha256.Sum256(data)
				}
				if sum != c.authSum {
					c.authSum = sum
					c.reloadAuths()
				}
			}
		}
	}()
}

// registryAuth returns the X-Registry-Auth header for an image ref, or "".
func (c *Client) registryAuth(image string) string {
	c.authMu.RLock()
	defer c.authMu.RUnlock()
	return c.auths[registryHostFromImage(image)]
}

// AuthedRegistries lists the registries hope currently has credentials for —
// a startup diagnostic so "still rate-limited?" has an obvious answer.
func (c *Client) AuthedRegistries() []string {
	c.authMu.RLock()
	defer c.authMu.RUnlock()
	out := make([]string, 0, len(c.auths))
	for k := range c.auths {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// registryHostFromImage extracts the registry host from an image reference,
// defaulting to docker.io when none is present.
func registryHostFromImage(image string) string {
	first, _, ok := strings.Cut(image, "/")
	if !ok {
		return "docker.io"
	}
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		return normalizeRegistry(first)
	}
	return "docker.io"
}

// normalizeRegistry folds Docker Hub's several spellings to "docker.io".
func normalizeRegistry(r string) string {
	switch r {
	case "https://index.docker.io/v1/", "index.docker.io", "registry-1.docker.io", "docker.io":
		return "docker.io"
	}
	return r
}
