// The `tip` custom attribute — a zero-footprint tooltip that attaches to ANY element
// via `tip="restart"` or `tip={{ text, pos }}`, replacing the <hope-tip> WRAPPER.
//
// Built on loom 0.21's @attribute: an attribute controller is behavior + a PORTALED
// render, no wrapper node in the flow. The old <hope-tip> was an inline-flex element
// that disrupted flex/grid layout (the cramming we hit); this adds nothing to the
// tree — the button is still just a button — and the bubble renders into document.body
// where it can't be clipped by an ancestor's overflow.
//
//   <button tip="restart">…</button>
//   <button tip={{ text: "close", pos: "bottom-end" }}>…</button>
import { attribute, LoomAttribute, reactive, prop } from "@toyz/loom";

declare module "@toyz/loom/jsx-runtime" {
  interface LoomCustomAttributes {
    tip?: string | { text?: string; pos?: string };
  }
}

let seq = 0;
// CSS Anchor Positioning natively pins the top-layer bubble to its host and flips it
// when it'd clip — no JS rect math. Not everywhere yet, so a JS fallback covers the rest.
const ANCHOR_OK = typeof CSS !== "undefined" && !!CSS.supports && CSS.supports("anchor-name: --x");
const BUBBLE = "background: var(--ink); border: 1px solid var(--line2); color: var(--hi);" +
  "font: 500 10.5px/1 var(--mono); letter-spacing: .03em; padding: 5px 8px; white-space: nowrap;" +
  "z-index: 3000; pointer-events: none;";

type TipArg = string | { text?: string; pos?: string } | null | undefined;

@attribute("tip")
export class Tip extends LoomAttribute<TipArg> {
  // The OBJECT form — tip={{ text, placement }} — binds these @prop accessors by key,
  // exactly like a component's props. The bare-string form (tip="logs") has no keys,
  // so bareArg() maps the raw attribute value onto text.
  @prop accessor text = "";
  @prop accessor pos = "top";
  @reactive accessor open = false;
  private anchor = "--tip-" + ++seq;

  connect() {
    this.bareArg();
    if (ANCHOR_OK) (this.el.style as { anchorName?: string }).anchorName = this.anchor;
    const show = () => (this.open = true);
    const hide = () => (this.open = false);
    const on = (ev: string, fn: () => void) => {
      this.el.addEventListener(ev, fn);
      this.track(() => this.el.removeEventListener(ev, fn));
    };
    on("pointerenter", show);
    on("pointerleave", hide);
    on("focusin", show);
    on("focusout", hide);
    this.track(() => { if (ANCHOR_OK) (this.el.style as { anchorName?: string }).anchorName = ""; });
  }

  valueChanged() {
    this.bareArg();
    if (this.open) this.rerender();
  }

  // A bare string tip="logs" isn't an object, so no @prop binds — map value -> text.
  private bareArg() {
    if (typeof this.arg !== "object" || this.arg == null) {
      this.text = this.value || "";
      this.pos = "top";
    }
  }

  update() {
    if (!this.open || !this.text) return;
    const bottom = this.pos.startsWith("bottom");
    if (ANCHOR_OK) {
      // Native: pin to the host's anchor, center on it, flip block-axis if it'd clip.
      this.css(".tip { position: fixed; position-anchor: " + this.anchor +
        "; position-area: " + (bottom ? "bottom" : "top") + "; justify-self: anchor-center;" +
        " margin-block: 6px; " + BUBBLE + " position-try-fallbacks: flip-block; }");
      return <div class="tip">{this.text}</div>;
    }
    // Fallback: fixed-position to the host rect after the bubble mounts (measured once).
    this.css(".tip { position: fixed; " + BUBBLE + " opacity: 0; transition: opacity .1s; } .tip.on { opacity: 1; }");
    requestAnimationFrame(() => this.place(bottom));
    return <div class="tip">{this.text}</div>;
  }

  private place(bottom: boolean) {
    const tip = this.$<HTMLElement>(".tip");
    if (!tip) return;
    const r = this.el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = bottom ? r.bottom + 6 : r.top - tr.height - 6;
    if (!bottom && top < 4) top = r.bottom + 6; // no room above -> flip below
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tr.width - 4));
    tip.style.top = top + "px";
    tip.style.left = left + "px";
    tip.classList.add("on");
  }
}
