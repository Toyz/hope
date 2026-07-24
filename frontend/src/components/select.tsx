// <hope-select> — a small reusable custom dropdown that matches hope's chrome
// (mono, hairline borders, no radius) instead of the native <select>. Set the
// `options` and `value` properties; it emits a "select" CustomEvent (detail =
// chosen value) and reflects the choice on its own `value`.
//
// With `multiple`, it is a multi-select: `value` is a JSON array string, the menu
// stays open across picks, options show a check, and the trigger shows the selected
// labels (or "N selected"). The "select" event's detail is the JSON array string.
import { LoomElement, component, styles, css, reactive, on } from "@toyz/loom";
import { query } from "@toyz/loom/element";

// Estimated menu height for the flip-up decision (search box + up to a few rows).
const MENU_EST = 260;
import { theme } from "../styles";

import type { Option } from "../contracts";
export type SelectOption = Option;

@component("hope-select")
@styles(theme, css`
  :host { display: block; position: relative; }
  .trigger { display: flex; align-items: center; gap: 8px; width: 100%; height: 38px; box-sizing: border-box;
    background: var(--ink); border: 1px solid var(--line); color: var(--hi);
    font: 13px/1 var(--mono); padding: 0 12px; cursor: pointer; text-align: left; }
  .trigger:hover { border-color: var(--line2); }
  .trigger.open { border-color: var(--line2); }
  .trigger .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger .lbl.ph { color: var(--dim); }
  .trigger .cbin { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--hi); font: 13px/1 var(--mono); padding: 0; }
  .trigger .cbin:focus { outline: none; }
  .trigger .cbin::placeholder { color: var(--dim); }
  .trigger loom-icon { color: var(--dim); flex: none; transition: transform .12s ease; }
  .trigger.open loom-icon { transform: rotate(180deg); }
  /* The menu is a popover: it renders in the browser's top layer, so it escapes the
     modal's clip / stacking / shadow-DOM boundaries entirely. Positioned with fixed
     coords set in JS (see positionMenu). */
  .menu { position: fixed; margin: 0; inset: auto; padding: 0; border: 1px solid var(--line2);
    max-height: 260px; overflow: auto; background: var(--panel); box-shadow: 0 8px 24px rgba(0,0,0,.45); }
  .msearch { position: sticky; top: 0; width: 100%; box-sizing: border-box; background: var(--ink);
    border: 0; border-bottom: 1px solid var(--line); color: var(--hi); font: 12.5px/1 var(--mono); padding: 10px 12px; }
  .msearch::placeholder { color: var(--dim); }
  .msearch:focus { outline: none; }
  .opt { padding: 10px 12px; font: 13px/1.2 var(--mono); color: var(--mid); cursor: pointer;
    border-bottom: 1px solid var(--line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt:last-child { border-bottom: 0; }
  .opt:hover { background: var(--raised); color: var(--hi); }
  .opt.on { color: var(--hi); background: color-mix(in srgb, var(--upd) 10%, transparent); }
  .opt .ck { flex: none; width: 14px; text-align: center; color: var(--upd); }
  .opt .ol { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt { display: flex; align-items: center; gap: 8px; }
  .empty { padding: 12px; font: 12px/1 var(--mono); color: var(--dim); }
`)
export class HopeSelect extends LoomElement {
  @reactive accessor options: SelectOption[] = [];
  @reactive accessor value = "";
  @reactive accessor placeholder = "—";
  // Mode flags arrive as JSX attributes (<hope-select multiple>), so read them via
  // hasAttribute — a @reactive accessor reads a stale value for attribute-set props (the
  // same reason hope-button checks hasAttribute("solid")). Attribute names are lowercase.
  private get isMulti(): boolean { return this.hasAttribute("multiple"); }
  private get isCombo(): boolean { return this.hasAttribute("combobox"); }
  private get allowsCustom(): boolean { return this.hasAttribute("allow-custom"); }
  @reactive accessor open = false;
  @reactive accessor query = "";
  @query(".msearch") accessor searchEl!: HTMLInputElement | null;
  @query(".trigger") accessor triggerEl!: HTMLElement | null;
  @query(".menu") accessor menuEl!: HTMLElement | null;

  // Clicks on the trigger/options stopPropagation, so any click that reaches the
  // document is outside this dropdown — close it. Auto-unbinds on disconnect.
  @on(document, "click")
  onDoc() {
    this.close();
  }

  private openMenu(seed = "") {
    this.query = seed;
    this.open = true;
    // Position is declarative (computed in update() from the trigger rect and set as the
    // menu's style, so loom's morph preserves it across filter re-renders — imperative
    // m.style was wiped by the morph, dropping the searchable menu to the viewport's
    // top-left on the first keystroke). Here we only reveal the popover + focus the filter.
    requestAnimationFrame(() => {
      (this.menuEl as any)?.showPopover?.();
      this.searchEl?.focus();
    });
  }

  // Fixed coords pinning the top-layer menu to the trigger, flipping above when there's
  // no room below. Returned as a style object so it lives in the render (morph-preserved).
  private menuPos(): Record<string, string> {
    const t = this.triggerEl?.getBoundingClientRect();
    if (!t) return {};
    const rows = Math.min(this.options.length, 6);
    const est = Math.min(MENU_EST, rows * 40 + (this.options.length > 6 ? 42 : 0) + 8);
    const roomBelow = window.innerHeight - t.bottom;
    const base = { left: t.left + "px", minWidth: t.width + "px" };
    return roomBelow < est + 12 && t.top > roomBelow
      ? { ...base, bottom: window.innerHeight - t.top + 3 + "px", top: "auto" }
      : { ...base, top: t.bottom + 3 + "px", bottom: "auto" };
  }

  private close() {
    if (!this.open) return;
    (this.menuEl as any)?.hidePopover?.();
    this.open = false;
  }

  private toggle = (e: Event) => {
    e.stopPropagation();
    if (this.open) this.close();
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

  // The selected set. Single: 0-or-1 of `value`. Multiple: `value` is a JSON array string.
  private sel(): string[] {
    if (!this.isMulti) return this.value ? [this.value] : [];
    try { const a = JSON.parse(this.value || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
  }

  private pick = (v: string, e: Event) => {
    e.stopPropagation();
    if (this.isMulti) {
      const cur = this.sel();
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      this.value = JSON.stringify(next);
      // Keep the menu open for more picks; emit the array so the form value updates live.
      this.dispatchEvent(new CustomEvent("select", { detail: this.value, bubbles: true, composed: true }));
      this.searchEl?.focus();
      return;
    }
    this.value = v;
    this.query = "";
    this.close();
    this.dispatchEvent(new CustomEvent("select", { detail: v, bubbles: true, composed: true }));
  };

  private emitSel(detail: string) { this.dispatchEvent(new CustomEvent("select", { detail, bubbles: true, composed: true })); }

  // The label shown in a closed combobox: the option matching the current value, else the
  // raw value (a custom entry), else empty.
  private displayLabel(): string {
    const m = this.options.find((o) => o.value === this.value);
    return m ? m.label : this.value;
  }

  // --- combobox (editable single type-ahead) ---
  private cbFocus = () => {
    if (this.open) return;
    this.query = this.displayLabel(); // seed the filter with the current text so it's editable
    this.open = true;
    requestAnimationFrame(() => (this.menuEl as any)?.showPopover?.());
  };
  private cbInput = (e: any) => {
    this.query = e.target.value;
    if (!this.open) { this.open = true; requestAnimationFrame(() => (this.menuEl as any)?.showPopover?.()); }
    // With custom entry, the typed text IS the value live; otherwise it's just a filter.
    if (this.allowsCustom) { this.value = this.query; this.emitSel(this.value); }
  };
  private cbKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { this.close(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = this.query.trim().toLowerCase();
    const exact = this.options.find((o) => o.label.toLowerCase() === q);
    const contains = this.options.filter((o) => o.label.toLowerCase().includes(q));
    const match = exact || (contains.length === 1 ? contains[0] : undefined);
    if (match) this.pick(match.value, e);
    else if (this.allowsCustom && this.query.trim()) { this.value = this.query.trim(); this.close(); this.emitSel(this.value); }
  };
  private cbBlur = () => {
    // Defer so a click on an option (which commits via pick) wins over the blur.
    setTimeout(() => {
      if (!this.open) return;
      if (!this.allowsCustom) {
        // List-restricted: commit only if the typed text names an option; else keep prior value.
        const m = this.options.find((o) => o.label.toLowerCase() === this.query.trim().toLowerCase());
        if (m && m.value !== this.value) { this.value = m.value; this.emitSel(this.value); }
      }
      this.close();
    }, 130);
  };

  update() {
    const sel = this.sel();
    const q = this.query.trim().toLowerCase();
    const shown = q ? this.options.filter((o) => o.label.toLowerCase().includes(q)) : this.options;
    // Pin the popover to the trigger in the render so the coords survive filter re-renders.
    const menuStyle = this.open ? this.menuPos() : undefined;
    // Trigger label: the single choice, or the multi-select summary (labels, then "N selected").
    const lbl = ((): string => {
      if (!sel.length) return this.placeholder;
      const labels = sel.map((v) => this.options.find((o) => o.value === v)?.label ?? v);
      return this.isMulti && sel.length > 2 ? `${sel.length} selected` : labels.join(", ");
    })();
    return (
      <div>
        {this.isCombo ? (
          <div class={"trigger" + (this.open ? " open" : "")}>
            <input class="cbin" type="text" placeholder={this.placeholder} value={this.open ? this.query : this.displayLabel()}
              onFocus={this.cbFocus} onInput={this.cbInput} onKeyDown={this.cbKey} onBlur={this.cbBlur} />
            <loom-icon name="chevron-down" size={13}></loom-icon>
          </div>
        ) : (
          <button type="button" class={"trigger" + (this.open ? " open" : "")} onClick={this.toggle} onKeyDown={this.onKey}>
            <span class={"lbl" + (sel.length ? "" : " ph")}>{lbl}</span>
            <loom-icon name="chevron-down" size={13}></loom-icon>
          </button>
        )}
        {this.open ? (
          <div class="menu" style={menuStyle} {...({ popover: "manual" } as any)} onClick={(e: Event) => e.stopPropagation()}>
            {!this.isCombo && this.options.length > 6 ? (
              <input class="msearch" type="text" placeholder="filter…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            ) : null}
            {shown.length === 0 ? <div class="empty">{this.options.length === 0 ? "nothing to pick" : "no match"}</div> : null}
            {shown.map((o) => {
              const on = sel.includes(o.value);
              return (
                <div class={"opt" + (on ? " on" : "")} onClick={(e: Event) => this.pick(o.value, e)}>
                  {this.isMulti ? <span class="ck">{on ? "✓" : ""}</span> : null}
                  <span class="ol">{o.label}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }
}
