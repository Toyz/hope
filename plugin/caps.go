package plugin

import (
	"context"
	"strings"
)

// Capability negotiation. On every call, hope announces what THIS hope build can
// render — the set of view kinds and feature flags — via two request headers. A
// plugin built against a newer SDK can then degrade gracefully on an older hope
// instead of emitting something hope can't draw. Read it in a handler with Caps:
//
//	func widget(ctx context.Context) (any, error) {
//	    if plugin.Caps(ctx).Supports("component") {
//	        return plugin.Box(plugin.Heading("Fleet", 3), …), nil // rich
//	    }
//	    return plugin.KVData{"nodes": 3}, nil                     // baseline fallback
//	}
//
// An older hope that predates negotiation sends no headers, so Supports returns
// false — always keep a baseline for anything you guard.
const (
	headerViewKinds = "X-Hope-View-Kinds" // wire contract shared with internal/pluginhost/dialer.go
	headerFeatures  = "X-Hope-Features"
)

type capsKey struct{}

// Capabilities is what the connected hope advertised it can render: the supported view
// kinds (kv/table/…/component) and feature flags (static, empty). Read it with Caps and
// query it with Supports.
type Capabilities struct {
	ViewKinds []string `json:"view_kinds"`
	Features  []string `json:"features"`
}

// Supports reports whether hope advertised the named capability — a view kind
// ("component") or a feature ("static", "empty"). False when hope sent no capabilities
// (an older build), so guard optional output and keep a baseline fallback.
func (c Capabilities) Supports(name string) bool {
	for _, k := range c.ViewKinds {
		if k == name {
			return true
		}
	}
	for _, f := range c.Features {
		if f == name {
			return true
		}
	}
	return false
}

// Caps returns the capabilities the connected hope advertised for the current call.
// Use it to adapt output across hope versions (see the package example above). Outside
// a hope-driven call (no headers) it returns an empty Capabilities.
func Caps(ctx context.Context) Capabilities {
	c, _ := ctx.Value(capsKey{}).(Capabilities)
	return c
}

// splitCaps parses a comma-separated capability header into a trimmed, non-empty list.
func splitCaps(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
