// PromptService — a small DI service for promise-based input dialogs, the input
// sibling of ConfirmService. A page collects one or more fields with
// `await prompt.ask({...})`; it resolves the field values, or null on cancel.
// Reusable: add fields to the `fields` array, no new component needed.
import type { Option } from "./contracts";
export type PromptOption = Option;

export type PromptField = {
  key: string;
  label: string;
  type?: "text" | "select" | "toggle";
  placeholder?: string;
  hint?: string; // small helper line under the control (e.g. a toggle's meaning)
  value?: string;
  optional?: boolean; // required by default
  options?: PromptOption[]; // static options for type: "select"
  // Dynamic options computed from the current field values (dependent selects).
  // When `dependsOn` changes, this field's value is cleared and options recomputed.
  optionsFrom?: (values: Record<string, string>) => PromptOption[];
  dependsOn?: string;
  // When `dependsOn` changes, prefill this field's value from the new values
  // (e.g. auto-populate a detected port) instead of clearing it.
  defaultFrom?: (values: Record<string, string>) => string;
};

export interface PromptOpts {
  title?: string;
  icon?: string; // loom-icon name (default "link")
  message?: string; // optional hint under the header
  submitLabel?: string; // default "Save"
  cancelLabel?: string; // default "Cancel"
  fields: PromptField[];
}

export class PromptService {
  private host: { show(o: PromptOpts): Promise<Record<string, string> | null> } | null = null;

  private getHost() {
    if (!this.host) {
      const el = document.createElement("hope-prompt");
      document.body.appendChild(el);
      this.host = el as unknown as { show(o: PromptOpts): Promise<Record<string, string> | null> };
    }
    return this.host;
  }

  /** Resolves the field values keyed by field.key, or null if cancelled. */
  ask(o: PromptOpts): Promise<Record<string, string> | null> {
    return this.getHost().show(o);
  }
}
