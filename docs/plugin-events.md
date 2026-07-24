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

## Design (not built): typed contracts + schema validation

The pub/sub above is untyped — a subscriber trusts the publisher's `Data` shape. The
next step turns the bus into a **typed, enforced interface layer**: a plugin declares
its public event contract, and hope — which sits in the middle of every plugin↔plugin
interaction — validates the payloads with JSON Schema. Neither side can bypass it,
because nothing on the wire is peer-to-peer; hope is the broker.

### Level 1 — typed events (extends the live bus)

A plugin declares what it publishes and consumes, each with a JSON Schema:

```go
p.Publishes("alert", schemaJSON, "a fired alert")   // outbound contract
p.Consumes("ack",   schemaJSON, "acknowledge an alert") // inbound contract (with OnEvent)
```

These ride in `hope.schema` as an `events: [{kind, dir, schema, reason}]` list (additive;
old hope ignores it). hope enforces:

- **Outbound** — in `ingress.publish` (`internal/pluginhost/ingress.go`), validate
  `Event.Data` against the publisher's declared schema for that kind. Invalid → `422`, no
  bus publish. A plugin can't emit garbage on its own contract. `Event.Data` is already
  `json.RawMessage`, so this is a pure add.
- **Inbound (optional)** — in `fanout` (`internal/pluginhost/fanout.go`), validate against
  the subscriber's `Consumes` schema before the `hope.event` push; mismatch → skip that
  subscriber (its declared expectation wasn't met), logged.

### Level 2 — direct plugin→plugin calls (the apex)

Beyond broadcast, a plugin exposes public **methods** another plugin invokes
request/response — a new `POST /rpc/_plugin/call {target, method, args}` ingress
(mirrors `_plugin_events`: `DeriveToken` bearer, per-identity routing, caps). hope:

1. resolves `target` to its live container, checks a `call:<target>` grant,
2. validates `args` against the callee's declared input schema,
3. proxies the call (a reserved `hope.pluginCall` unary, like `hope.event`),
4. validates the result against the output schema, returns it.

Typed inter-plugin RPC, brokered + audited. A plugin advertises callable methods with
schemas the same way it advertises views/actions today.

### Why hope-as-broker makes this uniquely enforceable

- **No peer-to-peer wire.** Every event and call passes through hope's ingress/bus, so
  validation is unavoidable — not opt-in politeness. A malformed payload never reaches
  the other plugin.
- **Discovery + versioning.** hope surfaces each plugin's contract (publishes/consumes/
  callable methods + schemas) in the inspector and a registry, so authors target real
  interfaces, and a schema change is a visible, gate-able contract change (auto-disable +
  re-consent on a breaking growth, same as the permission model).
- **One validator, everywhere.** `Event.Data`/`args` are already JSON; a single JSON
  Schema validator in core (one dep) covers publish, deliver, and call. Feature-gated via
  `Caps`/`Supports` so old hope/plugins degrade to untyped.

This is the MOSA endgame: modules coordinate through **discoverable, versioned,
hope-enforced typed interfaces** — an open-systems contract, not a message convention.

## Where it lives

- SDK: `plugin/publish.go` (`Publish`), `plugin/plugin.go` (`OnEvent`, `RequirePermission`),
  `plugin/jsonrpc.go` (`hope.event` dispatch + `hope.init` reverse-channel fields).
- Core: `internal/events` (the bus), `internal/pluginhost/ingress.go`
  (`/rpc/_plugin_events` publish), `internal/pluginhost/fanout.go` (subscribe fan-out).
- Permission model + phased design: the event-bus section of the plan file.
