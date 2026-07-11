package events

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Toyz/sov/gateway"
	"github.com/toyz/hope/internal/auth"
)

// ── bus fan-out / non-blocking behavior ─────────────────────────────────────

// A producer wired without a bus is a no-op, not a panic.
func TestPublishNilBus(t *testing.T) {
	var b *Bus
	b.Publish(Event{Kind: KindPing}) // must not panic
}

// One Publish reaches every registered subscriber with the same stamped Seq.
func TestPublishFanoutMultiple(t *testing.T) {
	b := New()
	ch1, c1 := b.Subscribe(0)
	defer c1()
	ch2, c2 := b.Subscribe(0)
	defer c2()

	b.Publish(Event{Kind: KindStackDeployed, Project: "x"})
	e1 := mustRecv(t, ch1)
	e2 := mustRecv(t, ch2)
	if e1.Seq != 1 || e2.Seq != 1 {
		t.Fatalf("both subscribers should see seq 1: %d %d", e1.Seq, e2.Seq)
	}
	if e1.Kind != KindStackDeployed || e2.Kind != KindStackDeployed || e1.Project != "x" || e2.Project != "x" {
		t.Fatalf("fan-out payload wrong: %+v %+v", e1, e2)
	}
}

// A slow (never-drained) subscriber must not stall the producer or starve a fast one.
func TestSlowSubscriberDoesNotBlockOthers(t *testing.T) {
	b := New()
	_, cancelSlow := b.Subscribe(0) // never read -> fills and drops
	defer cancelSlow()
	fast, cancelFast := b.Subscribe(0)
	defer cancelFast()

	// Publish well past the buffer size, draining the fast subscriber each time.
	// If a full subscriber blocked Publish, this would deadlock.
	for i := 0; i < subChanBuf+10; i++ {
		b.Publish(Event{Kind: KindContainerState})
		e := mustRecv(t, fast) // fast keeps up: gets every frame, in order
		if int(e.Seq) != i+1 {
			t.Fatalf("fast subscriber gap: seq %d at i %d", e.Seq, i)
		}
	}
	if b.Subscribers() != 2 {
		t.Fatalf("both subscribers should remain registered, got %d", b.Subscribers())
	}
}

// A dropped subscriber whose buffer is still full stays dropped: no resync leaks in
// until it actually drains (covers deliver's still-full skip).
func TestDroppedSubscriberStaysDropped(t *testing.T) {
	b := New()
	ch, cancel := b.Subscribe(0)
	defer cancel()

	// Fill the buffer exactly.
	for i := 0; i < subChanBuf; i++ {
		b.Publish(Event{Kind: KindContainerState})
	}
	// Next one can't fit -> subscriber marked dropped.
	b.Publish(Event{Kind: KindContainerState})
	// Still not drained: deliver tries a resync, buffer is full, so it stays dropped
	// and skips (no resync frame is injected).
	b.Publish(Event{Kind: KindContainerState})

	// Drain exactly what fits: every frame is a container.state, no resync sneaked in.
	for i := 0; i < subChanBuf; i++ {
		if e := mustRecv(t, ch); e.Kind != KindContainerState {
			t.Fatalf("unexpected frame while still full: %+v", e)
		}
	}
	if _, ok := recv(t, ch); ok {
		t.Fatal("buffer should be empty after draining subChanBuf frames")
	}
	// Now drained: the next publish delivers a resync, then the live event.
	b.Publish(Event{Kind: KindStackDeployed})
	if e := mustRecv(t, ch); e.Kind != KindResync {
		t.Fatalf("expected resync after catch-up, got %+v", e)
	}
	if e := mustRecv(t, ch); e.Kind != KindStackDeployed {
		t.Fatalf("expected the live event after resync, got %+v", e)
	}
}

// Concurrent producers + subscriber churn must be race-free (unsubscribe during
// publish is serialized under the bus lock). Run under -race.
func TestConcurrentPublishSubscribe(t *testing.T) {
	b := New()
	var wg sync.WaitGroup

	for p := 0; p < 4; p++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 300; i++ {
				b.Publish(Event{Kind: KindContainerState})
			}
		}()
	}
	for c := 0; c < 4; c++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 150; i++ {
				ch, cancel := b.Subscribe(0)
				select { // opportunistic read; Publish never blocks so no-read is fine
				case <-ch:
				default:
				}
				cancel()
			}
		}()
	}
	wg.Wait()
	if n := b.Subscribers(); n != 0 {
		t.Fatalf("all subscribers should have cancelled, got %d", n)
	}
}

// ── stream handler ──────────────────────────────────────────────────────────

func newAuthedReq(tok string) *gateway.Request {
	req := &gateway.Request{Method: http.MethodPost, Header: gateway.Header{}}
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return req
}

func TestHandlerMetadata(t *testing.T) {
	h := NewHandler(New(), auth.NewTokenManager("s", time.Hour, nil))
	if h.PluginName() != "events" {
		t.Errorf("PluginName = %q", h.PluginName())
	}
	if h.Doc() == "" {
		t.Error("Doc is empty")
	}
	if pats := h.RoutePatterns(); len(pats) != 1 || pats[0] != pathEvents {
		t.Errorf("RoutePatterns = %v", pats)
	}
}

func TestServeRouteRejects(t *testing.T) {
	tm := auth.NewTokenManager("secret", time.Hour, nil)
	tok, _ := tm.Issue("op")
	ctx := context.Background()

	// Wrong method.
	h := NewHandler(New(), tm)
	if resp := h.ServeRoute(ctx, &gateway.Request{Method: http.MethodGet, Header: gateway.Header{}}); resp.Status != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", resp.Status)
	}
	// Missing Authorization header.
	if resp := h.ServeRoute(ctx, newAuthedReq("")); resp.Status != http.StatusUnauthorized {
		t.Fatalf("no-auth status = %d, want 401", resp.Status)
	}
	// Malformed / invalid token.
	if resp := h.ServeRoute(ctx, newAuthedReq("not-a-valid-token")); resp.Status != http.StatusUnauthorized {
		t.Fatalf("bad-token status = %d, want 401", resp.Status)
	}
	// A handler with no token manager rejects everything (authenticated -> false).
	nilTok := NewHandler(New(), nil)
	if resp := nilTok.ServeRoute(ctx, newAuthedReq(tok)); resp.Status != http.StatusUnauthorized {
		t.Fatalf("nil-tokens status = %d, want 401", resp.Status)
	}
}

func TestServeRouteStreams(t *testing.T) {
	bus := New()
	tm := auth.NewTokenManager("secret", time.Hour, nil)
	tok, _ := tm.Issue("op")
	h := NewHandler(bus, tm)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resp := h.ServeRoute(ctx, newAuthedReq(tok))
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/x-ndjson" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if resp.Stream == nil {
		t.Fatal("expected a Stream")
	}

	dec := json.NewDecoder(resp.Stream)
	bus.Publish(Event{Kind: KindStackDeployed, Project: "blog"})
	var e Event
	if err := dec.Decode(&e); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if e.Kind != KindStackDeployed || e.Project != "blog" {
		t.Fatalf("streamed frame wrong: %+v", e)
	}
	if bus.Subscribers() != 1 {
		t.Fatalf("expected 1 subscriber while streaming, got %d", bus.Subscribers())
	}

	// Cancelling the request context tears the feed down and unsubscribes.
	cancel()
	waitFor(t, "unsubscribe on ctx cancel", func() bool { return bus.Subscribers() == 0 })
}

// Closing the read end (client disconnect) makes the next encode fail, so the
// producer goroutine returns and unsubscribes (covers the encode-error path).
func TestServeRouteClientDisconnect(t *testing.T) {
	bus := New()
	tm := auth.NewTokenManager("secret", time.Hour, nil)
	tok, _ := tm.Issue("op")
	h := NewHandler(bus, tm)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resp := h.ServeRoute(ctx, newAuthedReq(tok))
	rc, ok := resp.Stream.(io.ReadCloser)
	if !ok {
		t.Fatal("stream is not an io.ReadCloser")
	}
	waitFor(t, "subscriber registered", func() bool { return bus.Subscribers() == 1 })
	_ = rc.Close() // simulate the client going away

	// Drive an event through; the write to the closed pipe fails and the producer
	// goroutine returns, unsubscribing. Keep nudging until it's gone.
	waitFor(t, "unsubscribe on client disconnect", func() bool {
		bus.Publish(Event{Kind: KindContainerState})
		return bus.Subscribers() == 0
	})
}

// waitFor polls cond until true or a short deadline, failing with what timed out.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}
