// HopeTransport is the loom-rpc transport for hope. It injects the bearer
// token, unwraps the sov {data}/{error} envelope, redirects to /login on 401,
// and implements stream() against the backend's NDJSON routes — the piece
// loom-rpc leaves to the transport.
import { app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { RpcTransport, RpcError } from "@toyz/loom-rpc";
import { AuthStore } from "./auth-store";

export class HopeTransport extends RpcTransport {
  @inject(AuthStore) accessor auth!: AuthStore;

  // Fixed base path. A zero-arg constructor keeps HopeTransport injectable as
  // a DI token (an optional ctor param breaks loom's inject() typing).
  private readonly baseUrl = "/rpc";

  private headers(host?: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.auth.token) h["Authorization"] = `Bearer ${this.auth.token}`;
    if (host) h["X-Hope-Host"] = host; // per-request host target (fleet views)
    return h;
  }

  /** callOn runs an RPC against a specific host (X-Hope-Host) without changing
   *  the globally-active host — used to aggregate across hosts in fleet views. */
  callOn<T>(host: string, router: string, method: string, args: any[], signal?: AbortSignal): Promise<T> {
    return this.call<T>(router, method, args, signal, false, host);
  }

  async call<T>(router: string, method: string, args: any[], signal?: AbortSignal, retried = false, host?: string): Promise<T> {
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
        return this.call<T>(router, method, args, signal, true, host);
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
