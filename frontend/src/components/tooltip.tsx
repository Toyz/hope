// <hope-tip text="restart"> — the reusable tooltip. Wrap any control; the label
// shows on hover/focus, positioned above (default) or below (pos="bottom", for
// controls near the top edge like a panel toolbar). One definition so every hint
// reads the same, instead of the browser's native title.
//
// pos accepts an optional "-end" suffix ("bottom-end", "top-end") that right-
// anchors the label so it grows leftward — use it for controls flush against the
// right screen edge (a docked panel's action bar) where a centered tip clips off.
//
//   <hope-tip text="restart"><button>…</button></hope-tip>
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-tip")
@styles(theme, css`
  :host { position: relative; display: inline-flex; }
  .tip {
    position: absolute; left: 50%; transform: translateX(-50%) translateY(2px);
    background: var(--ink); border: 1px solid var(--line2); color: var(--hi);
    font: 500 10.5px/1 var(--mono); letter-spacing: .03em; padding: 5px 8px; white-space: nowrap;
    opacity: 0; pointer-events: none; transition: opacity .1s ease, transform .1s ease; z-index: 200;
  }
  :host(:hover) .tip, :host(:focus-within) .tip { opacity: 1; transform: translateX(-50%) translateY(0); }
  /* right-anchored: hug the control's right edge so the label can't overflow the
     viewport on the rightmost button of a toolbar */
  .tip.end { left: auto; right: 0; transform: translateX(0) translateY(2px); }
  :host(:hover) .tip.end, :host(:focus-within) .tip.end { transform: translateX(0) translateY(0); }
  .tip.top { bottom: calc(100% + 6px); }
  .tip.bottom { top: calc(100% + 6px); }
  @media (prefers-reduced-motion: reduce) { .tip { transition: opacity .1s ease; } }
`)
export class HopeTip extends LoomElement {
  @prop accessor text = "";
  @prop accessor pos = "top"; // "top" | "bottom" | "top-end" | "bottom-end"

  update() {
    const vert = this.pos.startsWith("bottom") ? "bottom" : "top";
    const end = this.pos.endsWith("end") ? " end" : "";
    return (
      <>
        <slot></slot>
        {this.text ? <span class={"tip " + vert + end}>{this.text}</span> : null}
      </>
    );
  }
}
