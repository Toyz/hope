package pluginhost

import (
	"context"

	"github.com/toyz/hope/internal/events"
)

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
func (r *PluginsRouter) StartRecordGC(ctx context.Context) {
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
		_ = r.store.DeletePlugin(rec.Key)
		_ = r.store.DeletePluginKVAll(rec.Key)
		r.bus.Publish(events.Event{Kind: events.KindPluginChanged, Host: host, Data: pluginChangeData(rec.Key, "reaped")})
	}
}
