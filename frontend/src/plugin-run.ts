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

// resolveFieldOptions pre-fetches RPC-populated select options: for any field with an
// optionsMethod, call the plugin (a read — unaudited) to get its choices and inject
// them as the field's options before the form opens. Fields without one pass through.
// A failed fetch yields an empty list so the form still opens (the select is just empty).
async function resolveFieldOptions(deps: RunDeps, surfaceKey: string, fields: PromptField[]): Promise<PromptField[]> {
  if (!fields.some((f) => f.optionsMethod)) return fields;
  return Promise.all(
    fields.map(async (f) => {
      if (!f.optionsMethod) return f;
      try {
        const opts = await deps.rpc.call<PromptOption[]>("Plugins", "call", [{ key: surfaceKey, method: f.optionsMethod, audit: false }]);
        return { ...f, options: Array.isArray(opts) ? opts : [] };
      } catch {
        return { ...f, options: [] };
      }
    }),
  );
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
  if (a.fields && a.fields.length) {
    const fields = await resolveFieldOptions(deps, surfaceKey, a.fields);
    // Selector->surface: if a field names a resolve method, wire a resolver that calls
    // the plugin with the current values and returns a component surface for the modal
    // to render inline. Closes over the RPC so the generic prompt stays rpc-free.
    const resolveMethod = a.fields.find((f) => f.resolveMethod)?.resolveMethod;
    const resolve = resolveMethod
      ? async (vals: Record<string, string>) => {
          try {
            const comp = await deps.rpc.call<any>("Plugins", "call", [{ key: surfaceKey, method: resolveMethod, args: vals, audit: false }]);
            return comp ? { key: surfaceKey, node: { kind: "component", comp }, schema: {} } : null;
          } catch {
            return null;
          }
        }
      : undefined;
    const v = await deps.prompt.ask({ title: a.label, submitLabel: "Run", fields, resolve });
    if (!v) return undefined;
    values = v;
  }
  if (a.danger && !(await deps.confirm.ask({ title: a.label, message: `Run "${a.label}"? This is a destructive action.`, danger: true, confirmLabel: a.label }))) {
    return undefined;
  }
  const merged = { ...(param || {}), ...(values || {}), ...(extra || {}) };
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
