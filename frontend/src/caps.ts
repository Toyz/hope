// caps caches the server capability flags so shared chrome (nav, footer) can
// decide what to show without every instance making a call. Only SUCCESSFUL
// results are cached — a call made before auth (e.g. on the login page) would
// 401, and caching that would wrongly hide the API link forever; instead the
// cache is cleared on failure so the next mount retries once authed.
import { app } from "@toyz/loom";
import { HopeTransport } from "./transport";
import type { Capabilities } from "./contracts";

let cached: Promise<Capabilities> | null = null;

export function capabilities(): Promise<Capabilities> {
  if (!cached) {
    const rpc = app.get(HopeTransport) as HopeTransport;
    cached = rpc.call<Capabilities>("System", "features", []);
    cached.catch(() => { cached = null; }); // don't cache a failure — retry next time
  }
  return cached.catch(() => ({ api_enabled: false, store_enabled: false }));
}
