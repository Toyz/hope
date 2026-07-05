// Agents page: every connected hope-agent with its build info (version, git
// sha, Go version, platform), daemon version, and container/image counts.
import { LoomElement, component, styles, css, reactive, mount, unmount, watch, interval, on, app } from "@toyz/loom";
import { Refreshing, withRefresh } from "../events";
import { clipboard, debounce } from "@toyz/loom/element";
import { signalModal } from "../modal";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { rpc, mutate } from "@toyz/loom-rpc";
import type { RpcMutator } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { System } from "../contracts";
import type { AgentView, AgentEnroll } from "../contracts";
import { resourceStyles } from "./resource-styles";
import { theme } from "../styles";

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
@styles(theme, css`
  ${resourceStyles}

  /* header stat-band skeleton children */
  .skstat { display: flex; flex-direction: column; gap: 8px; }

  .agrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 14px; }
  .acard { background: var(--panel); border: 1px solid var(--line); }
  .acard.off { border-color: color-mix(in srgb, var(--bad) 22%, var(--line)); }

  /* header bar — status dot + agent id, right-aligned up/seen chip, remove action */
  .acard .ahead { display: flex; align-items: center; gap: 10px; padding: 13px 15px; border-bottom: 1px solid var(--line); }
  .acard .adot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
  .acard .adot.off { background: var(--bad); }
  .acard .aid { font: 700 13.5px/1 var(--mono); color: var(--hi); letter-spacing: .01em; }
  .acard .aup { margin-left: auto; font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .acard .aup.seen { color: var(--warn); }
  .acard .afget { margin-left: 8px; }

  /* detail rows — mirror the inspector's .drow/.dk/.dv (fixed-width mono label + hi value) */
  .acard .arows { padding: 2px 15px 6px; }
  .acard .arow { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 8px 0;
    border-bottom: 1px solid var(--line); align-items: baseline; }
  .acard .arow:last-child { border-bottom: 0; }
  .acard .ak { font: 600 9px/1.6 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .acard .av { min-width: 0; font: 12px/1.5 var(--mono); color: var(--hi); word-break: break-all; }
  .acard .av .dim { color: var(--dim); }
  .acard .av .warnv { color: var(--warn); }

  /* empty state mirrors the API page: hero + numbered <hope-panel> cards */
  .setup { max-width: 940px; margin: 0 auto; }
  .setup .hero { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 22px; }
  .setup .hero .t { display: block; font: 700 30px/1 var(--mono); letter-spacing: .06em; color: var(--hi); margin-bottom: 10px; }
  .setup .hero .sub { display: block; max-width: 680px; font: 13px/1.6 var(--mono); color: var(--dim); }
  .setup .hero .sub code { color: var(--mid); }
  .setup p { font: 12.5px/1.7 var(--mono); color: var(--mid); margin: 0 0 12px; }
  .setup p:last-child { margin-bottom: 0; }
  .setup p code { color: var(--upd); }
  .setup .code { position: relative; background: var(--ink); border: 1px solid var(--line); }
  .setup .code pre { margin: 0; padding: 14px 15px; overflow-x: auto; font: 12px/1.7 var(--mono); color: var(--hi); white-space: pre; }
  .setup .code .cp { position: absolute; top: 8px; right: 8px; display: inline-flex; align-items: center; gap: 6px;
    background: var(--raised); border: 1px solid var(--line2); color: var(--dim); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 7px 10px; }
  .setup .code .cp:hover { color: var(--hi); border-color: var(--mid); }
  .setup .code .cp.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, var(--line)); }
  .setup .note { font: 11.5px/1.6 var(--mono); color: var(--dim); margin-top: 12px; }
  .setup .note b { color: var(--warn); font-weight: 600; }

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
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  // Agents are hub-global (not host-scoped), so no fleet/HostChanged wiring.
  @rpc(System, "agents", { eager: false }) accessor agentsQ!: ApiState<AgentView[]>;
  @mutate(System, "agentEnroll") accessor enrollMut!: RpcMutator<[], AgentEnroll>;
  @mutate(System, "forgetAgent") accessor forgetMut!: RpcMutator<[string], { ok: boolean }>;

  @reactive accessor copied = "";
  @reactive accessor modalOpen = false;

  @watch("modalOpen") private lockBody() { signalModal(this, this.modalOpen); }
  @unmount private releaseBody() { signalModal(this, false); }
  @reactive accessor enroll: AgentEnroll | null = null;
  @reactive accessor hostId = "my-host";

  get agents(): AgentView[] {
    // The server returns agents in map order (non-deterministic) — sort so the
    // cards don't shuffle on every refresh. Online first, then by id.
    return [...(this.agentsQ.data || [])].sort(
      (a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1) || a.id.localeCompare(b.id),
    );
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

  // loom @clipboard copies the return value; @debounce clears the "copied" flash
  // after 1.5s of no further copies (auto-cancelled on disconnect).
  @clipboard("write")
  private copy(text: string, tag: string) {
    this.copied = tag;
    this.clearCopied();
    return text;
  }
  @debounce(1500) private clearCopied() { this.copied = ""; }

  private openNew = async () => {
    this.modalOpen = true;
    try {
      this.enroll = await this.enrollMut.call();
    } catch { this.enroll = null; }
  };

  private forget = async (a: AgentView) => {
    const ok = await this.confirm.ask({
      title: "forget agent",
      danger: true,
      confirmLabel: "Forget",
      message: `Remove ${a.id} from the known-agents list. If it dials back in it'll reappear.`,
      stats: [{ label: "agent", value: a.id }, ...(a.last_seen ? [{ label: "last seen", value: ago(a.last_seen) + " ago" }] : [])],
    });
    if (!ok) return;
    try {
      await this.forgetMut.call(a.id);
      this.toast.ok(`forgot ${a.id}`);
      this.load();
    } catch (err: any) {
      this.toast.error(`forget ${a.id} — ${err?.message ?? "failed"}`);
    }
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

  // Spin the header refresh only for a user click (Refreshing bus, min-beat), not
  // the 8s background poll.
  @reactive accessor refreshing = false;
  private refreshRC = 0;
  @on(Refreshing) private onRefreshing(e: Refreshing) {
    this.refreshRC = Math.max(0, this.refreshRC + (e.active ? 1 : -1));
    this.refreshing = this.refreshRC > 0;
  }
  private userRefresh = () => { void withRefresh(() => this.load()); };


  update() {
    const online = this.agents.filter((a) => a.online).length;
    const running = this.agents.reduce((a, x) => a + x.running, 0);
    const containers = this.agents.reduce((a, x) => a + x.containers, 0);
    const first = this.busy && !this.loaded; // first load, nothing to show yet
    const dot = this.agents.length === 0 ? "" : online === this.agents.length ? "ok" : "warn";
    return (
      <div>
        <hope-phead heading="Agents" dot={dot} meta={first ? "connected hope-agents" : `${this.agents.length} agent${this.agents.length === 1 ? "" : "s"} · ${online} online`}>
          <hope-button slot="actions" icon="plus" onClick={this.openNew}>new agent</hope-button>
          <hope-button slot="actions" icon="rotate" spin={this.refreshing} disabled={this.busy} onClick={this.userRefresh}></hope-button>

          {first ? (
            <div class="vstats">{[0, 1, 2].map(() => <div class="skstat"><hope-skel w="64" h="9"></hope-skel><hope-skel w="52" h="16"></hope-skel></div>)}</div>
          ) : this.agents.length > 0 ? (
            <div class="vstats">
              <hope-stat label="agents" value={String(this.agents.length)}></hope-stat>
              <hope-stat label="online" value={String(online)} tone={online === this.agents.length ? "ok" : "warn"}></hope-stat>
              <hope-stat label="containers" value={String(running)} sub={`/ ${containers}`}></hope-stat>
            </div>
          ) : null}
        </hope-phead>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {first ? (
            <div class="agrid">
              {[0, 1, 2].map(() => (
                <div class="acard">
                  <div class="ahead"><hope-skel w="120" h="14"></hope-skel></div>
                  <div class="arows">
                    {[0, 1, 2, 3, 4].map(() => (
                      <div class="arow"><hope-skel w="80" h="10"></hope-skel><hope-skel w="140" h="12"></hope-skel></div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div class="agrid">
            {this.agents.map((a) => (
              <div class={"acard" + (a.online ? "" : " off")}>
                <div class="ahead">
                  <span class={"adot" + (a.online ? "" : " off")}></span>
                  <span class="aid">{a.id}</span>
                  {a.online ? (
                    <span class="aup">up {ago(a.connected_at)}</span>
                  ) : (
                    <>
                      <span class="aup seen">{a.last_seen ? "seen " + ago(a.last_seen) + " ago" : "offline"}</span>
                      <hope-button class="afget" size="sm" tone="danger" icon="trash" onClick={() => this.forget(a)}></hope-button>
                    </>
                  )}
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
              <div class="hero">
                <span class="t">Add a remote host</span>
                <span class="sub">A hope-agent runs on another machine and tunnels its Docker over this same port — no extra ports to open. Manage that host's stacks, images and tunnels right from here.</span>
              </div>

              <hope-panel n="01" label="Set a shared token on hope">
                <p>In hope's <code>config.toml</code>, set an <code>[agent]</code> token — a long random secret — then restart hope. This turns on the agent hub.</p>
                <div class="code"><pre>[agent]
token = "a-long-random-secret"</pre></div>
              </hope-panel>

              <hope-panel n="02" label="Run the agent on the remote host">
                <p>On the machine you want to add, run this. Replace <code>YOUR_AGENT_TOKEN</code> with the token from step 1 and pick a <code>--host-id</code>.</p>
                <div class="code">
                  <button class={"cp" + (this.copied === "empty" ? " ok" : "")} onClick={() => this.copy(this.agentCmd, "empty")}><loom-icon name="copy" size={12}></loom-icon>{this.copied === "empty" ? "copied" : "copy"}</button>
                  <pre>{this.agentCmd}</pre>
                </div>
                <div class="note"><b>Docker socket is root-equivalent</b> — only enroll hosts you control. The token is the only thing gating enrollment; keep it secret.</div>
              </hope-panel>

              <hope-panel n="03" label="It shows up here">
                <p>Once the agent dials in it appears on this page, and you can switch to it from the host picker in the top bar. This view refreshes automatically.</p>
              </hope-panel>
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
