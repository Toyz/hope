# hope-postgres

A **pgAdmin-class Postgres panel for [hope](../../..), in under 1,000 lines of Go** —
and most of those lines are SQL. Point it at a database and you get a browsable,
queryable, operable Postgres UI *inside hope*, with zero HTML/JS/CSS in the plugin.

The trick isn't the plugin — it's the SDK. hope plugins are **server-driven UI**: the
plugin only *declares* views (a table, a stat band, a chart, a tree, a paginated data
grid) and returns rows from SQL. hope renders the whole thing — pagination, sorting,
search, drill-down, charts, live streams, modals — from those descriptors. So the
interesting code here is the Postgres queries; the UI is free.

## What you get

- **Overview** — big-number stat tiles: database size, table count, live/total
  connections, and cache-hit ratio (tone-flagged when it's low).
- **Databases** — a card gallery of every database on the cluster, biggest first.
- **Tables** — every user table with a relative-size bar and a scan-health badge;
  click one to **drill into it**.
- **Table detail** — tabs for **Data** (a server-side paginated / sortable / searchable
  grid — nothing ships the whole table), **Columns** (types, nullability, PK badges),
  **Indexes**, **Stats** (bloat, scan mix, last vacuum/analyze), and reconstructed
  **DDL**. Click a row for the full record.
- **Query** — a SQL editor with a results grid, and an **Explain** pane (plain
  `EXPLAIN`, never runs your statement).
- **Activity** — a live session monitor you can **Cancel query** or **Terminate
  backend** from (`pg_cancel_backend` / `pg_terminate_backend`).
- **Schema** — a schema → table → column tree, plus a **live schema tree in the rail**
  (schema → table pages, rebuilt from the database on every layout fetch).
- **Maintenance** — `ANALYZE` and `VACUUM (ANALYZE)` as toolbar buttons.
- **Charts + a live "active connections" counter stream.**

It surfaces itself five ways (the SDK's whole contribution model, in one plugin):
a **container panel** on any `postgres*` / `pgvector*` / `timescale*` container, a
standalone **rail page** (also a ⌘K command-palette entry), a **dashboard widget**, a
**stack widget** on its own stack, and hidden **detail pages** for table + record.

## How it works

The plugin holds the database credentials (**your** secret, in **your** container).
hope never touches the database directly — it only speaks the plugin protocol, proxies
each call over the internal bridge network, and audits mutations. Credentials never
reach the browser.

## Run it

Build from the **repo root** (the Dockerfile pulls in both this module and the in-repo
SDK it `replace`s):

```sh
docker build -f examples/plugins/hope-postgres/Dockerfile -t hope-postgres .
```

Run it pointed at a database — the `hope.plugin.*` labels (baked into the image) make it
discoverable, and `HOPE_PLUGIN_TOKEN` is the shared secret you'll enter when enabling it
in hope:

```sh
docker run -e DATABASE_URL=postgres://user:pass@db:5432/app \
  -e HOPE_PLUGIN_TOKEN=secret \
  hope-postgres
```

Then enable it in hope's plugins UI and enter the token. It'll attach to any Postgres
container and add its **Postgres** page to the rail.

## Configure

One operator-managed setting, editable in the plugin inspector:

- **`page_size`** — rows per page in the table data browser (default `100`).

## Build without Docker (local dev)

```sh
cd examples/plugins/hope-postgres
DATABASE_URL=postgres://... HOPE_PLUGIN_TOKEN=secret go run .
# listens on :8080 (override with HOPE_PLUGIN_ADDR)
```

---

Requires the hope plugin SDK **v0.0.3+**. See [`plugin/`](../../../plugin) for the SDK
and [`examples/plugins/kitchen-sink`](../kitchen-sink) for a tour of every view kind,
surface, and layout primitive.
