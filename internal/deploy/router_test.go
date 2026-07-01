package deploy

import (
	"testing"

	"github.com/Toyz/sov"
)

// TestRouterRegisters guards the boot-time sov validation: every RPC method
// signature + sov param tag must be acceptable to the gateway (snake_case tag
// names, valid ordinals). A regression here panics on startup, so catch it here.
func TestRouterRegisters(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("DeployRouter failed to register: %v", r)
		}
	}()
	gw := sov.New()
	gw.Register(NewDeployRouter(nil, nil)) // nil deps: Register only inspects signatures
}
