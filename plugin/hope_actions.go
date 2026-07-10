package plugin

import "context"

// Hope is a handle to the operator ACTIONS a plugin may perform on hope — the
// operator pattern (watch events via OnEvent, then reconcile by mutating hope). Each
// action requires its own operator-granted scope and hope's reverse channel; without
// the grant hope rejects the call, and every action is audited. Actions target the
// plugin's OWN stack only.
type Hope struct{ p *Plugin }

// Hope returns the operator-actions handle.
func (p *Plugin) Hope() *Hope { return &Hope{p: p} }

// AddServiceLabel adds (or updates) a label on a service in the plugin's own stack and
// hope re-applies the stack, so the label PERSISTS across future redeploys. The classic
// use is a plugin that auto-adds Prometheus scrape labels on deploy. service is a
// service name in this plugin's stack; the plugin can't target another stack. Requires
// the spec:label permission.
func (h *Hope) AddServiceLabel(ctx context.Context, service, key, value string) error {
	url, pkey, token := h.p.reverse()
	if url == "" || pkey == "" {
		return ErrNoReverseChannel
	}
	_, err := postReverse(ctx, url, token, "/rpc/_plugin/action", map[string]any{
		"key":        pkey,
		"op":         "addServiceLabel",
		"service":    service,
		"labelKey":   key,
		"labelValue": value,
	})
	return err
}
