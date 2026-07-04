// Package hostguard is the server-side backstop for host-scoped writes. A
// mutation acts on exactly one host's Docker; if it arrives without naming that
// host (the X-Hope-Host header) it must NOT fall back to the globally-active host
// — that silent fallback is what let one host's stack get deployed onto another.
//
// The gateway middleware here rejects such a write before it reaches the router.
// Reads are untouched (a fallback is harmless for a read). Streaming mutations
// (/rpc/Stream/*) are RouteHandler routes that bypass middleware, so they are
// guarded separately in the logstream plugin — the two write-sets together cover
// every host mutation.
package hostguard

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/hosts"
)

// writeMethods are the host-scoped mutations reachable via normal RPC dispatch,
// by "Service.method" wire name. Keep this in sync when adding a mutation that
// touches one host's Docker; a read (List/Inspect/Stats/Fleet*) must NOT be here.
var writeMethods = map[string]bool{
	// single-container lifecycle
	"Containers.start":    true,
	"Containers.stop":     true,
	"Containers.restart":  true,
	"Containers.kill":     true,
	"Containers.remove":   true,
	"Containers.pull":     true,
	"Containers.redeploy": true,
	// whole-stack lifecycle
	"Stacks.start":    true,
	"Stacks.stop":     true,
	"Stacks.restart":  true,
	"Stacks.pull":     true,
	"Stacks.redeploy": true,
	// resource creation on a host
	"Deploy.createNetwork": true,
	"Deploy.createVolume":  true,
	// tunnel/route mutations (each edits the host's cloudflared connector)
	"Tunnels.createConnector": true,
	"Tunnels.renameConnector": true,
	"Tunnels.removeConnector": true,
	"Tunnels.addTunnel":       true,
	"Tunnels.removeTunnel":    true,
	"Tunnels.moveRoute":       true,
	"Tunnels.reorderRoutes":   true,
	// destructive host cleanup
	"System.pruneImages":     true,
	"System.pruneBuildCache": true,
	"System.removeImage":     true,
	"System.removeNetwork":   true,
	"System.removeVolume":    true,
}

// Middleware returns a sov middleware that fails a host-scoped write when the
// request carries no explicit, connected X-Hope-Host target — so a write always
// lands on the host the caller named, or is rejected, never the active host by
// omission.
func Middleware(h *hosts.Set) gateway.Middleware {
	return func(next gateway.Handler) gateway.Handler {
		return func(ctx context.Context, req *gateway.Request) *gateway.Response {
			router, method, ok := rpc.SplitRPCPath(req.Path)
			if ok && writeMethods[router+"."+method] {
				if _, _, err := h.ResolveTarget(req.Header.Get(hosts.TargetHeader)); err != nil {
					return errResp(http.StatusBadRequest, err.Error())
				}
			}
			return next(ctx, req)
		}
	}
}

// errResp builds the sov {error:{code,message}} envelope the transport expects.
func errResp(status int, msg string) *gateway.Response {
	body, _ := json.Marshal(map[string]any{
		"error": map[string]string{"code": "BAD_REQUEST", "message": msg},
	})
	return &gateway.Response{
		Status: status,
		Header: gateway.Header{"Content-Type": "application/json"},
		Body:   body,
	}
}
