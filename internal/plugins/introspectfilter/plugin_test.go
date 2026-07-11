package introspectfilter

import (
	"context"
	"testing"

	"github.com/Toyz/sov/gateway"
	"github.com/Toyz/sov/rpc"
)

// ContributeIntrospect strips the hidden services and the plugin catalog while
// leaving the public services intact.
func TestContributeIntrospect(t *testing.T) {
	report := &gateway.IntrospectReport{
		Services: map[string][]rpc.RouterDescriptor{
			"Auth":       nil, // hidden
			"Meme":       nil, // hidden
			"Deploy":     nil, // public
			"Containers": nil, // public
		},
		Plugins: []gateway.PluginInfo{{Name: "logger"}, {Name: "hosttarget"}},
	}
	p := New()
	if err := p.ContributeIntrospect(context.Background(), report, "", nil); err != nil {
		t.Fatalf("ContributeIntrospect: %v", err)
	}

	if _, ok := report.Services["Auth"]; ok {
		t.Error("Auth should be stripped")
	}
	if _, ok := report.Services["Meme"]; ok {
		t.Error("Meme should be stripped")
	}
	if _, ok := report.Services["Deploy"]; !ok {
		t.Error("Deploy should be kept")
	}
	if _, ok := report.Services["Containers"]; !ok {
		t.Error("Containers should be kept")
	}
	if len(report.Services) != 2 {
		t.Errorf("services = %v; want 2 public", report.Services)
	}
	if report.Plugins != nil {
		t.Errorf("Plugins = %v; want nil (recon-only, stripped)", report.Plugins)
	}
}

// A nil report is tolerated (no panic, no error).
func TestContributeIntrospectNil(t *testing.T) {
	if err := New().ContributeIntrospect(context.Background(), nil, "", nil); err != nil {
		t.Fatalf("nil report: %v", err)
	}
}

func TestPluginName(t *testing.T) {
	if got := New().PluginName(); got != "hope-introspectfilter" {
		t.Errorf("PluginName = %q; want hope-introspectfilter", got)
	}
}
