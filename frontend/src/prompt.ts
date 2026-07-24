// PromptService — a small DI service for promise-based input dialogs, the input
// sibling of ConfirmService. A page collects one or more fields with
// `await prompt.ask({...})`; it resolves the field values, or null on cancel.
// Reusable: add fields to the `fields` array, no new component needed.
import type { Option } from "./contracts";
import { lazyHost } from "./lazy-host";
export type PromptOption = Option;

export type PromptField = {
  key: string;
  label: string;
  type?: "text" | "textarea" | "select" | "toggle" | "kv" | "group";
  placeholder?: string;
  // A repeatable array-of-objects (a forms-builder): each row is a sub-form of `fields`.
  // The submitted value is a JSON array of the rows' value maps.
  fields?: PromptField[];
  addLabel?: string; // for "kv"/"group": the "+ add" button label (e.g. "option", "row")
  hint?: string; // small helper line under the control (e.g. a toggle's meaning)
  value?: string;
  optional?: boolean; // required by default
  options?: PromptOption[]; // static options for type: "select"
  // A plugin select whose options come from an RPC (Plugin.Options): hope fetches
  // them from this method and fills `options` before the form opens. Plugin-set only.
  optionsMethod?: string;
  // A plugin selector whose change resolves to an inline surface (Plugin.Resolve):
  // runPluginAction wires PromptOpts.resolve from this. Plugin-set only.
  resolveMethod?: string;
  // Dynamic options computed from the current field values (dependent selects).
  // When `dependsOn` changes, this field's value is cleared and options recomputed.
  optionsFrom?: (values: Record<string, string>) => PromptOption[];
  // Async options from a plugin RPC (Plugin.Options), computed from the CURRENT values —
  // runPluginAction wires this from `optionsMethod`. Fetched when the form opens and
  // re-fetched whenever `dependsOn` changes, so a cascading select narrows by an earlier
  // pick. Returns the choices; the modal caches them per field.
  optionsFetch?: (values: Record<string, string>) => Promise<PromptOption[]>;
  dependsOn?: string;
  // With `dependsOn`: the field renders ONLY when values[dependsOn] === dependsValue —
  // or, when dependsValue is empty, when values[dependsOn] is non-empty. Lets a form
  // reveal fields based on an earlier choice.
  dependsValue?: string;
  // When `dependsOn` changes, prefill this field's value from the new values
  // (e.g. auto-populate a detected port) instead of clearing it.
  defaultFrom?: (values: Record<string, string>) => string;
};

// ResolvedSurface is a plugin-surface returned by a selector->surface resolve call —
// the {key, node, schema} shape <hope-plugin-surface> renders. node is a component tree.
export interface ResolvedSurface {
  key: string;
  node: any;
  schema: any;
}

// A wizard step: a titled set of fields the modal renders one at a time. Values
// accumulate across steps, so a later step's cascading options (optionsFetch) and
// conditional fields (dependsOn) can read an earlier step's answers.
export interface PromptStep {
  title?: string;
  hint?: string;
  fields: PromptField[];
  // Optional per-step selector->surface preview (like PromptOpts.resolve).
  resolve?: (values: Record<string, string>) => Promise<ResolvedSurface | null>;
}

export interface PromptOpts {
  title?: string;
  icon?: string; // loom-icon name (default "link")
  message?: string; // optional hint under the header
  submitLabel?: string; // default "Save"
  cancelLabel?: string; // default "Cancel"
  fields: PromptField[];
  // Wizard: when set, the modal renders these steps in order with Back/Next/Finish and a
  // stepper, instead of the flat `fields` above. `fields` should be [] when steps are used.
  steps?: PromptStep[];
  // A plugin selector->surface: called with the current field values whenever they
  // change; the returned surface is rendered inline below the fields. Plugin actions
  // set this (it closes over the RPC); hope's own prompts leave it unset. In a wizard a
  // step's own `resolve` takes precedence for that step.
  resolve?: (values: Record<string, string>) => Promise<ResolvedSurface | null>;
}

export class PromptService {
  private getHost = lazyHost<{ show(o: PromptOpts): Promise<Record<string, string> | null> }>("hope-prompt");

  /** Resolves the field values keyed by field.key, or null if cancelled. */
  ask(o: PromptOpts): Promise<Record<string, string> | null> {
    return this.getHost().show(o);
  }
}
