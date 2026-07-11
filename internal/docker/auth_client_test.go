package docker

import (
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/registry"
)

// These exercise the registry-credential surface: parsing a docker config.json,
// the runtime add/remove/list, config-vs-db source gating, and the /auth verify
// handshake against the fake daemon. No production changes — only reading the
// auth.go methods and driving them.

// newAuthClient builds a Client with only the auth machinery initialised (no
// daemon needed for the map-only methods). configPath is loaded via initAuths.
func newAuthClient(t *testing.T, configPath string) *Client {
	t.Helper()
	c := &Client{auths: map[string]string{}, updByRef: map[string]refStatus{}}
	c.initAuths(configPath)
	return c
}

// TestReadDockerAuths proves the config.json parse: an `auth` blob is base64-decoded
// into user:pass, split-out username/password are read directly, Hub's long spelling
// folds to docker.io, and a helper-only (empty) entry is skipped.
func TestReadDockerAuths(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	blob := base64.StdEncoding.EncodeToString([]byte("ghuser:ghpass"))
	cfg := `{"auths":{
		"ghcr.io":{"auth":"` + blob + `"},
		"https://index.docker.io/v1/":{"username":"hubuser","password":"hubpass"},
		"helper.io":{}
	}}`
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	got := readDockerAuths(path)
	// helper.io (no creds) dropped; hub folded to docker.io.
	wantKeys := map[string]bool{"ghcr.io": true, "docker.io": true}
	if len(got) != len(wantKeys) {
		t.Fatalf("readDockerAuths keys = %v; want %v", keysOf(got), wantKeys)
	}
	for k := range wantKeys {
		if _, ok := got[k]; !ok {
			t.Errorf("missing key %q in %v", k, keysOf(got))
		}
	}
	// The ghcr.io header decodes back to the base64-embedded user + a password.
	if u, hasPass := decodeAuthHeader(got["ghcr.io"]); u != "ghuser" || !hasPass {
		t.Errorf("ghcr header = %q/%v; want ghuser/true", u, hasPass)
	}
	if u, hasPass := decodeAuthHeader(got["docker.io"]); u != "hubuser" || !hasPass {
		t.Errorf("docker.io header = %q/%v; want hubuser/true", u, hasPass)
	}

	// Missing file and empty path both yield an empty (non-nil) map.
	if m := readDockerAuths(filepath.Join(dir, "nope.json")); len(m) != 0 {
		t.Errorf("readDockerAuths(missing) = %v; want empty", m)
	}
	if m := readDockerAuths(""); len(m) != 0 {
		t.Errorf("readDockerAuths(\"\") = %v; want empty", m)
	}
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestEncodeDecodeAuthHeader proves the X-Registry-Auth round-trip and the
// password-presence flag, plus graceful handling of a garbage header.
func TestEncodeDecodeAuthHeader(t *testing.T) {
	if u, hasPass := decodeAuthHeader(encodeAuth("bob", "secret", "ghcr.io")); u != "bob" || !hasPass {
		t.Errorf("decode(encode(bob/secret)) = %q/%v; want bob/true", u, hasPass)
	}
	if u, hasPass := decodeAuthHeader(encodeAuth("nopass", "", "ghcr.io")); u != "nopass" || hasPass {
		t.Errorf("decode(encode(nopass/'')) = %q/%v; want nopass/false", u, hasPass)
	}
	if u, hasPass := decodeAuthHeader("!!! not base64 !!!"); u != "" || hasPass {
		t.Errorf("decode(garbage) = %q/%v; want empty/false", u, hasPass)
	}
}

// TestResolveConfigPath proves the precedence: explicit path wins, else
// $DOCKER_CONFIG/config.json, else ~/.docker/config.json.
func TestResolveConfigPath(t *testing.T) {
	if got := resolveConfigPath("/explicit/path.json"); got != "/explicit/path.json" {
		t.Errorf("resolveConfigPath(explicit) = %q; want passthrough", got)
	}
	t.Setenv("DOCKER_CONFIG", "/etc/docker-cfg")
	if got := resolveConfigPath(""); got != filepath.Join("/etc/docker-cfg", "config.json") {
		t.Errorf("resolveConfigPath($DOCKER_CONFIG) = %q; want /etc/docker-cfg/config.json", got)
	}
	t.Setenv("DOCKER_CONFIG", "")
	// With DOCKER_CONFIG cleared it falls to the home dir (or the /root fallback);
	// either way it must end in .docker/config.json.
	if got := resolveConfigPath(""); !strings.HasSuffix(got, filepath.Join(".docker", "config.json")) {
		t.Errorf("resolveConfigPath(default) = %q; want …/.docker/config.json", got)
	}
}

// TestRegistryCredsLifecycle proves the runtime add/list/remove path and the
// config-vs-db source gating, all off the merged auth map.
func TestRegistryCredsLifecycle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	blob := base64.StdEncoding.EncodeToString([]byte("ghuser:ghpass"))
	if err := os.WriteFile(path, []byte(`{"auths":{"ghcr.io":{"auth":"`+blob+`"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c := newAuthClient(t, path)

	// config.json host is present, config-sourced, read-only.
	if !c.IsConfigRegistry("ghcr.io") {
		t.Error("IsConfigRegistry(ghcr.io) = false; want true (from config.json)")
	}
	// A pull for a ghcr image resolves the config credential.
	if c.registryAuth("ghcr.io/toyz/app:latest") == "" {
		t.Error("registryAuth(ghcr image) is empty; want the config credential")
	}
	// A db-sourced runtime cred for a fresh host.
	c.AddRegistryCreds("registry.example.com", "user", "pass", RegistrySourceDB)
	if c.IsConfigRegistry("registry.example.com") {
		t.Error("IsConfigRegistry(runtime host) = true; want false (db-sourced)")
	}
	if c.registryAuth("registry.example.com/app:1") == "" {
		t.Error("registryAuth(runtime host) empty; want the added credential")
	}
	// Empty user+pass is a no-op (host must not appear).
	c.AddRegistryCreds("blank.example.com", "", "", RegistrySourceDB)

	// RegistryList: config host + the db host, sorted, passwords stripped.
	list := c.RegistryList()
	byServer := map[string]RegistryEntry{}
	for _, e := range list {
		byServer[e.Server] = e
	}
	if e, ok := byServer["ghcr.io"]; !ok || e.Source != RegistrySourceConfig || e.Username != "ghuser" || !e.HasPassword {
		t.Errorf("ghcr entry = %+v; want config/ghuser/hasPass", e)
	}
	if e, ok := byServer["registry.example.com"]; !ok || e.Source != RegistrySourceDB || e.Username != "user" || !e.HasPassword {
		t.Errorf("runtime entry = %+v; want db/user/hasPass", e)
	}
	if _, ok := byServer["blank.example.com"]; ok {
		t.Error("blank host should not be listed (empty creds are a no-op)")
	}
	// Sorted by server.
	for i := 1; i < len(list); i++ {
		if list[i-1].Server > list[i].Server {
			t.Errorf("RegistryList not sorted: %q before %q", list[i-1].Server, list[i].Server)
		}
	}

	// AuthedRegistries lists every effective host, sorted.
	authed := c.AuthedRegistries()
	if !reflect.DeepEqual(authed, sortedCopy(authed)) {
		t.Errorf("AuthedRegistries not sorted: %v", authed)
	}
	if !contains(authed, "ghcr.io") || !contains(authed, "registry.example.com") {
		t.Errorf("AuthedRegistries = %v; want ghcr.io + registry.example.com", authed)
	}

	// Removing a db cred works; removing a config cred is refused.
	if !c.RemoveRegistryCreds("registry.example.com") {
		t.Error("RemoveRegistryCreds(db host) = false; want true")
	}
	if c.registryAuth("registry.example.com/app:1") != "" {
		t.Error("registryAuth(removed host) should be empty after removal")
	}
	if c.RemoveRegistryCreds("registry.example.com") {
		t.Error("second RemoveRegistryCreds should report false (nothing left)")
	}
}

// TestAddRegistryCredsUpsert proves re-adding the same server replaces the prior
// entry rather than duplicating it.
func TestAddRegistryCredsUpsert(t *testing.T) {
	c := newAuthClient(t, "")
	c.AddRegistryCreds("reg.io", "old", "oldpass", RegistrySourceDB)
	c.AddRegistryCreds("reg.io", "new", "newpass", RegistrySourceDB)
	n := 0
	for _, e := range c.RegistryList() {
		if e.Server == "reg.io" {
			n++
			if e.Username != "new" {
				t.Errorf("reg.io username = %q; want new (upsert)", e.Username)
			}
		}
	}
	if n != 1 {
		t.Errorf("reg.io listed %d times; want 1 (upsert, not duplicate)", n)
	}
}

// TestConfigRegistrySourceCred proves a [[registry]]-sourced cred (source=config)
// is also treated as read-only and cannot be removed as a db cred.
func TestConfigRegistrySourceCred(t *testing.T) {
	c := newAuthClient(t, "")
	c.AddRegistryCreds("cfg.io", "u", "p", RegistrySourceConfig)
	if !c.IsConfigRegistry("cfg.io") {
		t.Error("IsConfigRegistry(config-sourced) = false; want true")
	}
	if c.RemoveRegistryCreds("cfg.io") {
		t.Error("RemoveRegistryCreds must not drop a config-sourced cred")
	}
}

// TestVerifyRegistry proves the /auth login handshake: a 200 authenticates
// (nil), a 401 surfaces the error.
func TestVerifyRegistry(t *testing.T) {
	t.Run("accepts good creds", func(t *testing.T) {
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/auth") {
				writeJSON(w, registry.AuthenticateOKBody{Status: "Login Succeeded"})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		if err := c.VerifyRegistry(t.Context(), "ghcr.io", "user", "pass"); err != nil {
			t.Errorf("VerifyRegistry(good) = %v; want nil", err)
		}
	})
	t.Run("rejects bad creds", func(t *testing.T) {
		c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/auth") {
				w.WriteHeader(http.StatusUnauthorized)
				writeJSON(w, map[string]any{"message": "incorrect username or password"})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		if err := c.VerifyRegistry(t.Context(), "ghcr.io", "user", "wrong"); err == nil {
			t.Error("VerifyRegistry(bad) = nil; want an auth error")
		}
	})
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func sortedCopy(s []string) []string {
	out := append([]string(nil), s...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}
