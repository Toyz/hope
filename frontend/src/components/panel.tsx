// <hope-panel> — the site-standard section card: a bordered panel with a header
// bar (uppercase label, optional step number, right-aligned actions) and a body.
// One definition so header bars don't drift across pages.
//
//   <hope-panel label="Public routes" icon="link" n="02">
//     <button slot="actions" ...>+ add tunnel</button>
//     …body…
//   </hope-panel>
//
// `icon` renders a loom-icon before the label; the "actions" slot is right-
// aligned in the header. Add `flush` when the body manages its own padding
// (tables / full-bleed rows).
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-panel")
@styles(theme, css`
  :host { display: block; margin-bottom: 14px; }
  .panel { border: 1px solid var(--line); background: var(--panel); }
  .ph { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line);
    font: 600 11px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--hi); }
  .ph .n { color: var(--dim); }
  .ph loom-icon { color: var(--upd); flex: none; }
  .ph .lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ph .grow { flex: 1; }
  .pb { padding: 16px; }
  .pb.flush { padding: 0; }
  /* let a panel with no visible header (label empty, no actions) drop the bar */
  .ph:empty { display: none; }
`)
export class HopePanel extends LoomElement {
  @prop accessor label = "";
  @prop accessor n = "";
  @prop accessor icon = "";
  @prop accessor flush = false;

  update() {
    return (
      <div class="panel">
        <div class="ph">
          {this.n ? <span class="n">{this.n}</span> : null}
          {this.icon ? <loom-icon name={this.icon} size={13}></loom-icon> : null}
          {this.label ? <span class="lbl">{this.label}</span> : null}
          <span class="grow"></span>
          <slot name="actions"></slot>
        </div>
        <div class={"pb" + (this.flush ? " flush" : "")}>
          <slot></slot>
        </div>
      </div>
    );
  }
}
