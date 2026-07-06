// Shared plugin-action runner — the single implementation of "invoke a plugin
// action": collect its fields, confirm if destructive, proxy the call (audited),
// and toast the result. Used by both the surface renderer (leaf + row actions) and
// the page header (phead action slot), so the flow isn't reimplemented per surface.
import type { HopeTransport } from "./transport";
import type { PromptService, PromptField } from "./prompt";
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

// runPluginAction returns the plugin's result on success, or undefined if the user
// cancelled a field prompt / danger confirm, or the call failed (toasted).
export async function runPluginAction(
  deps: RunDeps,
  surfaceKey: string,
  a: PluginActionDesc,
  extra?: Record<string, any>,
  param?: Record<string, any>,
  opts?: { quiet?: boolean }, // quiet: skip the success toast (inline edits), keep error toast
): Promise<any | undefined> {
  let values: Record<string, any> | undefined;
  if (a.fields && a.fields.length) {
    const v = await deps.prompt.ask({ title: a.label, submitLabel: "Run", fields: a.fields });
    if (!v) return undefined;
    values = v;
  }
  if (a.danger && !(await deps.confirm.ask({ title: a.label, message: `Run "${a.label}"? This is a destructive action.`, danger: true, confirmLabel: a.label }))) {
    return undefined;
  }
  const merged = { ...(param || {}), ...(values || {}), ...(extra || {}) };
  const args = Object.keys(merged).length ? merged : undefined;
  try {
    const res = await deps.rpc.call<any>("Plugins", "call", [{ key: surfaceKey, method: a.method, args, audit: true, danger: !!a.danger }]);
    if (!opts?.quiet) deps.toast.ok(res && typeof res === "object" && res.message ? String(res.message) : `${a.label} ok`);
    return res;
  } catch (e: any) {
    deps.toast.error(`${a.label} — ${e?.message ?? "failed"}`);
    return undefined;
  }
}
