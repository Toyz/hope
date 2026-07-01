// Agents page: every connected hope-agent with its build info (version, git
// sha, Go version, platform), daemon version, and container/image counts.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { AgentView } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

const ago = (iso: string) => {
  const t = Date.parse(iso);
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const shaShort = (s: string) => (s && s.length > 12 ? s.slice(0, 12) : s || "—");

@route("/agents")
@component("hope-agents")
@styles(css`
  ${theme}
  ${resourceStyles}

  .agrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 14px; }
  .acard { border: 1px solid var(--line); }
  .acard .ahead { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .acard .adot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
  .acard .adot.off { background: var(--bad); }
  .acard .aid { font: 700 14px/1 var(--mono); color: var(--hi); letter-spacing: .02em; }
  .acard .aup { margin-left: auto; font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .acard .arows { padding: 4px 16px 12px; }
  .acard .arow { display: flex; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .acard .arow:last-child { border-bottom: 0; }
  .acard .ak { flex: 0 0 92px; font: 600 9.5px/1.6 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .acard .av { flex: 1; min-width: 0; font: 12.5px/1.5 var(--mono); color: var(--hi); word-break: break-all; }
  .acard .av .dim { color: var(--dim); }
  .acard .av .warnv { color: var(--warn); }
`)
export class AgentsPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor agents: AgentView[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
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
    if (this.auth.isAuthenticated) this.load();
  }

  private load = async () => {
    this.busy = true;
    try {
      this.agents = (await this.rpc.call<AgentView[]>("System", "agents", [])) || [];
      this.error = "";
      this.loaded = true;
    } catch (err: any) {
      this.error = err?.message ?? "Can't list agents.";
    } finally {
      this.busy = false;
    }
  };

  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  update() {
    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> fleet</span></div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
                    <div class="grow"></div>
          <hope-nav active="agents"></hope-nav>
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {this.agents.length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">agents</i><i class="v">{this.agents.length}</i></span>
              <span class="stat"><i class="k">online</i><i class="v">{this.agents.filter((a) => a.online).length}</i></span>
              <span class="stat"><i class="k">containers</i><i class="v">{this.agents.reduce((a, x) => a + x.running, 0)}<i class="t"> / {this.agents.reduce((a, x) => a + x.containers, 0)}</i></i></span>
            </div>
          ) : null}

          <div class="agrid">
            {this.agents.map((a) => (
              <div class="acard">
                <div class="ahead">
                  <span class={"adot" + (a.online ? "" : " off")}></span>
                  <span class="aid">{a.id}</span>
                  <span class="aup">up {ago(a.connected_at)}</span>
                </div>
                <div class="arows">
                  <div class="arow"><span class="ak">version</span><span class="av">{a.version || <span class="dim">—</span>}{a.revision ? <span class="dim"> · {shaShort(a.revision)}</span> : null}</span></div>
                  <div class="arow"><span class="ak">runtime</span><span class="av">{a.go_version || <span class="dim">—</span>}{a.platform ? <span class="dim"> · {a.platform}</span> : null}</span></div>
                  <div class="arow"><span class="ak">built</span><span class="av">{a.build_time ? ago(a.build_time) + " ago" : <span class="dim">unknown</span>}</span></div>
                  <div class="arow"><span class="ak">docker</span><span class="av">{a.online ? (a.docker_version || <span class="dim">—</span>) : <span class="warnv">unreachable</span>}</span></div>
                  <div class="arow"><span class="ak">containers</span><span class="av">{a.running}<span class="dim"> / {a.containers} running</span></span></div>
                  <div class="arow"><span class="ak">images</span><span class="av">{a.images}</span></div>
                  <div class="arow"><span class="ak">remote</span><span class="av">{a.remote || <span class="dim">—</span>}</span></div>
                </div>
              </div>
            ))}
          </div>

          {this.loaded && this.agents.length === 0 && !this.error ? (
            <div class="empty">No agents connected. Run <b>hope agent</b> on a remote host to add one.</div>
          ) : null}
        </main>
      </div>
    );
  }
}
