// <hope-stat label="connectors" value="1" sub="/ 1 online" tone="ok"> — one
// labelled figure in a page header's stat row. Two ways to fill the value:
//   simple:  <hope-stat label="routes" value="8"></hope-stat>
//   rich:    <hope-stat label="edge"><span class="colo">lax01</span>…</hope-stat>
// The slotted form lets a page drop in chips/links/meters; it inherits the value
// font + colour so plain text still looks right. tone recolours a simple value.
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-stat")
@styles(theme, css`
  :host { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .k { color: var(--dim); font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .v { color: var(--hi); font: 500 15px/1 var(--mono); font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 6px; }
  .v.ok { color: var(--ok); } .v.warn { color: var(--warn); } .v.bad { color: var(--bad); } .v.upd { color: var(--upd); }
  .v .t { color: var(--dim); font-size: 12px; }
  /* rich (slotted) values inherit the value font + colour from this wrapper */
  ::slotted(*) { font: 500 15px/1 var(--mono); }
`)
export class HopeStat extends LoomElement {
  @prop accessor label = "";
  @prop accessor value = "";
  @prop accessor sub = "";
  @prop accessor tone = ""; // "" | ok | warn | bad | upd

  update() {
    return (
      <>
        <div class="k">{this.label}</div>
        {this.value ? (
          <div class={"v" + (this.tone ? " " + this.tone : "")}>{this.value}{this.sub ? <span class="t">{this.sub}</span> : null}</div>
        ) : (
          <div class="v"><slot></slot></div>
        )}
      </>
    );
  }
}
