// <hope-inspector> — the docked right column of the explorer shell: a container's
// detail without leaving the page. Opened from a stack row (Inspector.open), it
// streams the container's logs and offers the lifecycle actions inline; "expand"
// opens the full /container page for mounts/env/networks/edit. It closes on any
// navigation (the shell drops the column), so it always reflects the current host.
import { LoomElement, component, styles, css, reactive, mount, unmount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { Inspector } from "../inspector";
import { InspectorTarget, withRefresh } from "../events";
import { withHost } from "../host-url";
import type { LogFrame } from "../contracts";
import { theme } from "../styles";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

@component("hope-inspector")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; overflow: hidden;
    background: var(--panel); border-left: 1px solid var(--line); }

  .head { padding: 15px 15px 12px; border-bottom: 1px solid var(--line); }
  .row1 { display: flex; align-items: center; gap: 9px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ok); }
  .row1 h2 { margin: 0; font: 700 15px/1 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; }
  .x { margin-left: auto; color: var(--dim); cursor: pointer; display: inline-flex; }
  .x:hover { color: var(--hi); }
  .sub { margin-top: 7px; color: var(--dim); font: 500 10.5px/1.5 var(--mono); word-break: break-all; }

  .acts { display: flex; gap: 6px; margin-top: 13px; }
  .acts .b { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 0;
    border: 1px solid var(--line2); background: transparent; color: var(--mid); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
  .acts .b:hover { color: var(--hi); border-color: var(--dim); }
  .acts .b:disabled { opacity: .5; cursor: default; }
  .acts .b.danger:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, transparent); }
  .acts .b loom-icon { flex: none; }

  .tabs { display: flex; gap: 2px; padding: 10px 12px 0; border-bottom: 1px solid var(--line); }
  .tab { padding: 8px 10px; color: var(--dim); cursor: pointer; font: 600 10px/1 var(--mono);
    letter-spacing: .1em; text-transform: uppercase; border-bottom: 1px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: var(--mid); }
  .tab.on { color: var(--hi); border-bottom-color: var(--upd); }

  .log { flex: 1; overflow-y: auto; padding: 8px 12px 14px; font: 400 11.5px/1.65 var(--mono); }
  .log .ln { color: var(--mid); white-space: pre-wrap; word-break: break-word; }
  .empty { padding: 20px 14px; color: var(--dim); font-size: 11px; }
  .cursor { display: inline-block; width: 7px; height: 12px; background: var(--upd); vertical-align: -2px; animation: blink 1.1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }
`)
export class HopeInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(Inspector) accessor insp!: Inspector;

  @reactive accessor host = "";
  @reactive accessor id = "";
  @reactive accessor name = "";
  @reactive accessor lines: string[] = [];
  @reactive accessor busy = "";
  private ac?: AbortController;

  private get router(): LoomRouter { return app.get(LoomRouter); }

  @mount
  onMount() {
    // Read the current target the opener set, then stream its logs.
    this.host = this.insp.host;
    this.id = this.insp.id;
    this.name = this.insp.name;
    this.startLogs();
  }

  @unmount
  onUnmount() { this.ac?.abort(); }

  // Target switched to another container while open — reload in place.
  @on(InspectorTarget)
  private onTarget(e: InspectorTarget) {
    if (!e.id || e.id === this.id) return;
    this.host = e.host; this.id = e.id; this.name = e.name;
    this.startLogs();
  }

  // Any navigation drops the inspector (the shell removes the column).
  @on(RouteChanged)
  private onRoute() { if (this.id) this.insp.close(); }

  private startLogs() {
    this.ac?.abort();
    this.lines = [];
    if (!this.id) return;
    const ac = new AbortController();
    this.ac = ac;
    void (async () => {
      try {
        for await (const f of this.rpc.streamWithSignal<LogFrame>("Stream", "logs", [this.id], ac.signal)) {
          if (f.type === "ping") continue;
          const next = this.lines.concat(strip(f.data).replace(/\n$/, ""));
          this.lines = next.length > 500 ? next.slice(next.length - 500) : next;
        }
      } catch { /* aborted or closed */ }
    })();
  }

  private op = (o: string) => {
    if (this.busy) return;
    this.busy = o;
    void withRefresh(async () => {
      try {
        await this.rpc.call("Containers", o, [this.id]);
        // redeploy recreates the container under a new id — hand off to the full page.
        if (o === "redeploy") this.expand();
      } finally {
        this.busy = "";
      }
    });
  };

  private expand = () => {
    if (this.id) this.router.navigate(withHost(this.host, `/container/${encodeURIComponent(this.id)}`));
  };

  update() {
    if (!this.id) return <div class="empty">Select a container.</div>;
    return (
      <>
        <div class="head">
          <div class="row1">
            <span class="dot"></span>
            <h2>{this.name || "container"}</h2>
            <span class="x" title="close" onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></span>
          </div>
          <div class="sub">{this.host} / {this.name} &middot; {this.id.slice(0, 12)}</div>
          <div class="acts">
            <button class="b" disabled={!!this.busy} onClick={() => this.op("restart")}><loom-icon name="rotate" size={12}></loom-icon>restart</button>
            <button class="b" disabled={!!this.busy} onClick={() => this.op("redeploy")}><loom-icon name="redeploy" size={12}></loom-icon>redeploy</button>
            <button class="b" onClick={this.expand}><loom-icon name="chevron-right" size={12}></loom-icon>open</button>
            <button class="b danger" disabled={!!this.busy} onClick={() => this.op("stop")}><loom-icon name="stop" size={12}></loom-icon>stop</button>
          </div>
        </div>
        <div class="tabs">
          <span class="tab on">logs</span>
          <span class="tab" onClick={this.expand}>stats</span>
          <span class="tab" onClick={this.expand}>mounts</span>
          <span class="tab" onClick={this.expand}>env</span>
          <span class="tab" onClick={this.expand}>networks</span>
        </div>
        <div class="log">
          {this.lines.length === 0 ? <div class="empty">Waiting for output&hellip;</div> : this.lines.map((l) => <div class="ln">{l}</div>)}
          {this.lines.length > 0 ? <span class="cursor"></span> : null}
        </div>
      </>
    );
  }
}
