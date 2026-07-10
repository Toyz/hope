package events

import "testing"

// recv does a non-blocking read; delivery is synchronous inside Publish, so any
// frame the test expects is already buffered by the time Publish returns.
func recv(t *testing.T, ch <-chan Event) (Event, bool) {
	t.Helper()
	select {
	case e := <-ch:
		return e, true
	default:
		return Event{}, false
	}
}

func mustRecv(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	e, ok := recv(t, ch)
	if !ok {
		t.Fatal("expected a frame, got none")
	}
	return e
}

func TestPublishFanout(t *testing.T) {
	b := New()
	ch, cancel := b.Subscribe(0)
	defer cancel()
	b.Publish(Event{Kind: KindStackDeployed, Project: "a"})
	b.Publish(Event{Kind: KindStackDestroyed, Project: "b"})

	e1 := mustRecv(t, ch)
	if e1.Seq != 1 || e1.Kind != KindStackDeployed || e1.Project != "a" || e1.Source != SourceHope {
		t.Fatalf("frame 1 wrong: %+v", e1)
	}
	e2 := mustRecv(t, ch)
	if e2.Seq != 2 || e2.Kind != KindStackDestroyed {
		t.Fatalf("frame 2 wrong: %+v", e2)
	}
	if e1.Ts == 0 {
		t.Fatal("Ts not stamped")
	}
}

func TestFreshSubscribeNoReplay(t *testing.T) {
	b := New()
	b.Publish(Event{Kind: KindStackDeployed}) // before anyone subscribes
	ch, cancel := b.Subscribe(0)              // fresh connect => no replay
	defer cancel()
	if e, ok := recv(t, ch); ok {
		t.Fatalf("fresh subscribe should replay nothing, got %+v", e)
	}
	b.Publish(Event{Kind: KindStackDestroyed})
	if e := mustRecv(t, ch); e.Kind != KindStackDestroyed || e.Seq != 2 {
		t.Fatalf("live frame wrong: %+v", e)
	}
}

func TestReplaySince(t *testing.T) {
	b := New()
	sink, cancel0 := b.Subscribe(0) // keep the ring populated via a live sub too
	defer cancel0()
	b.Publish(Event{Kind: KindStackDeployed})  // seq 1
	b.Publish(Event{Kind: KindStackRedeployed}) // seq 2
	b.Publish(Event{Kind: KindStackDestroyed})  // seq 3
	// drain the live sub so it isn't relevant
	for range 3 {
		mustRecv(t, sink)
	}

	ch, cancel := b.Subscribe(1) // reconnect: saw up to seq 1
	defer cancel()
	e2 := mustRecv(t, ch)
	e3 := mustRecv(t, ch)
	if e2.Seq != 2 || e3.Seq != 3 {
		t.Fatalf("replay wrong: %+v %+v", e2, e3)
	}
	if _, ok := recv(t, ch); ok {
		t.Fatal("replay should stop at the newest event")
	}
}

func TestGapOlderThanRingResyncs(t *testing.T) {
	b := New()
	for range ringSize + 50 {
		b.Publish(Event{Kind: KindContainerState})
	}
	// since=1 is far older than the oldest retained seq -> single resync, no gap replay.
	ch, cancel := b.Subscribe(1)
	defer cancel()
	e := mustRecv(t, ch)
	if e.Kind != KindResync {
		t.Fatalf("expected resync for an out-of-ring gap, got %+v", e)
	}
	if _, ok := recv(t, ch); ok {
		t.Fatal("resync should be the only preload frame")
	}
}

func TestSlowSubscriberDropsThenResyncs(t *testing.T) {
	b := New()
	ch, cancel := b.Subscribe(0)
	defer cancel()
	// Fill the buffer exactly, without reading.
	for range subChanBuf {
		b.Publish(Event{Kind: KindContainerState})
	}
	// This one can't fit -> subscriber marked dropped, event skipped for it.
	b.Publish(Event{Kind: KindContainerState})

	// Drain everything buffered.
	for range subChanBuf {
		mustRecv(t, ch)
	}
	// Next publish: the dropped subscriber first gets a resync, then the live event.
	b.Publish(Event{Kind: KindStackDeployed})
	if e := mustRecv(t, ch); e.Kind != KindResync {
		t.Fatalf("expected resync after catch-up, got %+v", e)
	}
	if e := mustRecv(t, ch); e.Kind != KindStackDeployed {
		t.Fatalf("expected the live event after resync, got %+v", e)
	}
}

func TestCancelUnsubscribes(t *testing.T) {
	b := New()
	_, cancel := b.Subscribe(0)
	if n := b.Subscribers(); n != 1 {
		t.Fatalf("want 1 subscriber, got %d", n)
	}
	cancel()
	cancel() // idempotent
	if n := b.Subscribers(); n != 0 {
		t.Fatalf("want 0 subscribers after cancel, got %d", n)
	}
}
