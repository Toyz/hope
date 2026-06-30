package docker

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

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

// loadDockerAuths reads registry credentials from a docker config.json. An
// empty path resolves to $DOCKER_CONFIG/config.json or ~/.docker/config.json.
// A missing file is not an error — it just means no private-registry pulls.
//
// Note: only inline `auth` entries (from `docker login`) are supported, not
// credential-helper / credsStore setups, which keep secrets outside the file.
func loadDockerAuths(path string) map[string]string {
	if path == "" {
		if dc := os.Getenv("DOCKER_CONFIG"); dc != "" {
			path = filepath.Join(dc, "config.json")
		} else if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, ".docker", "config.json")
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var cfg dockerConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}

	out := map[string]string{}
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
		hdr, _ := json.Marshal(registryAuthHeader{Username: user, Password: pass, ServerAddress: registry})
		out[normalizeRegistry(registry)] = base64.URLEncoding.EncodeToString(hdr)
	}
	return out
}

// AddRegistryCreds registers an explicit registry credential (from config),
// overriding anything loaded from config.json for the same registry. Works
// without a credential helper, so it's the reliable path in hope's container.
func (c *Client) AddRegistryCreds(server, user, pass string) {
	if user == "" && pass == "" {
		return
	}
	hdr, _ := json.Marshal(registryAuthHeader{Username: user, Password: pass, ServerAddress: server})
	if c.auths == nil {
		c.auths = map[string]string{}
	}
	c.auths[normalizeRegistry(server)] = base64.URLEncoding.EncodeToString(hdr)
}

// registryAuth returns the X-Registry-Auth header for an image ref, or "".
func (c *Client) registryAuth(image string) string {
	if len(c.auths) == 0 {
		return ""
	}
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
