package hosttarget

import (
	"testing"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/hosts"
)

// ContributeContext copies the X-Hope-Host header onto the RPC context so
// hosts.TargetFrom can read it back; an absent/empty header leaves it clear.
func TestContributeContext(t *testing.T) {
	tests := []struct {
		name   string
		header string // X-Hope-Host value, "" = header absent
		want   string
	}{
		{name: "header sets target", header: "agent-7", want: "agent-7"},
		{name: "local id passes through", header: hosts.LocalID, want: hosts.LocalID},
		{name: "absent header leaves target empty", header: "", want: ""},
	}
	p := New()
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := rpc.NewContext(t.Context())
			req := &gateway.Request{Header: gateway.Header{}}
			if tt.header != "" {
				req.Header.Set(hosts.TargetHeader, tt.header)
			}
			if err := p.ContributeContext(ctx, req); err != nil {
				t.Fatalf("ContributeContext: %v", err)
			}
			if got := hosts.TargetFrom(ctx.Context); got != tt.want {
				t.Errorf("TargetFrom = %q; want %q", got, tt.want)
			}
		})
	}
}

func TestPluginName(t *testing.T) {
	if got := New().PluginName(); got != "hope-hosttarget" {
		t.Errorf("PluginName = %q; want hope-hosttarget", got)
	}
}
