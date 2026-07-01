// caps caches the server capability flags (fetched once) so shared chrome like
// the nav can decide what to show without every instance making a call.
import { app } from "@toyz/loom";
import { HopeTransport } from "./transport";
import type { Capabilities } from "./contracts";

let cached: Promise<Capabilities> | null = null;

export function capabilities(): Promise<Capabilities> {
  if (cached) return cached;
  const rpc = app.get(HopeTransport) as HopeTransport;
  cached = rpc.call<Capabilities>("System", "capabilities", []).catch(() => ({ api_enabled: false }));
  return cached;
}
