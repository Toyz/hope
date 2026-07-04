package hostguard

import (
	"context"
	"testing"

	"github.com/Toyz/sov/gateway"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// TestMiddlewareRequiresHostForWrites locks the backstop: a host-scoped write
// with no explicit, connected X-Hope-Host is rejected before it reaches the
// router, while reads (and non-RPC paths) pass through untouched. This is what
// stops a mutation from silently falling back to the active host.
func TestMiddlewareRequiresHostForWrites(t *testing.T) {
	h := hosts.New(&docker.Client{}, true, nil) // local present, no agents
	mw := Middleware(h)

	cases := []struct {
		name       string
		path       string
		host       string // X-Hope-Host, "" = header absent
		wantNext   bool   // did the request reach the router?
		wantStatus int    // when not passed through
	}{
		{"write, no host -> rejected", "/rpc/Containers/stop", "", false, 400},
		{"write, local host -> passes", "/rpc/Containers/stop", "local", true, 0},
		{"write, disconnected host -> rejected", "/rpc/Containers/stop", "ghost", false, 400},
		{"stack redeploy, no host -> rejected", "/rpc/Stacks/redeploy", "", false, 400},
		{"read, no host -> passes", "/rpc/Stacks/list", "", true, 0},
		{"read, no host -> passes (inspect)", "/rpc/Containers/inspect", "", true, 0},
		{"non-rpc path -> passes", "/rpc/_health", "", true, 0},
	}
	for _, c := range cases {
		called := false
		next := func(_ context.Context, _ *gateway.Request) *gateway.Response {
			called = true
			return &gateway.Response{Status: 200}
		}
		req := &gateway.Request{Path: c.path, Header: gateway.Header{}}
		if c.host != "" {
			req.Header.Set(hosts.TargetHeader, c.host)
		}
		resp := mw(next)(context.Background(), req)
		if called != c.wantNext {
			t.Errorf("%s: reached router = %v, want %v", c.name, called, c.wantNext)
		}
		if !c.wantNext && resp.Status != c.wantStatus {
			t.Errorf("%s: status = %d, want %d", c.name, resp.Status, c.wantStatus)
		}
	}
}
