// The real <hope-prompt> implementation (lazy chunk). show(opts) returns a
// promise of the field values (keyed by field.key) or null on cancel. Chrome
// matches <hope-confirm> so dialogs feel identical across the app.
import { LoomElement, styles, css, reactive, on, watch, unmount } from "@toyz/loom";
import { theme } from "../styles";
import { signalModal } from "../modal";
import "./plugin-surface"; // registers <hope-plugin-surface> for selector->surface fields
import type { PromptOpts, ResolvedSurface, PromptField } from "../prompt";

@styles(theme, css`
  .modal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: var(--scrim); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .box { width: 480px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2);
    border-top: 2px solid var(--upd); animation: pop .14s cubic-bezier(.2, .8, .3, 1) both; }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
  .head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 0;
    font: 600 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--hi); }
  .head .grow { flex: 1; }
  .head .x { background: transparent; border: 0; color: var(--dim); cursor: pointer; display: flex; padding: 2px; }
  .head .x:hover { color: var(--hi); }
  .msg { margin: 0; padding: 12px 20px 4px; font: 12.5px/1.6 var(--sans); color: var(--dim); }
  .fields { padding: 8px 20px 6px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
  .field label { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .field input, .field select, .field textarea { width: 100%; box-sizing: border-box; background: var(--ink); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1 var(--mono); padding: 10px 12px; border-radius: 0; }
  .field textarea { line-height: 1.6; resize: vertical; min-height: 62px; }
  .field input::placeholder, .field textarea::placeholder { color: var(--dim); }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--line2); }
  .field .hint { font: 11px/1.4 var(--mono); color: var(--dim); }
  .field.togfield { margin-bottom: 9px; }
  /* repeatable group (forms-builder): rows of a sub-form, add/remove */
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .rowitem { display: flex; align-items: flex-start; gap: 8px; border: 1px solid var(--line); background: var(--ink); padding: 10px 12px; }
  .rifields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .rifield { display: flex; flex-direction: column; gap: 5px; }
  .rifield label { font: 600 9px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .rirm { flex: none; display: flex; padding: 6px; background: transparent; border: 1px solid var(--line2); color: var(--dim); cursor: pointer; }
  .rirm:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line2)); }
  .riadd { margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; background: transparent; border: 1px dashed var(--line2);
    color: var(--mid); cursor: pointer; font: 600 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .riadd:hover { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .tog { display: flex; align-items: center; gap: 11px; cursor: pointer; user-select: none; padding: 3px 0; }
  .tog .tlabel { flex: 1; font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--mid); }
  .tog .sw { width: 34px; height: 18px; border: 1px solid var(--line2); background: var(--ink); position: relative; flex: none; transition: background .12s, border-color .12s; }
  .tog .sw::after { content: ""; position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; background: var(--dim); transition: transform .12s, background .12s; }
  .tog.on .sw { border-color: var(--upd); background: color-mix(in srgb, var(--upd) 22%, var(--ink)); }
  .tog.on .sw::after { transform: translateX(16px); background: var(--upd); }
  .tog .tl { font: 12.5px/1 var(--mono); color: var(--mid); }
  .acts { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .err { margin-right: auto; color: var(--bad); font: 11.5px/1.4 var(--mono); }
  /* selector->surface: the plugin-resolved surface rendered inline under the fields */
  .resolved { border-top: 1px solid var(--line); margin: 0 8px; max-height: 42vh; overflow: auto; }
  .resolved .rmsg { padding: 16px; color: var(--dim); font: 12px/1.4 var(--mono); text-align: center; }
`)
export default class PromptModalImpl extends LoomElement {
  @reactive accessor open = false;
  @reactive accessor opts: PromptOpts = { fields: [] };
  @reactive accessor values: Record<string, string> = {};
  @reactive accessor err = "";
  // selector->surface: the resolved surface rendered inline, and whether a resolve is
  // in flight. resolveSeq guards against out-of-order responses (last change wins).
  @reactive accessor resolved: ResolvedSurface | null = null;
  @reactive accessor resolving = false;
  private resolveSeq = 0;
  // Repeatable groups: per group-field key, the array of row value-maps (a forms-builder).
  @reactive accessor groups: Record<string, Record<string, string>[]> = {};

  @watch("open") private lockBody() { signalModal(this, this.open); }
  @unmount private releaseBody() { signalModal(this, false); }
  private resolver: ((v: Record<string, string> | null) => void) | null = null;

  show(o: PromptOpts): Promise<Record<string, string> | null> {
    this.opts = o;
    const v: Record<string, string> = {};
    const g: Record<string, Record<string, string>[]> = {};
    for (const f of o.fields) {
      if (f.type === "group") g[f.key] = [];
      else v[f.key] = f.value ?? (f.type === "select" && f.options?.length ? "" : "");
    }
    this.values = v;
    this.groups = g;
    this.err = "";
    this.resolved = null;
    this.resolveSeq++;
    this.open = true;
    if (o.resolve) this.runResolve(); // initial surface (honors any default field values)
    return new Promise((resolve) => (this.resolver = resolve));
  }

  // Call the plugin's selector->surface resolver with the current values and render the
  // result inline. Guarded by resolveSeq so a slow earlier response can't overwrite a
  // newer selection.
  private runResolve() {
    if (!this.opts.resolve) return;
    const seq = ++this.resolveSeq;
    this.resolving = true;
    const vals = { ...this.values };
    this.opts
      .resolve(vals)
      .then((s) => { if (seq === this.resolveSeq) { this.resolved = s; this.resolving = false; } })
      .catch(() => { if (seq === this.resolveSeq) { this.resolved = null; this.resolving = false; } });
  }

  private settle(v: Record<string, string> | null) {
    if (!this.open) return;
    this.open = false;
    const r = this.resolver;
    this.resolver = null;
    r?.(v);
  }

  // Bound once (auto-unbinds on disconnect); inert unless a dialog is open.
  @on(window, "keydown")
  private onKey(e: KeyboardEvent) {
    if (!this.open) return;
    if (e.key === "Escape") this.settle(null);
    if (e.key === "Enter") this.submit();
  }

  private set(key: string, val: string) {
    const next = { ...this.values, [key]: val };
    // Dependent fields recompute: prefill from defaultFrom, else clear so a stale
    // child value can't survive a parent change.
    for (const f of this.opts.fields) {
      if (f.dependsOn === key) next[f.key] = f.defaultFrom ? f.defaultFrom(next) : "";
    }
    this.values = next;
    // Re-resolve the inline surface on a DISCRETE change (select/toggle/kv) — not on
    // every text keystroke, which would storm the plugin with RPCs.
    if (this.opts.resolve) {
      const f = this.opts.fields.find((x) => x.key === key);
      if (f && f.type !== "text" && f.type !== "textarea") this.runResolve();
    }
  }

  // --- repeatable group (forms-builder) row ops ---
  private addRow(key: string, f: PromptField) {
    const row: Record<string, string> = {};
    for (const sf of f.fields || []) row[sf.key] = sf.value ?? "";
    this.groups = { ...this.groups, [key]: [...(this.groups[key] || []), row] };
  }
  private removeRow(key: string, i: number) {
    const arr = [...(this.groups[key] || [])];
    arr.splice(i, 1);
    this.groups = { ...this.groups, [key]: arr };
  }
  private setRow(key: string, i: number, sub: string, val: string) {
    const arr = (this.groups[key] || []).map((r, j) => (j === i ? { ...r, [sub]: val } : r));
    this.groups = { ...this.groups, [key]: arr };
  }

  // Renders one field's control (no label/wrapper). Shared by top-level fields and
  // group rows: `val` is the current value, `onSet` writes it, `scope` feeds optionsFrom.
  private control(f: PromptField, val: string, onSet: (v: string) => void, scope: Record<string, string>) {
    if (f.type === "select") return <hope-select options={f.optionsFrom ? f.optionsFrom(scope) : f.options || []} value={val} placeholder={f.placeholder || "—"} onSelect={(e: any) => onSet(e.detail)}></hope-select>;
    if (f.type === "toggle") return (
      <span class={"tog" + (val === "true" ? " on" : "")} onClick={() => onSet(val === "true" ? "false" : "true")}>
        <span class="sw"></span><span class="tlabel">{f.label}</span><span class="tl">{val === "true" ? "on" : "off"}</span>
      </span>
    );
    if (f.type === "textarea") return <textarea rows={3} placeholder={f.placeholder || ""} value={val} onInput={(e: any) => onSet(e.target.value)}></textarea>;
    if (f.type === "kv") return <hope-kv-editor value={val} placeholder={f.placeholder || ""} addLabel={f.addLabel || "entry"} onChange={(e: any) => onSet(e.detail)}></hope-kv-editor>;
    return <input type="text" placeholder={f.placeholder || ""} value={val} onInput={(e: any) => onSet(e.target.value)} />;
  }

  private submit = () => {
    const out = { ...this.values };
    for (const f of this.opts.fields) {
      if (f.type === "group") {
        const rows = this.groups[f.key] || [];
        if (!f.optional && rows.length === 0) {
          this.err = `${f.label} needs at least one`;
          return;
        }
        out[f.key] = JSON.stringify(rows); // action runner parses this back to an array
      } else if (!f.optional && !(this.values[f.key] || "").trim()) {
        this.err = `${f.label} is required`;
        return;
      }
    }
    this.settle(out);
  };

  update() {
    if (!this.open) return document.createComment("");
    const o = this.opts;
    return (
      <div class="modal" onClick={() => this.settle(null)}>
        <div class="box" onClick={(e: Event) => e.stopPropagation()}>
          <div class="head">
            <loom-icon name={o.icon || "link"} size={16} color="var(--upd)"></loom-icon>
            <span>{o.title || "Input"}</span>
            <span class="grow"></span>
            <button class="x" onClick={() => this.settle(null)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          {o.message ? <p class="msg">{o.message}</p> : null}
          <div class="fields">
            {o.fields.map((f) =>
              f.type === "group" ? (
                <div class="field group">
                  <label>{f.label}</label>
                  <div class="rows">
                    {(this.groups[f.key] || []).map((row, i) => (
                      <div class="rowitem">
                        <div class="rifields">
                          {(f.fields || []).map((sf) => (
                            <div class={"rifield" + (sf.type === "toggle" ? " togfield" : "")}>
                              {sf.type !== "toggle" ? <label>{sf.label}</label> : null}
                              {this.control(sf, row[sf.key] ?? "", (v) => this.setRow(f.key, i, sf.key, v), row)}
                            </div>
                          ))}
                        </div>
                        <button class="rirm" title="remove" onClick={() => this.removeRow(f.key, i)}><loom-icon name="trash" size={13}></loom-icon></button>
                      </div>
                    ))}
                  </div>
                  <button class="riadd" onClick={() => this.addRow(f.key, f)}><loom-icon name="plus" size={12}></loom-icon>{f.addLabel || "add"}</button>
                  {f.hint ? <span class="hint">{f.hint}</span> : null}
                </div>
              ) : (
                <div class={"field" + (f.type === "toggle" ? " togfield" : "")}>
                  {f.type !== "toggle" ? <label>{f.label}</label> : null}
                  {this.control(f, this.values[f.key], (v) => this.set(f.key, v), this.values)}
                  {f.hint ? <span class="hint">{f.hint}</span> : null}
                </div>
              ),
            )}
          </div>
          {o.resolve ? (
            <div class="resolved">
              {this.resolved ? (
                <hope-plugin-surface surface={this.resolved}></hope-plugin-surface>
              ) : this.resolving ? (
                <div class="rmsg">loading…</div>
              ) : (
                <div class="rmsg">select an option to preview</div>
              )}
            </div>
          ) : null}
          <div class="acts">
            {this.err ? <span class="err">{this.err}</span> : null}
            <hope-button onClick={() => this.settle(null)}>{o.cancelLabel || "Cancel"}</hope-button>
            <hope-button tone="primary" solid onClick={this.submit}>{o.submitLabel || "Save"}</hope-button>
          </div>
        </div>
      </div>
    );
  }
}
