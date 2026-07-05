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

A `query` view receives the user's text in the request params as
`{ "input": "<text>" }`.

**Stream kinds** (`streams[].kind`): `counter` (numbers ticking), `log`
(append-only lines), `series` (time series -> sparkline).

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

| surface     | mount point                              | v1     |
|-------------|------------------------------------------|--------|
| `container` | a tab/panel in the container inspector   | yes    |
| `page`      | a full custom nav page                   | later  |
| `rail`      | a rail/nav entry + actions               | later  |
| `dashboard` | a fleet/host dashboard widget            | later  |
| `stack`     | a stack-view widget                      | later  |
| `command`   | a command-palette entry                  | later  |

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

## Limits hope enforces

hope is the control plane and isolates itself from a slow or hostile plugin:
a per-call timeout, a response body cap (4 MiB), bounded concurrent calls and
streams per plugin, and stream frame size/rate caps. Design handlers to return
promptly and to bound their own output.

## Trust and change detection

On enable, hope fingerprints the plugin (a hash of `hope.schema` + the image
digest). If either changes later — an image swap, a schema change — hope
auto-disables the plugin and requires re-approval. A swapped container cannot
silently inject new actions into the control plane.

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

Add the labels, deploy it in your stack, enable it in hope. Reference plugins live
in [`examples/plugins/`](../examples/plugins): `hello-world` (every view kind, a
starter you can copy) and `hope-postgres` (a real PGAdmin-class panel).
