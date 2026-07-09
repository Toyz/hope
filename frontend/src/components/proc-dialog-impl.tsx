// The real processing-dialog implementation — the lazy chunk. Loaded on demand
// by the <hope-proc> stub (see proc-dialog.tsx) the first time a long op runs.
// loom queues run() calls made before this chunk lands and replays them here.
import { LoomElement, styles, css, reactive, watch, unmount } from "@toyz/loom";
import { query } from "@toyz/loom/element";
import { theme } from "../styles";
import { signalModal } from "../modal";
import type { ProcFn } from "./proc-dialog";

@styles(theme, css`
  .modal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  .box { width: 600px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); }
  .head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .head .t { font: 600 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--hi); }
  .head .grow { flex: 1; }
  .head .n { font: 600 12px/1 var(--mono); color: var(--dim); font-variant-numeric: tabular-nums; }
  .log { height: 340px; border: 0; border-bottom: 1px solid var(--line); background: #070a0f;
    overflow: auto; white-space: pre-wrap; word-break: break-all; font: 12px/1.6 var(--mono); color: #bfc9d8; }
  .acts { display: flex; justify-content: flex-end; padding: 13px 16px; }
  .btn { font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--mid);
    background: transparent; border: 1px solid var(--line); padding: 10px 16px; cursor: pointer; }
  .btn:hover:not(:disabled) { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
`)
export default class ProcDialogImpl extends LoomElement {
  @reactive accessor open = false;
  @reactive accessor title = "";
  @reactive accessor lines: string[] = [];
  @reactive accessor done = false;

  @watch("open") private lockBody() { signalModal(this, this.open); }
  @unmount private releaseBody() { signalModal(this, false); }
  @reactive accessor ok = true;
  @query(".log") accessor logEl!: HTMLElement | null;
  private ctrl?: AbortController;

  // Run a streamed operation, showing its progress. Resolves when fn finishes
  // (the dialog stays up until the user closes it).
  async run(title: string, fn: ProcFn): Promise<void> {
    this.title = title;
    this.lines = [];
    this.done = false;
    this.ok = true;
    this.open = true;
    this.ctrl = new AbortController();
    const emit = (line: string) => {
      this.lines = [...this.lines, line];
      requestAnimationFrame(() => {
        const el = this.logEl;
        if (el) el.scrollTop = el.scrollHeight;
      });
    };
    try {
      const res = await fn(emit, this.ctrl.signal);
      if (res === false) this.ok = false;
    } catch (err: any) {
      if (!this.ctrl.signal.aborted) {
        emit("error: " + (err?.message ?? "failed"));
        this.ok = false;
      }
    } finally {
      this.done = true;
    }
  }

  private close = () => {
    this.ctrl?.abort();
    this.open = false;
  };

  update() {
    if (!this.open) return document.createComment("");
    return (
      <div class="modal">
        <div class="box">
          <div class="head">
            <span class={"mark " + (this.done ? (this.ok ? "ok" : "bad") : "loop")}></span>
            <span class="t">{this.title}</span>
            <span class="grow"></span>
            <span class="n">{this.lines.length}</span>
          </div>
          <pre class="log">{this.lines.join("\n") || "starting…"}</pre>
          <div class="acts">
            {/* Always clickable: while the op runs, this CANCELS (aborts the client's
                stream watch). The op is detached server-side (streamOp uses WithoutCancel),
                so it still completes on the host — cancel just stops watching and, crucially,
                unblocks the caller (its awaited proc.run resolves) so a slow/hung op can
                never permanently deadlock the redeploy controls. */}
            <button class="btn" onClick={this.close}>{this.done ? "Close" : "Cancel"}</button>
          </div>
        </div>
      </div>
    );
  }
}
