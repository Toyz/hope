// Mission-control overview, terminal-instrument style. A tmux-like status bar
// synthesizes fleet state; a flat fleet ribbon shows every stack as a cell
// (dark = nominal, lit = trouble); below, an Attention zone then a quiet Fleet
// list of instrument rows. No glows, no per-row noise. Refreshes every 5s.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, route } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { StackSummary } from "../contracts";
import { theme, stackSeverity, severityRank, type Severity } from "../styles";

interface Ranked extends StackSummary {
  sev: Severity;
}

const UNGROUPED = "(ungrouped)";

@route("/")
@component("hope-dashboard")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--ink); }

  /* ── status bar (tmux/vim airline) ── */
  .bar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink);
  }
  .bar .s {
    display: flex; align-items: center; gap: 8px; padding: 0 16px;
    border-right: 1px solid var(--line); white-space: nowrap;
  }
  .bar .brand { font: 700 13px/1 var(--mono); letter-spacing: .28em; color: var(--hi); }
  .bar .k { font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .bar .v { font-size: 13px; color: var(--hi); font-variant-numeric: tabular-nums; }
  .bar .v .t { color: var(--dim); }
  .bar .grow { flex: 1; border-right: 1px solid var(--line); }
  .bar .verdict { gap: 9px; font-size: 11px; letter-spacing: .16em; text-transform: uppercase; }
  .bar .verdict.ok { color: var(--ok); }
  .bar .verdict.warn { color: var(--warn); }
  .bar .verdict.bad { color: var(--bad); }
  .bar .act { padding: 0; border-right: 1px solid var(--line); }
  .bar .act button {
    height: 100%; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer;
  }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 22px 24px 80px; max-width: 1180px; margin: 0 auto; }

  /* ── fleet ribbon ── */
  .ribbon { display: flex; gap: 2px; height: 12px; margin: 6px 0 30px; }
  .ribbon i { flex: 1 1 0; background: #1B3A2D; cursor: pointer; transition: opacity .1s; }
  .ribbon i.ok { background: #244B39; }
  .ribbon i.down { background: var(--faint); }
  .ribbon i.warn { background: var(--warn); }
  .ribbon i.bad, .ribbon i.loop { background: var(--bad); }
  .ribbon i:hover { opacity: .7; }
  /* ribbon sits under the bar → tooltip points DOWN, not up into the bar */
  .ribbon [data-tip]:hover::after { top: calc(100% + 8px); bottom: auto; }

  /* ── section ── */
  section { margin-bottom: 26px; }
  .head { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; }
  .head .label { font: 600 10px/1 var(--mono); letter-spacing: .22em; text-transform: uppercase; color: var(--dim); }
  .head .rule { flex: 1; height: 1px; background: var(--line); }
  .head .n { font: 600 11px/1 var(--mono); color: var(--dim); }

  /* ── instrument rows ── */
  .rows { border: 1px solid var(--line); }
  .row {
    display: grid; grid-template-columns: 7px 1fr auto 84px 14px;
    align-items: center; gap: 16px;
    padding: 0 16px; height: 42px;
    border-bottom: 1px solid var(--line); cursor: pointer;
    animation: fade .15s ease both;
  }
  .row:last-child { border-bottom: none; }
  .row:hover { background: var(--raised); }
  .row .name { font: 500 13px/1 var(--mono); color: var(--hi); letter-spacing: .01em; }
  .row:hover .name { color: #fff; }
  .row .why { font: 12px/1 var(--mono); text-align: right; }
  .row .why.bad { color: var(--bad); }
  .row .why.warn { color: var(--warn); }
  .row .count { font: 13px/1 var(--mono); text-align: right; color: var(--hi); font-variant-numeric: tabular-nums; }
  .row .count .t { color: var(--dim); }
  .row .chev { color: var(--faint); justify-self: end; }
  .row:hover .chev { color: var(--mid); }

  .empty { padding: 44px; text-align: center; color: var(--dim); border: 1px solid var(--line); }

  @media (max-width: 720px) {
    .bar .grow + .s, .bar .k { display: none; }
    .row { grid-template-columns: 7px 1fr auto 14px; }
    .row .why.hide-m { display: none; }
    main { padding: 18px 14px 60px; }
  }
`)
export class DashboardPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor stacks: StackSummary[] = [];
  @reactive accessor error = "";
  @reactive accessor loaded = false;
  @reactive accessor showUngrouped = false;

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
  }

  @interval(5000)
  tick() {
    if (this.auth.isAuthenticated) this.load();
  }

  private async load() {
    try {
      this.stacks = await this.rpc.call<StackSummary[]>("Stacks", "list", []);
      this.error = "";
      this.loaded = true;
    } catch (err: any) {
      this.error = err?.message ?? "Can't reach the daemon.";
    }
  }

  private visible(): StackSummary[] {
    return this.showUngrouped ? this.stacks : this.stacks.filter((s) => s.project !== UNGROUPED);
  }
  private hasUngrouped(): boolean {
    return this.stacks.some((s) => s.project === UNGROUPED);
  }
  private ranked(): Ranked[] {
    return this.visible()
      .map((s) => ({ ...s, sev: stackSeverity(s.running, s.total, s.restarting) }))
      .sort((a, b) => severityRank(a.sev) - severityRank(b.sev) || a.project.localeCompare(b.project));
  }

  private go(p: string) {
    this.router.navigate(`/stack/${encodeURIComponent(p)}`);
  }
  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  update() {
    const all = this.ranked();
    const vis = this.visible();
    const issues = all.filter((s) => s.sev === "loop" || s.sev === "warn");
    const nominal = all.filter((s) => s.sev === "ok" || s.sev === "down");
    const runC = vis.reduce((a, s) => a + s.running, 0);
    const totC = vis.reduce((a, s) => a + s.total, 0);
    const loops = all.filter((s) => s.sev === "loop").length;
    const vClass = loops > 0 ? "bad" : issues.length > 0 ? "warn" : "ok";
    const vText = issues.length === 0 ? "nominal" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`;

    return (
      <div>
        <div class="bar">
          <div class="s brand">HOPE</div>
          <div class="s"><span class="k">fleet</span></div>
          <div class="grow"></div>
          <div class="s"><span class="k">stacks</span><span class="v">{vis.length}</span></div>
          <div class="s"><span class="k">up</span><span class="v">{runC}<span class="t">/{totC}</span></span></div>
          <div class={"s verdict " + vClass}>
            <span class={"mark " + (vClass === "ok" ? "ok" : vClass)}></span>
            {vText}
          </div>
          {this.hasUngrouped() ? (
            <div class="s act">
              <button onClick={() => (this.showUngrouped = !this.showUngrouped)}>
                {this.showUngrouped ? "hide loose" : "loose"}
              </button>
            </div>
          ) : null}
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {all.length > 0 ? (
            <div class="ribbon">
              {all.map((s) => (
                <i
                  class={s.sev}
                  data-tip={`${s.project}   ${s.running}/${s.total}${s.restarting ? "   ⟳ restarting" : ""}`}
                  onClick={() => this.go(s.project)}
                ></i>
              ))}
            </div>
          ) : null}

          {issues.length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Attention</span>
                <span class="rule"></span>
                <span class="n">{issues.length}</span>
              </div>
              <div class="rows">
                {issues.map((s) => (
                  <div class="row" onClick={() => this.go(s.project)}>
                    <span class={"mark " + s.sev}></span>
                    <span class="name">{s.project}</span>
                    <span class={"why " + (s.sev === "loop" ? "bad" : "warn")}>
                      {s.sev === "loop"
                        ? `${s.containers.filter((c) => c.state === "restarting").length} restarting`
                        : `${s.total - s.running} down`}
                    </span>
                    <span class="count">
                      {s.running}
                      <span class="t">/{s.total}</span>
                    </span>
                    <loom-icon class="chev" name="chevron-right" size={15}></loom-icon>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {nominal.length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Fleet</span>
                <span class="rule"></span>
                <span class="n">{nominal.length}</span>
              </div>
              <div class="rows">
                {nominal.map((s) => (
                  <div class="row" onClick={() => this.go(s.project)}>
                    <span class={"mark " + (s.sev === "ok" ? "ok" : "")}></span>
                    <span class="name">{s.project}</span>
                    <span class="why hide-m dim">{s.sev === "down" ? "stopped" : ""}</span>
                    <span class="count">
                      {s.running}
                      <span class="t">/{s.total}</span>
                    </span>
                    <loom-icon class="chev" name="chevron-right" size={15}></loom-icon>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {this.loaded && all.length === 0 && !this.error ? (
            <div class="empty">No containers on this daemon.</div>
          ) : null}
        </main>
      </div>
    );
  }
}
