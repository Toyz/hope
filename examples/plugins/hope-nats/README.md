# hope-nats

A first-party [hope](https://github.com/toyz/hope) plugin: a **NATS** control panel. Point it
at a NATS server and it renders inside hope — server + JetStream stat tiles, a stream browser
you drill into (config, state, consumers), KV bucket + key browsing, a live subject monitor, a
publish action, and stream maintenance (purge/delete).

The plugin holds the connection (your secret, in your container); hope only speaks the plugin
protocol, proxies + audits calls, and never touches NATS directly.

## Run

```sh
docker run \
  -e NATS_URL=nats://user:pass@host:4222 \
  -e HOPE_PLUGIN_TOKEN=secret \
  -l hope.plugin=true -l hope.plugin.port=8080 \
  ghcr.io/toyz/hope-nats:latest
```

Or install it from hope's plugin marketplace (it's a built-in catalog entry) — hope deploys the
container into a stack, wires the network, and injects the token for you.

## Config

| Env / Setting   | What                                                                 |
| --------------- | ------------------------------------------------------------------- |
| `NATS_URL`      | `nats://` DSN reachable from the plugin's networks (**required**).  |
| `watch_subject` | Subject the Activity tab subscribes to (default `>` = everything).  |
| `page_size`     | Rows per page in the KV key browser (default `100`).                |

JetStream must be enabled on the server for the Streams and KV views; without it those tabs
show an "unavailable" state and the rest of the panel still works.

## Surfaces

- **Container panel** on any `nats*` image (the docked inspector).
- **Standalone page** (`NATS` in the rail) with a header **Publish** action.
- **Dashboard + stack widgets** (the overview stat tiles).
- **Stream detail page** (config/state + consumers, with purge/delete) and a **KV bucket page**
  (its keys). Clicking a stream row opens a quick-peek **flyout**.
