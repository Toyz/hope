// <hope-button> — the one action button. Native <button> inside, so `click`
// bubbles (composed) through the shadow boundary — bind onClick like any button.
// Replaces .btn/.tbtn/.pbtn/.ghost/.go.
//
//   <hope-button icon="rotate" onClick={this.restart}>restart</hope-button>
//   <hope-button tone="danger" icon="trash" disabled={busy} onClick={this.del}>remove</hope-button>
//   <hope-button tone="primary" solid={true} onClick={this.go}>deploy stack</hope-button>
//
// tone: "" (neutral) | primary | danger | warn.  size: "" (md) | sm.
// solid: filled by default (CTAs) instead of outline. On hover an outline button
// fills with its accent via a left-to-right "terminal" wipe.
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-button")
@styles(theme, css`
  :host { display: inline-flex; }
  /* disabled is driven by the host attribute (morph sets it directly), so it
     works even if a prop re-render lags: block clicks + dim. */
  :host([disabled]) { pointer-events: none; }
  :host([disabled]) button { opacity: .4; cursor: not-allowed; }

  button { position: relative; overflow: hidden; display: inline-flex; align-items: center; justify-content: center;
    box-sizing: border-box; width: 100%; white-space: nowrap; font: 600 11px/1 var(--mono); letter-spacing: .12em;
    text-transform: uppercase; color: var(--mid); background: transparent; border: 1px solid var(--line);
    border-radius: 0; cursor: pointer; padding: 8px 13px; transition: color .15s ease, border-color .15s ease; }
  .inner { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 7px; }
  .inner loom-icon { color: var(--dim); transition: color .15s ease; }

  /* terminal fill — the accent wipes in from the left on hover */
  .wipe { position: absolute; inset: 0; z-index: 0; background: var(--raised); transform: scaleX(0);
    transform-origin: left; transition: transform .2s cubic-bezier(.4, 0, .2, 1); }
  button:hover { color: var(--hi); border-color: var(--line2); }
  button:hover .inner loom-icon { color: var(--hi); }
  button:hover .wipe { transform: scaleX(1); }
  button:active { transform: translateY(1px); }

  /* tones: outline that fills to the accent on hover (wipe colour + hovered text) */
  .danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .danger .wipe { background: var(--bad); }
  .danger:hover, .danger:hover .inner loom-icon { color: #fff; }
  .danger:hover { border-color: var(--bad); }
  .warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .warn .wipe { background: var(--warn); }
  .warn:hover, .warn:hover .inner loom-icon { color: var(--on-accent); }
  .warn:hover { border-color: var(--warn); }
  .primary { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line)); }
  .primary .wipe { background: var(--upd); }
  .primary:hover, .primary:hover .inner loom-icon { color: var(--on-accent); }
  .primary:hover { border-color: var(--upd); }

  /* idle icon matches the button's tone (the base rule pins it to var(--dim),
     which leaves a toned button's accent text next to a grey icon). */
  .danger .inner loom-icon { color: var(--bad); }
  .warn .inner loom-icon { color: var(--warn); }
  .primary .inner loom-icon { color: var(--upd); }

  /* solid: filled by default (primary CTAs). No wipe — brightness on hover. */
  .solid .wipe { display: none; }
  .solid.primary { background: var(--upd); color: var(--on-accent); border-color: var(--upd); }
  .solid.primary .inner loom-icon { color: var(--on-accent); }
  .solid.primary:hover { background: color-mix(in srgb, var(--upd) 86%, #fff); }
  .solid.danger { background: var(--bad); color: #fff; border-color: var(--bad); }
  .solid.danger .inner loom-icon { color: #fff; }
  .solid.danger:hover { background: color-mix(in srgb, var(--bad) 86%, #fff); }
  .solid.warn { background: var(--warn); color: var(--on-accent); border-color: var(--warn); }
  .solid.warn .inner loom-icon { color: var(--on-accent); }
  .solid.warn:hover { background: color-mix(in srgb, var(--warn) 86%, #fff); }

  .sm { padding: 6px 10px; font-size: 10px; letter-spacing: .1em; }

  @media (prefers-reduced-motion: reduce) {
    .wipe { transition: none; }
    button:active { transform: none; }
  }
`)
export class HopeButton extends LoomElement {
  @prop accessor tone = "";
  @prop accessor size = "";
  @prop accessor icon = "";
  @prop accessor disabled = false;
  @prop accessor spin = false; // spin the icon (e.g. a refresh in flight)

  update() {
    const cls = [this.tone, this.hasAttribute("solid") ? "solid" : "", this.size === "sm" ? "sm" : ""].filter(Boolean).join(" ");
    return (
      <button class={cls} disabled={this.disabled}>
        <span class="wipe"></span>
        <span class="inner">{this.icon ? <loom-icon class={this.spin ? "spin" : ""} name={this.icon} size={13}></loom-icon> : null}<slot></slot></span>
      </button>
    );
  }
}
