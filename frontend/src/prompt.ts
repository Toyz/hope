// PromptService — a small DI service for promise-based input dialogs, the input
// sibling of ConfirmService. A page collects one or more fields with
// `await prompt.ask({...})`; it resolves the field values, or null on cancel.
// Reusable: add fields to the `fields` array, no new component needed.
export type PromptField = {
  key: string;
  label: string;
  type?: "text" | "select";
  placeholder?: string;
  value?: string;
  optional?: boolean; // required by default
  options?: { value: string; label: string }[]; // for type: "select"
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
