// Package socketproxy is hope's opt-in, LAN-facing reverse proxy that forwards
// the Docker HTTP API to the unix socket behind a method/path allowlist. It
// lets other tools on a trusted network reach the daemon through hope.
//
// SECURITY: an exposed Docker API is root-equivalent to whoever reaches the
// port. Defaults are read-only (GET/HEAD); writes require explicit allowlist
// entries. Bind it to a trusted LAN/overlay only — never a public interface.
package socketproxy

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"path"
	"strings"
	"time"

	"github.com/toyz/hope/internal/config"
)

// Server wraps the proxy http.Server.
type Server struct {
	http *http.Server
	addr string
}

// New builds a socket proxy from cfg. dockerHost must be a unix:// endpoint
// (the proxy forwards to that socket); a tcp:// endpoint is already network-
// reachable and is rejected. Returns (nil, nil) when disabled.
func New(cfg config.SocketProxyConfig, dockerHost string) (*Server, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	socketPath, ok := unixSocketPath(dockerHost)
	if !ok {
		return nil, fmt.Errorf("socketproxy requires a unix:// docker.host, got %q", dockerHost)
	}

	rp := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = "http"
			req.URL.Host = "docker"
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
			},
		},
	}

	guard := newAllowlist(cfg.AllowMethods, cfg.AllowPaths)
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !guard.permit(req.Method, req.URL.Path) {
			http.Error(w, "forbidden by socketproxy allowlist", http.StatusForbidden)
			return
		}
		rp.ServeHTTP(w, req)
	})

	return &Server{
		addr: cfg.Listen,
		http: &http.Server{
			Addr:              cfg.Listen,
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
		},
	}, nil
}

// Addr returns the listen address.
func (s *Server) Addr() string { return s.addr }

// ListenAndServe runs the proxy until ctx is cancelled, then shuts it down.
func (s *Server) ListenAndServe(ctx context.Context) error {
	errc := make(chan error, 1)
	go func() { errc <- s.http.ListenAndServe() }()
	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.http.Shutdown(shutCtx)
		return ctx.Err()
	case err := <-errc:
		return err
	}
}

// allowlist gates requests by HTTP method and path glob.
type allowlist struct {
	methods map[string]struct{}
	paths   []string
}

func newAllowlist(methods, paths []string) *allowlist {
	m := make(map[string]struct{}, len(methods))
	for _, x := range methods {
		m[strings.ToUpper(x)] = struct{}{}
	}
	return &allowlist{methods: m, paths: paths}
}

// permit reports whether method+path is allowed. Both the method AND the path
// must match. Path patterns use path.Match globs ("*" does not cross "/").
func (a *allowlist) permit(method, p string) bool {
	if _, ok := a.methods[strings.ToUpper(method)]; !ok {
		return false
	}
	for _, pat := range a.paths {
		if ok, _ := path.Match(pat, p); ok {
			return true
		}
	}
	return false
}

// unixSocketPath extracts the socket path from a unix:// docker host.
func unixSocketPath(host string) (string, bool) {
	switch {
	case strings.HasPrefix(host, "unix://"):
		return strings.TrimPrefix(host, "unix://"), true
	case strings.HasPrefix(host, "/"):
		return host, true
	default:
		return "", false
	}
}
