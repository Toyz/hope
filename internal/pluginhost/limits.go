package pluginhost

import (
	"sync"
	"time"
)

// Per-plugin resource caps so a single bad or hostile plugin cannot exhaust the
// control plane. hope is the control plane; every plugin is isolated to a bounded
// slice of it. Tunables are deliberately generous for real use but finite.
const (
	maxConcurrentCalls   = 8  // in-flight unary calls per plugin
	maxConcurrentStreams = 4  // live streams per plugin
	callRatePerSec       = 20 // sustained unary call rate per plugin
	callBurst            = 40 // token-bucket burst

	maxFrameBytes   = 64 << 10 // drop stream frames larger than this
	maxFramesPerSec = 50       // drop stream frames beyond this rate
)

// pluginLimiter holds one plugin's concurrency semaphores + a call-rate token
// bucket. All methods are safe for concurrent use.
type pluginLimiter struct {
	calls   chan struct{}
	streams chan struct{}

	mu     sync.Mutex
	tokens float64
	last   time.Time
}

func newPluginLimiter() *pluginLimiter {
	return &pluginLimiter{
		calls:   make(chan struct{}, maxConcurrentCalls),
		streams: make(chan struct{}, maxConcurrentStreams),
		tokens:  callBurst,
		last:    time.Now(),
	}
}

// allowRate consumes one token, refilling since the last call; false when the
// bucket is empty (the plugin is being called faster than callRatePerSec).
func (l *pluginLimiter) allowRate() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.tokens += now.Sub(l.last).Seconds() * callRatePerSec
	if l.tokens > callBurst {
		l.tokens = callBurst
	}
	l.last = now
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

// acquireCall reserves an in-flight unary slot without blocking; returns a release
// func and true, or (nil, false) when the plugin is at its concurrency cap.
func (l *pluginLimiter) acquireCall() (func(), bool) {
	select {
	case l.calls <- struct{}{}:
		return func() { <-l.calls }, true
	default:
		return nil, false
	}
}

// acquireStream reserves a live-stream slot without blocking.
func (l *pluginLimiter) acquireStream() (func(), bool) {
	select {
	case l.streams <- struct{}{}:
		return func() { <-l.streams }, true
	default:
		return nil, false
	}
}

// frameGate enforces per-stream frame size + rate caps. Not safe for concurrent use
// — one lives per stream goroutine.
type frameGate struct {
	windowStart time.Time
	count       int
}

func newFrameGate() *frameGate { return &frameGate{windowStart: time.Now()} }

// allow reports whether a frame of n bytes may pass: oversize frames are always
// dropped; otherwise up to maxFramesPerSec pass per rolling second.
func (g *frameGate) allow(n int) bool {
	if n > maxFrameBytes {
		return false
	}
	now := time.Now()
	if now.Sub(g.windowStart) >= time.Second {
		g.windowStart = now
		g.count = 0
	}
	if g.count >= maxFramesPerSec {
		return false
	}
	g.count++
	return true
}
