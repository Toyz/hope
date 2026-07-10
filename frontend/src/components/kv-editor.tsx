// <hope-kv-editor> — the shared key/value editor for options/labels, matching
// the service-form's env/port/volume row pattern so create dialogs don't drift.
// Two modes, toggled in-place: "key → value" rows (default) and a "raw" textarea
// for pasting KEY=VALUE lines. The source of truth is a KEY=VALUE-per-line string
// on `value`; every edit emits a "change" CustomEvent with the serialized string.
import { LoomElement, component, styles, css, reactive, watch, mount } from "@toyz/loom";
import { theme } from "../styles";
import { kvParse as parse, kvSerialize as serialize, type KvPair } from "../format";

type Pair = KvPair;

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
                  <hope-button icon="x" size="sm" onClick={() => this.del(i)}></hope-button>
                </div>
              ))}
            </div>
            <hope-button icon="plus" size="sm" onClick={this.add}>{this.addLabel}</hope-button>
          </div>
        ) : (
          <textarea rows={4} placeholder={this.placeholder} value={this.value} onInput={(e: any) => this.onText(e.target.value)}></textarea>
        )}
      </div>
    );
  }
}
