package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOnEventDeclaresSubscribePermission(t *testing.T) {
	p := New("t", "1").OnEvent(func(context.Context, Event) error { return nil })
	found := false
	for _, pm := range p.schema().Permissions {
		if pm.Scope == ScopeEventsSubscribe {
			found = true
		}
	}
	if !found {
		t.Fatal("OnEvent should auto-declare the events:subscribe permission in the schema")
	}
}

func TestRequirePermissionDedupes(t *testing.T) {
	p := New("t", "1").
		RequirePermission(ScopeStorage, "keep config").
		RequirePermission(ScopeStorage, "updated reason")
	perms := p.schema().Permissions
	if len(perms) != 1 || perms[0].Scope != ScopeStorage || perms[0].Reason != "updated reason" {
		t.Fatalf("expected one storage perm with the updated reason, got %+v", perms)
	}
}

func TestHopeEventDispatch(t *testing.T) {
	got := make(chan Event, 1)
	p := New("t", "1").OnEvent(func(_ context.Context, e Event) error { got <- e; return nil })

	body := `{"jsonrpc":"2.0","id":1,"method":"hope.event","params":{"kind":"stack.deployed","host":"h1","project":"proj"}}`
	req := httptest.NewRequest(http.MethodPost, "/__hope", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok") // TOFU pins this bearer
	rec := httptest.NewRecorder()
	p.serve(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case e := <-got:
		if e.Kind != "stack.deployed" || e.Host != "h1" || e.Project != "proj" {
			t.Fatalf("wrong event delivered: %+v", e)
		}
	default:
		t.Fatal("OnEvent handler was not called")
	}
}

func TestHopeEventNoHandler(t *testing.T) {
	p := New("t", "1") // no OnEvent registered
	body := `{"jsonrpc":"2.0","id":1,"method":"hope.event","params":{"kind":"x"}}`
	req := httptest.NewRequest(http.MethodPost, "/__hope", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()
	p.serve(rec, req)
	if !strings.Contains(rec.Body.String(), "no event handler") {
		t.Fatalf("expected a no-handler error frame, got %s", rec.Body.String())
	}
}
