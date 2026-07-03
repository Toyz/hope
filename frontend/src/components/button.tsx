// <hope-button> — the one action button. Native <button> inside, so `click`
// bubbles (composed) straight through the shadow boundary — bind onClick on the
// element like any button. One definition replaces .btn/.tbtn/.pbtn/.ghost/.go.
//
//   <hope-button icon="rotate" onClick={this.restart}>restart</hope-button>
//   <hope-button tone="danger" icon="trash" disabled={busy} onClick={this.del}>remove</hope-button>
//   <hope-button tone="primary" size="sm" onClick={this.go}>deploy</hope-button>
//
// tone: "" (neutral) | primary | danger | warn.  size: "" (md) | sm.
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-button")
@styles(theme, css`
  :host { display: inline-flex; }
  /* disabled is driven by the host attribute (morph sets it directly), so it
     works even if a prop re-render lags: block clicks + dim, independent of the
     inner button's own :disabled. */
  :host([disabled]) { pointer-events: none; }
  :host([disabled]) button { opacity: .4; cursor: not-allowed; }
  button { display: inline-flex; align-items: center; gap: 7px; box-sizing: border-box; width: 100%;
    justify-content: center; white-space: nowrap; font: 600 11px/1 var(--mono); letter-spacing: .12em;
    text-transform: uppercase; color: var(--mid); background: transparent; border: 1px solid var(--line);
    border-radius: 0; cursor: pointer; padding: 8px 13px; transition: color .1s, border-color .1s, background .1s; }
  button loom-icon { color: var(--dim); transition: color .1s; }
  button:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  button:hover loom-icon { color: var(--hi); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .sm { padding: 6px 10px; font-size: 10px; letter-spacing: .1em; }
  .danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .danger loom-icon { color: currentColor; }
  .danger:hover { color: #fff; background: var(--bad); border-color: var(--bad); }
  .warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .warn loom-icon { color: currentColor; }
  .warn:hover { color: #06080d; background: var(--warn); border-color: var(--warn); }
  .primary { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line)); }
  .primary loom-icon { color: currentColor; }
  .primary:hover { color: #06080d; background: var(--upd); border-color: var(--upd); }
`)
export class HopeButton extends LoomElement {
  @prop accessor tone = "";
  @prop accessor size = "";
  @prop accessor icon = "";
  @prop accessor disabled = false;

  update() {
    const cls = (this.tone || "") + (this.size === "sm" ? " sm" : "");
    return (
      <button class={cls} disabled={this.disabled}>
        {this.icon ? <loom-icon name={this.icon} size={13}></loom-icon> : null}
        <slot></slot>
      </button>
    );
  }
}
