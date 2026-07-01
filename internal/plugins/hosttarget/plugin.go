// Package hosttarget is a sov ContextContributor that captures the per-request
// host override (the X-Hope-Host header) onto the RPC context, so a headless API
// caller can target a specific host per call without mutating the globally-active
// host. Routers resolve it via hosts.ActiveFor(ctx). Mirrors mininote's
// workspace plugin: header -> ctx; the hosts package owns the accessors.
package hosttarget

import (
	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/hosts"
)

// Plugin implements gateway.ContextContributor.
type Plugin struct{}

var (
	_ gateway.Plugin             = (*Plugin)(nil)
	_ gateway.ContextContributor = (*Plugin)(nil)
)

// New returns the host-target context contributor.
func New() *Plugin { return &Plugin{} }

// PluginName surfaces in the plugin catalog.
func (p *Plugin) PluginName() string { return "hope-hosttarget" }

// ContributeContext stashes the requested host id (may be "") onto the context
// so it flows to derived contexts (timeouts, streams) and every router's dock().
func (p *Plugin) ContributeContext(ctx *rpc.Context, req *gateway.Request) error {
	if id := req.Header.Get(hosts.TargetHeader); id != "" {
		ctx.Context = hosts.WithTarget(ctx.Context, id)
	}
	return nil
}
