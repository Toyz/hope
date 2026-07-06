package pluginhost

import (
	"sync"
	"time"
)

// Limits is the per-plugin safety envelope that isolates the control plane from a
// bad or hostile plugin. hope OWNS these (a plugin must never raise its own DoS
// ceiling); the operator tunes them in [plugins.limits]. Defaults are generous for
// real use but finite.
type Limits struct {
	MaxConcurrentCalls   int
	MaxConcurrentStreams int
	CallRatePerSec       int
	CallBurst            int
	MaxFrameBytes        int
	MaxFramesPerSec      int
}

// DefaultLimits are the built-in caps applied when the operator sets nothing.
var DefaultLimits = Limits{
	MaxConcurrentCalls:   8,
	MaxConcurrentStreams: 4,
	CallRatePerSec:       20,
	CallBurst:            40,
	MaxFrameBytes:        64 << 10,
	MaxFramesPerSec:      50,
}

// WithDefaults fills any zero/negative field from DefaultLimits, so a partial
// operator config still yields a complete, safe envelope.
func (l Limits) WithDefaults() Limits {
	if l.MaxConcurrentCalls <= 0 {
		l.MaxConcurrentCalls = DefaultLimits.MaxConcurrentCalls
	}
	if l.MaxConcurrentStreams <= 0 {
		l.MaxConcurrentStreams = DefaultLimits.MaxConcurrentStreams
	}
	if l.CallRatePerSec <= 0 {
		l.CallRatePerSec = DefaultLimits.CallRatePerSec
	}
	if l.CallBurst <= 0 {
		l.CallBurst = DefaultLimits.CallBurst
	}
	if l.MaxFrameBytes <= 0 {
		l.MaxFrameBytes = DefaultLimits.MaxFrameBytes
	}
	if l.MaxFramesPerSec <= 0 {
		l.MaxFramesPerSec = DefaultLimits.MaxFramesPerSec
	}
	return l
}

// pluginLimiter holds one plugin's concurrency semaphores + a call-rate token
// bucket, bounded by the operator-configured Limits. Safe for concurrent use.
type pluginLimiter struct {
	lim     Limits
	calls   chan struct{}
	streams chan struct{}

	mu     sync.Mutex
	tokens float64
	last   time.Time
}

func newPluginLimiter(lim Limits) *pluginLimiter {
	return &pluginLimiter{
		lim:     lim,
		calls:   make(chan struct{}, lim.MaxConcurrentCalls),
		streams: make(chan struct{}, lim.MaxConcurrentStreams),
		tokens:  float64(lim.CallBurst),
		last:    time.Now(),
	}
}

// allowRate consumes one token, refilling since the last call; false when the
// bucket is empty (the plugin is being called faster than callRatePerSec).
func (l *pluginLimiter) allowRate() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.tokens += now.Sub(l.last).Seconds() * float64(l.lim.CallRatePerSec)
	if l.tokens > float64(l.lim.CallBurst) {
		l.tokens = float64(l.lim.CallBurst)
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

// frameGate enforces per-stream frame size + rate caps from the plugin's Limits.
// Not safe for concurrent use — one lives per stream goroutine.
type frameGate struct {
	maxBytes    int
	maxPerSec   int
	windowStart time.Time
	count       int
}

func newFrameGate(lim Limits) *frameGate {
	return &frameGate{maxBytes: lim.MaxFrameBytes, maxPerSec: lim.MaxFramesPerSec, windowStart: time.Now()}
}

// allow reports whether a frame of n bytes may pass: oversize frames are always
// dropped; otherwise up to maxPerSec pass per rolling second.
func (g *frameGate) allow(n int) bool {
	if n > g.maxBytes {
		return false
	}
	now := time.Now()
	if now.Sub(g.windowStart) >= time.Second {
		g.windowStart = now
		g.count = 0
	}
	if g.count >= g.maxPerSec {
		return false
	}
	g.count++
	return true
}
