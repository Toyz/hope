// <hope-phead> — the shared page header every resource/system page uses, so they
// all read the same instead of each re-rolling .vhead. Chrome only: a title row
// (health dot + heading + scope chip + meta + right-aligned "actions" slot) and a
// default slot BELOW it for the page's stat band or instrument. Like <hope-panel>,
// it's a thin slot wrapper — the page owns what goes in the band (a `.vstats` row
// of <hope-stat>, a disk/attachment meter, whatever) and renders it only when it
// has data, so there's no empty strip. Header + actions stay uniform everywhere.
//
//   <hope-phead heading="Tunnels" dot="ok" scope="local" meta="Cloudflare ingress">
//     <button slot="actions"><loom-icon name="plus"></loom-icon> connector</button>
//     <div class="vstats"><hope-stat label="routes" value="8"></hope-stat></div>
//   </hope-phead>
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-phead")
@styles(theme, css`
  :host { display: block; }
  .vhead { display: flex; align-items: center; gap: 11px; padding: 22px 28px 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--dim); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .dot.bad { background: var(--bad); } .dot.upd { background: var(--upd); }
  .dot.off { background: var(--bad); opacity: .5; }
  h1 { margin: 0; font: 700 18px/1 var(--mono); letter-spacing: .01em; color: var(--hi); }
  .meta { margin-left: 2px; color: var(--dim); font: 500 11px/1.4 var(--mono); word-break: break-all; }
  .grow { flex: 1; }

  /* actions: pages just slot <button slot="actions"> — styled here so the button
     look is uniform across every page's header */
  .acts { display: flex; align-items: center; gap: 8px; }
  ::slotted(button) { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px;
    border: 1px solid var(--line2); background: transparent; color: var(--mid); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
    transition: color .12s ease, border-color .12s ease, background .12s ease; }
  ::slotted(button:hover) { color: var(--hi); border-color: var(--dim); }
  ::slotted(button:disabled) { opacity: .5; cursor: default; }
  ::slotted(button.ic) { padding: 0 9px; }
  ::slotted(button.bad) { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line2)); }
  ::slotted(button.bad:hover) { color: #fff; background: var(--bad); border-color: var(--bad); }
`)
export class HopePhead extends LoomElement {
  @prop accessor heading = "";
  @prop accessor dot = ""; // "" | ok | warn | bad | upd | off
  @prop accessor scope = "";
  @prop accessor meta = "";

  update() {
    return (
      <>
        <div class="vhead">
          {this.dot ? <span class={"dot " + this.dot}></span> : null}
          <h1>{this.heading}</h1>
          {this.scope ? <hope-chip size="sm">{this.scope}</hope-chip> : null}
          {this.meta ? <span class="meta">{this.meta}</span> : null}
          <span class="grow"></span>
          <div class="acts"><slot name="actions"></slot></div>
        </div>
        <slot></slot>
      </>
    );
  }
}
