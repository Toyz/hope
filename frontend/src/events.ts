// App-wide bus events (loom EventBus). Emitting one of these lets any mounted
// component react without a page reload — @on(HostChanged) in a LoomElement
// subscribes on connect and auto-unsubscribes on disconnect.
import { LoomEvent, bus } from "@toyz/loom";

// Fired to open (or close) the docked inspector on a container. host+id identify
// the target; id === "" closes it. The shell renders the inspector column and the
// <hope-inspector> loads the target. Opening from a stack row keeps you in place
// instead of navigating to the full container page.
export class InspectorTarget extends LoomEvent {
  constructor(
    public host: string,
    public id: string,
    public name: string,
  ) {
    super();
  }
}

// Fired when the active Docker host or the fleet (all-hosts) view flag changes.
// Pages re-fetch in place; the host picker refreshes its label.
export class HostChanged extends LoomEvent {
  constructor(
    public activeId: string | null,
    public fleet: boolean,
  ) {
    super();
  }
}

// Fired around any refresh: active=true when it starts, false when it ends. The
// shared refresh control (<hope-refresh>) ref-counts these and spins while any
// refresh is in flight — so the spin lasts exactly as long as the work, on every
// mounted control, from any source.
export class Refreshing extends LoomEvent {
  constructor(public active: boolean) {
    super();
  }
}

// Bracket an async refresh with Refreshing(true)…Refreshing(false) on the bus,
// holding the "done" for a minimum beat so a fast refetch still shows a spin.
// Anything that refreshes (the shared control, the dashboard's check, …) wraps
// its work in this so every refresh control spins for the real duration.
const REFRESH_MIN_BEAT = 550;
export async function withRefresh<T>(fn: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now();
  bus.emit(new Refreshing(true));
  try {
    return await fn();
  } finally {
    const wait = Math.max(0, REFRESH_MIN_BEAT - (performance.now() - t0));
    setTimeout(() => bus.emit(new Refreshing(false)), wait);
  }
}

// Fired by any modal when it opens or closes. The root shell (hope-app) listens
// and ref-counts open modals to lock/unlock body scroll centrally — components
// announce intent, the root owns the DOM side-effect. `source` is the modal
// instance (a stable identity across its open/close pair).
export class ModalToggle extends LoomEvent {
  constructor(
    public source: object,
    public open: boolean,
  ) {
    super();
  }
}
