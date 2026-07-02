// HostContext — the single source of truth for the "all hosts" (fleet) view flag.
//
// The active Docker host itself is server-side state (System.setActiveHost); this
// service owns only the client-side fleet-view toggle, which used to be read via a
// `localStorage.getItem("hope.fleet")` getter copy-pasted across ~10 pages. It keeps
// the same "hope.fleet" storage key for back-compat, so existing sessions keep their
// view. Writes go through setFleet(); the host picker emits HostChanged after mutating
// host/fleet state so every mounted view re-fetches in place (no reload).
const KEY = "hope.fleet";

export class HostContext {
  // True when the dashboard/system pages should render their cross-fleet view.
  get fleet(): boolean {
    return localStorage.getItem(KEY) === "1";
  }

  setFleet(on: boolean): void {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  }
}
