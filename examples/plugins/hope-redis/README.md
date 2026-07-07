# hope-redis

A **Redis / Valkey control panel for [hope](../../..)**, in under 1,000 lines of Go.
Point it at a server and you get a browsable, queryable, operable Redis UI *inside
hope* — with zero HTML/JS/CSS in the plugin. Valkey and KeyDB are Redis-wire
compatible, so the same [go-redis](https://github.com/redis/go-redis) client drives
all three.

Like its Postgres sibling, the plugin only *declares* views and returns data; hope's
server-driven-UI SDK renders the pagination, sorting, drill-down, trees, streams, and
modals. The interesting code is the Redis calls; the UI is free.

## What you get

- **Overview** — stat tiles from `INFO`: version/role, memory (+peak), total keys,
  connected clients, ops/sec, and a tone-flagged **hit ratio**.
- **Keyspace** — a **rich tree**: `SCAN`ned keys grouped by `:` prefix, each leaf with
  a **type icon**, a **TTL dot**, and a link into its detail page (uses `SCAN`, never
  `KEYS`, so it won't stall a big instance; capped by the `scan_limit` setting).
- **Key detail** — **Value** shaped by type (string / hash / list / set / zset), and
  **Info** (type, TTL, encoding, size, length).
- **Console** — a command editor (`redis-cli`-style): run any command, see the reply.
- **Databases** — per-DB key counts.
- **Slowlog** — the slowest recent commands (with server-side durations).
- **Clients** — connected clients, with a per-row **Kill** action (`CLIENT KILL`).
- **Maintenance** — `FLUSHDB` / `FLUSHALL` as confirmed danger buttons.
- A live **ops/sec** counter stream.

It surfaces five ways: a **container panel** on any `redis*`/`valkey*`/`keydb*`
container, a standalone **rail page** (also a ⌘K entry), a **dashboard widget**, a
**stack widget**, and hidden **detail pages** for keys.

## How it works

The plugin holds the connection (**your** secret, in **your** container). hope never
talks to Redis directly — it speaks the plugin protocol, proxies each call over the
internal bridge network, and audits mutations. Credentials never reach the browser.

## Run it

Build from the **repo root** (the Dockerfile pulls in this module and the in-repo SDK
it `replace`s):

```sh
docker build -f examples/plugins/hope-redis/Dockerfile -t hope-redis .
```

Run it pointed at a server — the `hope.plugin.*` labels make it discoverable, and
`HOPE_PLUGIN_TOKEN` is the shared secret you enter when enabling it in hope:

```sh
docker run -e REDIS_URL=redis://:pass@host:6379/0 \
  -e HOPE_PLUGIN_TOKEN=secret \
  hope-redis
```

`REDIS_URL` accepts the standard `redis://` / `rediss://` DSN (host, port, password,
db index). Then enable it in hope and enter the token.

## Configure

- **`scan_limit`** — how many keys the keyspace tree loads (default `500`).

## Build without Docker (local dev)

```sh
cd examples/plugins/hope-redis
REDIS_URL=redis://... HOPE_PLUGIN_TOKEN=secret go run .
# listens on :8080 (override with HOPE_PLUGIN_ADDR)
```

---

Requires the hope plugin SDK **v0.0.5+**. See [`plugin/`](../../../plugin) for the SDK,
[`hope-postgres`](../hope-postgres) for the Postgres analog, and
[`kitchen-sink`](../kitchen-sink) for a tour of every view kind and surface.
