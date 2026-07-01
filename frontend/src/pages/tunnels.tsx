// Tunnels page: hope-managed Cloudflare connectors + the public routes they
// serve (hostname -> stack/service). Deploy a connector, add/remove routes.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import type { ConnectorView, TunnelView, StackSummary, OpResult } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

const short = (id: string) => (id && id.length > 12 ? id.slice(0, 12) : id || "—");
const UNGROUPED = "(ungrouped)";

// Internal (container-side) port from a docker port string.
const innerPort = (p: string): string => {
  const arrow = p.indexOf("->");
  const body = arrow >= 0 ? p.slice(arrow + 2) : p;
  return body.split("/")[0].trim();
};

@route("/tunnels")
@component("hope-tunnels")
@styles(css`
  ${theme}
  ${resourceStyles}

  .tacts { display: flex; gap: 8px; margin-bottom: 18px; }
  .tbtn { padding: 9px 14px; background: transparent; border: 1px solid var(--line); color: var(--mid);
    font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; cursor: pointer; }
  .tbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .tbtn.pri { color: #06080d; border-color: var(--upd); background: color-mix(in srgb, var(--upd) 85%, #000); }
  .tbtn.pri:hover { background: var(--upd); }
  .tbtn:disabled { opacity: .4; cursor: not-allowed; }

  .cgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .ccard { border: 1px solid var(--line); position: relative; }
  .ccard .chead { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  .ccard .cdot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
  .ccard .cdot.off { background: var(--bad); }
  .ccard .cdot.warn { background: var(--warn); }
  .ccard .cname { font: 700 13px/1 var(--mono); color: var(--hi); }
  .ccard .cdef { font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line)); padding: 3px 6px; border-radius: 4px; }
  .ccard .cstat { margin-left: auto; font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .ccard .cx { background: transparent; border: 0; color: var(--dim); cursor: pointer; padding: 2px; display: flex; }
  .ccard .cx:hover { color: var(--bad); }
  .ccard .crows { display: flex; }
  .ccard .cm { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .ccard .cm:last-child { border-right: 0; }
  .ccard .ck { font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .ccard .cv { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .ccard .cfoot { padding: 10px 16px; border-top: 1px solid var(--line); font: 11.5px/1.5 var(--mono); color: var(--dim); word-break: break-all; }
  .seclbl { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); margin: 0 0 12px; }
  td.host { color: var(--hi); }
  td.host a { color: var(--hi); text-decoration: none; }
  td.host a:hover { text-decoration: underline; }
  td.origin .svc { color: var(--dim); }
  td.rx { text-align: right; }
  .rmx { background: transparent; border: 1px solid transparent; color: var(--dim); cursor: pointer; padding: 5px 7px; display: inline-flex; }
  .rmx:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); background: var(--raised); }
  .disabled { padding: 40px; text-align: center; color: var(--dim); font: 13px/1.7 var(--mono); }

  /* add-route / deploy modal */
  .tmodal { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 20px;
    background: rgba(4,6,10,.66); backdrop-filter: blur(3px); }
  .tbox { width: 520px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); border-top: 2px solid var(--upd); }
  .thead { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line);
    font: 700 13px/1 var(--mono); letter-spacing: .04em; color: var(--hi); }
  .thead .grow { flex: 1; }
  .thead .tx { background: transparent; border: 0; color: var(--dim); cursor: pointer; display: flex; }
  .thead .tx:hover { color: var(--hi); }
  .tform { padding: 8px 18px 4px; }
  .frow { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
  .frow label { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .frow input, .frow select { width: 100%; box-sizing: border-box; background: var(--ink); border: 1px solid var(--line); color: var(--hi);
    font: 13px/1 var(--mono); padding: 10px 12px; border-radius: 0; }
  .frow input:focus, .frow select:focus { outline: none; border-color: var(--line2); }
  .frow2 { display: flex; gap: 12px; }
  .frow2 .frow { flex: 1; }
  .seg { display: flex; gap: 0; }
  .seg button { flex: 1; padding: 9px; background: transparent; border: 1px solid var(--line); color: var(--dim);
    font: 600 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; cursor: pointer; }
  .seg button.on { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .thint { font: 11.5px/1.5 var(--mono); color: var(--dim); padding: 0 18px 10px; }
  .thint.warn { color: var(--warn); }
  .tfoot { display: flex; align-items: center; gap: 10px; padding: 13px 18px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .tfoot .grow { flex: 1; }
  .tfoot .ferr { color: var(--bad); font: 11.5px/1.4 var(--mono); }
`)
export class TunnelsPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor connectors: ConnectorView[] = [];
  @reactive accessor routes: TunnelView[] = [];
  @reactive accessor stacks: StackSummary[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor disabled = false;
  @reactive accessor busy = false;

  // add-route form
  @reactive accessor addOpen = false;
  @reactive accessor fConnector = "";
  @reactive accessor fMode: "service" | "loose" = "service";
  @reactive accessor fProject = "";
  @reactive accessor fService = "";
  @reactive accessor fContainer = "";
  @reactive accessor fPort = "";
  @reactive accessor fHost = "";
  @reactive accessor fErr = "";
  @reactive accessor fBusy = false;

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
    if (this.auth.isAuthenticated && !this.disabled && !this.addOpen) this.load();
  }

  private load = async () => {
    this.busy = true;
    try {
      const [cons, routes, stacks] = await Promise.all([
        this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
        this.rpc.call<TunnelView[]>("Tunnels", "tunnels", []),
        this.rpc.call<StackSummary[]>("Stacks", "list", []).catch(() => []),
      ]);
      this.connectors = cons || [];
      this.routes = routes || [];
      this.stacks = stacks || [];
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

  private deployConnector = async () => {
    const name = (prompt("Name for the new connector (a Cloudflare tunnel is created and cloudflared is deployed):") || "").trim();
    if (!name) return;
    this.busy = true;
    try {
      await this.rpc.call<ConnectorView>("Tunnels", "createConnector", [name]);
      await this.load();
    } catch (err: any) {
      this.error = err?.message ?? "deploy failed";
    } finally {
      this.busy = false;
    }
  };

  private removeConnector = async (c: ConnectorView) => {
    const del = await this.confirm.ask({
      title: "remove connector",
      danger: true,
      confirmLabel: "Remove + delete tunnel",
      cancelLabel: "Cancel",
      message: `Remove connector "${c.title || c.name}"? This stops and deletes the cloudflared container AND deletes its Cloudflare tunnel (${short(c.tunnel_id)}). Its routes stop working.`,
    });
    if (!del) return;
    try {
      await this.rpc.call<OpResult>("Tunnels", "removeConnector", [c.id, true]);
      await this.load();
    } catch (err: any) {
      this.error = err?.message ?? "remove failed";
    }
  };

  private removeRoute = async (t: TunnelView) => {
    const ok = await this.confirm.ask({
      title: "remove route",
      danger: true,
      confirmLabel: "Remove",
      message: `Remove the route ${t.hostname}? Drops the tunnel ingress rule and deletes its DNS record.`,
    });
    if (!ok) return;
    try {
      await this.rpc.call<OpResult>("Tunnels", "removeTunnel", [t.hostname]);
      await this.load();
    } catch (err: any) {
      this.error = err?.message ?? "remove failed";
    }
  };

  private openAdd = () => {
    this.fConnector = (this.connectors.find((c) => c.default) || this.connectors[0])?.id || "";
    this.fMode = "service";
    this.fProject = "";
    this.fService = "";
    this.fContainer = "";
    this.fPort = "";
    this.fHost = "";
    this.fErr = "";
    this.addOpen = true;
  };

  private services(project: string) {
    const s = this.stacks.find((x) => x.project === project);
    if (!s) return [];
    const seen = new Set<string>();
    const out: { service: string; ports: string[] }[] = [];
    for (const c of s.containers) {
      const key = c.service || c.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ service: key, ports: (c.ports || []).map(innerPort).filter(Boolean) });
    }
    return out;
  }

  private looseContainers() {
    const s = this.stacks.find((x) => x.project === UNGROUPED);
    return s ? s.containers : [];
  }

  private replicaCount(project: string, service: string) {
    const s = this.stacks.find((x) => x.project === project);
    if (!s) return 0;
    return s.containers.filter((c) => (c.service || c.name) === service).length;
  }

  private submitAdd = async () => {
    const host = this.fHost.trim().toLowerCase();
    if (!host || !this.fPort.trim() || !this.fConnector) {
      this.fErr = "hostname, port and connector are required";
      return;
    }
    const project = this.fMode === "service" ? this.fProject : "";
    const service = this.fMode === "service" ? this.fService : "";
    const container = this.fMode === "loose" ? this.fContainer : "";
    if (this.fMode === "service" && (!project || !service)) {
      this.fErr = "pick a stack + service";
      return;
    }
    if (this.fMode === "loose" && !container) {
      this.fErr = "pick a container";
      return;
    }
    this.fBusy = true;
    this.fErr = "";
    try {
      const res = await this.rpc.call<OpResult>("Tunnels", "addTunnel", [host, this.fPort.trim(), this.fConnector, project, service, container]);
      if (res && res.ok === false) {
        this.fErr = res.error || "failed";
        this.fBusy = false;
        return;
      }
      this.addOpen = false;
      await this.load();
    } catch (err: any) {
      this.fErr = err?.message ?? "add failed";
    } finally {
      this.fBusy = false;
    }
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
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> fleet</span></div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/images")}>images</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/networks")}>networks</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/volumes")}>volumes</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/agents")}>agents</span></div>
          <div class="s nav"><span class="navlink on" onClick={() => this.router.navigate("/tunnels")}>tunnels</span></div>
          <div class="grow"></div>
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
            <div class="tacts">
              <button class="tbtn pri" disabled={this.busy} onClick={this.deployConnector}>deploy connector</button>
              {this.connectors.length > 0 ? <button class="tbtn" onClick={this.openAdd}>add route</button> : null}
            </div>
          ) : null}

          {!this.disabled && this.loaded ? (
            <div class="summary">
              <span class="stat"><i class="k">connectors</i><i class="v">{this.connectors.length}</i></span>
              <span class="stat"><i class="k">online</i><i class={"v" + (this.connectors.length && online < this.connectors.length ? " warnv" : "")}>{online}</i></span>
              <span class="stat"><i class="k">routes</i><i class="v">{this.routes.length}</i></span>
            </div>
          ) : null}

          {this.connectors.length > 0 ? (
            <div>
              <p class="seclbl">Connectors</p>
              <div class="cgrid">
                {this.connectors.map((c) => (
                  <div class="ccard">
                    <div class="chead">
                      <span class={"cdot" + (c.online ? "" : c.running ? " warn" : " off")}></span>
                      <span class="cname">{c.title || c.name}</span>
                      {c.default ? <span class="cdef">shared</span> : null}
                      <span class="cstat">{c.status || (c.running ? "connecting" : "stopped")}</span>
                      <button class="cx" title="remove connector" onClick={() => this.removeConnector(c)}><loom-icon name="x" size={14}></loom-icon></button>
                    </div>
                    <div class="crows">
                      <div class="cm"><span class="ck">routes</span><span class="cv">{c.routes}</span></div>
                      <div class="cm"><span class="ck">edge conns</span><span class="cv">{c.connections}</span></div>
                      <div class="cm"><span class="ck">tunnel</span><span class="cv" style="font-size:12px">{short(c.tunnel_id)}</span></div>
                    </div>
                    <div class="cfoot">{c.project ? `stack ${c.project} · ` : ""}{(c.networks || []).join(", ") || "no user networks yet"}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {this.routes.length > 0 ? (
            <div>
              <p class="seclbl">Routes</p>
              <table>
                <colgroup>
                  <col class="c-name" />
                  <col class="c-meta" />
                  <col class="c-meta" />
                  <col class="c-meta" />
                  <col class="c-act" />
                </colgroup>
                <thead>
                  <tr><th>Hostname</th><th>Target</th><th>Port</th><th>Connector</th><th></th></tr>
                </thead>
                <tbody>
                  {this.routes.map((t) => (
                    <tr>
                      <td class="host"><a href={`https://${t.hostname}`} target="_blank" rel="noreferrer">{t.hostname}</a>{t.path ? <span class="svc"> {t.path}</span> : null}</td>
                      <td class="origin">{t.project ? <span>{t.project} / {t.svc_name}</span> : <span class="svc">{t.container || t.service}</span>}</td>
                      <td class="rmeta">{t.port || "—"}</td>
                      <td class="rmeta">{t.connector}</td>
                      <td class="rx"><button class="rmx" title="remove route" onClick={() => this.removeRoute(t)}><loom-icon name="x" size={14}></loom-icon></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {!this.disabled && this.loaded && this.connectors.length === 0 && !this.error ? (
            <div class="empty">No connectors yet. <b>Deploy connector</b> lets hope create a Cloudflare tunnel and run cloudflared for you.</div>
          ) : null}
        </main>

        {this.addOpen ? this.renderAdd() : null}
      </div>
    );
  }

  private renderAdd() {
    const svcs = this.services(this.fProject);
    const svcPorts = svcs.find((s) => s.service === this.fService)?.ports || [];
    const replicas = this.fMode === "service" && this.fService ? this.replicaCount(this.fProject, this.fService) : 0;
    const con = this.connectors.find((c) => c.id === this.fConnector);
    const warnReplica = replicas > 1 && con && con.default;
    const projects = this.stacks.map((s) => s.project).filter((p) => p !== UNGROUPED);
    return (
      <div class="tmodal" onClick={() => (this.addOpen = false)}>
        <div class="tbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="thead">
            <loom-icon name="link" size={15} color="var(--upd)"></loom-icon>
            <span>add route</span>
            <span class="grow"></span>
            <button class="tx" onClick={() => (this.addOpen = false)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="tform">
            <div class="frow">
              <label>connector</label>
              <select value={this.fConnector} onInput={(e: any) => (this.fConnector = e.target.value)}>
                {this.connectors.map((c) => <option value={c.id} selected={c.id === this.fConnector}>{c.title || c.name}{c.default ? " (shared)" : ""}</option>)}
              </select>
            </div>
            <div class="frow">
              <label>target</label>
              <div class="seg">
                <button class={this.fMode === "service" ? "on" : ""} onClick={() => (this.fMode = "service")}>stack service</button>
                <button class={this.fMode === "loose" ? "on" : ""} onClick={() => (this.fMode = "loose")}>loose container</button>
              </div>
            </div>
            {this.fMode === "service" ? (
              <div class="frow2">
                <div class="frow">
                  <label>stack</label>
                  <select value={this.fProject} onInput={(e: any) => { this.fProject = e.target.value; this.fService = ""; this.fPort = ""; }}>
                    <option value="" selected={!this.fProject}>—</option>
                    {projects.map((p) => <option value={p} selected={p === this.fProject}>{p}</option>)}
                  </select>
                </div>
                <div class="frow">
                  <label>service</label>
                  <select value={this.fService} onInput={(e: any) => { this.fService = e.target.value; this.fPort = ""; }}>
                    <option value="" selected={!this.fService}>—</option>
                    {svcs.map((s) => <option value={s.service} selected={s.service === this.fService}>{s.service}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div class="frow">
                <label>container</label>
                <select value={this.fContainer} onInput={(e: any) => { this.fContainer = e.target.value; this.fPort = ""; }}>
                  <option value="" selected={!this.fContainer}>—</option>
                  {this.looseContainers().map((c) => <option value={c.id} selected={c.id === this.fContainer}>{c.name}</option>)}
                </select>
              </div>
            )}
            <div class="frow2">
              <div class="frow">
                <label>port</label>
                {svcPorts.length > 0 && this.fMode === "service" ? (
                  <select value={this.fPort} onInput={(e: any) => (this.fPort = e.target.value)}>
                    <option value="" selected={!this.fPort}>—</option>
                    {svcPorts.map((p) => <option value={p} selected={p === this.fPort}>{p}</option>)}
                  </select>
                ) : (
                  <input type="text" placeholder="8080" value={this.fPort} onInput={(e: any) => (this.fPort = e.target.value)} />
                )}
              </div>
              <div class="frow">
                <label>hostname</label>
                <input type="text" placeholder="blog.example.com" value={this.fHost} onInput={(e: any) => (this.fHost = e.target.value)} />
              </div>
            </div>
          </div>
          {warnReplica ? (
            <div class="thint warn">{replicas} replicas on a shared connector — hope briefly reattaches them to load-balance (sub-second blip). A per-stack connector avoids it.</div>
          ) : (
            <div class="thint">hope attaches the connector to the target's network, updates the tunnel ingress, and creates the DNS record.</div>
          )}
          <div class="tfoot">
            {this.fErr ? <span class="ferr">{this.fErr}</span> : null}
            <span class="grow"></span>
            <button class="tbtn" onClick={() => (this.addOpen = false)}>cancel</button>
            <button class="tbtn pri" disabled={this.fBusy} onClick={this.submitAdd}>{this.fBusy ? "adding…" : "add route"}</button>
          </div>
        </div>
      </div>
    );
  }
}
