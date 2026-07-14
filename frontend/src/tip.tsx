// The `tip` custom attribute — a zero-footprint tooltip that attaches to ANY element
// via `tip="restart"` or `tip={{ text, pos }}`, replacing the <hope-tip> WRAPPER.
//
// Built on loom 0.21's @attribute: an attribute controller is a full component
// (@prop / @reactive / @styles / update()) bound to a FOREIGN host and rendered into a
// PORTAL. No wrapper node in the flow (the old <hope-tip> was an inline-flex element
// that disrupted layout), and the styled bubble renders into document.body where an
// ancestor's overflow can't clip it. update() re-reads the host rect every render, so
// the bubble is always positioned to the button and only exists while hovered.
//
//   <button tip="restart">…</button>
//   <button tip={{ text: "close", pos: "bottom" }}>…</button>
import { attribute, LoomAttribute, reactive, prop, styles, css, on } from "@toyz/loom";

declare module "@toyz/loom/jsx-runtime" {
  interface LoomCustomAttributes {
    tip?: string | { text?: string; pos?: string };
  }
}

// The bubble design travels WITH the attribute — @styles scopes it into the controller's
// own shadow, which is teleported to the portal target. Theme vars (:root) inherit in.
const tipSheet = css`
  .bubble {
    position: fixed; z-index: 3000; pointer-events: none; white-space: nowrap;
    background: var(--ink); border: 1px solid var(--line2); color: var(--hi);
    font: 500 10.5px/1 var(--mono); letter-spacing: .03em; padding: 5px 8px;
  }
`;

type TipArg = string | { text?: string; pos?: string } | null | undefined;

@attribute("tip")
@styles(tipSheet)
export class Tip extends LoomAttribute<TipArg> {
  // Object form (tip={{ text, pos }}) binds these @prop accessors by key, exactly like
  // component props; a bare string (tip="logs") has no keys, so bareArg() maps value.
  @prop accessor text = "";
  @prop accessor pos = "top";
  @reactive accessor open = false;

  connect() {
    this.bareArg();
  }

  valueChanged() {
    this.bareArg();
  }

  // @on routes through CONNECT_HOOKS on an attribute controller exactly like on a
  // component; the resolver receives the controller, so `c => c.el` binds the host.
  // Auto-cleaned on disconnect — no manual addEventListener/track bookkeeping.
  @on((c: Tip) => c.el, "pointerenter") private onEnter() { this.open = true; }
  @on((c: Tip) => c.el, "focusin") private onFocus() { this.open = true; }
  @on((c: Tip) => c.el, "pointerleave") private onLeave() { this.open = false; }
  @on((c: Tip) => c.el, "focusout") private onBlur() { this.open = false; }

  private bareArg() {
    if (typeof this.arg !== "object" || this.arg == null) {
      this.text = this.value || "";
      this.pos = "top";
    }
  }

  update() {
    if (!this.open || !this.text) return;
    // Fresh host rect every render — the bubble follows the button, no stale coords.
    const r = this.el.getBoundingClientRect();
    const bottom = this.pos.startsWith("bottom");
    const style = {
      left: `${r.left + r.width / 2}px`,
      top: `${bottom ? r.bottom + 6 : r.top - 6}px`,
      transform: bottom ? "translateX(-50%)" : "translate(-50%, -100%)",
    };
    return <div class="bubble" style={style}>{this.text}</div>;
  }
}
