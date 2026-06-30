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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.auth.token) h["Authorization"] = `Bearer ${this.auth.token}`;
    return h;
  }

  async call<T>(router: string, method: string, args: any[], signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${router}/${method}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ args }),
      signal,
    });

    let json: { data?: T; error?: { message?: string; code?: string } };
    try {
      json = await res.json();
    } catch {
      throw new RpcError(`RPC ${router}.${method}: ${res.status}`, res.status, router, method);
    }

    if (res.status === 401 && !(router === "Auth" && method === "login")) {
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
  ): AsyncIterable<T> {
    const res = await fetch(`${this.baseUrl}/${router}/${method}`, {
      method: "POST",
      headers: this.headers(),
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

  private redirectLogin(): void {
    try {
      app.get(LoomRouter).navigate("/login");
    } catch {
      window.location.href = "/login";
    }
  }
}
