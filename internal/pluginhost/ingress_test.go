package pluginhost

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/Toyz/sov/gateway"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/store"
)

const testKey = "hostA|proj/svc"

// ingressFixture wires a real (temp) store with one enabled plugin and returns the
// ingress handler, its bus, and the plugin's valid token.
func ingressFixture(t *testing.T, grants []string) (*PluginIngress, *events.Bus, string) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hope.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	st.SetSecret("test-secret")
	if err := st.PutPlugin(store.PluginRecord{Key: testKey, Host: "hostA", Project: "proj", Service: "svc", Enabled: true, Grants: grants}); err != nil {
		t.Fatalf("put plugin: %v", err)
	}
	bus := events.New()
	return NewPluginIngress(st, bus, DefaultLimits), bus, st.DeriveToken(testKey)
}

func publishReq(key, token string, e events.Event) *gateway.Request {
	body, _ := json.Marshal(publishBody{Key: key, Event: e})
	h := gateway.Header{}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	return &gateway.Request{Method: http.MethodPost, Path: pathPluginEvents, Header: h, Body: body}
}

func TestIngressPublishesWithForcedAttribution(t *testing.T) {
	h, bus, token := ingressFixture(t, []string{scopeEventsPublish})
	ch, cancel := bus.Subscribe(0)
	defer cancel()

	// The plugin tries to spoof Source and pick a core-ish kind; hope must override.
	resp := h.ServeRoute(context.Background(), publishReq(testKey, token, events.Event{
		Kind: "alert", Source: "hope", Host: "evil", Data: json.RawMessage(`{"sev":"warn"}`),
	}))
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	select {
	case e := <-ch:
		if e.Kind != "plugin."+testKey+".alert" {
			t.Errorf("kind = %q, want namespaced", e.Kind)
		}
		if e.Source != "plugin."+testKey {
			t.Errorf("source = %q, want server-forced", e.Source)
		}
		if e.Host != "hostA" {
			t.Errorf("host = %q, want the record's host (not the spoofed one)", e.Host)
		}
	default:
		t.Fatal("event was not published to the bus")
	}
}

func TestIngressRejectsBadToken(t *testing.T) {
	h, _, _ := ingressFixture(t, []string{scopeEventsPublish})
	resp := h.ServeRoute(context.Background(), publishReq(testKey, "wrong-token", events.Event{Kind: "alert"}))
	if resp.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 for a bad token", resp.Status)
	}
}

func TestIngressRejectsMissingGrant(t *testing.T) {
	h, _, token := ingressFixture(t, nil) // enabled but no events:publish grant
	resp := h.ServeRoute(context.Background(), publishReq(testKey, token, events.Event{Kind: "alert"}))
	if resp.Status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 without the grant", resp.Status)
	}
}

func TestIngressRejectsUnknownPlugin(t *testing.T) {
	h, _, token := ingressFixture(t, []string{scopeEventsPublish})
	resp := h.ServeRoute(context.Background(), publishReq("nope|x/y", token, events.Event{Kind: "alert"}))
	if resp.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 for an unknown plugin", resp.Status)
	}
}
