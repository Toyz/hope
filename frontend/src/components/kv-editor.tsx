// <hope-kv-editor> — the shared key/value editor for options/labels, matching
// the service-form's env/port/volume row pattern so create dialogs don't drift.
// Two modes, toggled in-place: "key → value" rows (default) and a "raw" textarea
// for pasting KEY=VALUE lines. The source of truth is a KEY=VALUE-per-line string
// on `value`; every edit emits a "change" CustomEvent with the serialized string.
import { LoomElement, component, styles, css, reactive, watch, mount } from "@toyz/loom";
import { theme } from "../styles";

type Pair = { k: string; v: string };

@component("hope-kv-editor")
@styles(theme, css`
  :host { display: block; }
  input, textarea { box-sizing: border-box; background: var(--ink); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1 var(--mono); border-radius: 0; }
  input { height: 36px; padding: 0 11px; }
  textarea { width: 100%; padding: 10px 11px; font-size: 12.5px; line-height: 1.6; resize: vertical; min-height: 76px; }
  input::placeholder, textarea::placeholder { color: var(--dim); }
  input:focus, textarea:focus { outline: none; border-color: var(--line2); }

  .hd { display: flex; align-items: center; margin-bottom: 8px; }
  .hd .grow { flex: 1; }
  .seg { display: inline-flex; }
  .seg button { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 1px solid var(--line);
    color: var(--dim); cursor: pointer; font: 600 9px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 6px 9px; }
  .seg button + button { border-left: 0; }
  .seg button loom-icon { color: var(--dim); }
  .seg button.on { color: var(--hi); background: var(--raised); border-color: var(--line2); }

  .rows { display: flex; flex-direction: column; gap: 7px; }
  .row { display: flex; align-items: center; gap: 7px; }
  .row .k { flex: 0 0 40%; min-width: 0; }
  .row .v { flex: 1; min-width: 0; }
  .rm { display: inline-grid; place-items: center; width: 34px; height: 36px; flex: none; background: transparent;
    border: 1px solid transparent; color: var(--dim); cursor: pointer; }
  .rm:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); background: var(--raised); }
  .add { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; margin-top: 8px;
    background: transparent; border: 1px dashed var(--line2); color: var(--dim); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 7px 11px; }
  .add:hover { color: var(--hi); border-color: var(--mid); }
`)
export class KvEditor extends LoomElement {
  @reactive accessor value = ""; // KEY=VALUE per line
  @reactive accessor placeholder = "";
  @reactive accessor addLabel = "entry";
  @reactive accessor mode: "rows" | "text" = "rows";
  @reactive accessor rows: Pair[] = [];

  @mount onMount() {
    this.rows = parse(this.value);
    if (!this.rows.length) this.rows = [{ k: "", v: "" }];
  }

  // Re-hydrate rows when `value` is set from outside (not by our own emit).
  @watch("value") private onValue() {
    if (serialize(this.rows) !== this.value) {
      this.rows = parse(this.value);
      if (!this.rows.length) this.rows = [{ k: "", v: "" }];
    }
  }

  private commit(s: string) {
    this.value = s;
    this.dispatchEvent(new CustomEvent("change", { detail: s, bubbles: true, composed: true }));
  }

  private upd = (i: number, patch: Partial<Pair>) => {
    this.rows = this.rows.map((r, x) => (x === i ? { ...r, ...patch } : r));
    this.commit(serialize(this.rows));
  };
  private del = (i: number) => {
    this.rows = this.rows.filter((_, x) => x !== i);
    if (!this.rows.length) this.rows = [{ k: "", v: "" }];
    this.commit(serialize(this.rows));
  };
  private add = () => {
    this.rows = [...this.rows, { k: "", v: "" }];
  };
  private onText = (v: string) => {
    this.rows = parse(v);
    this.commit(v);
  };

  update() {
    return (
      <div>
        <div class="hd">
          <span class="grow"></span>
          <div class="seg">
            <button class={this.mode === "rows" ? "on" : ""} onClick={() => (this.mode = "rows")}>key<loom-icon name="chevron-right" size={10}></loom-icon>value</button>
            <button class={this.mode === "text" ? "on" : ""} onClick={() => (this.mode = "text")}>raw</button>
          </div>
        </div>
        {this.mode === "rows" ? (
          <div>
            <div class="rows">
              {this.rows.map((r, i) => (
                <div class="row">
                  <input class="k" type="text" placeholder="KEY" value={r.k} onInput={(e: any) => this.upd(i, { k: e.target.value })} />
                  <input class="v" type="text" placeholder="value" value={r.v} onInput={(e: any) => this.upd(i, { v: e.target.value })} />
                  <button class="rm" onClick={() => this.del(i)}><loom-icon name="x" size={14}></loom-icon></button>
                </div>
              ))}
            </div>
            <button class="add" onClick={this.add}><loom-icon name="plus" size={11}></loom-icon> {this.addLabel}</button>
          </div>
        ) : (
          <textarea rows={4} placeholder={this.placeholder} value={this.value} onInput={(e: any) => this.onText(e.target.value)}></textarea>
        )}
      </div>
    );
  }
}

function parse(s: string): Pair[] {
  const out: Pair[] = [];
  for (const line of (s || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) out.push({ k: t, v: "" });
    else out.push({ k: t.slice(0, i).trim(), v: t.slice(i + 1).trim() });
  }
  return out;
}

function serialize(rows: Pair[]): string {
  return rows.filter((r) => r.k.trim()).map((r) => `${r.k.trim()}=${r.v.trim()}`).join("\n");
}
