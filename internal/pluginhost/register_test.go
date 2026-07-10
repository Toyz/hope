package pluginhost

import (
	"testing"

	"github.com/Toyz/sov"
)

// TestPluginsRouterRegisters guards the boot-time sov validation. gw.Register reflects
// over EVERY exported method of the router and requires the (*rpc.Context, ...) RPC
// shape — an exported helper method (a Set*/Start* lifecycle func) panics at startup,
// which build/test otherwise miss. Any such method must be a package FUNCTION instead.
// This test fails fast if one sneaks back in.
func TestPluginsRouterRegisters(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("gw.Register(PluginsRouter) panicked — an exported method isn't RPC-shaped (make it a package func): %v", r)
		}
	}()
	gw := sov.New()
	// nil deps: Register only inspects method signatures, it doesn't call them.
	gw.Register(NewPluginsRouter(nil, nil, nil, nil, nil, false, false, Limits{}, nil))
}
