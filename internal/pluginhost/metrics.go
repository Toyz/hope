package pluginhost

import (
	"sync"
	"sync/atomic"
	"time"
)

// pluginMetrics is lightweight in-memory observability for one plugin: call and
// error counts plus latency, so the operator can see which plugins are hot, slow,
// or failing. Reset on restart (not persisted — the audit log is the durable trail).
type pluginMetrics struct {
	calls   atomic.Int64
	errors  atomic.Int64
	totalMs atomic.Int64
	lastMs  atomic.Int64
	lastAt  atomic.Int64 // unix millis of the most recent call
}

func (m *pluginMetrics) record(ok bool, d time.Duration) {
	m.calls.Add(1)
	if !ok {
		m.errors.Add(1)
	}
	ms := d.Milliseconds()
	m.totalMs.Add(ms)
	m.lastMs.Store(ms)
	m.lastAt.Store(time.Now().UnixMilli())
}

// PluginMetrics is the snapshot the Metrics RPC returns for one plugin.
type PluginMetrics struct {
	Key      string  `json:"key"`
	Calls    int64   `json:"calls"`
	Errors   int64   `json:"errors"`
	AvgMs    float64 `json:"avg_ms"`
	LastMs   int64   `json:"last_ms"`
	LastAtMs int64   `json:"last_at_ms"`
}

func (m *pluginMetrics) snapshot(key string) PluginMetrics {
	calls := m.calls.Load()
	avg := 0.0
	if calls > 0 {
		avg = float64(m.totalMs.Load()) / float64(calls)
	}
	return PluginMetrics{
		Key: key, Calls: calls, Errors: m.errors.Load(),
		AvgMs: avg, LastMs: m.lastMs.Load(), LastAtMs: m.lastAt.Load(),
	}
}

// metricsRegistry holds per-plugin metrics keyed by plugin identity.
type metricsRegistry struct {
	mu sync.Mutex
	m  map[string]*pluginMetrics
}

func (r *metricsRegistry) get(key string) *pluginMetrics {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m == nil {
		r.m = map[string]*pluginMetrics{}
	}
	pm := r.m[key]
	if pm == nil {
		pm = &pluginMetrics{}
		r.m[key] = pm
	}
	return pm
}

func (r *metricsRegistry) snapshot() []PluginMetrics {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]PluginMetrics, 0, len(r.m))
	for k, pm := range r.m {
		out = append(out, pm.snapshot(k))
	}
	return out
}
