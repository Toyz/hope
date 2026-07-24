// The real <hope-prompt> implementation (lazy chunk). show(opts) returns a
// promise of the field values (keyed by field.key) or null on cancel. Chrome
// matches <hope-confirm> so dialogs feel identical across the app.
import { LoomElement, styles, css, reactive, on, watch, unmount } from "@toyz/loom";
import { theme } from "../styles";
import { signalModal } from "../modal";
// NOTE: do NOT import ./plugin-surface here — it's already registered globally in
// main.tsx, and importing it into this lazy chunk created a circular dependency that
// silently broke the shared modal machinery (prompt/confirm/proc). The
// <hope-plugin-surface> tag used for selector->surface fields resolves from that
// global registration.
import type { PromptOpts, ResolvedSurface, PromptField, PromptOption } from "../prompt";

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
  /* wizard stepper */
  .steps { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 20px 2px; }
  .stepdot { display: flex; align-items: center; gap: 7px; color: var(--dim); font: 11px/1 var(--mono); letter-spacing: .02em; }
  .stepdot .sn { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1px solid var(--line2);
    border-radius: 50%; font-size: 9.5px; flex: none; }
  .stepdot.on { color: var(--hi); } .stepdot.on .sn { border-color: var(--upd); color: var(--upd); }
  .stepdot.done { color: var(--mid); } .stepdot.done .sn { border-color: var(--ok); color: var(--ok); }
  .stepdot:not(:last-child)::after { content: ""; width: 14px; height: 1px; background: var(--line2); }
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
  /* #4 inline validation error */
  .field .ferr { font: 600 11px/1.4 var(--mono); color: var(--bad); }
  .field.dynf { margin-top: -4px; padding-left: 10px; border-left: 2px solid color-mix(in srgb, var(--upd) 35%, var(--line)); }
  /* #5 number field with a unit suffix */
  .numf { display: flex; align-items: stretch; gap: 0; }
  .numf input { flex: 1; }
  .numf .unit { display: flex; align-items: center; padding: 0 12px; background: var(--ink); border: 1px solid var(--line); border-left: none;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }
  /* #5 multiselect -> <hope-select multiple> (dropdown); combobox -> <hope-select combobox>.
     chips is the inline toggle-pill variant (value is a JSON array), below. */
  .msel { display: flex; flex-wrap: wrap; gap: 7px; }
  .msel .mchip { padding: 6px 12px; border: 1px solid var(--line2); background: var(--ink); color: var(--mid); cursor: pointer;
    font: 600 11px/1 var(--mono); letter-spacing: .04em; user-select: none; transition: color .12s, border-color .12s, background .12s; }
  .msel .mchip:hover { color: var(--txt); border-color: var(--line2); }
  .msel .mchip.on { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 55%, var(--line2)); background: color-mix(in srgb, var(--upd) 12%, var(--ink)); }
  .msel .mempty { font: 11px/1.4 var(--mono); color: var(--dim); }
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
  // RPC-fetched select options per field key (optionsFetch): filled on open + re-fetched
  // when a field's dependsOn changes, so a cascading select narrows by an earlier pick.
  @reactive accessor liveOpts: Record<string, PromptOption[]> = {};
  @reactive accessor stepIdx = 0; // wizard: the current step index
  @reactive accessor fieldErrors: Record<string, string> = {}; // #4 validate: field key -> error
  @reactive accessor dynFields: Record<string, PromptField[]> = {}; // #1 fieldsFetch: parent key -> sub-fields
  @reactive accessor touched: Record<string, true> = {}; // #4: fields the user has changed
  @reactive accessor submitTried = false; // #4: became true on the first Run/Next attempt

  // #4: only surface a field's validation error once the user has touched it (or tried to
  // submit) — an untouched, freshly-opened form shows no red. Run is gated the same way.
  private showErr(key: string): string { return this.fieldErrors[key] && (this.submitTried || this.touched[key]) ? this.fieldErrors[key] : ""; }
  private runDisabled(): boolean { return this.invalid() && (this.submitTried || Object.keys(this.touched).length > 0); }

  private isWizard(): boolean { return !!this.opts.steps?.length; }
  // Every field across all steps (or the flat fields) PLUS any dynamic sub-fields — for
  // value seeding, options fetch, dependent recompute, validation, and the final submit.
  // Rendering uses curFields() (this step only).
  private allFields(): PromptField[] {
    const base = this.opts.steps ? this.opts.steps.flatMap((s) => s.fields) : this.opts.fields;
    const dyn = Object.values(this.dynFields).flat();
    return dyn.length ? [...base, ...dyn] : base;
  }

  // #4: run the plugin's validate on the current values -> per-field error map.
  private async runValidate() {
    if (!this.opts.validate) return;
    try {
      const errs = await this.opts.validate({ ...this.values });
      const map: Record<string, string> = {};
      for (const e of errs || []) if (e?.key && e?.error) map[e.key] = e.error;
      this.fieldErrors = map;
    } catch { /* keep prior errors on a transient failure */ }
  }

  // #1: a field's fieldsFetch returns a dynamic sub-form; fetch it with the current values
  // and seed the new sub-fields' initial values.
  private parseMulti(v: string): string[] { try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
  private toggleMulti(sel: string[], val: string): string[] { return sel.includes(val) ? sel.filter((x) => x !== val) : [...sel, val]; }

  private async fetchDynFields(f: PromptField) {
    if (!f.fieldsFetch) return;
    try {
      const subs = (await f.fieldsFetch({ ...this.values })) || [];
      this.dynFields = { ...this.dynFields, [f.key]: subs };
      const next = { ...this.values };
      for (const sf of subs) if (next[sf.key] === undefined) next[sf.key] = sf.value ?? "";
      this.values = next;
    } catch {
      this.dynFields = { ...this.dynFields, [f.key]: [] };
    }
  }

  private curFields(): PromptField[] { return this.opts.steps ? (this.opts.steps[this.stepIdx]?.fields ?? []) : this.opts.fields; }
  private curResolve() { return this.opts.steps ? this.opts.steps[this.stepIdx]?.resolve : this.opts.resolve; }

  // Fetch options for fields with optionsFetch, using the current values. changedKey
  // limits it to that field's dependents (after a change); omitted = every such field.
  private async fetchOpts(changedKey?: string) {
    const vals = { ...this.values };
    await Promise.all(this.allFields().map(async (f) => {
      if (!f.optionsFetch) return;
      if (changedKey && f.dependsOn !== changedKey) return; // only re-fetch dependents
      try { this.liveOpts = { ...this.liveOpts, [f.key]: (await f.optionsFetch!(vals)) || [] }; }
      catch { this.liveOpts = { ...this.liveOpts, [f.key]: [] }; }
    }));
  }

  // #8: live options — a field with refreshEvery re-fetches its options on an interval
  // while the modal is open, so a changing label stays current. Cleared on close/unmount.
  private refreshTimers: number[] = [];
  private startRefreshers() {
    this.stopRefreshers();
    for (const f of this.allFields()) {
      if (!f.optionsFetch || !f.refreshEvery || f.refreshEvery <= 0) continue;
      const key = f.key;
      const fetch = f.optionsFetch;
      const id = window.setInterval(async () => {
        try { this.liveOpts = { ...this.liveOpts, [key]: (await fetch({ ...this.values })) || [] }; } catch { /* keep prior options on a transient failure */ }
      }, f.refreshEvery * 1000);
      this.refreshTimers.push(id);
    }
  }
  private stopRefreshers() { for (const id of this.refreshTimers) window.clearInterval(id); this.refreshTimers = []; }

  // A field shows unless a dependsOn condition hides it: with dependsValue, only when the
  // dependency equals it; without, only when the dependency is non-empty.
  private shown(f: PromptField): boolean {
    if (!f.dependsOn) return true;
    const dv = this.values[f.dependsOn] ?? "";
    return f.dependsValue ? dv === f.dependsValue : !!dv;
  }

  @watch("open") private lockBody() { signalModal(this, this.open); }
  @unmount private releaseBody() { signalModal(this, false); this.stopRefreshers(); }
  private resolver: ((v: Record<string, string> | null) => void) | null = null;

  show(o: PromptOpts): Promise<Record<string, string> | null> {
    this.opts = o;
    const v: Record<string, string> = {};
    const g: Record<string, Record<string, string>[]> = {};
    // Seed ALL fields (every step) so cross-step dependencies + values exist up front.
    const all = o.steps ? o.steps.flatMap((s) => s.fields) : o.fields;
    for (const f of all) {
      if (f.type === "group") g[f.key] = [];
      else v[f.key] = f.value ?? (f.type === "select" && f.options?.length ? "" : "");
    }
    this.values = v;
    this.groups = g;
    this.liveOpts = {};
    this.fieldErrors = {};
    this.dynFields = {};
    this.touched = {};
    this.submitTried = false;
    this.stepIdx = 0;
    this.err = "";
    this.resolved = null;
    this.resolveSeq++;
    this.open = true;
    if (all.some((f) => f.optionsFetch)) void this.fetchOpts(); // initial RPC options
    this.startRefreshers(); // #8 live options
    for (const f of all) if (f.fieldsFetch && (f.value ?? "") !== "") void this.fetchDynFields(f); // #1 prefilled -> sub-form now
    if (o.validate) void this.runValidate(); // #4 initial validity
    if (this.curResolve()) this.runResolve(); // initial surface (honors any default field values)
    return new Promise((resolve) => (this.resolver = resolve));
  }

  // Call the current step's (or the flat) selector->surface resolver with the current
  // values and render the result inline. Guarded by resolveSeq so a slow earlier response
  // can't overwrite a newer selection.
  private runResolve() {
    const resolve = this.curResolve();
    if (!resolve) return;
    const seq = ++this.resolveSeq;
    this.resolving = true;
    const vals = { ...this.values };
    resolve(vals)
      .then((s) => { if (seq === this.resolveSeq) { this.resolved = s; this.resolving = false; } })
      .catch(() => { if (seq === this.resolveSeq) { this.resolved = null; this.resolving = false; } });
  }

  // --- wizard navigation ---
  private validateStep(): boolean {
    for (const f of this.curFields()) {
      if (!this.shown(f)) continue;
      if (f.type === "group") {
        if (!f.optional && (this.groups[f.key] || []).length === 0) { this.err = `${f.label} needs at least one`; return false; }
      } else if (!f.optional && !(this.values[f.key] || "").trim()) { this.err = `${f.label} is required`; return false; }
    }
    // #4: block advancing while any current-step field has a plugin validation error.
    for (const f of this.curFields()) if (this.fieldErrors[f.key]) { this.err = this.fieldErrors[f.key]; return false; }
    this.err = "";
    return true;
  }
  private next = () => {
    this.submitTried = true;
    if (!this.validateStep()) return;
    if (this.stepIdx >= (this.opts.steps!.length - 1)) { this.submit(); return; }
    this.stepIdx++;
    this.submitTried = false; // the next step starts clean — no premature errors
    this.resolved = null;
    void this.fetchOpts();      // the new step's options may depend on earlier answers
    if (this.curResolve()) this.runResolve();
  };
  private back = () => {
    if (this.stepIdx <= 0) return;
    this.stepIdx--;
    this.err = "";
    this.resolved = null;
    if (this.curResolve()) this.runResolve();
  };

  private settle(v: Record<string, string> | null) {
    if (!this.open) return;
    this.stopRefreshers(); // #8 stop live-option polling when the modal closes
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
    if (e.key === "Enter") { if (this.isWizard()) this.next(); else this.submit(); }
  }

  private set(key: string, val: string) {
    if (!this.touched[key]) this.touched = { ...this.touched, [key]: true };
    const next = { ...this.values, [key]: val };
    // Dependent fields recompute: prefill from defaultFrom, else clear so a stale
    // child value can't survive a parent change.
    for (const f of this.allFields()) {
      if (f.dependsOn === key) next[f.key] = f.defaultFrom ? f.defaultFrom(next) : "";
    }
    this.values = next;
    // Cascading: re-fetch options for any field that depends on the one that changed.
    if (this.allFields().some((f) => f.optionsFetch && f.dependsOn === key)) void this.fetchOpts(key);
    // #1: if the changed field drives a dynamic sub-form, refetch its fields.
    const chg = this.allFields().find((x) => x.key === key);
    if (chg?.fieldsFetch) void this.fetchDynFields(chg);
    // #4: re-validate on every change (the plugin decides what counts as an error).
    if (this.opts.validate) void this.runValidate();
    // Re-resolve the inline surface on a DISCRETE change (select/toggle/kv) — not on
    // every text keystroke, which would storm the plugin with RPCs.
    if (this.curResolve()) {
      const f = this.allFields().find((x) => x.key === key);
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
    if (f.type === "select") return <hope-select options={this.liveOpts[f.key] ?? (f.optionsFrom ? f.optionsFrom(scope) : f.options || [])} value={val} placeholder={f.placeholder || "—"} onSelect={(e: any) => onSet(e.detail)}></hope-select>;
    if (f.type === "toggle") return (
      <span class={"tog" + (val === "true" ? " on" : "")} onClick={() => onSet(val === "true" ? "false" : "true")}>
        <span class="sw"></span><span class="tlabel">{f.label}</span><span class="tl">{val === "true" ? "on" : "off"}</span>
      </span>
    );
    if (f.type === "textarea") return <textarea rows={3} placeholder={f.placeholder || ""} value={val} onInput={(e: any) => onSet(e.target.value)}></textarea>;
    if (f.type === "kv") return <hope-kv-editor value={val} placeholder={f.placeholder || ""} addLabel={f.addLabel || "entry"} onChange={(e: any) => onSet(e.detail)}></hope-kv-editor>;
    if (f.type === "number") return (
      <span class="numf">
        <input type="number" placeholder={f.placeholder || ""} value={val} min={f.min ?? undefined} max={f.max ?? undefined} step={f.step ?? undefined} onInput={(e: any) => onSet(e.target.value)} />
        {f.unit ? <span class="unit">{f.unit}</span> : null}
      </span>
    );
    if (f.type === "multiselect") {
      const opts = this.liveOpts[f.key] ?? (f.optionsFrom ? f.optionsFrom(scope) : f.options || []);
      return <hope-select multiple={true} options={opts} value={val} placeholder={f.placeholder || "select…"} onSelect={(e: any) => onSet(e.detail)}></hope-select>;
    }
    if (f.type === "chips") {
      const sel = this.parseMulti(val);
      const opts = this.liveOpts[f.key] ?? (f.optionsFrom ? f.optionsFrom(scope) : f.options || []);
      return (
        <div class="msel">
          {opts.map((o) => (
            <span class={"mchip" + (sel.includes(o.value) ? " on" : "")} onClick={() => onSet(JSON.stringify(this.toggleMulti(sel, o.value)))}>{o.label}</span>
          ))}
          {opts.length === 0 ? <span class="mempty">no options</span> : null}
        </div>
      );
    }
    if (f.type === "combobox") {
      const opts = this.liveOpts[f.key] ?? (f.optionsFrom ? f.optionsFrom(scope) : f.options || []);
      return <hope-select combobox={true} allow-custom={f.allowCustom ? true : undefined} options={opts} value={val} placeholder={f.placeholder || "type or pick…"} onSelect={(e: any) => onSet(e.detail)}></hope-select>;
    }
    return <input type="text" placeholder={f.placeholder || ""} value={val} onInput={(e: any) => onSet(e.target.value)} />;
  }

  private submit = () => {
    this.submitTried = true;
    const out = { ...this.values };
    for (const f of this.allFields()) {
      // A hidden (dependsOn unmet) field isn't required and doesn't submit a stale value.
      if (!this.shown(f)) { delete out[f.key]; continue; }
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
    // #4: a plugin validation error blocks the submit (Run is also disabled while invalid).
    if (this.invalid()) { this.err = Object.values(this.fieldErrors)[0]; return; }
    this.settle(out);
  };

  private invalid(): boolean { return Object.keys(this.fieldErrors).length > 0; }

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
          {this.isWizard() ? (
            <div class="steps">
              {o.steps!.map((s, i) => (
                <div class={"stepdot" + (i === this.stepIdx ? " on" : i < this.stepIdx ? " done" : "")}>
                  <span class="sn">{i < this.stepIdx ? "✓" : String(i + 1)}</span>
                  <span class="st">{s.title || "Step " + (i + 1)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {this.isWizard() && o.steps![this.stepIdx]?.hint ? <p class="msg">{o.steps![this.stepIdx].hint}</p> : o.message ? <p class="msg">{o.message}</p> : null}
          <div class="fields">
            {this.curFields().map((f) =>
              !this.shown(f) ? null :
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
                <>
                  <div class={"field" + (f.type === "toggle" ? " togfield" : "")}>
                    {f.type !== "toggle" ? <label>{f.label}</label> : null}
                    {this.control(f, this.values[f.key], (v) => this.set(f.key, v), this.values)}
                    {this.showErr(f.key) ? <span class="ferr">{this.showErr(f.key)}</span> : f.hint ? <span class="hint">{f.hint}</span> : null}
                  </div>
                  {(this.dynFields[f.key] || []).map((sf) =>
                    !this.shown(sf) ? null : (
                      <div class={"field dynf" + (sf.type === "toggle" ? " togfield" : "")}>
                        {sf.type !== "toggle" ? <label>{sf.label}</label> : null}
                        {this.control(sf, this.values[sf.key], (v) => this.set(sf.key, v), this.values)}
                        {this.showErr(sf.key) ? <span class="ferr">{this.showErr(sf.key)}</span> : sf.hint ? <span class="hint">{sf.hint}</span> : null}
                      </div>
                    ),
                  )}
                </>
              ),
            )}
          </div>
          {this.curResolve() ? (
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
            {this.isWizard() ? (
              <>
                <hope-button onClick={() => this.settle(null)}>{o.cancelLabel || "Cancel"}</hope-button>
                {this.stepIdx > 0 ? <hope-button onClick={this.back}>Back</hope-button> : null}
                <hope-button tone="primary" solid disabled={this.runDisabled()} onClick={this.next}>
                  {this.stepIdx >= o.steps!.length - 1 ? (o.submitLabel || "Finish") : "Next"}
                </hope-button>
              </>
            ) : (
              <>
                <hope-button onClick={() => this.settle(null)}>{o.cancelLabel || "Cancel"}</hope-button>
                <hope-button tone="primary" solid disabled={this.runDisabled()} onClick={this.submit}>{o.submitLabel || "Save"}</hope-button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
}
