// <hope-flyout> — a generic right-side drawer. Deliberately content-agnostic so ANYTHING
// can use it: a hope-plugin-surface renders a plugin's row flyout inside it, and hope's own
// pages can reuse it for their own detail panels later. It owns only the drawer chrome —
// scrim, sliding panel, header + close, body scroll, Esc / backdrop dismissal, and the
// body-scroll lock — and projects the caller's content through a slot.
//
//   <hope-flyout open={!!this.sel} title="Details" onClose={() => this.sel = null}>
//     {this.sel ? <my-content/> : null}
//   </hope-flyout>
import { LoomElement, component, styles, css, prop, watch, mount, unmount } from "@toyz/loom";
import { theme } from "../styles";
import { signalModal } from "../modal";

@component("hope-flyout")
@styles(theme, css`
  :host { display: contents; }
  .scrim { position: fixed; inset: 0; z-index: 900; background: rgba(4, 6, 10, .5); animation: ffade .12s ease both; }
  .panel { position: fixed; top: 0; right: 0; bottom: 0; z-index: 901; width: 460px; max-width: 92vw;
    background: var(--panel); border-left: 1px solid var(--line2); display: flex; flex-direction: column;
    box-shadow: -18px 0 48px rgba(0, 0, 0, .4); animation: fslide .16s cubic-bezier(.2, .8, .2, 1) both; }
  .head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); flex: none; }
  .head .t { font: 600 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--hi);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head .grow { flex: 1; }
  .x { background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer; padding: 6px;
    display: inline-flex; line-height: 0; }
  .x:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .x:focus-visible { outline: 2px solid var(--line2); outline-offset: 1px; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; }
  @keyframes ffade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes fslide { from { transform: translateX(18px); opacity: .5 } to { transform: none; opacity: 1 } }
  @media (prefers-reduced-motion: reduce) { .scrim, .panel { animation: none } }
`)
export class HopeFlyout extends LoomElement {
  @prop accessor open = false;
  @prop accessor title = "";

  @watch("open") private lock() { signalModal(this, this.open); }
  @mount private onM() { window.addEventListener("keydown", this.onKey); }
  @unmount private onU() { window.removeEventListener("keydown", this.onKey); signalModal(this, false); }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.open) { e.stopPropagation(); this.close(); }
  };
  // Dismissal (Esc, backdrop, close button) fires a "close" event — the loom convention
  // (parent binds onClose={...}, like hope-select's onSelect). The OWNER controls `open`,
  // so it flips its own state on this event; the flyout never self-closes.
  private close = () => { this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true })); };

  update() {
    if (!this.open) return document.createComment("");
    return (
      <>
        <div class="scrim" onClick={this.close}></div>
        <div class="panel" role="dialog" aria-modal="true" aria-label={this.title || "panel"}>
          <div class="head">
            <span class="t">{this.title || "Details"}</span>
            <span class="grow"></span>
            <button class="x" title="Close" onClick={this.close}><loom-icon name="x" size={13}></loom-icon></button>
          </div>
          <div class="body"><slot></slot></div>
        </div>
      </>
    );
  }
}
