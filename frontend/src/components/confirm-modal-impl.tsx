// The real confirm-modal implementation — the lazy chunk. Loaded on demand by
// the <hope-confirm> stub (see confirm-modal.tsx) the first time a confirm is
// shown. Exposes show(opts): Promise<boolean>; loom's @lazy queues calls made
// before this chunk finishes loading and replays them here.
import { LoomElement, styles, css, reactive, on, unmount, dialog } from "@toyz/loom";
import { theme } from "../styles";
import { signalModal } from "../modal";
import type { ConfirmOpts } from "../confirm";

@styles(theme, css`
  /* A real <dialog> opened with showModal(): the browser puts it in the TOP LAYER, so it
     paints above everything with no z-index, makes the rest of the page inert, traps and
     restores focus, and paints ::backdrop for us. All of that used to be a fixed-position
     scrim div plus a window keydown listener, and the inert/focus half was simply missing. */
  dialog { border: 0; padding: 20px; margin: auto; max-width: 100%; max-height: 100%;
    background: transparent; color: inherit; overflow: visible; }
  dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); animation: fade .12s ease both; }
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
`)
export default class ConfirmModalImpl extends LoomElement {
  // @dialog drives the <dialog> in the shadow root: setting this true calls showModal(),
  // false calls close(). The DOM is the truth and writes back — Escape closes natively and
  // sets this to false without going through settle(), which is why the promise is resolved
  // from the element's `close` event rather than from the button handlers.
  @dialog accessor open = false;
  @reactive accessor opts: ConfirmOpts = { message: "" };
  private resolver: ((v: boolean) => void) | null = null;
  private choice = false; // what the user picked; a dismiss leaves it false

  // Every close path converges on the <dialog>'s native `close` event — a button, Escape,
  // or a backdrop click — so the promise resolves exactly once however the dialog went
  // away. Deliberately NOT a @watch on `open`: @dialog wraps the raw accessor and schedules
  // its own update rather than routing through @reactive, so a watch would miss the
  // write-back that Escape performs, and the caller would await forever.
  // `close` does not bubble and is not in loom's JSX event allowlist, so bind it on the
  // element itself. Guarded like loom's own __loomOverlayBound so repeated renders don't
  // stack listeners and resolve the promise more than once.
  private bindClose(el: HTMLElement) {
    const marked = el as HTMLElement & { __hopeCloseBound?: boolean };
    if (marked.__hopeCloseBound) return;
    marked.__hopeCloseBound = true;
    el.addEventListener("close", () => this.onClosed());
  }

  private onClosed() {
    signalModal(this, false);
    const r = this.resolver;
    this.resolver = null;
    r?.(this.choice);
  }

  @unmount private releaseBody() { signalModal(this, false); }

  // Called via the lazy stub. Returns a promise that settles on the user's choice.
  show(o: ConfirmOpts): Promise<boolean> {
    this.opts = o;
    this.choice = false;
    this.open = true;
    signalModal(this, true); // showModal() makes the page inert but does not lock scroll
    return new Promise<boolean>((resolve) => (this.resolver = resolve));
  }

  private settle(v: boolean) {
    if (!this.open) return;
    this.choice = v;
    this.open = false; // -> close() -> native close event -> onClosed()
  }

  // Escape is native to <dialog> now; Enter-to-confirm is not, so it stays.
  @on(window, "keydown")
  private onKey(e: KeyboardEvent) {
    if (this.open && e.key === "Enter") this.settle(true);
  }

  update() {
    // The <dialog> is ALWAYS rendered — @dialog needs it present in the shadow root to call
    // showModal()/close() on. It is invisible until opened, so there is nothing to guard.
    const o = this.opts;
    const tone = o.danger ? "danger" : "warn";
    return (
      // showModal() has no light dismiss, so keep it: a click that lands on the dialog
      // itself (the ::backdrop area) rather than the box means "outside".
      <dialog
        ref={(el) => this.bindClose(el)}
        onClick={(e: Event) => { if (e.target === e.currentTarget) this.settle(false); }}
      >
        <div class={"box " + tone}>
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
            <hope-button onClick={() => this.settle(false)}>{o.cancelLabel || "Cancel"}</hope-button>
            <hope-button tone={o.danger ? "danger" : o.warn ? "warn" : "primary"} solid onClick={() => this.settle(true)}>
              {o.confirmLabel || "Confirm"}
            </hope-button>
          </div>
        </div>
      </dialog>
    );
  }
}
