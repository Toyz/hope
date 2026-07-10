// <hope-logs> — the docked MULTI-SOURCE log viewer: stack/service logs merged
// across containers, server-side ordered by timestamp (see logstream.streamMulti).
// Each line is tagged with a colored source, times are humanized, and a per-source
// filter + text search let you focus one service in a noisy 29-container stack.
// Shares the docked bottom slot with the container inspector (the shell shows one).
import { LoomElement, component, styles, css, reactive, mount, unmount, on, query } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { LogPanel } from "../log-panel";
import { LogPanelTarget } from "../events";
import type { LogFrame } from "../contracts";
import { parseLogLine, stripAnsi } from "../format";
import { theme } from "../styles";

interface LogLine { source: string; ts: string; msg: string; kind: string; }

@component("hope-logs")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }

  .bar { display: flex; align-items: stretch; height: 38px; flex: none; border-bottom: 1px solid var(--line); }
  .who { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-right: 1px solid var(--line); }
  .who .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--upd); flex: none; }
  .who .nm { font: 700 12.5px/1 var(--mono); color: var(--hi); }
  .who .sub { color: var(--dim); font: 500 10px/1 var(--mono); }
  .srch { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-right: 1px solid var(--line); min-width: 220px; }
  .srch loom-icon { color: var(--dim); }
  .srch input { flex: 1; background: transparent; border: 0; color: var(--hi); font: 12px/1 var(--mono); }
  .srch input:focus { outline: none; }
  .grow { flex: 1; }
  .acts { display: flex; align-items: stretch; border-left: 1px solid var(--line); }
  .pa { display: inline-flex; align-items: center; justify-content: center; width: 40px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .pa:hover { color: var(--hi); background: var(--raised); }
  .pa.on { color: var(--upd); }

  /* per-source filter strip — colored chips, click to hide a source */
  .srcs { flex: none; display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); overflow-x: auto; }
  .schip { display: inline-flex; align-items: center; gap: 6px; flex: none; padding: 4px 9px; cursor: pointer;
    background: transparent; border: 1px solid var(--line2); color: var(--mid); font: 600 10px/1 var(--mono); letter-spacing: .03em; white-space: nowrap; }
  .schip .sdot { width: 7px; height: 7px; border-radius: 50%; background: hsl(var(--h) 60% 58%); flex: none; }
  .schip:hover { color: var(--hi); }
  .schip.off { color: var(--dim); opacity: .5; text-decoration: line-through; }

  .body { flex: 1; min-height: 0; overflow: auto; padding: 8px 0 14px; }
  .ln { display: flex; align-items: baseline; gap: 12px; padding: 1px 14px; font: 400 11.5px/1.6 var(--mono); }
  .ln:hover { background: var(--raised); }
  .lsrc { flex: none; width: 150px; color: hsl(var(--h) 55% 66%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lts { flex: none; color: var(--dim); font-variant-numeric: tabular-nums; }
  .lmsg { color: var(--mid); white-space: pre; min-width: 0; }
  .lmsg.err { color: var(--bad); }
  .body.wrap .lmsg { white-space: pre-wrap; word-break: break-word; }
  .empty { padding: 20px 14px; color: var(--dim); font: 12px/1.4 var(--mono); }
`)
export class HopeLogs extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(LogPanel) accessor lp!: LogPanel;

  @reactive accessor host = "";
  @reactive accessor title = "";
  @reactive accessor method = "";
  @reactive accessor args: string[] = [];
  @reactive accessor lines: LogLine[] = [];
  @reactive accessor sources: string[] = []; // discovered sources, first-seen order
  @reactive accessor hiddenSrc: string[] = [];   // sources toggled off
  @reactive accessor q = "";
  @reactive accessor wrap = false;
  @query(".body") accessor bodyEl!: HTMLElement | null;
  private ac?: AbortController;
  private pinned = true;
  private buf: LogLine[] = []; // frames buffered between throttled flushes
  private newSrcs: string[] = [];
  private flushT: ReturnType<typeof setTimeout> | null = null;

  @mount
  onMount() {
    this.host = this.lp.host; this.title = this.lp.title; this.method = this.lp.method; this.args = this.lp.args;
    this.start();
  }

  @unmount
  onUnmount() { this.stop(); }

  @on(LogPanelTarget)
  private onTarget(e: LogPanelTarget) {
    if (!e.method) return; // close is handled by the shell hiding this element
    this.stop();
    this.host = e.host; this.title = e.title; this.method = e.method; this.args = e.args;
    this.lines = []; this.sources = []; this.hiddenSrc = []; this.q = ""; this.pinned = true;
    this.start();
  }

  private stop() {
    this.ac?.abort();
    if (this.flushT) { clearTimeout(this.flushT); this.flushT = null; }
    this.buf = []; this.newSrcs = [];
  }

  private project(): string { return this.args[0] || ""; }
  private shortSrc(s: string): string { const p = this.project() + "-"; return s.startsWith(p) ? s.slice(p.length) : s; }
  // Deterministic hue per source so a service keeps its color across the view.
  private hue(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }

  private start() {
    this.ac?.abort();
    const ac = new AbortController();
    this.ac = ac;
    if (!this.method) return;
    void (async () => {
      try {
        for await (const f of this.rpc.streamWithSignal<LogFrame>("Stream", this.method, this.args, ac.signal, this.host)) {
          if (f.type === "ping") continue;
          const src = f.source || "";
          if (src && !this.sources.includes(src) && !this.newSrcs.includes(src)) this.newSrcs.push(src);
          const { ts, msg } = parseLogLine(stripAnsi(f.data));
          this.buf.push({ source: src, ts, msg, kind: f.type });
          this.scheduleFlush();
        }
      } catch { /* aborted/closed */ }
    })();
  }

  // Coalesce a burst of frames into one render — a busy 29-container stack emits
  // thousands of lines fast; setting `lines` per frame would re-render the whole
  // list each time and lock the tab. Flush at ~8fps instead.
  private scheduleFlush() {
    if (this.flushT) return;
    this.flushT = setTimeout(() => { this.flushT = null; this.flush(); }, 120);
  }
  private flush() {
    if (this.newSrcs.length) { this.sources = [...this.sources, ...this.newSrcs]; this.newSrcs = []; }
    if (this.buf.length) {
      const next = this.lines.concat(this.buf);
      this.buf = [];
      this.lines = next.length > 2000 ? next.slice(next.length - 2000) : next;
      this.scrollTail();
    }
  }

  private onScroll = () => { const el = this.bodyEl; if (el) this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  private scrollTail() { if (!this.pinned) return; requestAnimationFrame(() => { const el = this.bodyEl; if (el) el.scrollTop = el.scrollHeight; }); }
  private toggleSrc(s: string) { this.hiddenSrc = this.hiddenSrc.includes(s) ? this.hiddenSrc.filter((x) => x !== s) : [...this.hiddenSrc, s]; }

  update() {
    const q = this.q.trim().toLowerCase();
    const shown = this.lines.filter((l) => !this.hiddenSrc.includes(l.source) && (!q || l.msg.toLowerCase().includes(q) || l.source.toLowerCase().includes(q)));
    return (
      <>
        <div class="bar">
          <div class="who"><span class="dot"></span><span class="nm">{this.title}</span><span class="sub">{this.sources.length} source{this.sources.length === 1 ? "" : "s"}</span></div>
          <div class="srch"><loom-icon name="search" size={13}></loom-icon><input placeholder="filter logs…" value={this.q} onInput={(e: any) => (this.q = e.target.value)} /></div>
          <span class="grow"></span>
          <div class="acts">
            <hope-tip text={this.wrap ? "no wrap" : "wrap lines"} pos="bottom"><button class={"pa" + (this.wrap ? " on" : "")} onClick={() => (this.wrap = !this.wrap)}><loom-icon name="menu" size={14}></loom-icon></button></hope-tip>
            <hope-tip text="close" pos="bottom"><button class="pa" onClick={() => this.lp.close()}><loom-icon name="x" size={15}></loom-icon></button></hope-tip>
          </div>
        </div>
        {this.sources.length > 1 ? (
          <div class="srcs">
            {this.sources.map((s) => (
              <button class={"schip" + (this.hiddenSrc.includes(s) ? " off" : "")} style={`--h:${this.hue(s)}`} onClick={() => this.toggleSrc(s)}>
                <span class="sdot"></span>{this.shortSrc(s)}
              </button>
            ))}
          </div>
        ) : null}
        <div class={"body" + (this.wrap ? " wrap" : "")} onScroll={this.onScroll}>
          {shown.length === 0 ? <div class="empty">Waiting for output&hellip;</div> : shown.map((l) => (
            <div class="ln">
              <span class="lsrc" style={`--h:${this.hue(l.source)}`}>{this.shortSrc(l.source)}</span>
              {l.ts ? <span class="lts">{l.ts}</span> : null}
              <span class={"lmsg" + (l.kind === "stderr" ? " err" : "")}>{l.msg}</span>
            </div>
          ))}
        </div>
      </>
    );
  }
}
