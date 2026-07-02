// HostContext — the reactive store for which Docker host the UI targets.
//
// Two pieces of client state, both persisted (survive reload) and reactive (a
// component that reads them in update() re-renders when they change, no manual
// event needed):
//   - fleet: the "all hosts" cross-fleet view flag.
//   - activeHost: the host id RPC should target ("" = server default / local).
//     HopeTransport reads this and sets X-Hope-Host, so the target is ambient —
//     callers (and @rpc queries) never thread a host argument.
import { persist } from "@toyz/loom";

export class HostContext {
  @persist("hope.fleet") accessor fleet = false;
  @persist("hope.host") accessor activeHost = "";
}
