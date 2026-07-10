package pluginhost

import (
	"testing"

	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/store"
)

func TestFanoutKindExcludesControlAndInternal(t *testing.T) {
	for _, k := range []events.Kind{events.KindPing, events.KindResync, events.KindPermissionReq} {
		if fanoutKind(k) {
			t.Errorf("%s should not be fanned out to plugins", k)
		}
	}
	for _, k := range []events.Kind{events.KindStackDeployed, events.KindContainerState, events.KindAgentOnline} {
		if !fanoutKind(k) {
			t.Errorf("%s should be fanned out to plugins", k)
		}
	}
}

func TestShouldDeliver(t *testing.T) {
	sub := store.PluginRecord{Key: "hostA|proj/svc", Host: "hostA", Enabled: true, Grants: []string{scopeEventsSubscribe}}

	cases := []struct {
		name string
		rec  store.PluginRecord
		e    events.Event
		want bool
	}{
		{"granted same host", sub, events.Event{Kind: events.KindStackDeployed, Host: "hostA"}, true},
		{"granted host-less (fleet-wide)", sub, events.Event{Kind: events.KindAgentOnline}, true},
		{"other host filtered out", sub, events.Event{Kind: events.KindStackDeployed, Host: "hostB"}, false},
		{"no grant", store.PluginRecord{Host: "hostA", Enabled: true}, events.Event{Kind: events.KindStackDeployed, Host: "hostA"}, false},
		{"disabled", store.PluginRecord{Host: "hostA", Grants: []string{scopeEventsSubscribe}}, events.Event{Kind: events.KindStackDeployed, Host: "hostA"}, false},
		{"no self-echo", sub, events.Event{Kind: "plugin.hostA|proj/svc.alert", Host: "hostA", Source: "plugin.hostA|proj/svc"}, false},
	}
	for _, c := range cases {
		if got := shouldDeliver(c.rec, c.e); got != c.want {
			t.Errorf("%s: shouldDeliver = %v, want %v", c.name, got, c.want)
		}
	}
}
