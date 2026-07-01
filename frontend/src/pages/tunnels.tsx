// Tunnels page: hope-managed Cloudflare connectors + the public routes they
// serve (hostname -> stack/service). Deploy a connector, add/remove routes.
// Host-aware: in "all hosts" mode the deploy/add dialogs ask which host to target;
// otherwise they use the actively-selected host.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import { ToastService } from "../toast";
import { PromptService, type PromptField } from "../prompt";
import type { ConnectorView, TunnelView, StackSummary, OpResult, HostView, ZoneView, OpFrame } from "../contracts";
import type { PromptOption } from "../prompt";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

const short = (id: string) => (id && id.length > 12 ? id.slice(0, 12) : id || "—");
const UNGROUPED = "(ungrouped)";

// Internal (container-side) port from a docker port string
// ("127.0.0.1:8080->8080/tcp" -> "8080", "9000/tcp" -> "9000").
const innerPort = (p: string): string => {
  const arrow = p.indexOf("->");
  return (arrow >= 0 ? p.slice(arrow + 2) : p).split("/")[0].trim();
};

@route("/tunnels")
@component("hope-tunnels")
@styles(css`
  ${theme}
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
  .chost { font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim);
    border: 1px solid var(--line); border-radius: 5px; padding: 4px 7px; }
`)
export class TunnelsPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(PromptService) accessor prompt!: PromptService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor connectors: ConnectorView[] = [];
  @reactive accessor routes: TunnelView[] = [];
  @reactive accessor stacks: StackSummary[] = [];
  @reactive accessor hosts: HostView[] = [];
  @reactive accessor zones: ZoneView[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor disabled = false;
  @reactive accessor busy = false;
  @reactive accessor hostQuery = "";
  private suppressUntil = 0; // pause the auto-reload right after a local change

  get fleetMode() {
    return localStorage.getItem("hope.fleet") === "1";
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
      const [cons, routes, stacks, hosts, zones] = await Promise.all([
        this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
        this.rpc.call<TunnelView[]>("Tunnels", "tunnels", []),
        this.rpc.call<StackSummary[]>("Stacks", "list", []).catch(() => []),
        this.rpc.call<HostView[]>("System", "hosts", []).catch(() => []),
        this.rpc.call<ZoneView[]>("Tunnels", "zones", []).catch(() => []),
      ]);
      this.connectors = cons || [];
      this.routes = routes || [];
      this.stacks = stacks || [];
      this.hosts = hosts || [];
      this.zones = zones || [];
      this.error = "";
      this.disabled = false;
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
        await this.rpc.call<OpResult>("Tunnels", "removeConnector", [c.id, true]);
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
    if (c) this.addRoute(c, this.routeInit(t));
  };

  private moveRoute = async (t: TunnelView, dir: "up" | "down") => {
    const cid = this.connectors.find((c) => c.name === t.connector)?.id;
    if (!cid) return;
    // Optimistic swap so the UI moves instantly; reconcile on failure.
    const arr = [...this.routes];
    const i = arr.indexOf(t);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= arr.length || arr[j].connector !== t.connector) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.routes = arr;
    this.suppressUntil = Date.now() + 6000; // don't let the auto-reload snap it back
    try {
      await this.rpc.call<OpResult>("Tunnels", "moveRoute", [cid, t.hostname, t.path || "", dir]);
    } catch (err: any) {
      this.error = err?.message ?? "reorder failed";
      this.suppressUntil = 0;
      await this.load(); // resync the true order
    }
  };

  private updateConnector = async (c: ConnectorView) => {
    await this.proc.run(`update ${c.title || c.name}`, async (emit, signal) => {
      let ok = true;
      try {
        emit("pulling latest cloudflared…");
        for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "redeploy", [c.id, "true", "true"], signal)) {
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
        await this.rpc.call<OpResult>("Tunnels", "removeTunnel", [t.hostname, t.path || ""]);
        emit("removed");
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    await this.load();
  };

  private stackOptions(): PromptOption[] {
    const out: PromptOption[] = [];
    for (const s of this.stacks) {
      if (s.project === UNGROUPED) continue;
      out.push({ value: s.project, label: s.project });
    }
    if (this.stacks.some((s) => s.project === UNGROUPED)) out.push({ value: UNGROUPED, label: "(loose containers)" });
    return out;
  }

  // Services in the chosen stack, replicas collapsed to one entry with a count.
  // Loose containers are listed individually. Value encodes the target.
  private serviceOptions(stack: string): PromptOption[] {
    if (!stack) return [];
    const s = this.stacks.find((x) => x.project === stack);
    if (!s) return [];
    if (stack === UNGROUPED) {
      return s.containers.map((c) => ({ value: ["ct", c.id].join("::"), label: c.name }));
    }
    const counts = new Map<string, number>();
    for (const c of s.containers) counts.set(c.service || c.name, (counts.get(c.service || c.name) || 0) + 1);
    return [...counts.entries()].map(([svc, n]) => ({ value: ["svc", stack, svc].join("::"), label: n > 1 ? `${svc}  ×${n}` : svc }));
  }

  // The first detected internal port for a target value, to auto-fill the port.
  private portForTarget(target: string): string {
    if (!target) return "";
    const [kind, a, b] = target.split("::");
    const firstPort = (ports?: string[]) => (ports || []).map(innerPort).find(Boolean) || "";
    if (kind === "svc") {
      const s = this.stacks.find((x) => x.project === a);
      for (const c of s?.containers || []) if ((c.service || c.name) === b) { const p = firstPort(c.ports); if (p) return p; }
    } else if (kind === "ct") {
      for (const s of this.stacks) { const c = s.containers.find((x) => x.id === a); if (c) return firstPort(c.ports); }
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
  private resolveTarget(t: TunnelView): { stack: string; target: string } {
    if (t.project && t.svc_name) return { stack: t.project, target: ["svc", t.project, t.svc_name].join("::") };
    const origin = t.service.replace(/^https?:\/\//, "").split(":")[0].split("/")[0];
    // Direct container-name match.
    for (const s of this.stacks) {
      const ct = s.containers.find((c) => c.name === origin);
      if (ct) {
        if (s.project === UNGROUPED) return { stack: UNGROUPED, target: ["ct", ct.id].join("::") };
        return { stack: s.project, target: ["svc", s.project, ct.service || ct.name].join("::") };
      }
    }
    // Replica alias match: hope-<project>-<service>.
    for (const s of this.stacks) {
      if (s.project === UNGROUPED) continue;
      for (const svc of new Set(s.containers.map((c) => c.service || c.name))) {
        if (`hope-${s.project}-${svc}` === origin) return { stack: s.project, target: ["svc", s.project, svc].join("::") };
      }
    }
    return { stack: "", target: "" };
  }

  // Build add-route initial values from an existing route (for "duplicate").
  private routeInit(t: TunnelView): Record<string, string> {
    const { stack, target } = this.resolveTarget(t);
    const { sub, domain } = this.splitHost(t.hostname);
    return { stack, target, port: t.port || "", sub, domain, host_name: domain ? "" : t.hostname, path: t.path || "" };
  }

  // A route belongs to a connector, so this is a per-connector action — the
  // connector (and thus its host) is implied, not a field. `init` prefills the
  // dialog (used by "duplicate").
  private addRoute = async (c: ConnectorView, init: Record<string, string> = {}) => {
    const haveZones = this.zones.length > 0;
    const v = await this.prompt.ask({
      title: `${init.target ? "duplicate route" : "add route"} · ${c.title || c.name}`,
      icon: "link",
      message: "hope attaches the connector to the target's network, updates the tunnel ingress, and creates the DNS record.",
      submitLabel: "Add route",
      fields: [
        { key: "stack", label: "stack", type: "select", placeholder: "pick a stack", value: init.stack, options: this.stackOptions() },
        { key: "target", label: "service", type: "select", placeholder: "pick a service", value: init.target, dependsOn: "stack", optionsFrom: (vals) => this.serviceOptions(vals.stack) },
        { key: "port", label: "port", placeholder: "8080", value: init.port, dependsOn: "target", defaultFrom: (vals) => this.portForTarget(vals.target) },
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
        const res = await this.rpc.call<OpResult>("Tunnels", "addTunnel", [host, v.port.trim(), c.id, project, service, container, (v.path || "").trim()]);
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

  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  update() {
    const online = this.connectors.filter((c) => c.online).length;
    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> {this.fleetMode ? "all hosts" : "fleet"}</span></div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/images")}>images</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/networks")}>networks</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/volumes")}>volumes</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/agents")}>agents</span></div>
          <div class="s nav"><span class="navlink on" onClick={() => this.router.navigate("/tunnels")}>tunnels</span></div>
          <div class="grow"></div>
          {!this.disabled && this.loaded ? (
            <div class="s act"><button disabled={this.busy} onClick={this.deployConnector}>deploy connector</button></div>
          ) : null}
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.disabled ? (
            <div class="disabled">
              Cloudflare tunnels are off.<br />
              Set <b>[cloudflare]</b> in config (enabled + api_token + account_id), then hope can<br />
              deploy a connector for you or adopt one you run (labeled <b>ink.hope.tunnel=&lt;id&gt;</b>).
            </div>
          ) : null}

          {this.error ? <div class="empty">{this.error}</div> : null}

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

  // One connector block: its card, then the routes it serves (ingress order).
  private renderConnector(c: ConnectorView) {
    const all = this.routes.filter((t) => t.connector === c.name);
    const q = this.hostQuery.trim().toLowerCase();
    const shown = q ? all.filter((t) => t.hostname.toLowerCase().includes(q) || (t.svc_name || "").toLowerCase().includes(q) || (t.project || "").toLowerCase().includes(q)) : all;
    return (
      <div class="cblock">
        <div class="chead">
          <span class={"cdot" + (c.online ? "" : c.running ? " warn" : " off")}></span>
          <div class="cwho">
            <div class="cl1">
              <span class="cname">{c.title || c.name}</span>
              {c.default ? <span class="cdef">shared</span> : null}
              {this.hosts.length > 1 ? <span class="chost" title="host this connector runs on">{this.activeHostId()}</span> : null}
            </div>
            <div class="cl2">
              <span class={c.online ? "ok" : c.running ? "warn" : "bad"}>{c.status || (c.running ? "connecting" : "stopped")}</span>
              <span class="sep">·</span>{c.connections} conns
              {c.colos && c.colos.length ? <span><span class="sep">·</span>edge {c.colos.join(" ")}</span> : null}
              {c.version ? <span><span class="sep">·</span>{c.version}</span> : null}
              <span class="sep">·</span>tunnel {short(c.tunnel_id)}
              <span class="sep">·</span>{(c.networks || []).join(", ") || "no networks yet"}
            </div>
          </div>
          <span class="cgrow"></span>
          {c.update_ready ? <button class="caddr upd" title="a newer cloudflared is available — pull + recreate" onClick={() => this.updateConnector(c)}>update</button> : null}
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
                let prevDomain: string | null = null;
                for (const t of shown) {
                  const { sub, domain } = this.splitHost(t.hostname);
                  const dkey = domain || t.hostname;
                  if (dkey !== prevDomain) {
                    rows.push(
                      <tr class="dgroup"><td colSpan={4}><a href={`https://${dkey}`} target="_blank" rel="noreferrer">{dkey}</a></td></tr>,
                    );
                    prevDomain = dkey;
                  }
                  const idx = all.indexOf(t);
                  rows.push(
                    <tr>
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
                return rows;
              })()}
            </tbody>
          </table>
        )}
      </div>
    );
  }
}
