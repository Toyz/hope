// <hope-select> — a small reusable custom dropdown that matches hope's chrome
// (mono, hairline borders, no radius) instead of the native <select>. Set the
// `options` and `value` properties; it emits a "select" CustomEvent (detail =
// chosen value) and reflects the choice on its own `value`.
import { LoomElement, component, styles, css, reactive, on } from "@toyz/loom";
import { query } from "@toyz/loom/element";
import { theme } from "../styles";

import type { Option } from "../contracts";
export type SelectOption = Option;

@component("hope-select")
@styles(css`
  ${theme}
  :host { display: block; position: relative; }
  .trigger { display: flex; align-items: center; gap: 8px; width: 100%; height: 38px; box-sizing: border-box;
    background: var(--ink); border: 1px solid var(--line); color: var(--hi);
    font: 13px/1 var(--mono); padding: 0 12px; cursor: pointer; text-align: left; }
  .trigger:hover { border-color: var(--line2); }
  .trigger.open { border-color: var(--line2); }
  .trigger .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger .lbl.ph { color: var(--dim); }
  .trigger loom-icon { color: var(--dim); flex: none; transition: transform .12s ease; }
  .trigger.open loom-icon { transform: rotate(180deg); }
  .menu { position: absolute; left: 0; right: 0; top: calc(100% + 3px); z-index: 50;
    max-height: 260px; overflow: auto; background: var(--panel); border: 1px solid var(--line2); }
  .msearch { position: sticky; top: 0; width: 100%; box-sizing: border-box; background: var(--ink);
    border: 0; border-bottom: 1px solid var(--line); color: var(--hi); font: 12.5px/1 var(--mono); padding: 10px 12px; }
  .msearch::placeholder { color: var(--dim); }
  .msearch:focus { outline: none; }
  .opt { padding: 10px 12px; font: 13px/1.2 var(--mono); color: var(--mid); cursor: pointer;
    border-bottom: 1px solid var(--line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt:last-child { border-bottom: 0; }
  .opt:hover { background: var(--raised); color: var(--hi); }
  .opt.on { color: var(--hi); background: color-mix(in srgb, var(--upd) 10%, transparent); }
  .empty { padding: 12px; font: 12px/1 var(--mono); color: var(--dim); }
`)
export class HopeSelect extends LoomElement {
  @reactive accessor options: SelectOption[] = [];
  @reactive accessor value = "";
  @reactive accessor placeholder = "—";
  @reactive accessor open = false;
  @reactive accessor query = "";
  @query(".msearch") accessor searchEl!: HTMLInputElement | null;

  // Clicks on the trigger/options stopPropagation, so any click that reaches the
  // document is outside this dropdown — close it. Auto-unbinds on disconnect.
  @on(document, "click")
  onDoc() {
    if (this.open) this.open = false;
  }

  private openMenu(seed = "") {
    this.query = seed;
    this.open = true;
    // Focus the filter box (if this list is searchable) so typing continues there.
    setTimeout(() => this.searchEl?.focus(), 0);
  }

  private toggle = (e: Event) => {
    e.stopPropagation();
    if (this.open) this.open = false;
    else this.openMenu();
  };

  // Type-to-open: a printable key while the (focused) trigger is closed opens the
  // menu and seeds the filter, so you can search without clicking first.
  private onKey = (e: KeyboardEvent) => {
    if (this.open || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      this.openMenu();
    } else if (this.options.length > 6 && e.key.length === 1 && e.key.trim()) {
      e.preventDefault();
      this.openMenu(e.key);
    }
  };

  private pick = (v: string, e: Event) => {
    e.stopPropagation();
    this.value = v;
    this.open = false;
    this.dispatchEvent(new CustomEvent("select", { detail: v, bubbles: true, composed: true }));
  };

  update() {
    const cur = this.options.find((o) => o.value === this.value);
    const q = this.query.trim().toLowerCase();
    const shown = q ? this.options.filter((o) => o.label.toLowerCase().includes(q)) : this.options;
    return (
      <div>
        <button type="button" class={"trigger" + (this.open ? " open" : "")} onClick={this.toggle} onKeyDown={this.onKey}>
          <span class={"lbl" + (cur ? "" : " ph")}>{cur ? cur.label : this.placeholder}</span>
          <loom-icon name="chevron-down" size={13}></loom-icon>
        </button>
        {this.open ? (
          <div class="menu" onClick={(e: Event) => e.stopPropagation()}>
            {this.options.length > 6 ? (
              <input class="msearch" type="text" placeholder="filter…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            ) : null}
            {shown.length === 0 ? <div class="empty">{this.options.length === 0 ? "nothing to pick" : "no match"}</div> : null}
            {shown.map((o) => (
              <div class={"opt" + (o.value === this.value ? " on" : "")} onClick={(e: Event) => this.pick(o.value, e)}>{o.label}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
}
