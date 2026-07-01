// Package introspectfilter trims hope's /rpc/_introspect (and thus the explorer)
// down to the public API surface. Introspection stays ON — it powers the
// explorer and lets API-key clients self-generate typed clients — but the
// control-plane services and the internal plugin catalog are pure recon with no
// value to a caller, so they're stripped from the published schema.
//
// It hooks IntrospectContributor (not ResponseInterceptor): the report is built
// once and shared by the /rpc/_introspect endpoint AND the explorer's internal
// IntrospectBody call, so mutating it here covers both.
package introspectfilter

import (
	"context"

	"github.com/Toyz/sov/gateway"
)

// hiddenServices are routers kept out of the published schema: auth/login is a
// session flow (an API key can't use it) and the meme endpoint is a gag.
var hiddenServices = map[string]bool{
	"Auth": true,
	"Meme": true,
}

// Plugin implements gateway.IntrospectContributor.
type Plugin struct{}

var (
	_ gateway.Plugin                = (*Plugin)(nil)
	_ gateway.IntrospectContributor = (*Plugin)(nil)
)

// New returns the introspect-filter plugin.
func New() *Plugin { return &Plugin{} }

// PluginName is stripped from the catalog along with the rest (see below).
func (p *Plugin) PluginName() string { return "hope-introspectfilter" }

// ContributeIntrospect removes the hidden services and the internal plugin
// catalog from the report before it's serialized (endpoint + explorer).
func (p *Plugin) ContributeIntrospect(_ context.Context, report *gateway.IntrospectReport, _ string, _ []string) error {
	if report == nil {
		return nil
	}
	for name := range hiddenServices {
		delete(report.Services, name)
	}
	report.Plugins = nil // internal wiring — recon only
	return nil
}
