// The real confirm-modal implementation — the lazy chunk. Loaded on demand by
// the <hope-confirm> stub (see confirm-modal.tsx) the first time a confirm is
// shown. Exposes show(opts): Promise<boolean>; loom's @lazy queues calls made
// before this chunk finishes loading and replays them here.
import { LoomElement, styles, css, reactive } from "@toyz/loom";
import { theme } from "../styles";
import type { ConfirmOpts } from "../confirm";

@styles(css`
  ${theme}
  .modal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
    background: rgba(4, 6, 10, .62); animation: fade .12s ease both; }
  .box { width: 440px; max-width: calc(100vw - 32px); background: var(--panel); border: 1px solid var(--line2); }
  .head { display: flex; align-items: center; gap: 9px; padding: 14px 18px; border-bottom: 1px solid var(--line);
    font: 600 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .head.danger { color: var(--bad); }
  .head.warn { color: var(--warn); }
  .msg { margin: 0; padding: 18px; font: 13px/1.6 var(--mono); color: var(--hi); }
  .acts { display: flex; justify-content: flex-end; gap: 8px; padding: 0 18px 18px; }
  .btn { font: 500 12px/1 var(--mono); color: var(--mid); background: transparent;
    border: 1px solid var(--line); border-radius: 0; padding: 8px 14px; cursor: pointer; }
  .btn:hover { color: var(--hi); border-color: var(--line2); }
  .btn.go { color: #fff; border-color: var(--bad); background: color-mix(in srgb, var(--bad) 78%, #000); }
  .btn.go:hover { background: var(--bad); }
  .btn.gowarn { color: #06080d; border-color: var(--warn); background: color-mix(in srgb, var(--warn) 82%, #000); }
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
    window.addEventListener("keydown", this.onKey);
    return new Promise<boolean>((resolve) => (this.resolver = resolve));
  }

  private settle(v: boolean) {
    if (!this.open) return;
    this.open = false;
    window.removeEventListener("keydown", this.onKey);
    const r = this.resolver;
    this.resolver = null;
    r?.(v);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.open) return;
    if (e.key === "Escape") this.settle(false);
    if (e.key === "Enter") this.settle(true);
  };

  update() {
    if (!this.open) return document.createComment("");
    const o = this.opts;
    const tone = o.danger ? "danger" : "warn";
    return (
      <div class="modal" onClick={() => this.settle(false)}>
        <div class="box" onClick={(e: Event) => e.stopPropagation()}>
          <div class={"head " + tone}>
            <loom-icon name="alert" size={16} color={o.danger ? "var(--bad)" : "var(--warn)"}></loom-icon>
            <span>{o.title || "Confirm"}</span>
          </div>
          <p class="msg">{o.message}</p>
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
