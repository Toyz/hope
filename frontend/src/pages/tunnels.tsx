// Tunnels page: hope-managed Cloudflare connectors + the public routes they
// serve (hostname -> stack/service). Read-only in stage 1; add/remove lands with
// the stack add-tunnel modal.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { ConnectorView, TunnelView } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

const short = (id: string) => (id && id.length > 12 ? id.slice(0, 12) : id || "—");

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
  .ccard .crows { display: flex; }
  .ccard .cm { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .ccard .cm:last-child { border-right: 0; }
  .ccard .ck { font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .ccard .cv { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .ccard .cfoot { padding: 10px 16px; border-top: 1px solid var(--line); font: 11.5px/1.5 var(--mono); color: var(--dim); word-break: break-all; }
  .seclbl { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); margin: 0 0 12px; }
  td.host { color: var(--hi); }
  td.origin .svc { color: var(--dim); }
  .disabled { padding: 40px; text-align: center; color: var(--dim); font: 13px/1.7 var(--mono); }
`)
export class TunnelsPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor connectors: ConnectorView[] = [];
  @reactive accessor routes: TunnelView[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor disabled = false;
  @reactive accessor busy = false;

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
      const [cons, routes] = await Promise.all([
        this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
        this.rpc.call<TunnelView[]>("Tunnels", "tunnels", []),
      ]);
      this.connectors = cons || [];
      this.routes = routes || [];
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
              Set <b>[cloudflare]</b> in config (enabled + api_token + account_id) and run a<br />
              cloudflared connector labeled <b>ink.hope.tunnel=&lt;tunnel-id&gt;</b>.
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
                </colgroup>
                <thead>
                  <tr><th>Hostname</th><th>Target</th><th>Port</th><th>Connector</th></tr>
                </thead>
                <tbody>
                  {this.routes.map((t) => (
                    <tr>
                      <td class="host">{t.hostname}{t.path ? <span class="svc"> {t.path}</span> : null}</td>
                      <td class="origin">{t.project ? <span>{t.project} / {t.svc_name}</span> : <span class="svc">{t.container || t.service}</span>}</td>
                      <td class="rmeta">{t.port || "—"}</td>
                      <td class="rmeta">{t.connector}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {!this.disabled && this.loaded && this.connectors.length === 0 && !this.error ? (
            <div class="empty">No connectors found. Run a cloudflared container labeled <b>ink.hope.tunnel=&lt;tunnel-id&gt;</b>.</div>
          ) : null}
        </main>
      </div>
    );
  }
}
