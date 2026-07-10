// HopeTransport is the loom-rpc transport for hope. It injects the bearer
// token, unwraps the sov {data}/{error} envelope, redirects to /login on 401,
// and implements stream() against the backend's NDJSON routes — the piece
// loom-rpc leaves to the transport.
import { app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { RpcTransport, RpcError } from "@toyz/loom-rpc";
import { AuthStore } from "./auth-store";
import { HostContext } from "./host-context";

export class HopeTransport extends RpcTransport {
  @inject(AuthStore) accessor auth!: AuthStore;

  // Fixed base path. A zero-arg constructor keeps HopeTransport injectable as
  // a DI token (an optional ctor param breaks loom's inject() typing).
  private readonly baseUrl = "/rpc";

  // The host every call targets: an explicit override (fleet aggregation) wins,
  // otherwise the ambient active host from the HostContext store. So @rpc queries
  // and plain calls target the right host without ever passing one.
  private targetHost(host?: string): string {
    if (host) return host;
    return app.has(HostContext) ? app.get(HostContext).activeHost : "";
  }

  private headers(host?: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.auth.token) h["Authorization"] = `Bearer ${this.auth.token}`;
    const target = this.targetHost(host);
    if (target) h["X-Hope-Host"] = target; // per-request host target
    return h;
  }

  /** callOn runs an RPC against a specific host (X-Hope-Host) without changing
   *  the globally-active host — used to aggregate across hosts in fleet views. */
  callOn<T>(host: string, router: string, method: string, args: any[], signal?: AbortSignal): Promise<T> {
    return this.call<T>(router, method, args, signal, false, host);
  }

  // Micro-batch queue: unary calls made in the same tick coalesce into one
  // POST /rpc/_batch (grouped by target host, since the host is a per-request
  // header). Abortable calls, Auth-flow calls, and lone calls stay direct.
  private batchQ: Array<{ alias: string; service: string; method: string; args: any[]; host: string; resolve: (v: any) => void; reject: (e: any) => void }> = [];
  private batchScheduled = false;
  private aliasSeq = 0;
  // Set once a gateway 404s /rpc/_batchstream (an older build without the streaming
  // route) so we stop probing it and use the buffered /rpc/_batch for the session.
  private batchStreamOff = false;

  // Calls that never coalesce into a batch. Entries are "Service.method" for a
  // single method, or "Service.*" for a whole router. A batch resolves
  // all-or-nothing, so a fast call gated behind the batch waits on its slowest
  // sibling — two reasons to opt out:
  //   - Auth.*    — the login/SSO flow must not recurse into the 401 batch
  //                 fallback (which re-issues each call through directCall).
  //   - System.fleet — gates the topology rail's first paint; keep it direct so
  //                 it returns on its own response, not the tick's slowest.
  //   - Plugins.*  — a plugin call crosses a network boundary (dial a container,
  //                 run arbitrary author code / a heavy query, possibly over the
  //                 agent tunnel), so its latency is unbounded. Batched, one slow
  //                 plugin call head-of-line-blocks every hope core call in the
  //                 same tick — the UI-lag the batch was meant to avoid. Keep
  //                 plugin calls direct so their latency stays isolated to the
  //                 plugin panel that made them.
  private static readonly NEVER_BATCH: ReadonlySet<string> = new Set(["Auth.*", "System.fleet", "Plugins.*"]);

  private neverBatch(router: string, method: string): boolean {
    return HopeTransport.NEVER_BATCH.has(`${router}.*`) || HopeTransport.NEVER_BATCH.has(`${router}.${method}`);
  }

  async call<T>(router: string, method: string, args: any[], signal?: AbortSignal, retried = false, host?: string): Promise<T> {
    // Abortable calls bypass batching (a batch is one request for many calls, so
    // there's no per-call abort), as do NEVER_BATCH calls — see that set.
    if (signal || this.neverBatch(router, method)) {
      return this.directCall<T>(router, method, args, signal, retried, host);
    }
    return new Promise<T>((resolve, reject) => {
      this.batchQ.push({ alias: "c" + this.aliasSeq++, service: router, method, args, host: this.targetHost(host), resolve, reject });
      if (!this.batchScheduled) {
        this.batchScheduled = true;
        queueMicrotask(() => { this.batchScheduled = false; void this.flushBatch(); });
      }
    });
  }

  private async flushBatch() {
    const q = this.batchQ;
    this.batchQ = [];
    // Group by host — one batch per host (the header targets the daemon). Hosts flush
    // concurrently; each group settles its own calls.
    const byHost = new Map<string, typeof q>();
    for (const c of q) {
      const g = byHost.get(c.host);
      if (g) g.push(c); else byHost.set(c.host, [c]);
    }
    for (const [hostKey, calls] of byHost) {
      const hostArg = hostKey || undefined;
      // A lone call gains nothing from a batch envelope — send it direct.
      if (calls.length === 1) {
        const c = calls[0];
        this.directCall(c.service, c.method, c.args, undefined, false, hostArg).then(c.resolve, c.reject);
        continue;
      }
      // Prefer the streaming endpoint (each call resolves as its result lands, no
      // head-of-line blocking); fall back to the buffered batch once/if it's absent.
      if (this.batchStreamOff) void this.sendBatchBuffered(calls, hostArg);
      else void this.sendBatchStream(calls, hostArg);
    }
  }

  private batchBody(calls: HopeTransport["batchQ"]) {
    return { calls: Object.fromEntries(calls.map((c) => [c.alias, { service: c.service, method: c.method, args: c.args }])) };
  }

  // sendBatchStream POSTs /rpc/_batchstream and settles each call the moment its NDJSON
  // frame arrives — so a fast call never waits on a slow sibling. Degrades safely: a 404
  // (older gateway) switches the session to the buffered batch; a transport failure or an
  // alias the server never emitted falls the affected calls back to a direct request.
  private async sendBatchStream(calls: HopeTransport["batchQ"], hostArg?: string) {
    const pending = new Map(calls.map((c) => [c.alias, c] as const));
    const direct = (c: (typeof calls)[number]) => this.directCall(c.service, c.method, c.args, undefined, false, hostArg).then(c.resolve, c.reject);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/_batchstream`, { method: "POST", headers: this.headers(hostArg), body: JSON.stringify(this.batchBody(calls)) });
    } catch {
      return this.sendBatchBuffered(calls, hostArg); // transport failed — try the buffered path
    }
    if (res.status === 404) { this.batchStreamOff = true; return this.sendBatchBuffered(calls, hostArg); }
    if (res.status === 401) { for (const c of calls) direct(c); return; } // whole-batch auth failure → SSO/login path
    if (!res.ok || !res.body) return this.sendBatchBuffered(calls, hostArg);

    const settle = (alias: string, r: { data?: any; error?: { message?: string; code?: string } }) => {
      const c = pending.get(alias);
      if (!c) return;
      pending.delete(alias);
      if (r?.error) c.reject(new RpcError(r.error.message ?? `RPC ${c.service}.${c.method}`, res.status, c.service, c.method, r.error.code));
      else c.resolve(r?.data);
    };
    const feed = (line: string) => {
      const s = line.trim();
      if (!s) return;
      try { const f = JSON.parse(s) as { alias: string; result: any }; settle(f.alias, f.result); } catch { /* skip a malformed line */ }
    };
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) { feed(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
      }
      feed(buffer); // trailing line without a newline
    } catch {
      /* mid-stream drop — unsettled calls fall through to the direct fallback below */
    }
    // Any alias the server never returned (drop, or an omission) must not hang forever.
    for (const [, c] of pending) direct(c);
  }

  // sendBatchBuffered is the original all-or-nothing /rpc/_batch: one request, one blob,
  // every call settling together. The streaming path's fallback.
  private async sendBatchBuffered(calls: HopeTransport["batchQ"], hostArg?: string) {
    try {
      const res = await fetch(`${this.baseUrl}/_batch`, { method: "POST", headers: this.headers(hostArg), body: JSON.stringify(this.batchBody(calls)) });
      if (res.status === 401) { // whole-batch auth failure — fall back to direct (which drives the SSO/login path)
        for (const c of calls) this.directCall(c.service, c.method, c.args, undefined, false, hostArg).then(c.resolve, c.reject);
        return;
      }
      const json: any = await res.json();
      // The batch body is {results}; tolerate a {data:{results}} envelope too.
      const results: Record<string, { data?: any; error?: { message?: string; code?: string } }> = json.results || json.data?.results || {};
      for (const c of calls) {
        const r = results[c.alias];
        if (!r) { c.reject(new RpcError(`RPC ${c.service}.${c.method}: missing batch result`, res.status, c.service, c.method)); continue; }
        if (r.error) c.reject(new RpcError(r.error.message ?? `RPC ${c.service}.${c.method}`, res.status, c.service, c.method, r.error.code));
        else c.resolve(r.data);
      }
    } catch {
      // Batch transport failed (e.g. endpoint missing) — fall back to per-call.
      for (const c of calls) this.directCall(c.service, c.method, c.args, undefined, false, hostArg).then(c.resolve, c.reject);
    }
  }

  private async directCall<T>(router: string, method: string, args: any[], signal?: AbortSignal, retried = false, host?: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${router}/${method}`, {
      method: "POST",
      headers: this.headers(host),
      body: JSON.stringify({ args }),
      signal,
    });

    let json: { data?: T; error?: { message?: string; code?: string } };
    try {
      json = await res.json();
    } catch {
      throw new RpcError(`RPC ${router}.${method}: ${res.status}`, res.status, router, method);
    }

    // A 401 means no/expired session. Behind Cloudflare Access the edge still
    // attaches a valid assertion, so try the SSO exchange once and retry — an
    // expired hope token self-heals without a visit to the login form. Auth's own
    // methods (login/sso) don't recurse.
    if (res.status === 401 && router !== "Auth") {
      if (!retried && (await this.trySso())) {
        return this.directCall<T>(router, method, args, signal, true, host);
      }
      this.auth.clear();
      this.redirectLogin();
    }

    if (!res.ok || json.error) {
      throw new RpcError(
        json.error?.message ?? `RPC ${router}.${method}: ${res.status}`,
        res.status,
        router,
        method,
        json.error?.code,
      );
    }
    return json.data as T;
  }

  /** loom-rpc @stream entry point — no caller-controlled teardown. */
  stream<T>(router: string, method: string, args: any[]): AsyncIterable<T> {
    return this.streamWithSignal<T>(router, method, args);
  }

  /**
   * streamWithSignal opens an NDJSON stream and yields one parsed object per
   * line. Pass an AbortSignal (from the consuming component's unmount) so the
   * underlying fetch is torn down deterministically.
   */
  async *streamWithSignal<T>(
    router: string,
    method: string,
    args: any[],
    signal?: AbortSignal,
    host?: string,
  ): AsyncIterable<T> {
    const res = await fetch(`${this.baseUrl}/${router}/${method}`, {
      method: "POST",
      headers: this.headers(host),
      body: JSON.stringify({ args }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new RpcError(`stream ${router}.${method}: ${res.status}`, res.status, router, method);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) yield JSON.parse(line) as T;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /**
   * events opens the global event feed (POST /rpc/_events) and yields one parsed
   * frame per NDJSON line. Unlike streamWithSignal it is NOT a router/method call:
   * the body is {since} (the last Seq seen) so a reconnect replays only the gap.
   * Host-agnostic — the feed is fleet-wide. Pass an AbortSignal to tear it down.
   */
  async *events(since: number, signal?: AbortSignal): AsyncIterable<any> {
    const res = await fetch(`${this.baseUrl}/_events`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ since }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new RpcError(`event feed: ${res.status}`, res.status, "_events", "");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) yield JSON.parse(line);
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  // trySso attempts the Cloudflare Access exchange (POST /rpc/Auth/sso). Returns
  // true and stores the token when the edge assertion is valid; false otherwise
  // (not behind Access, or the assertion didn't verify).
  private async trySso(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/Auth/sso`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: [] }),
      });
      if (!res.ok) return false;
      const j = (await res.json()) as { data?: { token?: string } };
      const tok = j?.data?.token;
      if (tok) {
        this.auth.set(tok, true); // came from the Access assertion
        return true;
      }
    } catch {
      /* no Access / network error */
    }
    return false;
  }

  private redirectLogin(): void {
    try {
      app.get(LoomRouter).navigate("/login");
    } catch {
      window.location.href = "/login";
    }
  }
}
