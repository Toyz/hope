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
	core := store.PluginRecord{Key: "hostA|proj/svc", Host: "hostA", Enabled: true, Grants: []string{scopeEventsSubscribe}}
	allPlugins := store.PluginRecord{Key: "hostA|proj/sub", Host: "hostA", Enabled: true, Grants: []string{scopeEventsSubscribePlugins}}
	fromPg := store.PluginRecord{Key: "hostA|proj/sub", Host: "hostA", Enabled: true, Grants: []string{scopeSubscribePluginPrefix + "hope-postgres"}}
	pluginEv := events.Event{Kind: "plugin.hostA|proj/pub.alert", Host: "hostA", Source: "plugin.hostA|proj/pub"}

	cases := []struct {
		name string
		rec  store.PluginRecord
		e    events.Event
		pub  string
		want bool
	}{
		{"core: granted same host", core, events.Event{Kind: events.KindStackDeployed, Host: "hostA"}, "", true},
		{"core: granted host-less (fleet-wide)", core, events.Event{Kind: events.KindAgentOnline}, "", true},
		{"core: other host filtered out", core, events.Event{Kind: events.KindStackDeployed, Host: "hostB"}, "", false},
		{"core: no grant", store.PluginRecord{Host: "hostA", Enabled: true}, events.Event{Kind: events.KindStackDeployed, Host: "hostA"}, "", false},
		{"core: disabled", store.PluginRecord{Host: "hostA", Grants: []string{scopeEventsSubscribe}}, events.Event{Kind: events.KindStackDeployed, Host: "hostA"}, "", false},
		{"no self-echo", core, events.Event{Kind: "plugin.hostA|proj/svc.alert", Host: "hostA", Source: "plugin.hostA|proj/svc"}, "svc", false},
		// the split: a core-only subscriber does NOT receive cross-plugin events.
		{"plugin event: core grant is not enough", core, pluginEv, "hope-postgres", false},
		{"plugin event: firehose grant delivers", allPlugins, pluginEv, "hope-postgres", true},
		{"plugin event: firehose grant, unknown publisher", allPlugins, pluginEv, "", true},
		{"plugin event: per-name grant matches", fromPg, pluginEv, "hope-postgres", true},
		{"plugin event: per-name grant, other publisher", fromPg, pluginEv, "hope-redis", false},
		// the plugins firehose does NOT grant core fleet events.
		{"core event: plugins grant is not enough", allPlugins, events.Event{Kind: events.KindStackDeployed, Host: "hostA"}, "", false},
	}
	for _, c := range cases {
		if got := shouldDeliver(c.rec, c.e, c.pub); got != c.want {
			t.Errorf("%s: shouldDeliver = %v, want %v", c.name, got, c.want)
		}
	}
}
