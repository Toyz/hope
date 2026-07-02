// App-wide bus events (loom EventBus). Emitting one of these lets any mounted
// component react without a page reload — @on(HostChanged) in a LoomElement
// subscribes on connect and auto-unsubscribes on disconnect.
import { LoomEvent } from "@toyz/loom";

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
