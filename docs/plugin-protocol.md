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

### How hope reaches your plugin

hope and the plugin container both join a dedicated bridge network, **`ink-plugins`**
(created on demand per daemon), and hope dials the plugin by a stable DNS alias on it.
So in the common case — hope and the plugin on the **same daemon** (co-located, or an
**agent** on the plugin's host) — you publish **nothing**; just the labels. hope joins
the network on enable and disconnects the plugin on disable.

The one case that still needs a published port: hope pointed at a **remote `tcp://`
daemon** it is *not* itself running on (e.g. a dev hope on your laptop driving a remote
docker). hope isn't a container on that daemon, so it can't join the network — it
reaches the plugin at the **daemon host's published port** instead. Bind it wildcard
(`- "18080:8080"`), not to a fixed host IP: a fixed IP hairpins and stalls a
co-located hope. With a wildcard bind, a co-located hope uses the `ink-plugins` alias
(and ignores the port) while a remote-tcp hope uses the published port — both work
from one compose.

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
| `cards` | `{ "items": [ { "title", "subtitle?", "icon?", "tone?", "to?", "fields?": [{label, value}] } ] }` | responsive card grid (a gallery) |
| `stat`  | `{ "stats": [ { "label", "value", "unit?", "sub?", "tone?", "icon?" } ] }` | big-number stat blocks (counters) |
| `text`  | `{ "text": "…" }` (or a raw string)                | monospace scrollable block (logs, config, output) |
| `component` | a `Comp` primitive tree (the escape hatch — see below) | a custom widget composed from safe primitives |

A `query` view receives the user's text in the request params as
`{ "input": "<text>" }`.

**Component views (the escape hatch)** — when the built-in kinds don't cover a
widget you want, a `component` view returns a **tree of safe primitives** hope
composes, instead of a fixed shape. Plugins never ship markup/JS (hope renders data,
never plugin HTML), so this is a typed primitive tree, not raw rendering. A node is
`{ "kind": ..., ... }`:

| primitive   | fields                        | renders as                                  |
|-------------|-------------------------------|---------------------------------------------|
| `box`/`stack` | `children`, `gap?`, `tone?` | a vertical container (a tile/card body)     |
| `row`/`grid`  | `children`, `gap?`          | a horizontal / responsive-grid container    |
| `heading`   | `text`, `level?` (1..4), `tone?` | a heading                                |
| `text`      | `text`, `tone?`               | a line of text                              |
| `keyval`    | `label`, `value` (scalar or rich cell) | a label/value line                 |
| `icon`      | `icon`                        | one icon (built-in name or an `icons` key)  |
| `sparkline` | `values` (numbers)            | a tiny inline line chart                    |
| `cell`      | `cell` (any rich cell)        | a Badge/Link/Number/… inline                |
| `divider` / `spacer` | (`size?` px, spacer) | a rule / vertical gap                    |

A container child's `size` is its weight (flex in a `row`, column span in a `grid`).
Unknown primitives are skipped, never fatal. The same tree can also ride **inline in
a layout** as a `component` node (below), which costs no per-view round-trip. SDK:
`plugin.ComponentView(...)` returning `plugin.Box/Stack/CRow/CGrid/Heading/CText/
KeyVal/CIcon/Sparkline/CCell/Divider/Spacer(...)`.

**Interactive tables** — `table` and `query` view descriptors may declare
interactivity; the columns are always dynamic (hope renders exactly the
`columns`/`rows` you return, pgAdmin-style):

| field         | effect                                                                       |
|---------------|------------------------------------------------------------------------------|
| `default`     | (query) initial editor text; `{param}` placeholders are filled from the page param, e.g. `"select * from {table}"` |
| `page_size`   | rows hope shows per page (plugin-level — you know your data). 0 => hope default |
| `row_method`  | a method hope calls with `{row: {column: value}}` when a row is clicked; the returned kv/table shows in a modal. `row_detail_button: true` triggers it from a per-row button instead of a whole-row click (use when rows are inline-editable) |
| `row_actions` | per-row action buttons: `[{ "method", "label", "icon?", "danger?", "fields?" }]`. Clicking calls `method` with `{row: {...}}` (plus any collected `fields`); `danger` confirms first, then hope refetches the table |
| `edit_method` | inline cell edit: editing a cell calls `method` with `{row, column, value}`. `edit_columns` (optional) limits which columns are editable. hope refetches on success |
| `server`      | server-driven table: hope does NOT ship every row. It sends the query state and expects one page + a total back (see below). For tables too large to send whole |
| `refresh`     | (any view) add a manual refresh button to the view header that re-fetches on click |
| `refresh_interval` | (any view) auto-refetch every N seconds — a live-ish view without a stream |
| `static`      | (any view) data is fixed for the life of the surface: hope fetches it once and reuses the cached result on tab re-entry / re-navigation instead of re-calling the plugin (fewer round-trips, less rate-limit pressure). A manual `refresh` still forces a re-fetch. SDK: `plugin.Static()` |
| `empty`       | (any view) an author "no data" state shown when the view resolves empty, instead of the generic text: `{ "icon?", "title?", "text?", "comp?" }` (`comp` = a custom Component tree). SDK: `plugin.EmptyView("No slow queries 🎉", plugin.EmptyIcon("check"))` |
| `facets`      | (server tables) dropdown filters: `[{ "key", "label", "options": [{label, value}] }]`. Selections arrive in the query as `_q.filters[key]`; apply them in your store |
| `default_sort`| (server tables) `{ "column", "dir": "asc"\|"desc" }` — the sort hope applies on FIRST load, before the user clicks a header (e.g. newest-first). It arrives in `_q.sort` and the column shows the arrow. SDK: `plugin.DefaultSort(col, dir)` |

**Server-driven tables** (`server: true`) — the keystone for large data. hope sends
the query state on each call and expects one page plus a total:

```json
// params hope sends (merged with the page param):
{ "_q": { "page": 2, "page_size": 100, "sort": { "column": "score", "dir": -1 }, "filter": "gold" } }

// your result:
{ "columns": ["id","name","score"], "rows": [ ... ], "total": 148213 }
```

Do the paging/sort/filter in your store (SQL `LIMIT/OFFSET/ORDER BY/WHERE`, a NATS
KV scan, etc.) and return only that page; `total` drives the pager. hope's filter
box becomes a server search (debounced), column headers sort server-side, and the
pager walks pages — none of it ships the whole table. Read the query in Go with
`plugin.ReadTableQuery(ctx)`; declare it with the `plugin.ServerSide()` table option.

Every one of these is a call into a method *you* implement — hope proxies, you
decide. Read the clicked row in your handler as `params.row`.

**Header actions** — a `page`/`container`/`dashboard` contribution may set
`actions: ["method", ...]` (names of registered actions), rendered as a toolbar in
the surface header (for pages, hope's page header) — page-level actions distinct
from leaf actions inside the layout. hope collects fields, confirms danger, audits.

**Rich cells** — a `table`/`cards` value, a `kv` value, or a stat/card **field**
value may be a typed cell object instead of a plain scalar, so dense data reads
well. `{ "type": ..., "value": ..., ... }`:

| type       | extra fields            | renders as                                   |
|------------|-------------------------|----------------------------------------------|
| `badge`    | `tone` (ok/warn/bad/info) | a colored pill                             |
| `link`     | `to` (plugin-relative) or `href` (external) | a link (in-app nav / new tab)  |
| `time`     | —                       | a unix timestamp as relative time + absolute on hover |
| `number`   | `unit?`                 | thousands-formatted, right-aligned            |
| `progress` | —                       | a 0..1 bar                                    |
| `code`     | —                       | inline monospace                              |
| `image`    | `alt`, `w?`/`h?`, `fit?`, `fb?`, `lb?` | an image (see below)            |

Filtering/sorting/editing operate on the cell's `value`. Unknown types fall back to
text; a plain scalar is unchanged. A `kv` view whose values are all plain scalars
renders as hope's compact key/value list; if any value is a typed cell, hope renders
the rows itself so images/badges/links work in a KV too. SDK constructors:
`plugin.Badge/Link/Time/Number/Progress/Code/DetailLink/Image`.

**Images** — `Image(src, alt, opts...)`. The browser loads `src` directly (hope
proxies RPC, not image bytes), so `src` MUST be an absolute `http(s)` URL reachable
from the browser — e.g. a public on-demand webp/avif proxy. A non-`http(s)` src
renders as `alt`. Options set the render box and behavior:

| opt                    | cell field | effect                                             |
|------------------------|------------|----------------------------------------------------|
| `ImgW(px)` / `ImgH(px)`| `w`/`h`    | fix one dimension; the other is auto (keeps aspect)|
| `ImgBox(w, h)`         | `w`+`h`    | fixed box, image centered + contained              |
| `ImgFit("cover")`      | `fit`      | fill the box, cropping overflow (default `contain`)|
| `ImgFallback(url)`     | `fb`       | shown if `src` fails; if it too fails, renders blank|
| `ImgLightbox()`        | `lb`       | click opens an in-app full-screen viewer (Esc/backdrop/X to close) instead of a new tab |

With no opts an image is a small inline thumbnail. A **card** may also set `image`
(an absolute `http(s)` URL) for a hero image at the top of the card.

**Master-detail** — click a row → a full detail page. A `link`/`DetailLink` cell
navigates PLUGIN-RELATIVE (`to` is a page id/path; hope prefixes `/plugin/<key>/…`,
so a plugin never needs to know its own hope key). Declare the target with a
`DetailPage(id, title, paramKey, node)` — a hidden page (not in the rail) addressed
by a stable `id`; hope passes the URL arg as `param[paramKey]` (e.g. `.../user/42`
→ `{id: "42"}`). Give any `Page` a stable `id` with `PageID` so links/breadcrumbs
can target it (rail links use the id too, so navigation marks the entry active).

**Breadcrumbs** — a page contribution may set `breadcrumbs: [{label, to?}]` (with
`{param}` templating filled from the page param). hope feeds them into its own
topbar trail: `fleet / plugins / <plugin> / <your crumbs>`. Plugin-relative `to`s
resolve like link cells; the last crumb is the current page.

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

**Initialization (`hope.init`)** — the reserved lifecycle handshake. Once a plugin is
reachable (at enable/install, and again after a restart), hope calls `hope.init` with
the operator's settings plus hope's own protocol/capabilities — so a plugin can set
itself up *with* its config instead of booting on defaults and waiting for a later
`hope.settings` push:

```json
{"jsonrpc":"2.0","id":N,"method":"hope.init","params":{
  "settings":{"page_size":"250"},
  "protocolVersion":1,
  "capabilities":{"view_kinds":["kv","table","component"],"features":["static","empty"]}}}
```

hope applies the settings (so `SettingValue` works immediately) and the plugin may run
setup logic via the SDK's `p.OnInit(func(ctx, plugin.InitContext) error)` hook. It's
optional and additive: a plugin that doesn't implement `hope.init` returns
method-not-found and hope falls back to the `hope.settings` push — so older plugins keep
working. `hope.settings` remains the path for live setting changes after init.

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

**Surfaces** (hope renders the ones marked below and silently ignores any it
doesn't know, so a newer plugin degrades gracefully on older hope):

| surface     | mount point                              | rendered |
|-------------|------------------------------------------|----------|
| `container` | a tab/panel in the container inspector   | yes      |
| `page`      | a full custom nav page (incl. dynamic nested pages via `pages[]`) | yes |
| `command`   | plugin pages + actions in the command palette | yes |
| `rail`      | a rail/nav entry (plugin pages nest under their container) | yes |
| `dashboard` | a fleet/host dashboard widget            | yes      |
| `stack`     | a stack-view widget (matched to the stack's containers) | yes |

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

- `section` — titled group (`title`, `children`); `collapsible: true` (+ optional
  `collapsed: true`) makes it fold on a title click
- `tabs` — tabbed children (each child's `title` is its tab label)
- `row` / `grid` — arrangement (`children`). A child's `size` sets its width share:
  in a `row` it's the flex weight (e.g. `Weight(1)` beside `Weight(2)` → 1/3 vs 2/3);
  in a `grid` it's a column span. Default (0) = equal share. SDK: `node.Weight(n)`.
- `leaf` — a single `view`/`action`/`stream` referenced by `ref` (its method name).
  `Filled()` makes a leaf grow to fill remaining height (e.g. a table)
- `component` — an inline `Comp` primitive tree (`comp`; see *Component views* above)
  rendered straight from the layout, with **no** per-view round-trip — ideal for a
  small static dashboard/stack tile. SDK: `plugin.Component(plugin.Box(...))`

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

## The reverse channel (events, publish, storage, actions)

Everything above is hope calling your plugin. The **reverse channel** is your plugin
calling *back* into hope — to react to fleet events, publish its own events/alerts,
persist config, and (as an operator) mutate its own stack. It is **least-privilege and
opt-in**: your plugin gets nothing on this direction unless it (a) *declares* the scope
it wants and (b) the operator *consents* when enabling it.

### Permissions & consent

Declare a scope with `RequirePermission` (or let a helper auto-declare it). It appears
in `hope.schema` under `permissions: [{scope, reason}]`; when the operator enables the
plugin, hope shows a consent prompt for each requested scope. The operator can revoke a
grant anytime from the plugin inspector. Your per-plugin token proves *identity*; the
granted scopes are what hope *authorizes* — a plugin can never widen its own access.

| scope              | lets the plugin…                                             |
|--------------------|-------------------------------------------------------------|
| `events:subscribe` | receive fleet events via `OnEvent` (auto-declared by it)    |
| `events:publish`   | publish events/alerts onto hope's bus                       |
| `storage`          | read/write durable per-install key/value config             |
| `spec:label`       | add a label to a service in its OWN stack (persists)        |

A plugin may also ask for a scope at runtime with `RequestPermission(scope, reason)` —
hope raises the same consent prompt; nothing is granted without the operator's click.

### How the plugin reaches hope

No configuration. hope reaches your plugin by its **container id** over the shared
`ink-plugins` network; the reverse works the same way — hope derives its own callback
URL from its container id + listen port (`http://<hope-container-id>:<port>`) and hands
it to each plugin in `hope.init` along with the plugin's key. Docker's embedded DNS
resolves it on `ink-plugins`, symmetric with how hope dials you.

This means the reverse channel is for **co-located plugins** (same host as hope, on
`ink-plugins`) — the common case. A remote plugin reached over the agent tunnel can't
resolve hope's container from another daemon, so its reverse calls no-op with
`ErrNoReverseChannel` (as does any plugin when hope isn't containerized). Design your
plugin to degrade gracefully: the SDK returns that error and the plugin keeps running.

### Subscribe — react to fleet events

```go
p.OnEvent(func(ctx context.Context, e plugin.Event) error {
    // e.Kind: stack.deployed | container.state | image.update | agent.online | ...
    return nil
})
```

hope delivers each relevant event as a unary `hope.event` call to plugins holding
`events:subscribe`, host-scoped and best-effort. Handlers should return quickly and be
idempotent (an action you take may produce an event delivered back to you).

### Publish — emit events & alerts

```go
p.Alert(ctx, "warn", "Low cache hit ratio", "91% (floor 95%)", "pg-cache-hit")
p.ResolveAlert(ctx, "Low cache hit ratio", "pg-cache-hit") // clears it on recovery
p.Publish(ctx, plugin.Event{Kind: "myevent", Data: raw})    // arbitrary event
```

hope **stamps the attribution itself** — `Source = plugin.<identity>` and the kind is
namespaced `plugin.<identity>.<name>` — so a plugin can never spoof another's events or
a core hope kind. Alerts surface as toasts + the alert-inbox bell; `dedupeKey` groups
repeats and lets `ResolveAlert` clear them. Requires `events:publish`.

### Storage — durable per-install config

```go
p.Storage().Set(ctx, "rules", myRules) // opaque JSON hope persists, namespaced to you
var rules []Rule
ok, _ := p.Storage().Get(ctx, "rules", &rules)
p.Storage().Delete(ctx, "rules")
keys, _ := p.Storage().List(ctx, "")
```

hope persists bytes it never interprets, keyed to your stable install identity (two
installs of the same image are isolated; a `Forget` wipes it). It's for small config a
stateless plugin has nowhere else to keep — e.g. the alert rules an operator defined.
Requires `storage`.

### Operate — mutate your own stack

```go
p.Hope().AddServiceLabel(ctx, "web", "prometheus.io/scrape", "true")
```

The operator/reconciler pattern: watch events with `OnEvent`, then act. hope mutates the
service's **stored spec** and re-applies, so the change persists across redeploys (a
live-container relabel would evaporate on the next recreate). Scoped to the plugin's own
stack only, audited, and gated on `spec:label`.

### End-to-end example

`examples/plugins/hope-postgres` is the reference: the operator adds alert rules from the
UI (metric + comparator + threshold), the rules persist in `p.Storage`, and a background
loop evaluates them and `p.Alert`s on breach. `examples/plugins/kitchen-sink` exercises
every reverse verb as a smoke test.

## Protocol version

hope announces the protocol version it speaks on every call via the
`X-Hope-Protocol-Version` header, and reads yours from `hope.schema`'s
`protocolVersion`. A skew is not fatal: hope skips surfaces, node kinds, and view
kinds it doesn't implement, and reports a compat verdict (`ok` / `plugin_newer` /
`plugin_older`) on the manifest. Build to the version you target; degrade, don't
break.

### Capability negotiation

The protocol version is coarse. Alongside it, hope announces exactly **which view
kinds and features this build can render** via two headers on every call:

- `X-Hope-View-Kinds` — e.g. `kv,table,query,tree,chart,cards,stat,text,search,component`
- `X-Hope-Features` — e.g. `static,empty`

So a plugin built against a newer SDK can adapt instead of emitting something an older
hope can't draw. In the Go SDK, read it with `plugin.Caps(ctx)`:

```go
func widget(ctx context.Context) (any, error) {
    if plugin.Caps(ctx).Supports("component") {
        return plugin.Box(plugin.Heading("Fleet", 3), /* … */), nil // rich
    }
    return plugin.KVData{"nodes": 3}, nil                            // baseline fallback
}
```

An older hope that predates negotiation sends no capability headers, so `Supports`
returns false — always keep a baseline for anything you guard.

### Stability policy

- **Additive by default.** New view kinds, node kinds, surfaces, and struct fields are
  added as optional (`omitempty`) fields — a minor SDK bump (`v0.x`). Existing plugins
  keep working unchanged; an older hope skips what it doesn't know.
- **`protocolVersion` bumps only on a breaking change** to an existing shape — none has
  happened yet, and additive growth never forces one.
- **Unknown is skipped, never fatal**, in both directions (see above). This is the
  contract that lets hope and plugins version independently.
- Prefer `Caps` over `protocolVersion` checks for feature gating: it degrades per
  feature, not per whole version.

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
