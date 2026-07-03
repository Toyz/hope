// Tunnels page: hope-managed Cloudflare connectors + the public routes they
// serve (hostname -> stack/service). Deploy a connector, add/remove routes.
// Host-aware: in "all hosts" mode the deploy/add dialogs ask which host to target;
// otherwise they use the actively-selected host.
import { LoomElement, component, styles, css, reactive, mount, unmount, watch, interval, on, app } from "@toyz/loom";
import { draggable, dropzone } from "@toyz/loom/element";
import { signalModal } from "../modal";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { HostChanged } from "../events";
import { UNGROUPED } from "../const";
import { innerPort } from "../format";
import { appBar } from "../app-bar";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import { ToastService } from "../toast";
import { PromptService, type PromptField } from "../prompt";
import type { ConnectorView, TunnelView, StackSummary, OpResult, HostView, ZoneView, OpFrame } from "../contracts";
import type { PromptOption } from "../prompt";
import { resourceStyles } from "./resource-styles";

const short = (id: string) => (id && id.length > 12 ? id.slice(0, 12) : id || "—");

@route("/tunnels")
@component("hope-tunnels")
@styles(css`
  ${resourceStyles}

  /* a connector and the routes it owns are one bordered unit */
  .cblock { border: 1px solid var(--line); margin-bottom: 22px; }
  .chead { display: flex; align-items: center; gap: 12px; padding: 13px 16px; }
  .chead .cdot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); flex: none; }
  .chead .cdot.off { background: var(--bad); }
  .chead .cdot.warn { background: var(--warn); }
  .cwho { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .cl1 { display: flex; align-items: center; gap: 9px; }
  .cl1 .cname { font: 700 14px/1 var(--mono); color: var(--hi); }
  .cl1 .cdef { font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line)); padding: 3px 6px; border-radius: 4px; }
  .cl2 { font: 11.5px/1 var(--mono); color: var(--dim); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .cl2 .sep { color: var(--faint); }
  .cl2 .ok { color: var(--ok); }
  .cl2 .warn { color: var(--warn); }
  .cl2 .bad { color: var(--bad); }
  .cgrow { flex: 1; }
  .caddr { background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer;
    font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 6px 10px; }
  .caddr:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .caddr.upd { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line)); }
  .caddr.upd:hover { color: #06080d; background: var(--upd); border-color: var(--upd); }
  .cx { background: transparent; border: 0; color: var(--dim); cursor: pointer; padding: 4px; display: flex; }
  .cx:hover { color: var(--bad); }
  .seclbl { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); margin: 0 0 12px; }
  td.host a { color: var(--hi); text-decoration: none; }
  td.host a:hover { text-decoration: underline; }
  td.host .sub { color: var(--hi); font-weight: 600; }
  td.host .rootlbl { color: var(--dim); font-style: italic; }
  /* domain sub-header groups routes; subdomain rows sit indented under it */
  tr.dgroup td { padding: 9px 14px; border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 45%, var(--panel)); }
  tr.dgroup a { color: var(--mid); text-decoration: none; font: 600 11px/1 var(--mono); letter-spacing: .06em; }
  tr.dgroup a:hover { color: var(--hi); }
  tr.dgroup + tr td, tr.dgroup ~ tr td.host { }
  td.host { padding-left: 30px; }
  td.host .svc { color: var(--dim); }
  tr.route { cursor: grab; }
  tr.route:active { cursor: grabbing; }
  tr.route.drop-over td { box-shadow: inset 0 2px 0 var(--upd); }
  td.origin .svc { color: var(--dim); }
  td.origin .tlink { display: inline-flex; align-items: center; gap: 3px; color: var(--hi); cursor: pointer; }
  td.origin .tlink loom-icon { color: var(--dim); }
  td.origin .tlink:hover { text-decoration: underline; }
  td.origin .tlink:hover loom-icon { color: var(--hi); }
  .cblock .rtbl { border: 0; border-top: 1px solid var(--line2); }
  .cblock .rtbl thead th { background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  colgroup col.c-port { width: 90px; }
  colgroup col.c-act { width: 132px; }
  .noroutes { padding: 13px 16px; border-top: 1px solid var(--line2); color: var(--dim); font: 12.5px/1.6 var(--mono); }
  td.rx { text-align: right; white-space: nowrap; }
  .ord { display: inline-flex; margin-right: 6px; vertical-align: middle; }
  .ord loom-icon.up { transform: rotate(180deg); }
  .rmx { background: transparent; border: 1px solid transparent; color: var(--dim); cursor: pointer; padding: 5px 6px; display: inline-flex; }
  .rmx:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ord .rmx:hover { color: var(--upd); }
  .rmx.del:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); }
  .rmx:disabled { opacity: .3; cursor: not-allowed; }
  .rmx:disabled:hover { color: var(--dim); border-color: transparent; background: transparent; }
  .disabled { padding: 40px; text-align: center; color: var(--dim); font: 13px/1.7 var(--mono); }
  /* first-load skeleton so slow Cloudflare calls don't blank-then-snap */
  .skb { display: inline-block; height: 12px; min-width: 36px; background: var(--line); animation: skpulse 1.2s ease-in-out infinite; }
  .skb.sv { height: 15px; width: 30px; }
  .skb.w160 { width: 160px; height: 14px; }
  .skb.w200 { width: 200px; }
  .skb.w240 { width: 240px; }
  @keyframes skpulse { 0%, 100% { opacity: .3; } 50% { opacity: .65; } }
  .chost { font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim);
    border: 1px solid var(--line); border-radius: 5px; padding: 4px 7px; }
  /* make the identity block open a detail breakdown (mirrors the images page) */
  .cwho { cursor: pointer; }
  .cl2 .nets { color: var(--mid); border-bottom: 1px dotted var(--faint); }
  .cwho:hover .cl2 .nets { color: var(--hi); border-bottom-color: var(--line2); }

  /* connector detail modal — same model as the images detail sheet */
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .dmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  .dbox { width: 600px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); }
  .dhead { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line); }
  .dhead .dt { font: 700 14px/1.2 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dhead .dgrow { flex: 1; }
  .dx { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .dx:hover { color: var(--hi); }
  .dfacts { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .dfacts .st { display: flex; flex-direction: column; gap: 5px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .dfacts .sk { font: 600 9px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .dfacts .sv { font: 600 14px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  .dfacts .sv.ok { color: var(--ok); } .dfacts .sv.warn { color: var(--warn); } .dfacts .sv.bad { color: var(--bad); }
  .dbody { padding: 6px 18px 14px; }
  .drow { display: flex; gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .drow:last-child { border-bottom: 0; }
  .drow.top { align-items: flex-start; }
  .dk { flex: 0 0 84px; font: 600 10px/1.8 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .dv { flex: 1; min-width: 0; font: 12.5px/1.6 var(--mono); color: var(--hi); display: flex; flex-wrap: wrap; align-items: center; gap: 0; }
  .dv .dim { color: var(--dim); }
  .netchip { font: 12px/1 var(--mono); color: var(--hi); border: 1px solid var(--line); padding: 5px 8px; margin: 0 6px 6px 0; }
`)
export class TunnelsPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(PromptService) accessor prompt!: PromptService;
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
  @reactive accessor detail: ConnectorView | null = null;

  @watch("detail") private lockBody() { signalModal(this, !!this.detail); }
  @unmount private releaseBody() { signalModal(this, false); }
  private suppressUntil = 0; // pause the auto-reload right after a local change

  get fleetMode() {
    return this.hostCtx.fleet;
  }

  // Host/fleet switched elsewhere — re-fetch in place (no reload).
  @on(HostChanged)
  onHostChanged() {
    if (this.auth.isAuthenticated) this.load();
  }

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
        await this.rpc.call<ConnectorView>("Tunnels", "createConnector", [v.name.trim()]);
        emit("connector deployed");
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    await this.load();
  };

  // Rename the connector's Cloudflare tunnel. Pure API change — routes and the
  // connector's networks are untouched (the title reads the live tunnel name).
  private renameConnector = async (c: ConnectorView) => {
    const v = await this.prompt.ask({
      title: "rename tunnel",
      icon: "link",
      submitLabel: "Rename",
      fields: [{ key: "name", label: "new name", placeholder: c.title || c.name, value: c.title || c.name }],
    });
    if (!v) return;
    const name = v.name.trim();
    if (!name || name === (c.title || c.name)) return;
    await this.proc.run(`rename ${c.title || c.name}`, async (emit) => {
      try {
        emit("renaming Cloudflare tunnel…");
        const res = await this.rpc.callOn<OpResult>(this.hostOf(c), "Tunnels", "renameConnector", [c.id, name]);
        if (res && res.ok === false) { emit("failed: " + (res.error || "error")); return false; }
        emit("renamed -> " + name);
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message || "error"));
        return false;
      }
    });
    this.load();
  };

  private removeConnector = async (c: ConnectorView) => {
    const del = await this.confirm.ask({
      title: "remove connector",
      danger: true,
      confirmLabel: "Remove + delete tunnel",
      message: `Remove connector "${c.title || c.name}"? This stops and deletes the cloudflared container AND deletes its Cloudflare tunnel (${short(c.tunnel_id)}). Its routes stop working.`,
    });
    if (!del) return;
    await this.proc.run(`remove connector ${c.title || c.name}`, async (emit) => {
      try {
        emit("stopping + removing cloudflared…");
        emit("deleting Cloudflare tunnel…");
        await this.rpc.callOn<OpResult>(this.hostOf(c), "Tunnels", "removeConnector", [c.id, true]);
        emit("removed");
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    await this.load();
  };

  // Jump to the stack (or container) a route targets.
  private openTarget = (t: TunnelView) => {
    if (t.project) {
      this.router.navigate(`/stack/${encodeURIComponent(t.project)}`);
      return;
    }
    if (t.container) {
      for (const s of this.stacks) {
        const c = s.containers.find((x) => x.name === t.container);
        if (c) {
          this.router.navigate(`/container/${encodeURIComponent(c.id)}`);
          return;
        }
      }
    }
  };

  private duplicateRoute = (t: TunnelView) => {
    const c = this.connectors.find((x) => x.name === t.connector);
    if (c) this.addRoute(c, this.routeInit(t, this.hostOf(c)));
  };

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
  @draggable({ selector: "tr.route" })
  private dragRoute(el: HTMLElement) { return el.dataset.rid || ""; }

  @dropzone({ selector: "tr.route", overClass: "drop-over" })
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

  private updateConnector = async (c: ConnectorView) => {
    await this.proc.run(`update ${c.title || c.name}`, async (emit, signal) => {
      let ok = true;
      try {
        emit("pulling latest cloudflared…");
        for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "redeploy", [c.id, "true", "true"], signal, this.hostOf(c))) {
          if (f.type === "log" && f.data) emit(f.data);
          else if (f.type === "done" && !f.ok) {
            ok = false;
            emit("failed: " + (f.error ?? ""));
          }
        }
        emit(ok ? "connector updated" : "done");
      } catch (e: any) {
        ok = false;
        emit("connection lost — connector is restarting…");
      }
      return ok;
    });
    await this.load();
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
    for (const z of this.zones) {
      if (host === z.name) return { sub: "", domain: z.name };
      if (host.endsWith("." + z.name)) return { sub: host.slice(0, -(z.name.length + 1)), domain: z.name };
    }
    return { sub: "", domain: "" };
  }

  // Resolve a route's origin back to a stack+service (or loose container) so
  // "duplicate" can prefill the target, even when the backend couldn't map it.
  private resolveTarget(t: TunnelView, host?: string): { stack: string; target: string } {
    if (t.project && t.svc_name) return { stack: t.project, target: ["svc", t.project, t.svc_name].join("::") };
    const origin = t.service.replace(/^https?:\/\//, "").split(":")[0].split("/")[0];
    const scoped = this.stacksFor(host);
    // Direct container-name match.
    for (const s of scoped) {
      const ct = s.containers.find((c) => c.name === origin);
      if (ct) {
        if (s.project === UNGROUPED) return { stack: UNGROUPED, target: ["ct", ct.id].join("::") };
        return { stack: s.project, target: ["svc", s.project, ct.service || ct.name].join("::") };
      }
    }
    // Replica alias match: hope-<project>-<service>.
    for (const s of scoped) {
      if (s.project === UNGROUPED) continue;
      for (const svc of new Set(s.containers.map((c) => c.service || c.name))) {
        if (`hope-${s.project}-${svc}` === origin) return { stack: s.project, target: ["svc", s.project, svc].join("::") };
      }
    }
    return { stack: "", target: "" };
  }

  // Build add-route initial values from an existing route (for "duplicate").
  private routeInit(t: TunnelView, host?: string): Record<string, string> {
    const { stack, target } = this.resolveTarget(t, host);
    const { sub, domain } = this.splitHost(t.hostname);
    return { stack, target, port: t.port || "", sub, domain, host_name: domain ? "" : t.hostname, path: t.path || "" };
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
    const online = this.connectors.filter((c) => c.online).length;
    return (
      <div>
        {this.detail ? this.renderConnDetail(this.detail) : null}
        {appBar("tunnels", [
          !this.disabled && this.loaded ? (
            <div class="s act"><button style="display:inline-flex;align-items:center;gap:6px" disabled={this.busy} onClick={this.deployConnector}><loom-icon name="plus" size={12}></loom-icon> connector</button></div>
          ) : null,
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>,
        ])}

        <main>
          {this.disabled ? (
            <div class="disabled">
              Cloudflare tunnels are off.<br />
              Set <b>[cloudflare]</b> in config (enabled + api_token + account_id), then hope can<br />
              deploy a connector for you or adopt one you run (labeled <b>ink.hope.tunnel=&lt;id&gt;</b>).
            </div>
          ) : null}

          {this.error ? <div class="empty">{this.error}</div> : null}

          {!this.disabled && !this.error && !this.loaded ? (
            <div class="skel">
              <div class="summary">
                <span class="stat"><i class="k">connectors</i><i class="skb sv"></i></span>
                <span class="stat"><i class="k">online</i><i class="skb sv"></i></span>
                <span class="stat"><i class="k">routes</i><i class="skb sv"></i></span>
              </div>
              <div class="cblock">
                <div class="chead">
                  <span class="cdot"></span>
                  <div class="cwho"><div class="cl1"><span class="skb w160"></span></div><div class="cl2"><span class="skb w240"></span></div></div>
                </div>
                <div class="noroutes"><span class="skb w200"></span></div>
              </div>
            </div>
          ) : null}

          {!this.disabled && this.loaded ? (
            <div class="summary">
              <span class="stat"><i class="k">connectors</i><i class="v">{this.connectors.length}</i></span>
              <span class="stat"><i class="k">online</i><i class={"v" + (this.connectors.length && online < this.connectors.length ? " warnv" : "")}>{online}</i></span>
              <span class="stat"><i class="k">routes</i><i class="v">{this.routes.length}</i></span>
            </div>
          ) : null}

          {!this.disabled && this.routes.length > 3 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Filter routes by hostname…" value={this.hostQuery} onInput={(e: any) => (this.hostQuery = e.target.value)} />
            </div>
          ) : null}

          {this.connectors.map((c) => this.renderConnector(c))}

          {!this.disabled && this.loaded && this.connectors.length === 0 && !this.error ? (
            <div class="empty">No connectors yet. <b>Deploy connector</b> lets hope create a Cloudflare tunnel and run cloudflared for you.</div>
          ) : null}
        </main>
      </div>
    );
  }

  // Emphasize the subdomain, dim the shared domain, so same-domain routes cluster
  // visually (www.helba.ai vs helba.ai).
  private renderHost(host: string) {
    const { sub, domain } = this.splitHost(host);
    if (domain && sub) return <span><b class="sub">{sub}</b><span class="dom">.{domain}</span></span>;
    if (domain) return <span><span class="rootat">@</span> <span class="dom">{domain}</span></span>;
    return <span>{host}</span>;
  }

  // Connector detail sheet — the extra info that used to crowd the header
  // (networks, edge locations, cloudflared version, full tunnel id), broken
  // down the same way the images page details a single image.
  private renderConnDetail(c: ConnectorView) {
    const routes = this.routes.filter((t) => t.connector === c.name).length;
    const state = c.online ? "ok" : c.running ? "warn" : "bad";
    return (
      <div class="dmodal" onClick={() => (this.detail = null)}>
        <div class="dbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt" title={c.title || c.name}>{c.title || c.name}</span>
            {c.default ? <span class="cdef">shared</span> : null}
            <span class="dgrow"></span>
            <button class="dx" onClick={() => (this.detail = null)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="dfacts">
            <span class="st"><i class="sk">status</i><i class={"sv " + state}>{c.status || (c.running ? "connecting" : "stopped")}</i></span>
            <span class="st"><i class="sk">conns</i><i class="sv">{c.connections}</i></span>
            <span class="st"><i class="sk">routes</i><i class="sv">{routes}</i></span>
            <span class="st"><i class="sk">networks</i><i class="sv">{c.networks?.length || 0}</i></span>
            {this.hosts.length > 1 ? <span class="st"><i class="sk">host</i><i class="sv">{this.hostOf(c)}</i></span> : null}
          </div>
          <div class="dbody">
            <div class="drow"><span class="dk">tunnel id</span><span class="dv">{c.tunnel_id || <span class="dim">—</span>}</span></div>
            <div class="drow"><span class="dk">edge</span><span class="dv">{c.colos && c.colos.length ? c.colos.join("  ") : <span class="dim">not connected</span>}</span></div>
            <div class="drow"><span class="dk">cloudflared</span>
              <span class="dv">{c.version || <span class="dim">unknown</span>}{c.update_ready ? <span class="dim">  · update available</span> : null}</span>
            </div>
            <div class="drow top"><span class="dk">networks</span>
              <span class="dv">
                {c.networks && c.networks.length ? c.networks.map((n) => <span class="netchip">{n}</span>) : <span class="dim">none attached yet — added when you publish a route</span>}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // One connector block: its card, then the routes it serves (ingress order).
  private renderConnector(c: ConnectorView) {
    const all = this.routes.filter((t) => t.connector === c.name);
    const q = this.hostQuery.trim().toLowerCase();
    const shown = q ? all.filter((t) => t.hostname.toLowerCase().includes(q) || (t.svc_name || "").toLowerCase().includes(q) || (t.project || "").toLowerCase().includes(q)) : all;
    return (
      <div class="cblock">
        <div class="chead">
          <span class={"cdot" + (c.online ? "" : c.running ? " warn" : " off")}></span>
          <div class="cwho" title="open connector details" onClick={() => (this.detail = c)}>
            <div class="cl1">
              <span class="cname">{c.title || c.name}</span>
              {c.default ? <span class="cdef">shared</span> : null}
              {this.hosts.length > 1 ? <span class="chost" title="host this connector runs on">{this.hostOf(c)}</span> : null}
            </div>
            <div class="cl2">
              <span class={c.online ? "ok" : c.running ? "warn" : "bad"}>{c.status || (c.running ? "connecting" : "stopped")}</span>
              <span class="sep">·</span>{c.connections} conns
              {c.colos && c.colos.length ? <span><span class="sep">·</span>edge {c.colos.join(" ")}</span> : null}
              <span class="sep">·</span>tunnel {short(c.tunnel_id)}
              <span class="sep">·</span>
              {c.networks && c.networks.length ? <span class="nets">{c.networks.length} network{c.networks.length === 1 ? "" : "s"}</span> : <span>no networks yet</span>}
            </div>
          </div>
          <span class="cgrow"></span>
          {c.update_ready ? <button class="caddr upd" title="a newer cloudflared is available — pull + recreate" onClick={() => this.updateConnector(c)}>update</button> : null}
          <button class="caddr" title="rename this tunnel" onClick={() => this.renameConnector(c)}>rename</button>
          <button class="caddr" onClick={() => this.addRoute(c)}>+ route</button>
          <button class="cx" title="remove connector" onClick={() => this.removeConnector(c)}><loom-icon name="x" size={15}></loom-icon></button>
        </div>
        {all.length === 0 ? (
          <div class="noroutes">No routes yet — <b>+ route</b> to publish a service through this connector.</div>
        ) : shown.length === 0 ? (
          <div class="noroutes">No routes match "{this.hostQuery}".</div>
        ) : (
          <table class="rtbl">
            <colgroup>
              <col class="c-name" />
              <col class="c-meta" />
              <col class="c-port" />
              <col class="c-act" />
            </colgroup>
            <thead>
              <tr><th>Hostname</th><th>Target</th><th>Port</th><th></th></tr>
            </thead>
            <tbody>
              {(() => {
                const rows: any[] = [];
                // Group routes by domain (each domain header once) — routes for the
                // same domain aren't necessarily contiguous in ingress order, and
                // cross-hostname order doesn't affect Cloudflare matching.
                const groups = new Map<string, TunnelView[]>();
                const order: string[] = [];
                for (const t of shown) {
                  const { domain } = this.splitHost(t.hostname);
                  const dkey = domain || t.hostname;
                  if (!groups.has(dkey)) { groups.set(dkey, []); order.push(dkey); }
                  groups.get(dkey)!.push(t);
                }
                for (const dkey of order) {
                  rows.push(
                    <tr class="dgroup"><td colSpan={4}><a href={`https://${dkey}`} target="_blank" rel="noreferrer">{dkey}</a></td></tr>,
                  );
                  for (const t of groups.get(dkey)!) {
                    const { sub, domain } = this.splitHost(t.hostname);
                    const idx = all.indexOf(t);
                    rows.push(
                      <tr class="route" data-rid={this.ridOf(t)} data-cid={t.connector}>
                      <td class="host">
                        <a href={`https://${t.hostname}`} target="_blank" rel="noreferrer">{domain && sub ? <span class="sub">{sub}</span> : <span class="rootlbl">root</span>}</a>
                        {t.path ? <span class="svc"> {t.path}</span> : null}
                      </td>
                      <td class="origin">{t.project ? <span class="tlink" onClick={() => this.openTarget(t)}>{t.project} / {t.svc_name}<loom-icon name="chevron-right" size={11}></loom-icon></span> : t.container ? <span class="tlink" onClick={() => this.openTarget(t)}>{t.container}<loom-icon name="chevron-right" size={11}></loom-icon></span> : <span class="svc">{t.service}</span>}</td>
                      <td class="rmeta">{t.port || "—"}</td>
                      <td class="rx">
                        {all.length > 1 ? (
                          <span class="ord">
                            <button class="rmx" title="move up" disabled={idx === 0} onClick={() => this.moveRoute(t, "up")}><loom-icon class="up" name="chevron-down" size={13}></loom-icon></button>
                            <button class="rmx" title="move down" disabled={idx === all.length - 1} onClick={() => this.moveRoute(t, "down")}><loom-icon name="chevron-down" size={13}></loom-icon></button>
                          </span>
                        ) : null}
                        <button class="rmx" title="duplicate route" onClick={() => this.duplicateRoute(t)}><loom-icon name="copy" size={13}></loom-icon></button>
                        <button class="rmx del" title="remove route" onClick={() => this.removeRoute(t)}><loom-icon name="x" size={14}></loom-icon></button>
                      </td>
                    </tr>,
                    );
                  }
                }
                return rows;
              })()}
            </tbody>
          </table>
        )}
      </div>
    );
  }
}
