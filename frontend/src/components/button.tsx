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
  /* Disabled is gated on the INNER native <button disabled={this.disabled}> — set from
     the prop on every render, always correct. We must NOT gate on :host([disabled]):
     when hope-button is a slotted child (e.g. slot="actions" in hope-phead) loom updates
     the disabled PROPERTY but can leave a STALE disabled ATTRIBUTE on the host, so
     :host([disabled]){pointer-events:none} makes an ENABLED button swallow its own clicks
     (dead action buttons, no error). A native disabled button blocks the click itself —
     no pointer-events needed — so the host onClick never fires while disabled. */
  button:disabled { opacity: .4; cursor: not-allowed; }

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
  // Tooltip — a PROP named `tooltip` (NOT `tip`) so the host attribute is `tooltip`, which
  // the global `tip` @attribute ignores. Same shape as the tip attribute (a string, or
  // { text, pos } for placement); it's forwarded verbatim as `tip` to the INNER native
  // button, so the shared tooltip binds to a plain element instead of this interactive
  // component host — a `tip` @attribute on the host disrupted its click delegation (dead
  // action buttons).
  @prop accessor tooltip: string | { text?: string; pos?: string } = "";

  update() {
    // Read `disabled` from the ATTRIBUTE, not the @prop. When hope-button is a slotted
    // child (slot="actions" in hope-phead) loom re-renders it on a prop change but its
    // @prop getter returns a STALE cached value — the attribute morphs correctly while
    // this.disabled stays frozen, so an enabled button rendered a disabled native button
    // and swallowed clicks. hasAttribute reflects the live morph (same as `solid` below).
    const disabled = this.hasAttribute("disabled");
    const cls = [this.tone, this.hasAttribute("solid") ? "solid" : "", this.size === "sm" ? "sm" : ""].filter(Boolean).join(" ");
    return (
      <button class={cls} disabled={disabled} tip={this.tooltip || undefined}>
        <span class="wipe"></span>
        <span class="inner">{this.icon ? <loom-icon class={this.spin ? "spin" : ""} name={this.icon} size={13}></loom-icon> : null}<slot></slot></span>
      </button>
    );
  }
}
