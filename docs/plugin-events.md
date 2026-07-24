# Plugin ↔ plugin events (the reverse-channel bus)

hope has a single in-process **event bus**. hope publishes core events onto it
(stack redeployed, container state, agent online, image update, …) and streams them
live to the UI. Plugins are first-class participants on that same bus: a plugin can
**publish** its own events up the reverse channel, and any other plugin can
**subscribe** and react. This is the MOSA payoff — modules coordinate through a
standard open bus, with hope owning zero domain knowledge of what they say.

**This already works end-to-end.** No build needed; this doc describes the shape.

## The two SDK calls

```go
// PUBLISH — send an event up the reverse channel (needs the events:publish grant).
p.Publish(ctx, plugin.Event{
    Kind: "alert",                       // a short suffix YOU choose; hope namespaces it
    Data: json.RawMessage(`{"sev":"crit","msg":"replication lag 42s"}`),
})

// SUBSCRIBE — react to bus events, including other plugins' (needs events:subscribe).
p.OnEvent(func(ctx context.Context, e plugin.Event) error {
    // e.Kind == "plugin.<publisher-identity>.alert", e.Source == "plugin.<publisher>"
    // e.Data == the raw payload the publisher sent
    return nil
})
```

Registering `OnEvent` auto-declares `events:subscribe`; call `RequirePermission(
plugin.ScopeEventsPublish, "reason")` to declare publish. Both are consented by the
operator at enable — deny-by-default (see the permission model in the event-bus plan).

## What hope does in the middle (the trust boundary)

A plugin publishes to `POST /rpc/_plugin_events` with its per-install bearer token.
hope (`internal/pluginhost/ingress.go`):

- **Verifies identity** — recomputes `DeriveToken(key)` and constant-time compares.
  A co-located hostile container cannot forge another plugin's events (the other's
  token is `HMAC(hope-secret, otherKey)`; the secret never leaves hope).
- **Forces attribution** — hope sets `Source = "plugin.<key>"` and
  `Kind = "plugin.<key>.<sanitized-suffix>"`, ignoring whatever the plugin claims. A
  plugin can't spoof another's `Source` or emit a core `hope` kind.
- **Caps** — per-value size + per-plugin rate (`pluginhost.Limits`); over-cap → 413/429.
- Then `bus.Publish(event)`.

Fan-out (`internal/pluginhost/fanout.go`): the bus reader pushes each event to every
**enabled** plugin holding `events:subscribe`, as a unary `hope.event` call, on a
bounded worker pool (drop-oldest, 2s per push — a slow subscriber never backs up the
bus). `fanoutKind` forwards everything except `ping`/`resync`/`permission.requested`,
so plugin-published `plugin.*` kinds are delivered like core kinds.

## Flow

```
plugin A                    hope                         plugin B
  p.Publish ──POST──▶ verify token
                      force Source/Kind
                      bus.Publish ─────▶ UI feed (live)
                                   └───▶ fan-out ──hope.event──▶ p.OnEvent
```

Same bus also drives the UI, so a plugin event can surface as a toast / rail badge
without any subscriber.

## Poster child: alerts (no hope change)

`hope-postgres` evaluates its own rules and calls `p.Publish(ctx, Event{Kind:"alert",
Data: {severity,title,detail,dedupeKey}})`. A separate `hope-notifier` plugin
`OnEvent`s those and fans them to Slack/email. hope knows nothing about postgres or
Slack — it's pure transport between two modules. Ack/mute/resolve are follow-up
events keyed by `dedupeKey`.

## Requirements / caveats

- **Both plugins enabled + granted** — publisher needs `events:publish`, subscriber
  `events:subscribe`. Missing grant → the call is inert (deny-by-default).
- **Reverse channel must be live** — hope delivers `hopeBaseURL` + `pluginKey` in
  `hope.init` (needs a callback URL configured on hope). `p.Publish` is a clean no-op
  until then, so a new plugin on an old hope degrades gracefully.
- **Best-effort delivery** — fire-and-forget, time-bounded, drop-oldest on a saturated
  worker pool. Not a durable queue; design idempotent reactions (like the UI's
  idempotent rail patches).
- **Identity is per-install** — `Source` is the publisher's `host|project/service`
  stable key, so two installs of the same image are distinct publishers.
- **hope reserves the namespace** — you pick the kind *suffix*; hope owns the
  `plugin.<key>.` prefix. You cannot emit a core kind or spoof another plugin.

## Where it lives

- SDK: `plugin/publish.go` (`Publish`), `plugin/plugin.go` (`OnEvent`, `RequirePermission`),
  `plugin/jsonrpc.go` (`hope.event` dispatch + `hope.init` reverse-channel fields).
- Core: `internal/events` (the bus), `internal/pluginhost/ingress.go`
  (`/rpc/_plugin_events` publish), `internal/pluginhost/fanout.go` (subscribe fan-out).
- Permission model + phased design: the event-bus section of the plan file.
