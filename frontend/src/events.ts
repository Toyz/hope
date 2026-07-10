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
    public tab = "", // optional initial tab to open on (e.g. "logs"); "" keeps current
  ) {
    super();
  }
}

// Fired to open (or close) the docked MULTI-SOURCE log panel — stack/service logs
// merged across containers. method+args are the Stream route (stackLogs/serviceLogs)
// and its args; method === "" closes it. Shares the docked slot with the inspector.
export class LogPanelTarget extends LoomEvent {
  constructor(
    public host: string,
    public title: string,
    public method: string,
    public args: string[],
  ) {
    super();
  }
}

// Fired to open (or close) the docked IMAGE inspector on an image (host + ref).
// ref === "" closes it. Shares the docked bottom slot with the container inspector
// and the log viewer (the shell shows one at a time).
export class ImageInspectorTarget extends LoomEvent {
  constructor(
    public host: string,
    public ref: string,
  ) {
    super();
  }
}

// Fired to open (or close) the docked VOLUME inspector (host + name). name === ""
// closes it. Shares the docked bottom slot with the other inspectors + logs.
export class VolumeInspectorTarget extends LoomEvent {
  constructor(
    public host: string,
    public name: string,
  ) {
    super();
  }
}

// Fired to open (or close) the docked NETWORK inspector (host + ref). ref === ""
// closes it. Shares the docked bottom slot with the other inspectors + logs.
export class NetworkInspectorTarget extends LoomEvent {
  constructor(
    public host: string,
    public ref: string,
  ) {
    super();
  }
}

// Fired to open (or close) the docked CONNECTOR inspector (host + connector id).
// Keyed by id, not name: connector names aren't unique (they're local to a stack
// and hope doesn't force uniqueness). id === "" closes it.
export class ConnectorInspectorTarget extends LoomEvent {
  constructor(
    public host: string,
    public id: string,
  ) {
    super();
  }
}

// Fired to open/close the docked plugin inspector. key is the plugin's stable
// identity (host|project/service); host is the fleet host it lives on.
export class PluginInspectorTarget extends LoomEvent {
  constructor(
    public host: string,
    public key: string,
  ) {
    super();
  }
}

// Fired when a plugin's trust/state changes (enable / disable / forget / settings)
// so the rail (pages) and container inspector (surfaces) refetch immediately.
export class PluginsChanged extends LoomEvent {}

// Fired by the plugins page to open the marketplace installer for a target host.
// preselect (optional) is a catalog id to jump straight into installing that plugin.
export class OpenInstaller extends LoomEvent {
  constructor(public host: string, public preselect = "") {
    super();
  }
}

// Fired by a plugin page to feed its author-declared breadcrumbs into the topbar's
// existing scope trail (absolute `to`s already resolved). null clears them, so the
// topbar falls back to deriving the trail from the path.
export class PageCrumbs extends LoomEvent {
  constructor(public crumbs: { label: string; to?: string }[] | null) {
    super();
  }
}

// The current plugin-page crumbs, persisted so the topbar reads them even across a
// full page reload (the bus event is fire-and-forget and can be missed if the topbar
// subscribes after the page emits). Source of truth; the event is the re-render nudge.
export const pluginCrumbs: { value: { label: string; to?: string }[] | null } = { value: null };

// Fired to open the global command palette (the ⌘K "jump to" search). The topbar
// search box emits it; <hope-palette> listens (⌘K itself is handled in-palette).
export class PaletteToggle extends LoomEvent {}

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

// Fired when a stack or container(s) were removed, so the rail (and any fleet view)
// can patch its tree IN PLACE — drop the affected nodes — instead of refetching the
// whole fleet. host is the fleet host id; give `project` for a whole-stack removal or
// `ids` for specific container(s). Mirrors UpdatesApplied's in-place patch model.
export class TopologyRemoved extends LoomEvent {
  constructor(public host: string, public project?: string, public ids?: string[]) {
    super();
  }
}

// Fired when containers are ADDED to the fleet (e.g. a marketplace plugin install deploys a
// container into a stack). The new container's details aren't known client-side, so unlike
// TopologyRemoved (which patches in place) the rail refetches the fleet so the stack shows it.
export class TopologyChanged extends LoomEvent {
  constructor(public host: string, public project?: string) {
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

// Fired after a successful update (pull + recreate) so always-mounted surfaces —
// the rail's topology dots — can patch their "outdated" markers IN PLACE instead
// of refetching the whole fleet map (the backend already flipped the freshness
// cache to current on redeploy, so the patch matches server truth). `ids` scopes
// it to specific containers; omit it to clear the whole project on that host.
export class UpdatesApplied extends LoomEvent {
  constructor(
    public host: string,
    public project: string,
    public ids?: string[],
  ) {
    super();
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

// --- Server-originated events (re-emitted by EventFeed from the /rpc/_events
// feed). These carry SERVER truth pushed from the daemon, so a change made in
// another tab / by another operator / by the daemon itself updates this tab live.
// They deliberately reuse the existing in-place-patch events above where possible
// (TopologyChanged/TopologyRemoved/UpdatesApplied/PluginsChanged); the classes
// below are the few new shapes the feed needs. ---

// Fired when a container's lifecycle state changed on the server (start/stop/
// restart/kill). host + optional container ids scope it; a page showing those
// containers can refetch their status.
export class ContainerStateChanged extends LoomEvent {
  constructor(public host: string, public ids?: string[]) {
    super();
  }
}

// Fired when a new image update became available on the server (the freshness
// crawler flipped a verdict to outdated). Inverse of UpdatesApplied.
export class UpdateAvailable extends LoomEvent {
  constructor(public host: string, public ids?: string[]) {
    super();
  }
}

// Fired when a host's tunnel routes changed on the server (connector/route add or
// remove), so a tunnels view can refetch.
export class TunnelsChanged extends LoomEvent {
  constructor(public host: string) {
    super();
  }
}

// Fired when an agent host connected or disconnected, so fleet views reflect it
// live without waiting for a manual refresh.
export class AgentStatusChanged extends LoomEvent {
  constructor(public host: string, public online: boolean) {
    super();
  }
}
