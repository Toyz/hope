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
  :host { display: block; margin-bottom: 16px; }
  /* flat underline field — instrument, not a boxed input; doesn't compete with the
     topbar's boxed jump-search */
  .s { position: relative; border-bottom: 1px solid var(--line); transition: border-color .12s; }
  .s:focus-within { border-bottom-color: var(--line2); }
  .s .ico { position: absolute; left: 2px; top: 50%; transform: translateY(-50%); color: var(--dim); display: flex; pointer-events: none; }
  .s input { width: 100%; box-sizing: border-box; background: transparent; border: 0;
    color: var(--hi); font: 13px/1 var(--mono); padding: 11px 40px 11px 26px; }
  .s input::placeholder { color: var(--dim); }
  .s input:focus { outline: none; }
  .s .clear { position: absolute; right: 0; top: 50%; transform: translateY(-50%);
    background: transparent; border: 0; color: var(--dim); cursor: pointer;
    font: 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; padding: 6px 4px; }
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
