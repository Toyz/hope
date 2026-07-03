// <hope-search> — the site-standard filter box. One design for every list page:
// a bordered field with a leading search glyph and a trailing "clear" that shows
// once there's text. Emits a `search` CustomEvent (detail = current text) on
// every keystroke and on clear.
//
//   <hope-search placeholder="Search networks…" text={this.query}
//                onSearch={(e: any) => (this.query = e.detail)}></hope-search>
//
// `text` seeds/controls the value (plain attribute, not the special `value`
// prop). Read changes off the `search` event — its detail is the new string.
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-search")
@styles(theme, css`
  :host { display: block; margin-bottom: 18px; }
  .s { position: relative; }
  .s .ico { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--dim); display: flex; pointer-events: none; }
  .s input { width: 100%; box-sizing: border-box; background: var(--panel); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1 var(--mono); padding: 12px 34px 12px 38px; border-radius: 0; }
  .s input::placeholder { color: var(--dim); }
  .s input:focus { outline: none; border-color: var(--line2); }
  .s .clear { position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    background: transparent; border: 0; color: var(--dim); cursor: pointer;
    font: 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 5px; }
  .s .clear:hover { color: var(--hi); }
`)
export class HopeSearch extends LoomElement {
  @prop accessor placeholder = "Search…";
  @prop accessor text = "";

  private input = (e: any) => this.fire(e.target.value);
  private clear = () => this.fire("");

  private fire(v: string) {
    this.text = v;
    this.dispatchEvent(new CustomEvent("search", { detail: v }));
  }

  update() {
    return (
      <div class="s">
        <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
        <input type="text" placeholder={this.placeholder} value={this.text} onInput={this.input} />
        {this.text ? <button class="clear" onClick={this.clear}>clear</button> : null}
      </div>
    );
  }
}
