// The real confirm-modal implementation — the lazy chunk. Loaded on demand by
// the <hope-confirm> stub (see confirm-modal.tsx) the first time a confirm is
// shown. Exposes show(opts): Promise<boolean>; loom's @lazy queues calls made
// before this chunk finishes loading and replays them here.
import { LoomElement, styles, css, reactive, on } from "@toyz/loom";
import { theme } from "../styles";
import type { ConfirmOpts } from "../confirm";

@styles(css`
  ${theme}
  .modal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  .box { width: 460px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2);
    border-top: 2px solid var(--line2); animation: pop .14s cubic-bezier(.2, .8, .3, 1) both; }
  .box.danger { border-top-color: var(--bad); }
  .box.warn { border-top-color: var(--warn); }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
  .head { display: flex; align-items: center; gap: 10px; padding: 17px 20px 0;
    font: 600 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .head.danger { color: var(--bad); }
  .head.warn { color: var(--warn); }
  .msg { margin: 0; padding: 13px 20px 16px; font: 13.5px/1.65 var(--sans); color: var(--hi); }
  .stats { display: flex; flex-direction: column; margin: 0 20px 6px; border: 1px solid var(--line); }
  .stats .st { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 14px; border-bottom: 1px solid var(--line); }
  .stats .st:last-child { border-bottom: 0; }
  .stats .sk { font: 600 10px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .stats .sv { font: 600 13px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; white-space: nowrap; }
  .box.danger .stats .sv { color: var(--bad); }
  .box.warn .stats .sv { color: var(--warn); }
  .acts { display: flex; justify-content: flex-end; gap: 10px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .btn { font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--mid);
    background: transparent; border: 1px solid var(--line); border-radius: 0; padding: 10px 16px; cursor: pointer;
    transition: color .1s, border-color .1s, background .1s; }
  .btn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .btn:focus-visible { outline: 1px solid var(--line2); outline-offset: 1px; }
  .btn.go { color: #fff; border-color: var(--bad); background: color-mix(in srgb, var(--bad) 80%, #000); }
  .btn.go:hover { background: var(--bad); }
  .btn.gowarn { color: #06080d; border-color: var(--warn); background: color-mix(in srgb, var(--warn) 85%, #000); }
  .btn.gowarn:hover { background: var(--warn); }
`)
export default class ConfirmModalImpl extends LoomElement {
  @reactive accessor open = false;
  @reactive accessor opts: ConfirmOpts = { message: "" };
  private resolver: ((v: boolean) => void) | null = null;

  // Called via the lazy stub. Returns a promise that settles on the user's choice.
  show(o: ConfirmOpts): Promise<boolean> {
    this.opts = o;
    this.open = true;
    return new Promise<boolean>((resolve) => (this.resolver = resolve));
  }

  private settle(v: boolean) {
    if (!this.open) return;
    this.open = false;
    const r = this.resolver;
    this.resolver = null;
    r?.(v);
  }

  // Bound once (auto-unbinds on disconnect); inert unless a dialog is open.
  @on(window, "keydown")
  private onKey(e: KeyboardEvent) {
    if (!this.open) return;
    if (e.key === "Escape") this.settle(false);
    if (e.key === "Enter") this.settle(true);
  }

  update() {
    if (!this.open) return document.createComment("");
    const o = this.opts;
    const tone = o.danger ? "danger" : "warn";
    return (
      <div class="modal" onClick={() => this.settle(false)}>
        <div class={"box " + tone} onClick={(e: Event) => e.stopPropagation()}>
          <div class={"head " + tone}>
            <loom-icon name="alert" size={16} color={o.danger ? "var(--bad)" : "var(--warn)"}></loom-icon>
            <span>{o.title || "Confirm"}</span>
          </div>
          <p class="msg">{o.message}</p>
          {o.stats && o.stats.length ? (
            <div class="stats">
              {o.stats.map((s) => (
                <span class="st"><i class="sk">{s.label}</i><i class="sv">{s.value}</i></span>
              ))}
            </div>
          ) : null}
          <div class="acts">
            <button class="btn" onClick={() => this.settle(false)}>{o.cancelLabel || "Cancel"}</button>
            <button class={"btn" + (o.danger ? " go" : o.warn ? " gowarn" : "")} onClick={() => this.settle(true)}>
              {o.confirmLabel || "Confirm"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
