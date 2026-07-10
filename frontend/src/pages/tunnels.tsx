// Tunnels page: hope-managed Cloudflare connectors + the public routes they
// serve (hostname -> stack/service). Deploy a connector, add/remove routes.
// Host-aware: in "all hosts" mode the deploy/add dialogs ask which host to target;
// otherwise they use the actively-selected host.
import { LoomElement, component, styles, css, reactive, mount, watch, interval, on, prop, app } from "@toyz/loom";
import { draggable, dropzone } from "@toyz/loom/element";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { ConnectorInspector } from "../connector-inspector";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { stackPath, containerPath } from "../host-url";
import { HostChanged, Refreshing, withRefresh, TunnelsChanged } from "../events";
import { UNGROUPED } from "../const";
import { innerPort } from "../format";
import { splitHost } from "../util";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import { ToastService } from "../toast";
import { PromptService, type PromptField } from "../prompt";
import type { ConnectorView, TunnelView, StackSummary, OpResult, HostView, ZoneView } from "../contracts";
import type { PromptOption } from "../prompt";
import { theme } from "../styles";

@route("/tunnels/:host")
@route("/tunnels/:host/:id")
@component("hope-tunnels")
@styles(theme, css`
  :host { display: block; min-height: 100%; background: var(--ink); }

  /* header stat-band children (slotted into <hope-stat>) */
  .skstat { display: flex; flex-direction: column; gap: 8px; }
  .colos { display: flex; gap: 6px; flex-wrap: wrap; }
  .colo { font: 600 10px/1.6 var(--mono); letter-spacing: .08em; color: var(--upd);
    border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line2)); padding: 2px 7px; }
  .cfver { font: 500 15px/1 var(--mono); color: var(--hi); } .cfver .upd { color: var(--warn); font-size: 12px; }

  /* connector section: band header (opens docked inspector) + route table */
  .tconn { border-bottom: 1px solid var(--line); }
  .cband { display: flex; align-items: center; gap: 12px; padding: 14px 28px; background: #11161f; border-bottom: 1px solid var(--line); cursor: pointer; }
  .cband:hover { background: #141b26; }
  /* active (its inspector is docked): accent the BAND only, not every route row */
  .tconn.on .cband { box-shadow: inset 2px 0 0 var(--upd); background: color-mix(in srgb, var(--upd) 9%, #11161f); }
  .tconn.on .cband:hover { background: color-mix(in srgb, var(--upd) 13%, #11161f); }
  .cband .cdot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); flex: none; }
  .cband .cdot.warn { background: var(--warn); } .cband .cdot.off { background: var(--bad); }
  .cband .cname { font: 700 13.5px/1 var(--mono); color: var(--hi); }
  .cband:hover .cname { text-decoration: underline; }
  .cband .grow { flex: 1; }
  .cmeta { display: flex; align-items: center; gap: 18px; }
  .cm { display: flex; align-items: baseline; gap: 6px; font: 11.5px/1 var(--mono); color: var(--mid); }
  .cm .lbl { font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
  .cm b { color: var(--hi); font-weight: 600; font-variant-numeric: tabular-nums; }
  .cm.warn b { color: var(--warn); }
  .cver { color: var(--dim); font: 11px/1 var(--mono); }
  .cgo { color: var(--faint); flex: none; } .cband:hover .cgo { color: var(--mid); }
  .tconn.on .cgo { color: var(--upd); }

  /* domain sub-header: clusters routes for one domain */
  .rdgroup { padding: 9px 28px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--ink) 45%, var(--panel)); }
  .rdgroup a { color: var(--mid); text-decoration: none; font: 600 11px/1 var(--mono); letter-spacing: .06em; }
  .rdgroup a:hover { color: var(--hi); text-decoration: underline; }
  .rrow.drop-over { box-shadow: inset 0 2px 0 var(--upd); }
  .rrow { cursor: grab; } .rrow:active { cursor: grabbing; }
  .rhost .rootlbl { color: var(--dim); font-style: italic; }
  .rthead, .rrow { display: grid; grid-template-columns: minmax(0, 1.5fr) 44px minmax(0, 1.5fr) 110px 70px; align-items: center; gap: 16px; padding: 0 28px; }
  .rthead { height: 34px; border-bottom: 1px solid var(--line); }
  .rthead span { font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .rthead .r { text-align: right; }
  .rrow { height: 46px; border-bottom: 1px solid var(--line); }
  .rrow:last-child { border-bottom: 0; }
  .rrow:hover { background: var(--raised); }
  .rhost { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .rhost .lock { color: var(--ok); flex: none; }
  .rhost .h { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rhost .h a { color: inherit; }
  .rhost .h a:hover { text-decoration: underline; }
  .rhost .h b { color: var(--hi); font-weight: 600; } .rhost .h .dom { color: var(--dim); }
  .rflow { display: flex; align-items: center; justify-content: center; color: var(--faint); }
  .rflow svg { width: 38px; height: 10px; }
  .rsvc2 { display: flex; align-items: baseline; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rsvc2 .proj { color: var(--dim); } .rsvc2 .svc { color: var(--hi); cursor: pointer; } .rsvc2 .svc:hover { text-decoration: underline; }
  .rsvc2 .port { color: var(--mid); } .rsvc2 .via { color: var(--dim); font-size: 10.5px; }
  .rpath { color: var(--upd); font: 12px/1 var(--mono); } .rpath.none { color: var(--faint); }
  .racts { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
  .rmx2 { background: transparent; border: 1px solid transparent; color: var(--dim); cursor: pointer; padding: 4px 5px; display: inline-flex; opacity: 0; }
  .rrow:hover .rmx2 { opacity: 1; }
  .rmx2:hover { color: var(--hi); border-color: var(--line2); }
  .rmx2.del:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line2)); }
  .rmx2:disabled { opacity: 0; }
  .rmx2 loom-icon.up { transform: rotate(180deg); }
  .taddr { display: flex; align-items: center; gap: 8px; padding: 12px 28px; color: var(--dim); font: 11.5px/1 var(--mono); cursor: pointer; border-bottom: 1px solid var(--line); }
  .taddr:hover { color: var(--upd); }
  .noroutes2 { padding: 16px 28px; color: var(--dim); font: 12.5px/1.6 var(--mono); border-bottom: 1px solid var(--line); }
`)
export class TunnelsPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ConnectorInspector) accessor connInsp!: ConnectorInspector;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor connectors: ConnectorView[] = [];
  @reactive accessor routes: TunnelView[] = [];
  @reactive accessor stacks: (StackSummary & { host?: string })[] = [];
  @reactive accessor hosts: HostView[] = [];
  @reactive accessor zones: ZoneView[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor disabled = false;
  @reactive accessor busy = false;
  @reactive accessor hostQuery = "";
  // Trailing :id opens the docked connector inspector for that connector id
  // (deep-linkable). id, not name — connector names aren't unique.
  @prop({ param: "id" }) accessor routeConn = "";

  private suppressUntil = 0; // pause the auto-reload right after a local change

  get fleetMode() {
    return this.hostCtx.fleet;
  }

  // Host/fleet switched elsewhere — re-fetch in place (no reload).
  @on(HostChanged)
  onHostChanged() {
    if (this.auth.isAuthenticated) this.load();
  }

  // A route/connector changed on the server (this tab or another) — re-fetch,
  // unless we just made a local change (suppressUntil) and already updated in place.
  @on(TunnelsChanged)
  onTunnelsChanged() {
    if (this.auth.isAuthenticated && Date.now() >= this.suppressUntil) this.load();
  }

  // Spin the header refresh only for a user-triggered refresh (via the Refreshing
  // bus, min-beat), not the 8s background poll (which would spin near-constantly).
  @reactive accessor refreshing = false;
  private refreshRC = 0;
  @on(Refreshing) private onRefreshing(e: Refreshing) {
    this.refreshRC = Math.max(0, this.refreshRC + (e.active ? 1 : -1));
    this.refreshing = this.refreshRC > 0;
  }
  private userRefresh = () => { void withRefresh(() => this.load()); };

  // The host these connectors were listed from (Connectors runs on the active host).
  private activeHostId() {
    return this.hosts.find((h) => h.active)?.id || "local";
  }

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
    this.syncConn();
  }

  @watch("routeConn")
  private onConnParam() { this.syncConn(); }

  // Drive the docked connector inspector from the URL's id segment (the connector
  // id). apply() only sets state + fires the bus event (no navigation), so it
  // can't loop with select(). The connector's real host is resolved once the list
  // has loaded (fleet mode aggregates hosts); load() re-syncs to correct it.
  private syncConn() {
    if (this.routeConn) {
      const id = decodeURIComponent(this.routeConn);
      this.connInsp.onChange = () => this.load();
      this.connInsp.apply(this.hostOf(this.connById(id)), id);
    } else if (this.connInsp.isOpen) {
      this.connInsp.apply("", "");
    }
  }

  private connById(id: string): ConnectorView | undefined {
    return this.connectors.find((c) => c.id === id);
  }

  @interval(8000)
  tick() {
    if (this.auth.isAuthenticated && !this.disabled && Date.now() >= this.suppressUntil) this.load();
  }

  private load = async () => {
    this.busy = true;
    try {
      const [hosts, zones] = await Promise.all([
        this.rpc.call<HostView[]>("System", "hosts", []).catch(() => []),
        this.rpc.call<ZoneView[]>("Tunnels", "zones", []).catch(() => []),
      ]);
      this.hosts = hosts || [];
      this.zones = zones || [];

      const cons: ConnectorView[] = [];
      const routes: TunnelView[] = [];
      const stacks: (StackSummary & { host?: string })[] = [];
      let disabled = false;

      if (this.fleetMode && this.hosts.length) {
        // Connectors + stacks live on specific hosts — aggregate across all of
        // them (X-Hope-Host per call) so "all hosts" shows every connector, its
        // routes, AND the right stacks/services for the add-route picker.
        const per = await Promise.all(
          this.hosts.map(async (h) => {
            try {
              const [c, t, s] = await Promise.all([
                this.rpc.callOn<ConnectorView[]>(h.id, "Tunnels", "connectors", []),
                this.rpc.callOn<TunnelView[]>(h.id, "Tunnels", "tunnels", []),
                this.rpc.callOn<StackSummary[]>(h.id, "Stacks", "list", []).catch(() => []),
              ]);
              return { host: h.id, cons: c || [], routes: t || [], stacks: s || [] };
            } catch (e: any) {
              if (/disabled/i.test(e?.message || "")) disabled = true;
              return { host: h.id, cons: [] as ConnectorView[], routes: [] as TunnelView[], stacks: [] as StackSummary[] };
            }
          }),
        );
        // Dedup by connector id / route key: a stale backend that ignores
        // X-Hope-Host returns the active host's connectors for every query, so
        // guard against showing the same connector (and its routes) N times.
        const seenC = new Set<string>();
        const seenR = new Set<string>();
        for (const p of per) {
          for (const c of p.cons) {
            if (seenC.has(c.id)) continue;
            seenC.add(c.id);
            cons.push({ ...c, host: p.host });
          }
          for (const t of p.routes) {
            const k = `${t.connector}|${t.hostname}|${t.path || ""}`;
            if (seenR.has(k)) continue;
            seenR.add(k);
            routes.push({ ...t, host: p.host });
          }
          for (const s of p.stacks) stacks.push({ ...s, host: p.host });
        }
      } else {
        try {
          const hid = this.activeHostId();
          const [c, t, s] = await Promise.all([
            this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
            this.rpc.call<TunnelView[]>("Tunnels", "tunnels", []),
            this.rpc.call<StackSummary[]>("Stacks", "list", []).catch(() => []),
          ]);
          for (const x of c || []) cons.push({ ...x, host: hid });
          for (const x of t || []) routes.push({ ...x, host: hid });
          for (const x of s || []) stacks.push({ ...x, host: hid });
        } catch (e: any) {
          if (/disabled/i.test(e?.message || "")) disabled = true;
          else throw e;
        }
      }

      this.connectors = cons;
      this.routes = routes;
      this.stacks = stacks;
      this.disabled = disabled && cons.length === 0; // only "off" if no host has tunnels
      this.error = "";
      this.loaded = true;
      if (this.routeConn) this.syncConn(); // now that the list is in, correct the host
    } catch (err: any) {
      const msg = err?.message ?? "Can't list tunnels.";
      if (/disabled/i.test(msg)) this.disabled = true;
      else this.error = msg;
      this.loaded = true;
    } finally {
      this.busy = false;
    }
  };

  // The host a connector runs on (fleet aggregation tags it; else the active host).
  private hostOf(c?: ConnectorView | null): string {
    return c?.host || this.activeHostId();
  }
  private connByName(name: string): ConnectorView | undefined {
    return this.connectors.find((c) => c.name === name);
  }

  // In "all hosts" mode, a host picker so you choose where to deploy/attach;
  // otherwise the actively-selected host is implied (no field).
  private hostField(): PromptField | null {
    if (!this.fleetMode) return null;
    const conn = this.hosts.filter((h) => h.connected);
    if (conn.length <= 1) return null;
    const active = conn.find((h) => h.active) || conn[0];
    return { key: "host", label: "host", type: "select", value: active.id, options: conn.map((h) => ({ value: h.id, label: h.id + (h.kind === "local" ? " (local)" : "") })) };
  }

  private async targetHost(v: Record<string, string>) {
    if (v.host) await this.rpc.call("System", "setActiveHost", [v.host]);
  }

  private deployConnector = async () => {
    const fields: PromptField[] = [];
    const hf = this.hostField();
    if (hf) fields.push(hf);
    fields.push({ key: "name", label: "name", placeholder: "shared" });
    const v = await this.prompt.ask({
      title: "deploy connector",
      icon: "link",
      message: "hope creates a Cloudflare tunnel and runs a cloudflared container for it on the chosen host.",
      submitLabel: "Deploy",
      fields,
    });
    if (!v) return;
    await this.proc.run(`deploy connector ${v.name.trim()}`, async (emit) => {
      try {
        await this.targetHost(v);
        emit("creating Cloudflare tunnel…");
        emit("pulling cloudflared + starting (first pull can take a moment)…");
        await this.rpc.callOn<ConnectorView>(this.hostCtx.activeHost || this.activeHostId(), "Tunnels", "createConnector", [v.name.trim()]);
        emit("connector deployed");
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    await this.load();
  };

  // Jump to the exact container a route targets, on that route's host. Prefer the
  // resolved origin container id (from the backend), then fall back to matching the
  // container name in the loaded stacks, then to the stack view.
  private openTarget = (t: TunnelView) => {
    const host = t.host || this.activeHostId();
    const cid = this.containerIdFor(t, host);
    if (cid) {
      const proj = t.project || this.stacksFor(host).find((s) => s.containers.some((c) => c.id === cid))?.project || UNGROUPED;
      this.router.navigate(containerPath(host, proj, cid));
      return;
    }
    if (t.project) this.router.navigate(stackPath(host, t.project));
  };

  // Resolve a route to a concrete container id: the backend-provided origin id if
  // present, else the first container matching the container name or the service.
  private containerIdFor(t: TunnelView, host?: string): string {
    if (t.container_id) return t.container_id;
    for (const s of this.stacksFor(host)) {
      const byName = s.containers.find((c) => c.name === t.container);
      if (byName) return byName.id;
      if (t.project && s.project === t.project && t.svc_name) {
        const bySvc = s.containers.find((c) => (c.service || c.name) === t.svc_name);
        if (bySvc) return bySvc.id;
      }
    }
    return "";
  }

  // applyOrder optimistically sets a new route order and persists the affected
  // connector's ingress in one call. Shared by the up/down buttons and drag-drop.
  private applyOrder = async (connector: string, arr: TunnelView[]) => {
    const cid = this.connectors.find((c) => c.name === connector)?.id;
    if (!cid) return;
    this.routes = arr;
    this.suppressUntil = Date.now() + 6000; // don't let the auto-reload snap it back
    const order = arr.filter((t) => t.connector === connector).map((t) => ({ hostname: t.hostname, path: t.path || "" }));
    try {
      await this.rpc.callOn<OpResult>(this.hostOf(this.connByName(connector)), "Tunnels", "reorderRoutes", [cid, JSON.stringify(order)]);
    } catch (err: any) {
      this.error = err?.message ?? "reorder failed";
      this.suppressUntil = 0;
      await this.load(); // resync the true order
    }
  };

  private moveRoute = async (t: TunnelView, dir: "up" | "down") => {
    const arr = [...this.routes];
    const i = arr.indexOf(t);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= arr.length || arr[j].connector !== t.connector) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    await this.applyOrder(t.connector, arr);
  };

  // rid identifies a route row for drag-and-drop (hostname + path, url-encoded so
  // it survives a data attribute).
  private ridOf(t: TunnelView) { return encodeURIComponent(t.hostname) + "|" + encodeURIComponent(t.path || ""); }

  // Native HTML5 drag, wired via loom's @draggable/@dropzone with row delegation.
  @draggable({ selector: ".rrow" })
  private dragRoute(el: HTMLElement) { return el.dataset.rid || ""; }

  @dropzone({ selector: ".rrow", overClass: "drop-over" })
  private dropRoute(data: string, _ev: DragEvent, el: HTMLElement) {
    this.reorderByDrag(data, el.dataset.rid || "");
  }

  // reorderByDrag moves the dragged route to just before the drop target within
  // the SAME connector (Cloudflare matches ingress per-connector), then persists
  // the connector's new order in one call. Optimistic, like moveRoute.
  private reorderByDrag = async (fromRid: string, toRid: string) => {
    if (!fromRid || !toRid || fromRid === toRid) return;
    const arr = [...this.routes];
    const from = arr.find((t) => this.ridOf(t) === fromRid);
    const to = arr.find((t) => this.ridOf(t) === toRid);
    if (!from || !to || from.connector !== to.connector) return; // only within a connector
    arr.splice(arr.indexOf(from), 1);
    arr.splice(arr.indexOf(to), 0, from);
    await this.applyOrder(from.connector, arr);
  };

  private removeRoute = async (t: TunnelView) => {
    const ok = await this.confirm.ask({
      title: "remove route",
      danger: true,
      confirmLabel: "Remove",
      message: `Remove the route ${t.hostname}? Drops the tunnel ingress rule and deletes its DNS record.`,
    });
    if (!ok) return;
    await this.proc.run(`remove route ${t.hostname}`, async (emit) => {
      try {
        emit("dropping ingress rule + DNS…");
        await this.rpc.callOn<OpResult>(t.host || this.activeHostId(), "Tunnels", "removeTunnel", [t.hostname, t.path || ""]);
        emit("removed");
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    await this.load();
  };

  // Stacks scoped to a host (fleet mode aggregates every host's stacks, so the
  // add-route picker must filter to the connector's own host).
  private stacksFor(host?: string) {
    return host ? this.stacks.filter((s) => s.host === host) : this.stacks;
  }

  private stackOptions(host?: string): PromptOption[] {
    const scoped = this.stacksFor(host);
    const out: PromptOption[] = [];
    for (const s of scoped) {
      if (s.project === UNGROUPED) continue;
      out.push({ value: s.project, label: s.project });
    }
    if (scoped.some((s) => s.project === UNGROUPED)) out.push({ value: UNGROUPED, label: "(loose containers)" });
    return out;
  }

  // Services in the chosen stack, replicas collapsed to one entry with a count.
  // Loose containers are listed individually. Value encodes the target.
  private serviceOptions(stack: string, host?: string): PromptOption[] {
    if (!stack) return [];
    const s = this.stacksFor(host).find((x) => x.project === stack);
    if (!s) return [];
    if (stack === UNGROUPED) {
      return s.containers.map((c) => ({ value: ["ct", c.id].join("::"), label: c.name }));
    }
    const counts = new Map<string, number>();
    for (const c of s.containers) counts.set(c.service || c.name, (counts.get(c.service || c.name) || 0) + 1);
    return [...counts.entries()].map(([svc, n]) => ({ value: ["svc", stack, svc].join("::"), label: n > 1 ? `${svc}  ×${n}` : svc }));
  }

  // The first detected internal port for a target value, to auto-fill the port.
  private portForTarget(target: string, host?: string): string {
    if (!target) return "";
    const [kind, a, b] = target.split("::");
    const firstPort = (ports?: string[]) => (ports || []).map(innerPort).find(Boolean) || "";
    if (kind === "svc") {
      const s = this.stacksFor(host).find((x) => x.project === a);
      for (const c of s?.containers || []) if ((c.service || c.name) === b) { const p = firstPort(c.ports); if (p) return p; }
    } else if (kind === "ct") {
      for (const s of this.stacksFor(host)) { const c = s.containers.find((x) => x.id === a); if (c) return firstPort(c.ports); }
    }
    return "";
  }

  // Split a hostname into subdomain + a known zone (domain), for prefilling.
  private splitHost(host: string): { sub: string; domain: string } {
    return splitHost(host, this.zones.map((z) => z.name));
  }


  // A route belongs to a connector, so this is a per-connector action — the
  // connector (and thus its host) is implied, not a field. `init` prefills the
  // dialog (used by "duplicate").
  private addRoute = async (c: ConnectorView, init: Record<string, string> = {}) => {
    const haveZones = this.zones.length > 0;
    const chost = this.hostOf(c);
    const v = await this.prompt.ask({
      title: `${init.target ? "duplicate route" : "add route"} · ${c.title || c.name}`,
      icon: "link",
      message: "hope attaches the connector to the target's network, updates the tunnel ingress, and creates the DNS record.",
      submitLabel: "Add route",
      fields: [
        { key: "stack", label: "stack", type: "select", placeholder: "pick a stack", value: init.stack, options: this.stackOptions(chost) },
        { key: "target", label: "service", type: "select", placeholder: "pick a service", value: init.target, dependsOn: "stack", optionsFrom: (vals) => this.serviceOptions(vals.stack, chost) },
        { key: "port", label: "port", placeholder: "8080", value: init.port, dependsOn: "target", defaultFrom: (vals) => this.portForTarget(vals.target, chost) },
        ...(haveZones
          ? ([
              { key: "sub", label: "subdomain (blank = root domain)", optional: true, placeholder: "blog", value: init.sub },
              { key: "domain", label: "domain", type: "select", placeholder: "pick a domain", value: init.domain, options: this.zones.map((z) => ({ value: z.name, label: z.name })) },
            ] as const)
          : ([{ key: "host_name", label: "hostname", placeholder: "blog.example.com", value: init.host_name }] as const)),
        { key: "path", label: "path (optional)", optional: true, placeholder: "/api", value: init.path },
      ],
    });
    if (!v) return;
    if (!v.target) {
      this.error = "pick a service";
      return;
    }
    const [kind, a, b] = v.target.split("::");
    const project = kind === "svc" ? a : "";
    const service = kind === "svc" ? b : "";
    const container = kind === "ct" ? a : "";
    const host = (haveZones ? (v.sub.trim() ? `${v.sub.trim()}.${v.domain}` : v.domain) : v.host_name).trim().toLowerCase();
    if (!host) {
      this.error = "hostname required";
      return;
    }
    await this.proc.run(`add route ${host}`, async (emit) => {
      try {
        emit("attaching connector to the target's network…");
        emit("updating tunnel ingress + DNS…");
        const res = await this.rpc.callOn<OpResult>(this.hostOf(c), "Tunnels", "addTunnel", [host, v.port.trim(), c.id, project, service, container, (v.path || "").trim()]);
        if (res && res.ok === false) {
          emit("failed: " + (res.error || "error"));
          return false;
        }
        if ((res as any)?.reattached) emit("reattached replicas for load-balancing");
        emit(`route live -> ${(res as any)?.origin || service || container}`);
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    await this.load();
  };


  update() {
    const cons = this.connectors;
    const online = cons.filter((c) => c.online).length;
    const allColos = [...new Set(cons.flatMap((c) => c.colos || []))];
    const ver = cons.find((c) => c.version)?.version || "";
    const anyUpd = cons.some((c) => c.update_ready);
    const fleet = this.fleetMode;
    const openConn = this.routeConn ? decodeURIComponent(this.routeConn) : "";
    const health = cons.length ? (online === cons.length ? "ok" : "warn") : "";
    return (
      <div>
        <hope-phead heading="Tunnels" dot={health} scope={fleet ? "fleet" : this.hostCtx.token || "local"} meta="Cloudflare ingress · public hostnames → internal services">
          {!this.disabled && this.loaded ? <hope-button slot="actions" icon="plus" disabled={this.busy} onClick={this.deployConnector}>connector</hope-button> : null}
          <hope-button slot="actions" icon="rotate" spin={this.refreshing} disabled={this.busy} onClick={this.userRefresh}></hope-button>

          {!this.loaded ? (
            <div class="vstats">{[0, 1, 2, 3].map(() => <div class="skstat"><hope-skel w="64" h="9"></hope-skel><hope-skel w="52" h="16"></hope-skel></div>)}</div>
          ) : !this.disabled && cons.length > 0 ? (
            <div class="vstats">
              <hope-stat label="connectors" value={String(online)} sub={`/ ${cons.length} online`} tone={online === cons.length ? "ok" : "warn"}></hope-stat>
              <hope-stat label="public routes" value={String(this.routes.length)}></hope-stat>
              {allColos.length ? <hope-stat label="edge presence"><span class="colos">{allColos.slice(0, 6).map((co) => <span class="colo">{co}</span>)}</span></hope-stat> : null}
              {ver ? <hope-stat label="cloudflared"><span class="cfver">{ver}{anyUpd ? <span class="upd"> · update</span> : null}</span></hope-stat> : null}
            </div>
          ) : null}
        </hope-phead>

        {this.disabled ? (
          <div class="empty">
            Cloudflare tunnels are off. Set <b>[cloudflare]</b> in config (enabled + api_token + account_id),<br />
            then hope can deploy a connector for you or adopt one you run (labeled <b>ink.hope.tunnel=&lt;id&gt;</b>).
          </div>
        ) : null}

        {this.error ? <div class="empty">{this.error}</div> : null}

        {!this.disabled && this.routes.length > 3 ? (
          <div style="padding:12px 28px;border-bottom:1px solid var(--line)"><hope-search placeholder="Filter routes by hostname…" text={this.hostQuery} onSearch={(e: any) => (this.hostQuery = e.detail)}></hope-search></div>
        ) : null}

        {!this.loaded && !this.error ? this.renderSkeleton() : null}

        {cons.map((c) => this.renderConnector(c, openConn))}

        {!this.disabled && this.loaded && cons.length === 0 && !this.error ? (
          <div class="empty">No connectors yet. <b>Deploy connector</b> lets hope create a Cloudflare tunnel and run cloudflared for you.</div>
        ) : null}
      </div>
    );
  }

  // First-load skeleton: a connector section shaped like the real one so content
  // swaps in without a layout jump (no popin).
  private renderSkeleton() {
    return (
      <div class="tconn">
        <div class="cband" style="cursor:default">
          <span class="cdot" style="background:var(--line2)"></span>
          <hope-skel w="130" h="13"></hope-skel>
          <span class="grow"></span>
          <hope-skel w="180" h="11"></hope-skel>
        </div>
        <div class="rthead"><span>hostname</span><span></span><span>service</span><span>path</span><span class="r"></span></div>
        {[0, 1, 2, 3].map(() => (
          <div class="rrow" style="cursor:default">
            <div class="rhost"><hope-skel w="150" h="12"></hope-skel></div>
            <div class="rflow"></div>
            <div class="rsvc2"><hope-skel w="120" h="12"></hope-skel></div>
            <div class="rpath"><hope-skel w="44" h="12"></hope-skel></div>
            <div class="racts"></div>
          </div>
        ))}
      </div>
    );
  }

  // One connector section: a band header + a full-bleed table of the routes it
  // serves (public hostname -> internal service), matching the other pages. The
  // band opens the docked connector inspector (detail + update/rename/remove).
  private renderConnector(c: ConnectorView, openConn = "") {
    const on = openConn === c.id;
    const all = this.routes.filter((t) => t.connector === c.name);
    const q = this.hostQuery.trim().toLowerCase();
    const shown = q ? all.filter((t) => t.hostname.toLowerCase().includes(q) || (t.svc_name || "").toLowerCase().includes(q) || (t.project || "").toLowerCase().includes(q)) : all;
    const edge = (c.colos || []).slice(0, 2).join("·");
    return (
      <div class={"tconn" + (on ? " on" : "")}>
        <div class="cband" onClick={() => this.connInsp.select(this.hostOf(c), c.id, () => this.load())}>
          <span class={"cdot" + (c.online ? "" : c.running ? " warn" : " off")}></span>
          <span class="cname">{c.title || c.name}</span>
          {c.default ? <hope-chip tone="upd" size="sm">shared</hope-chip> : null}
          {this.hosts.length > 1 ? <hope-chip size="sm">{this.hostOf(c)}</hope-chip> : null}
          {c.update_ready ? <hope-chip tone="warn" size="sm">update</hope-chip> : null}
          <span class="grow"></span>
          <div class="cmeta">
            <span class="cm"><span class="lbl">conns</span><b>{c.connections}</b></span>
            <span class="cm"><span class="lbl">routes</span><b>{all.length}</b></span>
            {edge ? <span class="cm"><span class="lbl">edge</span><b>{edge}</b></span> : null}
            {c.version ? <span class="cver">cloudflared {c.version}</span> : null}
          </div>
          <loom-icon class="cgo" name="chevron-right" size={15}></loom-icon>
        </div>
        {all.length === 0 ? (
          <div class="noroutes2">No routes yet — <b>add route</b> to publish a service through this connector.</div>
        ) : shown.length === 0 ? (
          <div class="noroutes2">No routes match "{this.hostQuery}".</div>
        ) : (
          <>
            <div class="rthead"><span>hostname</span><span></span><span>service</span><span>path</span><span class="r"></span></div>
            {(() => {
              // Cluster routes under their domain (one header per domain) — same
              // ingress isn't contiguous, and cross-domain order doesn't matter to
              // Cloudflare. Drag/move reorder within a connector persists per-domain.
              const groups = new Map<string, TunnelView[]>();
              const order: string[] = [];
              for (const t of shown) {
                const { domain } = this.splitHost(t.hostname);
                const dkey = domain || t.hostname;
                if (!groups.has(dkey)) { groups.set(dkey, []); order.push(dkey); }
                groups.get(dkey)!.push(t);
              }
              const rows: any[] = [];
              for (const dkey of order) {
                rows.push(<div class="rdgroup"><a href={`https://${dkey}`} target="_blank" rel="noreferrer">{dkey}</a></div>);
                for (const t of groups.get(dkey)!) {
                  const { sub, domain } = this.splitHost(t.hostname);
                  const idx = all.indexOf(t);
                  rows.push(
                    <div class="rrow" data-rid={this.ridOf(t)} data-cid={t.connector}>
                      <div class="rhost">
                        <loom-icon class="lock" name="lock" size={12}></loom-icon>
                        <span class="h"><a href={`https://${t.hostname}`} target="_blank" rel="noreferrer">{domain && sub ? <b>{sub}</b> : domain ? <span class="rootlbl">root</span> : <b>{t.hostname}</b>}</a></span>
                      </div>
                      <div class="rflow"><loom-icon name="arrow-right" size={14}></loom-icon></div>
                      <div class="rsvc2">{t.project ? <span><span class="proj">{t.project} / </span><span class="svc" title="open container" onClick={() => this.openTarget(t)}>{t.svc_name}</span></span> : <span class="svc" title="open container" onClick={() => this.openTarget(t)}>{t.container || t.service}</span>}{t.port ? <span class="port">:{t.port}</span> : null}</div>
                      <div class={"rpath" + (t.path ? "" : " none")}>{t.path || "—"}</div>
                      <div class="racts">
                        {all.length > 1 ? (
                          <>
                            <button class="rmx2" title="move up" disabled={idx === 0} onClick={() => this.moveRoute(t, "up")}><loom-icon class="up" name="chevron-down" size={12}></loom-icon></button>
                            <button class="rmx2" title="move down" disabled={idx === all.length - 1} onClick={() => this.moveRoute(t, "down")}><loom-icon name="chevron-down" size={12}></loom-icon></button>
                          </>
                        ) : null}
                        <button class="rmx2 del" title="remove route" onClick={() => this.removeRoute(t)}><loom-icon name="x" size={13}></loom-icon></button>
                      </div>
                    </div>,
                  );
                }
              }
              return rows;
            })()}
            <div class="taddr" onClick={() => this.addRoute(c)}><loom-icon name="plus" size={12}></loom-icon> add route</div>
          </>
        )}
      </div>
    );
  }
}
