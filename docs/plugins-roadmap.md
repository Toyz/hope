# hope plugins — roadmap (what's shipped, what's next)

The container-plugin system (discover a container's JSON-RPC endpoint, trust it,
render + proxy its capabilities). This tracks what's done and what's deliberately
deferred. Protocol spec: [plugin-protocol.md](plugin-protocol.md).

## Shipped

- **Discovery + trust** — fleet-wide crawler + cache; enable/disable/forget;
  deterministic per-plugin token; settings sealed at rest.
- **Dialing** — local network-attach + remote agent DIAL stream; per-call timeout +
  response body cap; self-heal on redeploy.
- **Surfaces rendered** — container panel, full page (incl. dynamic nested pages),
  rail nesting, command palette (plugin page jump).
- **Renderer** — kv / table / query / tree; syntax-highlight query editor; fill
  height; interactive tables (dynamic columns, `page_size`, `default`, row-detail
  modal, row actions with input fields); counter/series sparklines.
- **Security (Tier 1)** — plugin icon SVG sanitization + per-plugin namespace;
  action audit log; schema-hash re-approval (on top of image-digest stale check);
  destructive-action confirms on every surface.
- **Hardening (Tier 2)** — operator-tunable per-plugin caps (`[plugins.limits]`):
  concurrent calls/streams, call rate, stream frame size/rate; protocol-version
  negotiation (`X-Hope-Protocol-Version` + compat verdict).
- **Observability** — per-plugin call/error/latency metrics (`Plugins.Metrics`).
- **Reference plugins** — hello-world, kitchen-sink (exercises the whole protocol),
  hope-postgres.

## Deferred — additional surfaces (descriptor + renderer already support them)

These reuse `<hope-plugin-surface>` verbatim; the work is wiring the mount point.

1. **`dashboard` widget** — plugin tiles on the fleet/host dashboard. Host: a
   `DashboardWidgets()` method returning enabled plugins' `dashboard` contributions;
   FE: mount them in `pages/dashboard.tsx`.
2. **`stack` widget** — same, in the stack view, filtered by the contribution
   `match` against the stack's containers.
3. **`command` actions** — the palette jumps to plugin *pages* today; extend it to
   *run* a plugin action from ⌘K (prompt fields → `Plugins.call` with audit). Needs
   an Entry variant with a run callback, reusing the surface's action flow.

## Deferred — ecosystem (the scaling story)

4. **Install flow** — today hope discovers already-running plugin containers. Add
   "install a plugin by image ref" → hope deploys the sidecar into a stack. The
   app-store on-ramp.
5. **Image distribution** — get a plugin image onto N hosts. Ties into the
   self-hosted registry plan (registry container + fleet pull + auth distribution).
6. **MCP bridge** — re-expose enabled plugins as AI tools via a `hope mcp` adapter,
   so an agent can drive fleet plugins. The AI-native payoff.
7. **Non-Go SDK example** — a ~30-line Node/Python plugin proving the wire is
   genuinely language-agnostic ("extend without joining").
8. **Multi-replica dial policy** — document/handle stateful-action-on-one-replica
   for replicated plugin services (reads/streams already tolerate any replica).

## Notes on ownership (where policy lives)

- **Presentation** (page size, query defaults, row interactivity, icons) is
  **plugin-level** — declared in the schema; the author knows their data.
- **Safety caps** (concurrency, rate, frame limits) are **hope-owned** — a plugin
  must never raise its own DoS ceiling — but **operator-tunable** via config.
- **Trust** (enable, re-approval, audit) is **operator-owned** — discovered is not
  trusted; every action is logged.
