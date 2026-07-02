// Agents page: every connected hope-agent with its build info (version, git
// sha, Go version, platform), daemon version, and container/image counts.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { rpc, mutate } from "@toyz/loom-rpc";
import type { RpcMutator } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { appBar } from "../app-bar";
import { System } from "../contracts";
import type { AgentView, AgentEnroll } from "../contracts";
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

  .setup { max-width: 760px; margin: 8px auto 0; }
  .setup .lead { text-align: center; margin-bottom: 26px; }
  .setup .lead h2 { font: 700 18px/1.3 var(--mono); color: var(--hi); margin: 0 0 8px; letter-spacing: .01em; }
  .setup .lead p { font: 13px/1.6 var(--sans); color: var(--dim); margin: 0; }
  .setup .step { display: flex; gap: 14px; padding: 18px 0; border-top: 1px solid var(--line); }
  .setup .step:first-of-type { border-top: 0; }
  .setup .num { flex: none; width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid var(--line2);
    font: 700 12px/1 var(--mono); color: var(--upd); }
  .setup .sbody { flex: 1; min-width: 0; }
  .setup .stitle { font: 600 13px/1.4 var(--mono); color: var(--hi); margin-bottom: 4px; }
  .setup .sdesc { font: 12.5px/1.6 var(--sans); color: var(--dim); margin-bottom: 10px; }
  .setup .sdesc code { font-family: var(--mono); color: var(--mid); }
  .setup .code { position: relative; background: var(--ink); border: 1px solid var(--line); }
  .setup .code pre { margin: 0; padding: 14px 15px; overflow-x: auto; font: 12px/1.65 var(--mono); color: var(--hi); white-space: pre; }
  .setup .code .cp { position: absolute; top: 8px; right: 8px; display: inline-flex; align-items: center; gap: 6px;
    background: var(--raised); border: 1px solid var(--line2); color: var(--dim); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 7px 10px; }
  .setup .code .cp:hover { color: var(--hi); border-color: var(--mid); }
  .setup .code .cp.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, var(--line)); }
  .setup .hint { font: 11.5px/1.5 var(--mono); color: var(--dim); margin-top: 9px; }
  .setup .hint b { color: var(--warn); font-weight: 600; }

  .amodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: afade .12s ease both; }
  @keyframes afade { from { opacity: 0; } to { opacity: 1; } }
  .abox { width: 620px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); border-top: 2px solid var(--upd);
    animation: apop .14s cubic-bezier(.2, .8, .3, 1) both; }
  @keyframes apop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
  .abox .ahd { display: flex; align-items: center; gap: 10px; padding: 16px 20px 0;
    font: 600 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--hi); }
  .abox .ahd .grow { flex: 1; }
  .abox .ax { background: transparent; border: 0; color: var(--dim); cursor: pointer; display: flex; padding: 2px; }
  .abox .ax:hover { color: var(--hi); }
  .abox .abd { padding: 16px 20px 6px; }
  .abox .awarn { margin-bottom: 16px; padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line));
    background: color-mix(in srgb, var(--warn) 7%, transparent); font: 12px/1.6 var(--sans); color: var(--warn); }
  .abox .awarn code { font-family: var(--mono); }
  .abox .f { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .abox label { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .abox input { width: 100%; box-sizing: border-box; height: 38px; background: var(--ink); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1 var(--mono); padding: 0 12px; }
  .abox input:focus { outline: none; border-color: var(--line2); }
  .abox .code { position: relative; background: var(--ink); border: 1px solid var(--line); }
  .abox .code pre { margin: 0; padding: 14px 15px; overflow-x: auto; font: 12px/1.65 var(--mono); color: var(--hi); white-space: pre; }
  .abox .code .cp { position: absolute; top: 8px; right: 8px; display: inline-flex; align-items: center; gap: 6px;
    background: var(--raised); border: 1px solid var(--line2); color: var(--dim); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 7px 10px; }
  .abox .code .cp:hover { color: var(--hi); border-color: var(--mid); }
  .abox .code .cp.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, var(--line)); }
  .abox .hint { font: 11.5px/1.5 var(--mono); color: var(--dim); margin-top: 4px; }
  .abox .hint b { color: var(--warn); font-weight: 600; }
  .abox .aft { display: flex; justify-content: flex-end; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .abox .btn { font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #06080d;
    background: var(--upd); border: 1px solid var(--upd); padding: 10px 18px; cursor: pointer; }
  .abox .btn:hover { background: color-mix(in srgb, var(--upd) 88%, #fff); }
`)
export class AgentsPage extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HostContext) accessor hostCtx!: HostContext;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  // Agents are hub-global (not host-scoped), so no fleet/HostChanged wiring.
  @rpc(System, "agents", { eager: false }) accessor agentsQ!: ApiState<AgentView[]>;
  @mutate(System, "agentEnroll") accessor enrollMut!: RpcMutator<[], AgentEnroll>;

  @reactive accessor copied = "";
  @reactive accessor modalOpen = false;
  @reactive accessor enroll: AgentEnroll | null = null;
  @reactive accessor hostId = "my-host";

  get agents(): AgentView[] {
    return this.agentsQ.data || [];
  }
  get loaded(): boolean {
    return !!this.agentsQ.data;
  }
  get busy(): boolean {
    return this.agentsQ.loading;
  }
  get error(): string {
    return this.agentsQ.error?.message ?? "";
  }

  // The agent dials this hub over hope's own port (through Cloudflare if fronted),
  // so the endpoint is derived from wherever the UI is being served.
  private connectUrl(path = "/agent/connect"): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}${path}`;
  }

  private cmd(token: string, hostId: string, wsPath = "/agent/connect"): string {
    return [
      "docker run -d --name hope-agent --restart unless-stopped \\",
      "  -v /var/run/docker.sock:/var/run/docker.sock \\",
      "  ghcr.io/toyz/hope agent \\",
      `  --connect ${this.connectUrl(wsPath)} \\`,
      `  --token ${token} \\`,
      `  --host-id ${hostId || "my-host"}`,
    ].join("\n");
  }

  private get agentCmd(): string { return this.cmd("YOUR_AGENT_TOKEN", "my-host"); }
  private get modalCmd(): string {
    return this.cmd(this.enroll?.token || "YOUR_AGENT_TOKEN", this.hostId, this.enroll?.ws_path || "/agent/connect");
  }
  // Masked for display (Cloudflare-style) — copy still grabs the real token.
  private maskToken(t: string): string {
    if (!t || t === "YOUR_AGENT_TOKEN") return t;
    return t.length <= 8 ? "••••••••" : t.slice(0, 4) + "…" + t.slice(-4);
  }
  private get modalCmdDisplay(): string {
    return this.cmd(this.maskToken(this.enroll?.token || "YOUR_AGENT_TOKEN"), this.hostId, this.enroll?.ws_path || "/agent/connect");
  }

  private copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = tag;
      setTimeout(() => (this.copied = ""), 1500);
    } catch { /* clipboard blocked */ }
  };

  private openNew = async () => {
    this.modalOpen = true;
    try {
      this.enroll = await this.enrollMut.call();
    } catch { this.enroll = null; }
  };

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

  private load = () => this.agentsQ.refetch();


  update() {
    return (
      <div>
        {appBar("agents", [
          <div class="s act"><button style="display:inline-flex;align-items:center;gap:6px" onClick={this.openNew}><loom-icon name="plus" size={12}></loom-icon> new agent</button></div>,
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>,
        ])}

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
            <div class="setup">
              <div class="lead">
                <h2>Add a remote host</h2>
                <p>A hope-agent runs on another machine and tunnels its Docker over this same port — no extra ports to open. Manage that host's stacks, images and tunnels right from here.</p>
              </div>

              <div class="step">
                <div class="num">1</div>
                <div class="sbody">
                  <div class="stitle">Set a shared token on hope</div>
                  <div class="sdesc">In hope's <code>config.toml</code>, set an <code>[agent]</code> token — a long random secret — then restart hope. This turns on the agent hub.</div>
                  <div class="code"><pre>[agent]
token = "a-long-random-secret"</pre></div>
                </div>
              </div>

              <div class="step">
                <div class="num">2</div>
                <div class="sbody">
                  <div class="stitle">Run the agent on the remote host</div>
                  <div class="sdesc">On the machine you want to add, run this. Replace <code>YOUR_AGENT_TOKEN</code> with the token from step 1 and pick a <code>--host-id</code>.</div>
                  <div class="code">
                    <button class={"cp" + (this.copied === "empty" ? " ok" : "")} onClick={() => this.copy(this.agentCmd, "empty")}><loom-icon name="copy" size={12}></loom-icon>{this.copied === "empty" ? "copied" : "copy"}</button>
                    <pre>{this.agentCmd}</pre>
                  </div>
                  <div class="hint"><b>Docker socket is root-equivalent</b> — only enroll hosts you control. The token is the only thing gating enrollment; keep it secret.</div>
                </div>
              </div>

              <div class="step">
                <div class="num">3</div>
                <div class="sbody">
                  <div class="stitle">It shows up here</div>
                  <div class="sdesc">Once the agent dials in it appears on this page, and you can switch to it from the host picker in the top bar. This view refreshes automatically.</div>
                </div>
              </div>
            </div>
          ) : null}
        </main>

        {this.modalOpen ? (
          <div class="amodal" onClick={() => (this.modalOpen = false)}>
            <div class="abox" onClick={(e: Event) => e.stopPropagation()}>
              <div class="ahd">
                <loom-icon name="link" size={16} color="var(--upd)"></loom-icon>
                <span>add an agent</span>
                <span class="grow"></span>
                <button class="ax" onClick={() => (this.modalOpen = false)}><loom-icon name="x" size={15}></loom-icon></button>
              </div>
              <div class="abd">
                {this.enroll && !this.enroll.enabled ? (
                  <div class="awarn">The agent hub is off. Set an <code>[agent]</code> token in hope's config and restart, then come back — the command will include it automatically.</div>
                ) : null}
                <div class="f">
                  <label>host id</label>
                  <input type="text" placeholder="my-host" value={this.hostId} onInput={(e: any) => (this.hostId = e.target.value)} />
                </div>
                <div class="f">
                  <label>run this on the host you're adding</label>
                  <div class="code">
                    <button class={"cp" + (this.copied === "modal" ? " ok" : "")} onClick={() => this.copy(this.modalCmd, "modal")}><loom-icon name="copy" size={12}></loom-icon>{this.copied === "modal" ? "copied" : "copy"}</button>
                    <pre>{this.modalCmdDisplay}</pre>
                  </div>
                </div>
                <div class="hint"><b>The token is a secret</b> — it grants root-equivalent control of any host that presents it. Don't paste this command where others can see it.</div>
              </div>
              <div class="aft">
                <button class="btn" onClick={() => (this.modalOpen = false)}>Done</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
}
