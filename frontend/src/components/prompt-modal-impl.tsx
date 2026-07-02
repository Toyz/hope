// The real <hope-prompt> implementation (lazy chunk). show(opts) returns a
// promise of the field values (keyed by field.key) or null on cancel. Chrome
// matches <hope-confirm> so dialogs feel identical across the app.
import { LoomElement, styles, css, reactive, on } from "@toyz/loom";
import { theme } from "../styles";
import type { PromptOpts } from "../prompt";

@styles(css`
  ${theme}
  .modal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
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
  .field input, .field select { width: 100%; box-sizing: border-box; background: var(--ink); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1 var(--mono); padding: 10px 12px; border-radius: 0; }
  .field input::placeholder { color: var(--dim); }
  .field input:focus, .field select:focus { outline: none; border-color: var(--line2); }
  .field .hint { font: 11px/1.4 var(--mono); color: var(--dim); }
  .tog { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
  .tog .sw { width: 34px; height: 18px; border: 1px solid var(--line2); background: var(--ink); position: relative; flex: none; transition: background .12s, border-color .12s; }
  .tog .sw::after { content: ""; position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; background: var(--dim); transition: transform .12s, background .12s; }
  .tog.on .sw { border-color: var(--upd); background: color-mix(in srgb, var(--upd) 22%, var(--ink)); }
  .tog.on .sw::after { transform: translateX(16px); background: var(--upd); }
  .tog .tl { font: 12.5px/1 var(--mono); color: var(--mid); }
  .acts { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .err { margin-right: auto; color: var(--bad); font: 11.5px/1.4 var(--mono); }
  .btn { font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--mid);
    background: transparent; border: 1px solid var(--line); border-radius: 0; padding: 10px 16px; cursor: pointer;
    transition: color .1s, border-color .1s, background .1s; }
  .btn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .btn.go { color: #06080d; border-color: var(--upd); background: color-mix(in srgb, var(--upd) 85%, #000); }
  .btn.go:hover { background: var(--upd); }
`)
export default class PromptModalImpl extends LoomElement {
  @reactive accessor open = false;
  @reactive accessor opts: PromptOpts = { fields: [] };
  @reactive accessor values: Record<string, string> = {};
  @reactive accessor err = "";
  private resolver: ((v: Record<string, string> | null) => void) | null = null;

  show(o: PromptOpts): Promise<Record<string, string> | null> {
    this.opts = o;
    const v: Record<string, string> = {};
    for (const f of o.fields) v[f.key] = f.value ?? (f.type === "select" && f.options?.length ? "" : "");
    this.values = v;
    this.err = "";
    this.open = true;
    return new Promise((resolve) => (this.resolver = resolve));
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
  }

  private submit = () => {
    for (const f of this.opts.fields) {
      if (!f.optional && !(this.values[f.key] || "").trim()) {
        this.err = `${f.label} is required`;
        return;
      }
    }
    this.settle({ ...this.values });
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
            {o.fields.map((f) => (
              <div class="field">
                <label>{f.label}</label>
                {f.type === "select" ? (
                  <hope-select options={f.optionsFrom ? f.optionsFrom(this.values) : f.options || []} value={this.values[f.key]} placeholder={f.placeholder || "—"} onSelect={(e: any) => this.set(f.key, e.detail)}></hope-select>
                ) : f.type === "toggle" ? (
                  <span class={"tog" + (this.values[f.key] === "true" ? " on" : "")} onClick={() => this.set(f.key, this.values[f.key] === "true" ? "false" : "true")}>
                    <span class="sw"></span>
                    <span class="tl">{this.values[f.key] === "true" ? "on" : "off"}</span>
                  </span>
                ) : (
                  <input type="text" placeholder={f.placeholder || ""} value={this.values[f.key]} onInput={(e: any) => this.set(f.key, e.target.value)} />
                )}
                {f.hint ? <span class="hint">{f.hint}</span> : null}
              </div>
            ))}
          </div>
          <div class="acts">
            {this.err ? <span class="err">{this.err}</span> : null}
            <button class="btn" onClick={() => this.settle(null)}>{o.cancelLabel || "Cancel"}</button>
            <button class="btn go" onClick={this.submit}>{o.submitLabel || "Save"}</button>
          </div>
        </div>
      </div>
    );
  }
}
