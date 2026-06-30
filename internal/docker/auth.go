package docker

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// regCred is an explicit registry credential from config ([[registry]]).
type regCred struct{ server, user, pass string }

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
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".docker", "config.json")
	}
	return ""
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
	merged := readDockerAuths(c.authPath)
	for _, r := range c.regCreds {
		merged[normalizeRegistry(r.server)] = encodeAuth(r.user, r.pass, r.server)
	}
	c.authMu.Lock()
	c.auths = merged
	c.authMu.Unlock()
}

// AddRegistryCreds registers an explicit registry credential (from config) and
// rebuilds the auth map. Works without a credential helper.
func (c *Client) AddRegistryCreds(server, user, pass string) {
	if user == "" && pass == "" {
		return
	}
	c.regCreds = append(c.regCreds, regCred{server: server, user: user, pass: pass})
	c.reloadAuths()
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
