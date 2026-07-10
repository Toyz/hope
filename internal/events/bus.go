package events

import (
	"sync"
	"time"
)

// ringSize is how many recent events the bus keeps for replay-on-reconnect. A
// briefly-dropped connection reconnects with ?since=<lastSeq> and gets exactly the
// events it missed; a gap larger than the ring degrades to one resync (full
// refetch) instead of a silent hole. subChanBuf matches it so a fresh subscriber's
// replay preload always fits without blocking under the bus lock.
const (
	ringSize   = 256
	subChanBuf = 256
)

// Bus is an in-process publish/subscribe fan-out. Publish never blocks on a slow
// subscriber (a wedged browser tab must not stall producers): a subscriber whose
// buffer is full is marked dropped and skipped, and once it drains it receives a
// synthetic resync frame (telling the client to refetch current state) before live
// events resume. Mirrors the crawlers' "never block a producer" philosophy.
type Bus struct {
	mu   sync.Mutex
	seq  uint64
	ring []Event // last ringSize events, oldest-first (bounded slice, not circular index — simpler, N is tiny)
	subs map[*subscriber]struct{}
	now  func() int64 // injectable clock for tests
}

type subscriber struct {
	ch      chan Event
	dropped bool // sticky: set when a send would block, cleared by a delivered resync
}

// New returns an empty bus ready for Publish/Subscribe.
func New() *Bus {
	return &Bus{
		subs: make(map[*subscriber]struct{}),
		now:  func() int64 { return time.Now().UnixMilli() },
	}
}

// Publish stamps Seq/Ts/Source, records the event in the replay ring, and fans it
// out non-blockingly to every subscriber. Safe for concurrent producers.
func (b *Bus) Publish(e Event) {
	if b == nil {
		return // a producer wired without a bus (tests, embedding) is a no-op
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	e.Seq = b.seq
	if e.Ts == 0 {
		e.Ts = b.now()
	}
	if e.Source == "" {
		e.Source = SourceHope
	}
	b.ring = append(b.ring, e)
	if len(b.ring) > ringSize {
		b.ring = b.ring[len(b.ring)-ringSize:]
	}
	for s := range b.subs {
		b.deliver(s, e)
	}
}

// deliver sends one event to one subscriber without blocking. A dropped subscriber
// must first accept a resync (so the client refetches) before it sees live events
// again; if it's still backed up, it stays dropped and this event is skipped for it.
// Caller holds b.mu.
func (b *Bus) deliver(s *subscriber, e Event) {
	if s.dropped {
		select {
		case s.ch <- Event{Seq: e.Seq, Kind: KindResync, Ts: e.Ts, Source: SourceHope}:
			s.dropped = false
		default:
			return // still full; remain dropped, skip
		}
	}
	select {
	case s.ch <- e:
	default:
		s.dropped = true
	}
}

// Subscribe registers a new subscriber and returns its event channel plus a cancel
// func that unregisters it. sinceSeq replays the gap on reconnect: events newer than
// sinceSeq (that are still in the ring) are preloaded; sinceSeq==0 is a fresh connect
// (no replay — the client already loaded current state on page mount); a gap older
// than the ring preloads a single resync instead. Registration + preload are atomic
// under the bus lock so no event is missed or duplicated at the live boundary.
func (b *Bus) Subscribe(sinceSeq uint64) (<-chan Event, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &subscriber{ch: make(chan Event, subChanBuf)}
	for _, e := range b.replay(sinceSeq) {
		s.ch <- e // fits: replay is bounded by ringSize <= subChanBuf
	}
	b.subs[s] = struct{}{}
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs, s)
			b.mu.Unlock()
		})
	}
	return s.ch, cancel
}

// replay computes the preload frames for a (re)connecting subscriber. Caller holds
// b.mu.
func (b *Bus) replay(sinceSeq uint64) []Event {
	if sinceSeq == 0 || len(b.ring) == 0 {
		return nil // fresh connect, or nothing buffered yet
	}
	oldest := b.ring[0].Seq
	if sinceSeq < oldest-1 {
		// The gap predates the ring — we can't prove what was missed. One resync
		// tells the client to refetch current state.
		return []Event{{Seq: b.seq, Kind: KindResync, Ts: b.now(), Source: SourceHope}}
	}
	out := make([]Event, 0, len(b.ring))
	for _, e := range b.ring {
		if e.Seq > sinceSeq {
			out = append(out, e)
		}
	}
	return out
}

// Subscribers reports the current subscriber count (for a health gauge / debugging
// a stuck feed).
func (b *Bus) Subscribers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
