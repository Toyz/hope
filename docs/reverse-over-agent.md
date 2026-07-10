# Reverse channel over the agent tunnel

## Problem

The plugin reverse channel (`Publish` / `Alert` / `Storage` / `Hope().Action`)
works only for plugins **co-located with hope**. hope hands every plugin a single
callback URL — `http://<hope-container-id>:<port>` (`hopeCallbackURL`,
serve.go:87, "reachable by a co-located plugin") — via `hope.init`
(install.go:501). A plugin on an **agent host** is on a different machine's docker
network; hope's container-id doesn't resolve there, so its reverse calls silently
fail. Agent-hosted plugins are dial-only (hope reaches them; they can't call back).

The forward path is fine: the dialer reaches agent-hosted plugins through the
agent's host client / `DialContainer` over the existing yamux tunnel. Only the
reverse path is missing.

## Design: relay the reverse channel through the existing agent tunnel

The yamux session is symmetric. Today hope (yamux **client**) opens `DOCKER`/`DIAL`
streams and the agent (yamux **server**) accepts them. For the reverse path the
**agent opens** a `REVERSE` stream and **hope accepts** it. Each side only accepts
the other's opens, so the two directions coexist with no collision. hope currently
never calls `sess.Accept()`, so adding a hope-side accept loop is purely additive.

Uniform addressing rule: **a plugin's callback URL is the container-id of whichever
hope-or-agent process is co-located on the plugin's host.** hope's id for
co-located plugins; the agent's id for agent-hosted plugins (the agent relays).

### Reachability — agent joins `ink-plugins`

Just as hope attaches *itself* to a plugin's network to dial it (dialer.go:118),
the **agent** must be reachable by plugins on its host. Plugins share the single
`ink-plugins` network. So hope, via the agent's docker client, connects the agent's
own container to `ink-plugins` (when that network exists on the agent host). Then
`<agent-container-id>` resolves for every plugin on that host. One attach per host,
idempotent, done lazily when the network first appears.

### Transport — no sov internals

hope's hub does **not** re-implement gateway dispatch. On accepting a `REVERSE`
stream it:
1. `http.ReadRequest` the plugin's request off the stream.
2. **Path-guard**: reject anything whose path isn't `/rpc/_plugin*` (403) — the
   relay may only reach the plugin ingress, never operator RPCs.
3. Dial hope's own gateway over loopback (`127.0.0.1:<server-port>`), `req.Write`
   the request, copy the response back onto the stream.

This reuses hope's real `/rpc/_plugin_*` handlers unchanged — token verify
(`DeriveToken`, constant-time) and server-forced `Source`/`Kind` attribution are
identical to a co-located POST. The relay is pure transport; the plugin's token is
still the only thing that authorizes, and the agent (already root-equivalent via
docker proxy) gains nothing it didn't have.

### Capability negotiation (back-compat)

New handshake cap token `reverse` (next to `capStreamTypes`, agent.go:35). The
agent advertises it in the trailing handshake fields; the hub echoes it in the `OK`
reply only if it too supports it. The reverse path activates **only when both
agree** — an old agent + new hope, or new agent + old hope, behave exactly as
today. Zero impact on current deployments until both are updated.

## Implementation stages

### 1. Protocol + hub (hope side) — compiles + unit-testable
- `internal/agent/agent.go`: `const capReverse = "reverse"`.
- `internal/agent/hub.go`:
  - Parse `reverse` from the agent's handshake caps (same loop as `capStreamTypes`,
    ~:256); echo it in the reply when hope supports it (~:262).
  - `Hub.reverseTarget string` + `SetReverseTarget(addr)` — hope's loopback gateway
    addr (`127.0.0.1` + port of `cfg.Server.Addr`).
  - When `reverse` negotiated, after `reg.add` (~:303) spawn
    `go h.acceptReverse(sessCtx, sess)`: `for { s,err := sess.Accept(); if err {return}; go h.handleReverse(s) }`.
  - `handleReverse(s net.Conn)`: `http.ReadRequest`; if
    `!strings.HasPrefix(req.URL.Path, "/rpc/_plugin")` → write 403 + close; else
    `net.Dial("tcp", h.reverseTarget)`, `req.Write(lc)`, `io.Copy(s, lc)` (+ close).
- `cmd/hope/serve.go`: `hub.SetReverseTarget(loopback(cfg.Server.Addr))` near the
  other hub wiring (~:197/341).

### 2. Addressing (pluginhost)
- `SetCallbackURL` already stores hope's own URL. Add per-host resolution in
  `initPlugin` (install.go ~:501): if the plugin's host is an agent (not local),
  set `hopeBaseURL = http://<agentContainerID>:<reversePort>` instead. hope has the
  agent's container-id from the handshake (`Host.Info.ContainerID`, hub.go:248/299)
  via the registry. Add `reversePort` constant (e.g. `8790`), shared by agent
  listener + this URL.
- Local plugins keep hope's container-id URL (unchanged).

### 3. Agent listener + relay (agent side)
- `internal/agent/agent.go`, when `reverse` negotiated in `serveOnce`:
  - Start a local listener on `:<reversePort>` (all interfaces → reachable on
    `ink-plugins` once hope attaches the agent).
  - Per accepted conn: `s, _ := sess.Open()`; `s.Write("REVERSE\n")`; pipe
    conn↔s (bidirectional `io.Copy`). This carries the plugin's raw HTTP to hope.
  - Tear down the listener on ctx cancel / session close.

### 4. Networking (pluginhost)
- When installing/initializing an agent-hosted plugin, connect the agent's
  container to `ink-plugins` via the agent's docker client
  (`NetworkConnect(agentContainerID, "ink-plugins")`), idempotent (ignore
  "already exists"). Skip for local (hope's own attach path already exists).

## Security review points
- Path-guard on the relay is the whole boundary against operator-route abuse —
  verify it rejects `/rpc/...` non-plugin paths and non-POST.
- Plugin token verification is unchanged (loopback hits the real ingress).
- The agent is already trusted (docker proxy = root); the relay grants no new
  authority. A hostile *plugin* still needs a valid `DeriveToken`, which is
  `HMAC(hope-secret, identity)` and never leaves hope.

## Fleet test plan (can't be exercised without a live agent)
1. Old agent + new hope: everything behaves as today (reverse inactive).
2. New both, co-located plugin: reverse still works (unchanged path).
3. New both, agent-hosted plugin: `p.Alert` on the agent host reaches hope's bell;
   `p.Storage` round-trips; forge with a wrong token → 401.
4. `curl` a non-plugin path through a REVERSE stream → 403 (path-guard).
5. Agent reconnect: listener + accept loop rebind cleanly; no leaked goroutines.
