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
}

// attachFieldOptions wires an async optionsFetch on any field with an optionsMethod: the
// modal calls it with the CURRENT values (when the form opens, and again when a dependsOn
// field changes), so a cascading select narrows its choices by an earlier pick. The
// plugin's Options(ctx) reads those values via Params(ctx) — same wiring as a resolve
// method. No static pre-fetch: the modal owns the lifecycle so it stays live.
function attachFieldOptions(deps: RunDeps, surfaceKey: string, fields: PromptField[]): PromptField[] {
  return fields.map((f) => {
    if (!f.optionsMethod) return f;
    const method = f.optionsMethod;
    return {
      ...f,
      optionsFetch: async (vals: Record<string, string>) => {
        try {
          const opts = await deps.rpc.call<PromptOption[]>("Plugins", "call", [{ key: surfaceKey, method, args: vals, audit: false }]);
          return Array.isArray(opts) ? opts : [];
        } catch {
          return [];
        }
      },
    };
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
  if (a.steps && a.steps.length) {
    // Wizard: each step gets its fields wired (cascading options + per-step resolve).
    const steps = a.steps.map((s) => ({ title: s.title, hint: s.hint, fields: attachFieldOptions(deps, surfaceKey, s.fields), resolve: mkResolve(s.fields) }));
    const v = await deps.prompt.ask({ title: a.label, submitLabel: "Finish", fields: [], steps });
    if (!v) return undefined;
    values = v;
  } else if (a.fields && a.fields.length) {
    const fields = attachFieldOptions(deps, surfaceKey, a.fields);
    const v = await deps.prompt.ask({ title: a.label, submitLabel: "Run", fields, resolve: mkResolve(a.fields) });
    if (!v) return undefined;
    values = v;
  }
  if (a.danger && !(await deps.confirm.ask({ title: a.label, message: `Run "${a.label}"? This is a destructive action.`, danger: true, confirmLabel: a.label }))) {
    return undefined;
  }
  const merged = { ...(param || {}), ...(values || {}), ...(extra || {}) };
  // Group fields arrive as a JSON string (the modal serializes the rows); parse them
  // back into an array so the plugin action receives an array of objects, not a string.
  for (const f of a.steps ? a.steps.flatMap((s) => s.fields) : a.fields || []) {
    if (f.type === "group" && typeof merged[f.key] === "string") {
      try { merged[f.key] = JSON.parse(merged[f.key] as string); } catch { merged[f.key] = []; }
    }
  }
  const args = Object.keys(merged).length ? merged : undefined;
  try {
    const res: PluginResult | any = await deps.rpc.call<any>("Plugins", "call", [{ key: surfaceKey, method: a.method, args, audit: true, danger: !!a.danger }]);
    const r: PluginResult = res && typeof res === "object" ? res : {};
    // The plugin refused in a 200 body (ok:false / level:error): surface as an error
    // and DON'T refetch — nothing changed.
    if (r.ok === false || r.level === "error") {
      deps.toast.error(r.message ? String(r.message) : `${a.label} failed`);
      return { ok: false, refetch: false, result: res };
    }
    if (!opts?.quiet) {
      const msg = r.message ? String(r.message) : `${a.label} ok`;
      if (r.level === "info") deps.toast.warn(msg); // no dedicated info tone; warn is the neutral-attention one
      else deps.toast.ok(msg);
    }
    return { ok: true, refetch: r.refetch !== false, result: res };
  } catch (e: any) {
    deps.toast.error(`${a.label} — ${e?.message ?? "failed"}`);
    return { ok: false, refetch: false };
  }
}
