// Package introspectfilter trims hope's /rpc/_introspect (and thus the explorer)
// down to the public API surface. Introspection stays ON — it powers the
// explorer and lets API-key clients self-generate typed clients — but the
// control-plane services and the internal plugin catalog are pure recon with no
// value to a caller, so they're stripped from the published schema.
package introspectfilter

import (
	"encoding/json"

	"github.com/Toyz/sov/gateway"
)

const introspectPath = "/rpc/_introspect"

// hiddenServices are routers kept out of the published schema: auth/login is a
// session flow (an API key can't use it) and the meme endpoint is a gag.
var hiddenServices = map[string]bool{
	"Auth": true,
	"Meme": true,
}

// Plugin implements gateway.ResponseInterceptor.
type Plugin struct{}

var (
	_ gateway.Plugin              = (*Plugin)(nil)
	_ gateway.ResponseInterceptor = (*Plugin)(nil)
)

// New returns the introspect-filter plugin.
func New() *Plugin { return &Plugin{} }

// PluginName surfaces in the (now-stripped) plugin catalog.
func (p *Plugin) PluginName() string { return "hope-introspectfilter" }

// InterceptResponse removes the hidden services and the internal plugin catalog
// from the introspect JSON, leaving services + types intact. No-op elsewhere.
func (p *Plugin) InterceptResponse(req *gateway.Request, resp *gateway.Response) error {
	if req == nil || resp == nil || req.Path != introspectPath || resp.Status != 200 || len(resp.Body) == 0 {
		return nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(resp.Body, &m); err != nil {
		return nil // not the shape we expected — leave it untouched
	}
	changed := false
	if _, ok := m["plugins"]; ok {
		delete(m, "plugins") // internal wiring — recon only
		changed = true
	}
	if raw, ok := m["services"]; ok {
		var svcs map[string]json.RawMessage
		if json.Unmarshal(raw, &svcs) == nil {
			for name := range hiddenServices {
				if _, has := svcs[name]; has {
					delete(svcs, name)
					changed = true
				}
			}
			if b, err := json.Marshal(svcs); err == nil {
				m["services"] = b
			}
		}
	}
	if !changed {
		return nil
	}
	if b, err := json.Marshal(m); err == nil {
		resp.Body = b
	}
	return nil
}
