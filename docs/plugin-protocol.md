# hope plugin protocol

hope is extensible by the services running on your fleet, not only by Go code
compiled into it. A **plugin** is any container that exposes a small JSON-RPC 2.0
endpoint and declares a few labels. hope discovers it across the fleet, and — once
you enable it — renders its data views, actions, and live streams inside the hope
UI, proxying every call itself.

The thesis: extend hope without joining it. A plugin is *your* container, *your*
language, *your* endpoint. No recompiling hope, no framework to adopt, no hope
release to wait on.

This document is the wire contract. The Go SDK (`github.com/toyz/hope/plugin`) is
the reference implementation and the fast path, but any language that speaks HTTP +
JSON can implement it.

## At a glance

- Transport: HTTP `POST` to a single path (default `/__hope`), JSON-RPC 2.0.
- Fixed methods hope calls: `hope.schema` (manifest) and `hope.layout` (UI
  descriptor). The `hope.*` namespace is reserved.
- Your methods: any name you register — views (read), actions (mutate), streams
  (live). hope calls them by name.
- Discovery: three container labels.
- Trust: the operator explicitly enables each discovered plugin. Only `hope.schema`
  is callable before that; everything else requires a bearer token.

## Labels

Declare these on the plugin container so hope discovers it:

```yaml
labels:
  - "hope.plugin=true"          # opt in (required)
  - "hope.plugin.port=8080"     # container port the endpoint listens on (required)
  - "hope.plugin.path=/__hope"  # endpoint path (optional, default /__hope)
  # optional pre-manifest display hints, used only until the manifest loads:
  - "hope.plugin.title=Badge Directory"
  - "hope.plugin.icon=database"
```

Identity (name, version, icon) comes from `hope.schema`, not the labels — the
labels only tell hope where to dial.

## The browser never touches your plugin

hope proxies every call. The plugin endpoint stays internal to the docker network
(unpublished); hope reaches it by attaching to the network locally, or over the
agent tunnel for a remote host. So a plugin needs **no CORS, no TLS, no public
port**. Keep the endpoint unpublished.

## Authentication

Every method except `hope.schema` requires a bearer token:

```
Authorization: Bearer <token>
```

Two ways to establish the shared secret:

1. **Pinned (recommended).** Set `HOPE_PLUGIN_TOKEN` in the plugin container's
   environment and enter the same value in hope when you enable the plugin. hope
   sends it on every call; the SDK verifies it with a constant-time compare.
2. **Trust-on-first-use.** If the plugin has no configured token, the SDK pins the
   first bearer hope presents and rejects mismatches thereafter. hope mints a
   per-plugin token on enable, so this needs zero operator config — at the cost of a
   first-call trust window on a shared network. Prefer pinned for anything
   sensitive.

`hope.schema` is intentionally unauthenticated so hope can read a plugin's identity
during discovery, before you have decided to trust it. Keep `hope.schema` free of
anything secret.

## Methods

### `hope.schema` -> Schema

Identity + capabilities. Returned unauthenticated.

```json
{
  "protocolVersion": 1,
  "name": "hope-postgres",
  "version": "1.0.0",
  "description": "Browse and query a Postgres database",
  "icon": "database",
  "icons": { "pg": "<path d=\"...\"/>" },
  "views":   [ { "method": "counts", "label": "Counts", "kind": "kv" } ],
  "actions": [ { "method": "reindex", "label": "Reindex", "danger": true, "fields": [ ... ] } ],
  "streams": [ { "method": "activity", "label": "Activity", "kind": "counter" } ]
}
```

- `icon` — a hope built-in icon name, or a key in `icons`.
- `icons` — plugin-scoped map of `name -> inner SVG markup` (path/circle/rect
  elements, **not** a full `<svg>`), 24x24 stroke to match hope's icon set. hope
  sanitizes and namespaces these per plugin; they cannot shadow hope's built-ins or
  other plugins' icons. Anything hope can't sanitize is dropped.

**View kinds** (`views[].kind`):

| kind    | handler returns                                   | rendered as            |
|---------|---------------------------------------------------|------------------------|
| `kv`    | a flat object `{label: value}`                    | key/value list         |
| `table` | `{ "columns": ["a","b"], "rows": [[...], ...] }`   | paginated grid         |
| `query` | same `{columns, rows}`, computed from user input  | query editor + grid    |
| `tree`  | `{ "nodes": [ { "label", "children": [...] } ] }`  | tree browser           |
| `chart` | `{ "type": "bar"\|"line", "labels": [...], "series": [{ "name", "values": [...] }] }` | bar/line chart w/ axes + legend |

A `query` view receives the user's text in the request params as
`{ "input": "<text>" }`.

**Interactive tables** — `table` and `query` view descriptors may declare
interactivity; the columns are always dynamic (hope renders exactly the
`columns`/`rows` you return, pgAdmin-style):

| field         | effect                                                                       |
|---------------|------------------------------------------------------------------------------|
| `default`     | (query) initial editor text; `{param}` placeholders are filled from the page param, e.g. `"select * from {table}"` |
| `page_size`   | rows hope shows per page (plugin-level — you know your data). 0 => hope default |
| `row_method`  | a method hope calls with `{row: {column: value}}` when a row is clicked; the returned kv/table shows in a modal |
| `row_actions` | per-row action buttons: `[{ "method", "label", "icon?", "danger?", "fields?" }]`. Clicking calls `method` with `{row: {...}}` (plus any collected `fields`); `danger` confirms first, then hope refetches the table |
| `edit_method` | inline cell edit: editing a cell calls `method` with `{row, column, value}`. `edit_columns` (optional) limits which columns are editable. hope refetches on success |

Every one of these is a call into a method *you* implement — hope proxies, you
decide. Read the clicked row in your handler as `params.row`.

**Header actions** — a `page`/`container`/`dashboard` contribution may set
`actions: ["method", ...]` (names of registered actions), rendered as a toolbar in
the surface header (for pages, hope's page header) — page-level actions distinct
from leaf actions inside the layout. hope collects fields, confirms danger, audits.

**Stream kinds** (`streams[].kind`): `counter` (numbers ticking), `log`
(append-only lines), `series` (time series -> sparkline).

**Settings** (`settings[]`) — operator-managed configuration the plugin exposes.
These are distinct from an action's `fields` (per-invocation input) and from the
plugin's rendered panel: a **setting** is config the operator *sets and manages*
(in the plugin inspector), a **view/stream** is what the plugin *shows* (on the
container inspector). Each entry:

```json
{ "key": "page_size", "label": "Page size", "kind": "number", "default": "100", "hint": "rows per query page" }
```

`kind` is `text` | `textarea` | `select` (with `options`) | `toggle` | `number` |
`secret`. hope renders the form, persists the values **encrypted at rest**, and
pushes them to the plugin via the reserved `hope.settings` method:

```json
{"jsonrpc":"2.0","id":N,"method":"hope.settings","params":{"values":{"page_size":"250"}}}
```

A `secret` setting is masked in the UI and never rendered back. In the Go SDK,
declare a setting with `p.Setting(...)` and read the current value in any handler
with `p.SettingValue("page_size")`.

### `hope.layout` -> Layout

A UI contribution descriptor. Requires auth.

```json
{
  "protocolVersion": 1,
  "contributions": [
    {
      "surface": "container",
      "title": "Postgres",
      "icon": "database",
      "match": { "images": ["postgres*"] },
      "node": {
        "kind": "section",
        "children": [
          { "kind": "tabs", "children": [
            { "kind": "leaf", "ref": "counts",  "title": "Overview" },
            { "kind": "leaf", "ref": "query",   "title": "Query" },
            { "kind": "leaf", "ref": "schema",  "title": "Schema" }
          ] }
        ]
      }
    }
  ]
}
```

A **contribution** mounts a layout tree onto a **surface**. hope renders the
surfaces it implements and silently ignores the rest — so a plugin built for a
newer hope degrades gracefully on an older one, and vice-versa. Combined with
`protocolVersion`, that is the forward-compatibility guarantee: unknown surfaces,
node kinds, and view kinds are skipped, never fatal.

**Surfaces** (only `container` is rendered in hope v1; the rest are reserved and
will render in later versions with no protocol change):

| surface     | mount point                              | rendered |
|-------------|------------------------------------------|----------|
| `container` | a tab/panel in the container inspector   | yes      |
| `page`      | a full custom nav page (incl. dynamic nested pages via `pages[]`) | yes |
| `command`   | plugin pages + actions in the command palette | yes |
| `rail`      | a rail/nav entry (plugin pages nest under their container) | yes |
| `dashboard` | a fleet/host dashboard widget            | yes      |
| `stack`     | a stack-view widget                      | later    |

**Dynamic pages** — a `page` contribution may carry `pages[]` (one level of
nesting): each item shares the contribution's `node` but passes its own `param`,
which hope merges into every call the page makes. So one layout becomes many rail
entries (e.g. a database's tables), each rendering the same views with a different
argument. Read it in a handler as `params.<key>`.

**Match** (container/stack surfaces) decides which containers a contribution
applies to. The plugin declares it; hope does not map containers to plugins. Set
clauses are AND-ed; values within a clause are OR-ed. An empty/absent match means
"the plugin's own container" — the trivial self-describing case.

```json
{ "always": true }                      // every container
{ "images": ["postgres*", "pgvector*"] } // by image ref glob
{ "labels": { "app": "db" } }            // by label
{ "services": ["postgres"] }             // by compose service name
```

**Layout tree** nodes are surface-agnostic — the same tree drives a container
panel now and a full page later:

- `section` — titled group (`title`, `children`)
- `tabs` — tabbed children (each child's `title` is its tab label)
- `row` / `grid` — arrangement (`children`, optional `size` weights)
- `leaf` — a single `view`/`action`/`stream` referenced by `ref` (its method name)

If a plugin returns no contributions, hope synthesizes a single `container`
contribution (matching the plugin's own container) that lists its views/streams,
then its actions — so a minimal plugin renders with zero layout code.

### Your methods

- **View / action** — a normal unary JSON-RPC call: hope POSTs
  `{"jsonrpc":"2.0","id":N,"method":"<name>","params":{...}}` and you reply
  `{"jsonrpc":"2.0","id":N,"result":<value>}`. Actions receive the UI-collected
  field values as `params`.
- **Stream** — hope POSTs the same request; you reply with
  `Content-Type: application/x-ndjson` and write one JSON-RPC result frame per line
  as events occur:

  ```
  {"jsonrpc":"2.0","id":N,"result":{"connections":12}}
  {"jsonrpc":"2.0","id":N,"result":{"connections":13}}
  ```

  hope cancels the request (closes the body / cancels the context) the moment the
  UI disconnects. Stop emitting when that happens — do not leak a goroutine.

### Action results (passing state back)

An action's result is a contract, so the plugin — not hope — decides what the user
sees and whether the view reloads. All fields optional:

```json
{ "ok": false, "message": "can't delete: 3 children" }   // error toast, no refetch
{ "message": "Deleted user 42" }                          // success toast + refetch
{ "refetch": false }                                      // success, view unchanged (no reload)
{ "level": "info", "message": "queued" }                  // neutral toast
```

- `ok: false` (or `level: "error"`) → hope shows an error and does **not** refetch or
  close the row modal — the mutation was refused, nothing changed.
- otherwise → success toast (`message`, or a default), and hope refetches the owning
  view unless `refetch` is `false`.
- a thrown JSON-RPC error is always an error toast.

So a delete returns `{ "ok": true, "message": "Deleted 42" }` and the row vanishes
on refetch; a rejected delete returns `{ "ok": false, "message": "..." }` and the
row stays with the reason shown. **Persist the change in your own store** before
returning ok — hope refetches the same view method, so a plugin that regenerates
data each call will show no change (see kitchen-sink's in-memory state).

### Errors

Standard JSON-RPC 2.0 error object:

```json
{"jsonrpc":"2.0","id":N,"error":{"code":-32601,"message":"method not found"}}
```

| code    | meaning              |
|---------|----------------------|
| -32700  | parse error          |
| -32600  | invalid request      |
| -32601  | method not found     |
| -32602  | invalid params       |
| -32603  | internal error       |
| -32001  | unauthorized         |

## Protocol version

hope announces the protocol version it speaks on every call via the
`X-Hope-Protocol-Version` header, and reads yours from `hope.schema`'s
`protocolVersion`. A skew is not fatal: hope skips surfaces, node kinds, and view
kinds it doesn't implement, and reports a compat verdict (`ok` / `plugin_newer` /
`plugin_older`) on the manifest. Build to the version you target; degrade, don't
break.

## Limits hope enforces

hope is the control plane and isolates itself from a slow or hostile plugin: a
per-call timeout, a response body cap (4 MiB), bounded concurrent calls and streams
per plugin, a call-rate limit, and stream frame size/rate caps. These are
**hope-owned** — a plugin cannot raise its own ceiling — but the operator tunes the
envelope in `[plugins.limits]` (`max_concurrent_calls`, `max_concurrent_streams`,
`call_rate_per_sec`, `call_burst`, `max_frame_bytes`, `max_frames_per_sec`); unset
fields use built-in defaults. Design handlers to return promptly and bound their
own output. Over-cap unary calls are rejected; over-cap stream frames are dropped.

## Trust, change detection, and audit

On enable, hope fingerprints the plugin: the image digest (a cheap fleet-wide
stale check) **and** a hash of `hope.schema` captured at approval. An image swap
flags the plugin changed; a runtime schema change (new capabilities the operator
never approved) is caught on inspect and auto-disables the plugin, requiring
re-approval. A swapped or mutated container cannot silently inject new actions into
the control plane.

Every **action** hope proxies (not reads) is recorded in an audit log —
who/plugin/host/method/danger/ok/duration — so there is a trail of everything a
plugin was asked to do through the control plane.

## Minimal plugin (Go SDK)

```go
package main

import (
	"context"
	"log"

	"github.com/toyz/hope/plugin"
)

func main() {
	p := plugin.New("badge-directory", "1.0.0").
		Description("Live Badge Directory counters").
		Icon("database")

	p.View("counts", "Counters", plugin.KV, func(ctx context.Context) (any, error) {
		return map[string]any{"users": 1_402_301, "badges": 88_123}, nil
	})

	p.Stream("live", "Live", plugin.Counter, func(ctx context.Context, emit plugin.EmitFunc) error {
		// emit(...) until ctx is done
		<-ctx.Done()
		return nil
	})

	log.Fatal(p.ListenAndServe(":8080")) // JSON-RPC 2.0 at /__hope
}
```

An interactive table with a row-detail modal and a per-row delete action:

```go
p.TableView("rows", "Rows",
    func(ctx context.Context) (any, error) {
        return map[string]any{"columns": []string{"id", "name"}, "rows": rows}, nil
    },
    plugin.PageSize(50),
    plugin.RowDetail("inspect"), // clicking a row calls inspect(row) -> modal
    plugin.RowActions(plugin.RowAction{Method: "del", Label: "Delete", Danger: true}),
)
p.QueryView("sql", "Query", "sql", "select * from {table}", runSQL) // prepopulated editor
```

Add the labels, deploy it in your stack, enable it in hope. Reference plugins live
in [`examples/plugins/`](../examples/plugins): `hello-world` (every view kind, a
starter you can copy), `kitchen-sink` (exercises the whole protocol — interactive
tables, row actions, dynamic pages, every stream/setting kind), and `hope-postgres`
(a real PGAdmin-class panel).
