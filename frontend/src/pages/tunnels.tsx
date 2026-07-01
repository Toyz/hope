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
import { PromptService, type PromptField } from "../prompt";
import type { ConnectorView, TunnelView, StackSummary, OpResult, HostView } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

const short = (id: string) => (id && id.length > 12 ? id.slice(0, 12) : id || "—");
const UNGROUPED = "(ungrouped)";

@route("/tunnels")
@component("hope-tunnels")
@styles(css`
  ${theme}
  ${resourceStyles}

  .cgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .ccard { border: 1px solid var(--line); }
  .ccard .chead { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  .ccard .cdot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
  .ccard .cdot.off { background: var(--bad); }
  .ccard .cdot.warn { background: var(--warn); }
  .ccard .cname { font: 700 13px/1 var(--mono); color: var(--hi); }
  .ccard .cdef { font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line)); padding: 3px 6px; border-radius: 4px; }
  .ccard .cstat { margin-left: auto; font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .ccard .caddr { background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer;
    font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 5px 8px; }
  .ccard .caddr:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ccard .cx { background: transparent; border: 0; color: var(--dim); cursor: pointer; padding: 2px; display: flex; }
  .ccard .cx:hover { color: var(--bad); }
  .ccard .crows { display: flex; }
  .ccard .cm { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .ccard .cm:last-child { border-right: 0; }
  .ccard .ck { font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .ccard .cv { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .ccard .cfoot { padding: 10px 16px; border-top: 1px solid var(--line); font: 11.5px/1.5 var(--mono); color: var(--dim); word-break: break-all; }
  .seclbl { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); margin: 0 0 12px; }
  td.host a { color: var(--hi); text-decoration: none; }
  td.host a:hover { text-decoration: underline; }
  td.origin .svc { color: var(--dim); }
  td.rx { text-align: right; }
  .rmx { background: transparent; border: 1px solid transparent; color: var(--dim); cursor: pointer; padding: 5px 7px; display: inline-flex; }
  .rmx:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); background: var(--raised); }
  .disabled { padding: 40px; text-align: center; color: var(--dim); font: 13px/1.7 var(--mono); }
`)
export class TunnelsPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(PromptService) accessor prompt!: PromptService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor connectors: ConnectorView[] = [];
  @reactive accessor routes: TunnelView[] = [];
  @reactive accessor stacks: StackSummary[] = [];
  @reactive accessor hosts: HostView[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor disabled = false;
  @reactive accessor busy = false;

  get fleetMode() {
    return localStorage.getItem("hope.fleet") === "1";
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
    if (this.auth.isAuthenticated && !this.disabled) this.load();
  }

  private load = async () => {
    this.busy = true;
    try {
      const [cons, routes, stacks, hosts] = await Promise.all([
        this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
        this.rpc.call<TunnelView[]>("Tunnels", "tunnels", []),
        this.rpc.call<StackSummary[]>("Stacks", "list", []).catch(() => []),
        this.rpc.call<HostView[]>("System", "hosts", []).catch(() => []),
      ]);
      this.connectors = cons || [];
      this.routes = routes || [];
      this.stacks = stacks || [];
      this.hosts = hosts || [];
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
        await this.rpc.call<OpResult>("Tunnels", "removeTunnel", [t.hostname]);
        emit("removed");
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    await this.load();
  };

  // Every stack service + every loose container, flattened so the dialog is one
  // select. The value encodes the target as "svc::project::service" or "ct::id".
  private targetOptions() {
    const out: { value: string; label: string }[] = [];
    for (const s of this.stacks) {
      if (s.project === UNGROUPED) continue;
      const seen = new Set<string>();
      for (const c of s.containers) {
        const svc = c.service || c.name;
        if (seen.has(svc)) continue;
        seen.add(svc);
        out.push({ value: ["svc", s.project, svc].join("::"), label: `${s.project} / ${svc}` });
      }
    }
    const loose = this.stacks.find((x) => x.project === UNGROUPED);
    for (const c of loose?.containers || []) {
      out.push({ value: ["ct", c.id].join("::"), label: `loose: ${c.name}` });
    }
    return out;
  }

  // A route belongs to a connector, so this is a per-connector action — the
  // connector (and thus its host) is implied, not a field.
  private addRoute = async (c: ConnectorView) => {
    const v = await this.prompt.ask({
      title: `add route · ${c.title || c.name}`,
      icon: "link",
      message: "hope attaches the connector to the target's network, updates the tunnel ingress, and creates the DNS record.",
      submitLabel: "Add route",
      fields: [
        { key: "target", label: "target (stack service or loose container)", type: "select", placeholder: "—", options: this.targetOptions() },
        { key: "port", label: "port", placeholder: "8080" },
        { key: "host_name", label: "hostname", placeholder: "blog.example.com" },
      ],
    });
    if (!v) return;
    const [kind, a, b] = v.target.split("::");
    const project = kind === "svc" ? a : "";
    const service = kind === "svc" ? b : "";
    const container = kind === "ct" ? a : "";
    const host = v.host_name.trim().toLowerCase();
    await this.proc.run(`add route ${host}`, async (emit) => {
      try {
        emit("attaching connector to the target's network…");
        emit("updating tunnel ingress + DNS…");
        const res = await this.rpc.call<OpResult>("Tunnels", "addTunnel", [host, v.port.trim(), c.id, project, service, container]);
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
                      <button class="caddr" onClick={() => this.addRoute(c)}>+ route</button>
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
      </div>
    );
  }
}
