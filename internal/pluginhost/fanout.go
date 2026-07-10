package pluginhost

import (
	"context"
	"time"

	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/store"
)

// Permission scopes (mirror the SDK's Scope* constants in plugin/schema.go). Kept as
// local literals so hope's main module doesn't import the plugin module.
const (
	scopeEventsSubscribe = "events:subscribe"
	scopeEventsPublish   = "events:publish"
	scopeStorage         = "storage"
	scopeSpecLabel       = "spec:label"
)

const (
	fanoutTimeout = 2 * time.Second // per hope.event push
	fanoutWorkers = 8               // max concurrent pushes fleet-wide
)

// StartEventFanout subscribes to the bus and pushes each hope event to every enabled
// plugin holding the events:subscribe grant, as a unary hope.event call. Best-effort
// and bounded: the bus reader drains fast and hands each push to a bounded worker
// pool, so a slow plugin never backs up the bus (a saturated dispatch drops the
// delivery); each push is time-bounded. Runs until ctx is cancelled. No-op without a
// bus or store (nothing to fan out / no grants to check).
func (r *PluginsRouter) StartEventFanout(ctx context.Context) {
	if r.bus == nil || !r.store.Enabled() {
		return
	}
	ch, cancel := r.bus.Subscribe(0)
	sem := make(chan struct{}, fanoutWorkers)
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
				r.dispatchEvent(ctx, e, sem)
			}
		}
	}()
}

// dispatchEvent pushes one event to the subscribed plugins without blocking the bus
// reader. Each push runs on a bounded worker; when the pool is saturated the delivery
// is dropped (best-effort — the plugin sees a gap, same tolerance the bus itself has).
func (r *PluginsRouter) dispatchEvent(ctx context.Context, e events.Event, sem chan struct{}) {
	if !fanoutKind(e.Kind) {
		return
	}
	recs, err := r.store.Plugins()
	if err != nil {
		return
	}
	for _, rec := range recs {
		if !shouldDeliver(rec, e) {
			continue
		}
		select {
		case sem <- struct{}{}:
			go func(rec store.PluginRecord) {
				defer func() { <-sem }()
				r.pushEvent(ctx, rec, e)
			}(rec)
		default:
			// saturated — drop this delivery
		}
	}
}

// shouldDeliver reports whether an event should be pushed to a given plugin: it must
// be enabled, hold the events:subscribe grant, be on the event's host (a host-less
// event is fleet-wide), and not be the event's own publisher (no self-echo).
func shouldDeliver(rec store.PluginRecord, e events.Event) bool {
	if !rec.Enabled || !rec.HasGrant(scopeEventsSubscribe) {
		return false
	}
	if e.Host != "" && rec.Host != "" && e.Host != rec.Host {
		return false
	}
	if e.Source == "plugin."+rec.Key {
		return false
	}
	return true
}

// fanoutKind reports whether a kind is delivered to plugins. Control frames and
// hope-internal signals are not (a plugin never needs ping/resync/consent prompts).
func fanoutKind(k events.Kind) bool {
	switch k {
	case events.KindPing, events.KindResync, events.KindPermissionReq:
		return false
	}
	return true
}

// pushEvent dials the plugin and delivers one event via hope.event. Detached from the
// bus context's cancellation but time-bounded, so shutdown still stops it and a hung
// plugin can't hold a worker forever.
func (r *PluginsRouter) pushEvent(parent context.Context, rec store.PluginRecord, e events.Event) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), fanoutTimeout)
	defer cancel()
	members, host, ok := r.group(ctx, rec.Key)
	if !ok {
		return // no live container for this identity right now
	}
	ep, err := r.dial(ctx, host, representative(members), rec.Token, false)
	if err != nil {
		return
	}
	_, _ = ep.callRPC(ctx, "hope.event", e) // best-effort; a method-not-found (old SDK) is fine
}
