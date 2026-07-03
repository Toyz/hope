// <hope-panel> — the site-standard section card: a bordered panel with a header
// bar (uppercase label, optional icon + step number, right-aligned actions) and
// a body. Optionally collapsible. One definition so header bars don't drift.
//
//   <hope-panel label="Public routes" icon="link" n="02">
//     <button slot="actions" ...>+ add tunnel</button>
//     …body…
//   </hope-panel>
//
// - `icon` renders a loom-icon before the label; the "actions" slot is right-
//   aligned in the header (clicks there don't toggle collapse).
// - `collapsible` makes the label area toggle the body; `collapsed` sets the
//   initial state.
// - `flush` when the body manages its own padding (tables / full-bleed rows).
import { LoomElement, component, styles, css, prop, reactive, mount, watch } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-panel")
@styles(theme, css`
  :host { display: block; margin-bottom: 14px; }
  .panel { border: 1px solid var(--line); background: var(--panel); }
  /* fixed height + centered so an icon (taller than the text) doesn't grow the bar */
  .ph { display: flex; align-items: center; gap: 10px; padding: 0 16px; min-height: 40px; box-sizing: border-box;
    border-bottom: 1px solid var(--line);
    font: 600 11px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--hi); }
  .phlabel { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ph.clickable .phlabel { cursor: pointer; }
  .ph.clickable .phlabel:hover { color: #fff; }
  .ph .n { color: var(--dim); }
  .ph loom-icon { color: var(--upd); flex: none; }
  .ph .caret { color: var(--dim); transition: transform .12s ease; }
  .ph.open .caret { transform: rotate(90deg); }
  .ph .lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ph .grow { flex: 1; }
  .pb { padding: 16px; }
  .pb.flush { padding: 0; }
`)
export class HopePanel extends LoomElement {
  @prop accessor label = "";
  @prop accessor n = "";
  @prop accessor icon = "";
  @prop accessor flush = false;
  @prop accessor collapsible = false;
  @prop accessor collapsed = false;
  @reactive accessor viewOpen = true;

  @mount onMount() {
    this.viewOpen = !this.collapsed;
  }

  // `collapsed` is controllable: a parent can drive open/closed by changing it.
  @watch("collapsed") private syncCollapse() {
    this.viewOpen = !this.collapsed;
  }

  private toggle = () => {
    if (this.collapsible) this.viewOpen = !this.viewOpen;
  };

  update() {
    const open = !this.collapsible || this.viewOpen;
    return (
      <div class="panel">
        <div class={"ph" + (open ? " open" : "") + (this.collapsible ? " clickable" : "")}>
          <span class="phlabel" onClick={this.toggle}>
            {this.collapsible ? <loom-icon class="caret" name="chevron-right" size={12}></loom-icon> : null}
            {this.n ? <span class="n">{this.n}</span> : null}
            {this.icon ? <loom-icon name={this.icon} size={13}></loom-icon> : null}
            {this.label ? <span class="lbl">{this.label}</span> : null}
          </span>
          <span class="grow"></span>
          <slot name="actions"></slot>
        </div>
        {open ? (
          <div class={"pb" + (this.flush ? " flush" : "")}>
            <slot></slot>
          </div>
        ) : null}
      </div>
    );
  }
}
