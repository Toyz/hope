// <hope-alert> — the reusable inline banner. Tone drives the border/tint/icon;
// the message is slotted so callers pass rich text (<b>, <code>). One definition
// so warnings/errors/notices read the same everywhere.
//
//   <hope-alert tone="warn">No state db mounted — <b>not persisted</b>.</hope-alert>
//
// tone: "warn" (default) | "bad" | "ok" | "info". `icon` overrides the default.
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-alert")
@styles(theme, css`
  :host { display: block; margin-bottom: 18px; }
  .a { display: flex; align-items: flex-start; gap: 11px; padding: 12px 15px;
    border: 1px solid var(--line); background: var(--panel);
    font: 12px/1.6 var(--mono); color: var(--mid); }
  .a loom-icon { flex: none; margin-top: 1px; }
  .a.warn { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); background: color-mix(in srgb, var(--warn) 8%, transparent); }
  .a.warn loom-icon { color: var(--warn); }
  .a.bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); background: color-mix(in srgb, var(--bad) 8%, transparent); }
  .a.bad loom-icon { color: var(--bad); }
  .a.ok { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); background: color-mix(in srgb, var(--ok) 8%, transparent); }
  .a.ok loom-icon { color: var(--ok); }
  .a.info { border-color: var(--line2); }
  .a.info loom-icon { color: var(--upd); }
`)
export class HopeAlert extends LoomElement {
  @prop accessor tone = "warn";
  @prop accessor icon = "";

  update() {
    const ic = this.icon || (this.tone === "ok" ? "check" : "alert");
    return (
      <div class={"a " + (this.tone || "warn")}>
        <loom-icon name={ic} size={15}></loom-icon>
        <span class="msg"><slot></slot></span>
      </div>
    );
  }
}
