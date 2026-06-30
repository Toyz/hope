// Container detail — a terminal. Live logs + live stats (loom-rpc @stream over
// NDJSON) and the raw inspect JSON. Streams tear down on unmount via AbortSignal.
import { LoomElement, component, styles, css, reactive, unmount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter, onRouteEnter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { HopeTransport } from "../transport";
import type { LogFrame } from "../contracts";
import { theme } from "../styles";

type Tab = "logs" | "stats" | "inspect";
const MAX_LINES = 600;

@route("/container/:id")
@component("hope-container")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--ink); }

  .bar {
    position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink);
  }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .bar .back:hover { color: var(--hi); }
  .bar .crumb { font: 600 13px/1 var(--mono); letter-spacing: .04em; }
  .bar .grow { flex: 1; }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 22px 24px 48px; max-width: 1080px; margin: 0 auto; }

  .tabs { display: flex; margin-bottom: 14px; border-bottom: 1px solid var(--line); }
  .tabs button {
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim);
    background: transparent; border: 0; border-bottom: 2px solid transparent;
    padding: 11px 16px; margin-bottom: -1px; cursor: pointer;
  }
  .tabs button:hover { color: var(--mid); }
  .tabs button.active { color: var(--hi); border-bottom-color: var(--hi); }
  .tabs .wrapbtn { margin-left: auto; border-bottom-color: transparent; color: var(--dim); }
  .tabs .wrapbtn:hover { color: var(--hi); }

  pre.logs { height: 66vh; }
  pre.logs.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }

  .gauges { display: flex; gap: 56px; padding: 30px 4px; }
  .gauge .v { font: 600 36px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--hi); }
  .gauge .l { font: 600 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .2em; color: var(--dim); margin-top: 10px; }

  .err { color: var(--bad); font: 12px/1.5 var(--mono); margin-bottom: 12px; }
`)
export class ContainerPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor id = "";
  @reactive accessor tab: Tab = "logs";
  @reactive accessor logLines: string[] = [];
  @reactive accessor cpu = "—";
  @reactive accessor mem = "—";
  @reactive accessor inspectJson = "";
  @reactive accessor error = "";
  @reactive accessor wrap = false;

  private ctrl = new AbortController();

  // Fires on every activation, including container -> container navigation, so
  // the old streams are torn down and new ones started for the new id.
  @onRouteEnter
  entered(params: Record<string, string>) {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.id = decodeURIComponent(params.id ?? "");
    this.ctrl.abort();
    this.ctrl = new AbortController();
    this.logLines = [];
    this.cpu = "—";
    this.mem = "—";
    this.inspectJson = "";
    this.tab = "logs";
    this.error = "";
    this.runLogs();
    this.runStats();
  }

  @unmount
  onUnmount() {
    this.ctrl.abort();
  }

  private async runLogs() {
    try {
      for await (const f of this.rpc.streamWithSignal<LogFrame>("Stream", "logs", [this.id], this.ctrl.signal)) {
        const next = this.logLines.concat(stripAnsi(f.data).replace(/\n$/, ""));
        this.logLines = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        requestAnimationFrame(() => {
          const el = this.shadowRoot?.querySelector("pre.logs") as HTMLElement | null;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    } catch (err: any) {
      if (!this.ctrl.signal.aborted) this.error = `logs: ${err?.message ?? err}`;
    }
  }

  private async runStats() {
    try {
      for await (const s of this.rpc.streamWithSignal<any>("Stream", "stats", [this.id], this.ctrl.signal)) {
        this.applyStats(s);
      }
    } catch (err: any) {
      if (!this.ctrl.signal.aborted) this.error = `stats: ${err?.message ?? err}`;
    }
  }

  private applyStats(s: any) {
    try {
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
      const cpus = s.cpu_stats.online_cpus || (s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1);
      if (sysDelta > 0 && cpuDelta >= 0) this.cpu = ((cpuDelta / sysDelta) * cpus * 100).toFixed(1) + "%";
      const used = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.cache ?? 0);
      this.mem = `${mb(used)} / ${mb(s.memory_stats.limit ?? 0)}`;
    } catch {
      /* partial frame */
    }
  }

  private selectTab = async (t: Tab) => {
    this.tab = t;
    if (t === "inspect" && !this.inspectJson) {
      try {
        const data = await this.rpc.call<unknown>("Containers", "inspect", [this.id]);
        this.inspectJson = JSON.stringify(data, null, 2);
      } catch (err: any) {
        this.inspectJson = err?.message ?? "inspect failed";
      }
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
          <div class="s"><loom-link href="/" class="back">‹ fleet</loom-link></div>
          <div class="s"><span class="crumb">{this.id.slice(0, 16)}</span></div>
          <div class="grow"></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="err">{this.error}</div> : null}
          <div class="tabs">
            {(["logs", "stats", "inspect"] as Tab[]).map((t) => (
              <button class={this.tab === t ? "active" : ""} onClick={() => this.selectTab(t)}>
                {t}
              </button>
            ))}
            {this.tab === "logs" ? (
              <button class="wrapbtn" onClick={() => (this.wrap = !this.wrap)}>{this.wrap ? "no wrap" : "wrap"}</button>
            ) : null}
          </div>

          {this.tab === "logs" ? (
            <pre class={"logs" + (this.wrap ? " wrap" : "")}>{this.logLines.join("\n") || "Waiting for output…"}</pre>
          ) : null}

          {this.tab === "stats" ? (
            <div class="gauges">
              <div class="gauge">
                <div class="v">{this.cpu}</div>
                <div class="l">CPU</div>
              </div>
              <div class="gauge">
                <div class="v">{this.mem}</div>
                <div class="l">Memory</div>
              </div>
            </div>
          ) : null}

          {this.tab === "inspect" ? <pre>{this.inspectJson || "Loading…"}</pre> : null}
        </main>
      </div>
    );
  }
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0) + " MB";
}

// Strip ANSI color/escape sequences so colored logger output (e.g. Go pretty
// loggers) renders as clean text instead of raw escape boxes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}
