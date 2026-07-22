package pluginhost

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/toyz/hope/internal/docker"
)

// cachedLayout is a plugin's last successfully fetched hope.schema + hope.layout. It
// lets hope render an unreachable plugin's surfaces as DEGRADED (title / tabs / widget
// shell, with its cells reporting the outage) instead of silently omitting it — the
// operator sees the plugin is present but down, not that it vanished. In-memory (like
// metrics): a cold hope has no cache, so a plugin never reached since boot is still
// skipped (there's nothing to render), and the cache clears on disable/forget.
type cachedLayout struct {
	schema json.RawMessage
	layout json.RawMessage
	at     int64 // unix millis of the last successful fetch
}

// layoutCache holds the last-good schema+layout per plugin identity.
type layoutCache struct {
	mu sync.RWMutex
	m  map[string]cachedLayout
}

func (c *layoutCache) put(key string, schema, layout json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]cachedLayout{}
	}
	c.m[key] = cachedLayout{schema: schema, layout: layout, at: time.Now().UnixMilli()}
}

func (c *layoutCache) get(key string) (cachedLayout, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.m[key]
	return v, ok
}

// drop forgets a plugin's cached layout so a re-enabled or re-installed plugin can't
// render stale contributions before its first successful dial.
func (c *layoutCache) drop(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, key)
}

// surfaceLayout dials the plugin and fetches its hope.schema + hope.layout, caching the
// result on success. On a dial / schema / layout failure it falls back to the last-good
// cached copy and returns a non-empty `degraded` reason, so the caller can render the
// plugin's surfaces as degraded rather than dropping it. ok is false only when the
// plugin is unreachable AND has no cache — there is genuinely nothing to render.
func (r *PluginsRouter) surfaceLayout(ctx context.Context, host string, rep docker.PluginContainer, key, token string) (schemaRaw json.RawMessage, sd schemaDoc, ld layoutDoc, degraded string, ok bool) {
	fail := func(reason string) (json.RawMessage, schemaDoc, layoutDoc, string, bool) {
		cl, has := r.layouts.get(key)
		if !has {
			return nil, schemaDoc{}, layoutDoc{}, "", false
		}
		var s schemaDoc
		var l layoutDoc
		_ = json.Unmarshal(cl.schema, &s)
		if json.Unmarshal(cl.layout, &l) != nil {
			return nil, schemaDoc{}, layoutDoc{}, "", false
		}
		return cl.schema, s, l, reason, true
	}
	ep, err := r.dial(ctx, host, rep, token, false)
	if err != nil {
		return fail("unreachable")
	}
	schemaRaw, err = ep.callRPC(ctx, "hope.schema", nil)
	if err != nil {
		return fail("schema call failed")
	}
	layoutRaw, err := ep.callRPC(ctx, "hope.layout", nil)
	if err != nil {
		return fail("layout call failed")
	}
	_ = json.Unmarshal(schemaRaw, &sd)
	if err := json.Unmarshal(layoutRaw, &ld); err != nil {
		return fail("layout parse failed")
	}
	r.layouts.put(key, schemaRaw, layoutRaw)
	return schemaRaw, sd, ld, "", true
}
