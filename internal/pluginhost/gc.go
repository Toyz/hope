package pluginhost

import (
	"context"
	"time"

	"github.com/toyz/hope/internal/events"
)

// reconcileMisses is how many consecutive reconcile passes an enabled record's
// identity must be absent (on a reachable host) before it's reaped — a grace window
// that rides out a redeploy gap (old container gone, new one not yet discovered).
const reconcileMisses = 3

// StartRecordGC reaps orphaned plugin records off the event bus. Without it, deleting
// a stack (or removing a plugin's container) leaves the plugin's bbolt record —
// settings, storage, token, approval — orphaned forever, since the only other cleanup
// is the manual Forget.
//
// This is the FAST PATH: a stack.destroyed event is an intentional whole-stack
// teardown (never a redeploy, which keeps the same identity), so every record under
// that host/project is safe to drop immediately. The reconcile backstop for other
// removal routes (a record whose identity no longer has a container on a REACHABLE
// host) is a separate, discovery-driven follow-up. Runs until ctx is cancelled.
func StartRecordGC(ctx context.Context, r *PluginsRouter) {
	if r.bus == nil || !r.store.Enabled() {
		return
	}
	ch, cancel := r.bus.Subscribe(0)
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-ch:
				if !ok {
					return
				}
				if e.Kind == events.KindStackDestroyed && e.Host != "" && e.Project != "" {
					r.reapStack(e.Host, e.Project)
				}
			}
		}
	}()
}

// StartPluginLiveness keeps the rail's plugin view fresh when a plugin container's
// state changes out-of-band. The discovery scan is cached for cacheTTL (15s), so
// after restarting a plugin container the rail would show stale state until the TTL
// lapses. This subscribes to the bus and, on a container.state event that hits a
// discovered plugin container, busts the discovery cache and republishes
// plugin.changed so the UI refetches immediately. Unlike GC it needs no bbolt store,
// so it runs whenever plugins are enabled. Runs until ctx is cancelled.
func StartPluginLiveness(ctx context.Context, r *PluginsRouter) {
	if r.bus == nil {
		return
	}
	ch, cancel := r.bus.Subscribe(0)
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-ch:
				if !ok {
					return
				}
				if e.Kind == events.KindContainerState && e.Host != "" && r.touchesPlugin(e.IDs) {
					r.invalidateScan()
					r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Host: e.Host, Data: pluginChangeData("", "container-state")})
				}
			}
		}
	}()
}

// reapStack deletes every plugin record (and its storage) belonging to a destroyed
// stack.
func (r *PluginsRouter) reapStack(host, project string) {
	recs, err := r.store.Plugins()
	if err != nil {
		return
	}
	for _, rec := range recs {
		if rec.Host != host || rec.Project != project {
			continue
		}
		r.reap(rec.Key, host)
	}
}

// reap deletes one record + its storage and announces the change.
func (r *PluginsRouter) reap(key, host string) {
	_ = r.store.DeletePlugin(key)
	_ = r.store.DeletePluginKVAll(key)
	r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Host: host, Data: pluginChangeData(key, "reaped")})
}

// StartRecordReconcile is the GC BACKSTOP for removals the fast path (stack.destroyed)
// misses — a container deleted out-of-band, or an image swap that changed the compose
// identity. On an interval it reconciles enabled records against live discovery: a
// record whose identity is absent on a REACHABLE host for reconcileMisses consecutive
// passes is reaped. The reachable guard is the safety catch — an offline agent host's
// plugins simply vanish from discovery, so their absence proves nothing and they are
// never GC'd while the host is down. No-op without a store.
func StartRecordReconcile(ctx context.Context, r *PluginsRouter, every time.Duration) {
	if !r.store.Enabled() {
		return
	}
	r.missCount = map[string]int{}
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				r.reconcileOnce(ctx)
			}
		}
	}()
}

func (r *PluginsRouter) reconcileOnce(ctx context.Context) {
	online := map[string]bool{}
	for _, h := range r.hosts.All() {
		if h.Online {
			online[h.ID] = true
		}
	}
	live := map[string]bool{}
	for _, d := range r.scan(ctx, true) {
		live[pluginIdentity(d.Host, d.PC)] = true
	}
	recs, err := r.store.Plugins()
	if err != nil {
		return
	}
	for _, rec := range recs {
		switch {
		case live[rec.Key]:
			delete(r.missCount, rec.Key) // present -> reset any streak
		case !online[rec.Host]:
			// Host unreachable: absence is unknowable, keep the record untouched.
		default:
			r.missCount[rec.Key]++
			if r.missCount[rec.Key] >= reconcileMisses {
				delete(r.missCount, rec.Key)
				r.reap(rec.Key, rec.Host)
			}
		}
	}
}
