// EventFeed is the single, app-lifetime subscription to hope's server event feed
// (POST /rpc/_events). It holds ONE persistent NDJSON stream and re-emits each
// server frame onto the loom bus as the matching app event — so the rail, widgets,
// and pages react to server-side changes (another tab, another operator, the
// daemon) exactly as they already react to local actions, with no new wiring in
// those components.
//
// Owned by <hope-app> (the always-mounted, auth-gated root): started on mount,
// stopped on unmount. The loop tolerates being started before login (it idles
// until a token appears) and reconnects with exponential backoff + jitter — never
// the fixed busy-retry pattern.
import { bus } from "@toyz/loom";
import type { HopeTransport } from "./transport";
import type { AuthStore } from "./auth-store";
import {
  TopologyChanged,
  TopologyRemoved,
  UpdatesApplied,
  PluginsChanged,
  ContainerStateChanged,
  UpdateAvailable,
  TunnelsChanged,
  AgentStatusChanged,
  PermissionRequested,
  PluginAlert,
} from "./events";

// One server frame off the feed. Everything but kind is optional (see the Go
// events.Event); ping/resync are control frames with no scope.
interface Frame {
  seq?: number;
  kind: string;
  host?: string;
  project?: string;
  ids?: string[];
  source?: string; // "hope" | "plugin.<identity>"
  data?: Record<string, string>; // kind-specific payload (e.g. permission.requested)
}

const BACKOFF_BASE = 500;
const BACKOFF_CAP = 30_000;
const IDLE_POLL = 1_000; // how often to check for a token before we're logged in

export class EventFeed {
  private stopped = false;
  private since = 0; // last Seq applied — a reconnect replays only the gap
  private ctrl?: AbortController;

  constructor(
    private rpc: HopeTransport,
    private auth: AuthStore,
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.ctrl?.abort();
  }

  private async loop(): Promise<void> {
    let backoff = BACKOFF_BASE;
    while (!this.stopped) {
      // Not logged in yet (or logged out) — idle without hammering the endpoint.
      if (!this.auth.token) {
        await this.sleep(IDLE_POLL);
        continue;
      }
      this.ctrl = new AbortController();
      try {
        for await (const f of this.rpc.events(this.since, this.ctrl.signal) as AsyncIterable<Frame>) {
          this.handle(f);
          backoff = BACKOFF_BASE; // a delivered frame proves the connection is healthy
        }
      } catch {
        // Network drop / server restart / 401 — fall through to backoff + reconnect.
      }
      if (this.stopped) break;
      const jitter = backoff * (0.5 + Math.random());
      await this.sleep(Math.min(BACKOFF_CAP, jitter));
      backoff = Math.min(BACKOFF_CAP, backoff * 2);
    }
  }

  // handle re-emits one server frame as the matching loom event. The existing
  // in-place-patch events (TopologyChanged/Removed, UpdatesApplied, PluginsChanged)
  // are idempotent, so the tab that caused a change double-applying is harmless —
  // no dedup needed.
  private handle(f: Frame): void {
    if (typeof f.seq === "number" && f.seq > this.since) this.since = f.seq;
    const host = f.host ?? "";
    switch (f.kind) {
      case "ping":
        return; // keepalive
      case "resync":
        // We may have missed events — refetch broadly (host "" = whole fleet).
        bus.emit(new TopologyChanged(""));
        bus.emit(new PluginsChanged());
        return;
      case "stack.deployed":
      case "stack.redeployed":
        bus.emit(new TopologyChanged(host, f.project));
        return;
      case "stack.destroyed":
        bus.emit(new TopologyRemoved(host, f.project));
        return;
      case "container.removed":
        bus.emit(new TopologyRemoved(host, undefined, f.ids));
        return;
      case "container.state": {
        const d = f.data ?? {};
        bus.emit(new ContainerStateChanged(host, f.ids, d.action ?? "", d.name ?? ""));
        return;
      }
      case "image.update":
        bus.emit(new UpdateAvailable(host, f.ids));
        return;
      case "image.current":
        bus.emit(new UpdatesApplied(host, f.project ?? "", f.ids));
        return;
      case "plugin.changed":
        bus.emit(new PluginsChanged());
        return;
      case "permission.requested": {
        const d = f.data ?? {};
        bus.emit(new PermissionRequested(d.key ?? "", d.name ?? "", host, d.scope ?? "", d.reason ?? ""));
        return;
      }
      case "tunnel.changed":
        bus.emit(new TunnelsChanged(host));
        return;
      case "agent.online":
        bus.emit(new AgentStatusChanged(host, true));
        return;
      case "agent.offline":
        bus.emit(new AgentStatusChanged(host, false));
        return;
      default:
        // Plugin-published alert (kind plugin.<key>.alert): surface it. Other
        // plugin-namespaced / future kinds are ignored so an older frontend degrades
        // gracefully.
        if (f.kind.startsWith("plugin.") && f.kind.endsWith(".alert")) {
          const d = f.data ?? {};
          bus.emit(
            new PluginAlert(
              f.source ?? "",
              d.severity ?? "info",
              d.title ?? "",
              d.detail ?? "",
              d.dedupeKey ?? "",
              d.resolved === "true" || (d.resolved as unknown) === true,
              host,
            ),
          );
        }
        return;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
