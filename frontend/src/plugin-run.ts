// Shared plugin-action runner — the single implementation of "invoke a plugin
// action": collect its fields, confirm if destructive, proxy the call (audited),
// and toast the result. Used by both the surface renderer (leaf + row actions) and
// the page header (phead action slot), so the flow isn't reimplemented per surface.
import type { HopeTransport } from "./transport";
import type { PromptService, PromptField, PromptOption } from "./prompt";
import type { ConfirmService } from "./confirm";
import type { ToastService } from "./toast";

export interface PluginActionDesc {
  method: string;
  label: string;
  icon?: string;
  danger?: boolean;
  fields?: PromptField[];
  // A wizard: stepped fields rendered one page at a time (Back/Next/Finish). Values
  // accumulate across steps; the action still receives one merged value map.
  steps?: { title?: string; hint?: string; fields: PromptField[] }[];
  prefill?: Record<string, string>; // #3: explicit initial values (merged over row/param context)
  validateMethod?: string;          // #4: method returning [{key,error}] to gate the submit
  confirmMethod?: string;           // #6: method returning a go/no-go payload shown before running
}

export interface RunDeps {
  rpc: HopeTransport;
  prompt: PromptService;
  confirm: ConfirmService;
  toast: ToastService;
}

// ActionOutcome is what runPluginAction reports to callers so they can react to the
// plugin's state, not guess. `ok` is false when the plugin refused (result ok:false
// or a JSON-RPC error); `refetch` is the plugin's hint on whether the owning view
// changed (default true on success, false on failure).
export interface ActionOutcome {
  ok: boolean;
  refetch: boolean;
  result?: any;
  // #7 rich result directive, extracted from the plugin's result so the caller (which
  // owns the router + flyout) can act on it: jump to a route, or open a component surface
  // in the right-side drawer, right after the action succeeds.
  directive?: ActionDirective;
}

// #7: a post-action UI directive returned by an action handler.
export interface ActionDirective {
  navigate?: string;            // route to navigate to (relative to the app)
  flyout?: any;                 // a component node to open in the right-side drawer
  flyoutTitle?: string;         // drawer title (default "Result")
  flyoutWidth?: string;         // "" | "large" | a CSS width
}

// The plugin's action RESULT CONTRACT — any/all optional. hope interprets these so
// the plugin can pass state back and the user understands what happened:
//   { "ok": false, "message": "can't delete: 3 children" }  -> error toast, no refetch
//   { "message": "Deleted user 42" }                          -> success toast + refetch
//   { "refetch": false }                                      -> success, view unchanged
//   { "level": "info", "message": "queued" }                  -> info toast
// A thrown JSON-RPC error is always an error toast. Absence of a result = success.
interface PluginResult {
  ok?: boolean;
  message?: string;
  level?: "ok" | "info" | "error";
  refetch?: boolean;
  // #7 rich result: a plugin action can steer the UI after it runs — jump to a route, or
  // open a component surface in the right-side drawer (e.g. the new order's lifecycle).
  navigate?: string;
  flyout?: any;
  flyoutTitle?: string;
  flyoutWidth?: string;
}

// attachFieldOptions wires an async optionsFetch on any field with an optionsMethod: the
// modal calls it with the CURRENT values (when the form opens, and again when a dependsOn
// field changes), so a cascading select narrows its choices by an earlier pick. The
// plugin's Options(ctx) reads those values via Params(ctx) — same wiring as a resolve
// method. No static pre-fetch: the modal owns the lifecycle so it stays live.
function attachFieldOptions(deps: RunDeps, surfaceKey: string, fields: PromptField[]): PromptField[] {
  return fields.map((f) => {
    let out = f;
    if (f.optionsMethod) {
      const method = f.optionsMethod;
      out = {
        ...out,
        optionsFetch: async (vals: Record<string, string>) => {
          try {
            const opts = await deps.rpc.call<PromptOption[]>("Plugins", "call", [{ key: surfaceKey, method, args: vals, audit: false }]);
            return Array.isArray(opts) ? opts : [];
          } catch {
            return [];
          }
        },
      };
    }
    // #1: a fieldsMethod turns this field's change into a dynamic sub-form. The returned
    // schema is itself wired (its sub-fields may carry their own optionsMethod/dependsOn).
    if (f.fieldsMethod) {
      const method = f.fieldsMethod;
      out = {
        ...out,
        fieldsFetch: async (vals: Record<string, string>) => {
          try {
            const raw = await deps.rpc.call<PromptField[]>("Plugins", "call", [{ key: surfaceKey, method, args: vals, audit: false }]);
            return Array.isArray(raw) ? attachFieldOptions(deps, surfaceKey, raw) : [];
          } catch {
            return [];
          }
        },
      };
    }
    return out;
  });
}

// runPluginAction runs an action and returns a structured ActionOutcome, or
// undefined if the user cancelled a field prompt / danger confirm. Callers use the
// outcome to decide whether to refetch — the plugin, not hope, owns that decision.
export async function runPluginAction(
  deps: RunDeps,
  surfaceKey: string,
  a: PluginActionDesc,
  extra?: Record<string, any>,
  param?: Record<string, any>,
  opts?: { quiet?: boolean }, // quiet: skip the SUCCESS toast (inline edits); errors always toast
): Promise<ActionOutcome | undefined> {
  let values: Record<string, any> | undefined;
  // A resolver for a field-set: if any field names a resolve method, wire a call that
  // renders the plugin's returned component surface inline (closes over the RPC so the
  // generic prompt stays rpc-free). Shared by flat forms and per-wizard-step.
  const mkResolve = (fields: PromptField[]) => {
    const rm = fields.find((f) => f.resolveMethod)?.resolveMethod;
    if (!rm) return undefined;
    return async (vals: Record<string, string>) => {
      try {
        const comp = await deps.rpc.call<any>("Plugins", "call", [{ key: surfaceKey, method: rm, args: vals, audit: false }]);
        return comp ? { key: surfaceKey, node: { kind: "component", comp }, schema: {} } : null;
      } catch {
        return null;
      }
    };
  };
  // Context prefill (#3): seed a field's initial value from the invoking page param + the
  // clicked row's columns + an explicit Prefill, where the field Key matches — so
  // commanding from a satellite's row pre-selects that satellite. The user can still edit;
  // the form value wins on submit. A validate method gates the submit if present.
  const pctx: Record<string, any> = { ...(param || {}), ...(((extra as any)?.row as Record<string, any>) || {}), ...(a.prefill || {}) };
  const prefill = (fs: PromptField[]): PromptField[] =>
    Object.keys(pctx).length ? fs.map((f) => (f.type !== "group" && pctx[f.key] != null ? { ...f, value: String(pctx[f.key]) } : f)) : fs;
  // A validate method (a.validateMethod): the modal calls it on change and gates Run on the
  // returned per-field errors. Closes over the RPC + surface key.
  const vmethod = a.validateMethod;
  const validate = vmethod
    ? async (vals: Record<string, string>) => {
        try {
          const errs = await deps.rpc.call<any>("Plugins", "call", [{ key: surfaceKey, method: vmethod, args: vals, audit: false }]);
          return Array.isArray(errs) ? errs : errs?.errors || [];
        } catch {
          return [];
        }
      }
    : undefined;
  if (a.steps && a.steps.length) {
    // Wizard: each step gets its fields wired (prefill + cascading options + per-step resolve).
    const steps = a.steps.map((s) => ({ title: s.title, hint: s.hint, fields: attachFieldOptions(deps, surfaceKey, prefill(s.fields)), resolve: mkResolve(s.fields) }));
    const v = await deps.prompt.ask({ title: a.label, submitLabel: "Finish", fields: [], steps, validate });
    if (!v) return undefined;
    values = v;
  } else if (a.fields && a.fields.length) {
    const fields = attachFieldOptions(deps, surfaceKey, prefill(a.fields));
    const v = await deps.prompt.ask({ title: a.label, submitLabel: "Run", fields, resolve: mkResolve(a.fields), validate });
    if (!v) return undefined;
    values = v;
  }
  if (a.danger && !(await deps.confirm.ask({ title: a.label, message: `Run "${a.label}"? This is a destructive action.`, danger: true, confirmLabel: a.label }))) {
    return undefined;
  }
  // #3: form values win over the invoking context. extra (the clicked row, {row:{...}})
  // and param (page params) fill in the rest; a field the operator edited overrides a
  // prefilled context value with the same key.
  const merged = { ...(param || {}), ...(extra || {}), ...(values || {}) };
  // Group + multiselect fields arrive as a JSON string (the modal serializes rows /
  // the selected set); parse them back into arrays so the plugin action receives an
  // array, not a string. (Dynamic sub-form fields aren't listed here, so a multiselect
  // returned by a FieldsMethod stays a JSON string for the plugin to decode.)
  for (const f of a.steps ? a.steps.flatMap((s) => s.fields) : a.fields || []) {
    if ((f.type === "group" || f.type === "multiselect" || f.type === "chips") && typeof merged[f.key] === "string") {
      try { merged[f.key] = JSON.parse(merged[f.key] as string); } catch { merged[f.key] = []; }
    }
  }
  const args = Object.keys(merged).length ? merged : undefined;
  // #6 Impact confirmation gate: the plugin computes a go/no-go message from the entered
  // values; the operator must approve before the action runs. Runs after any Danger gate.
  if (a.confirmMethod) {
    try {
      const c = await deps.rpc.call<any>("Plugins", "call", [{ key: surfaceKey, method: a.confirmMethod, args, audit: false }]);
      if (c && c.message) {
        const ok = await deps.confirm.ask({ title: c.title || a.label, message: String(c.message), danger: !!c.danger, confirmLabel: c.confirmLabel || a.label });
        if (!ok) return undefined;
      }
    } catch { /* confirm provider unavailable -> proceed rather than block the action */ }
  }
  try {
    const res: PluginResult | any = await deps.rpc.call<any>("Plugins", "call", [{ key: surfaceKey, method: a.method, args, audit: true, danger: !!a.danger }]);
    const r: PluginResult = res && typeof res === "object" ? res : {};
    // The plugin refused in a 200 body (ok:false / level:error): surface as an error
    // and DON'T refetch — nothing changed.
    if (r.ok === false || r.level === "error") {
      deps.toast.error(r.message ? String(r.message) : `${a.label} failed`);
      return { ok: false, refetch: false, result: res };
    }
    // #7: package any UI directive the plugin returned so the caller can navigate / open a
    // flyout with its own router + drawer context.
    const directive: ActionDirective | undefined =
      r.navigate || r.flyout ? { navigate: r.navigate, flyout: r.flyout, flyoutTitle: r.flyoutTitle, flyoutWidth: r.flyoutWidth } : undefined;
    // Success toast — but a directive-only result (open a flyout / navigate, no message) is
    // its own feedback, so don't also pop a redundant "ok" toast (e.g. a node Info action).
    if (!opts?.quiet && !(directive && !r.message)) {
      const msg = r.message ? String(r.message) : `${a.label} ok`;
      if (r.level === "info") deps.toast.warn(msg); // no dedicated info tone; warn is the neutral-attention one
      else deps.toast.ok(msg);
    }
    return { ok: true, refetch: r.refetch !== false, result: res, directive };
  } catch (e: any) {
    deps.toast.error(`${a.label} — ${e?.message ?? "failed"}`);
    return { ok: false, refetch: false };
  }
}
