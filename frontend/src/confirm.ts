// ConfirmService — a small DI service for promise-based confirmations. Any page
// gates a destructive action with `await confirm.ask({...})`. It mounts a single
// <hope-confirm> stub on first use; loom's @lazy loads the real modal chunk on
// demand and queues this show() until it lands (see components/confirm-modal*).
export interface ConfirmOpts {
  /** Header text. Default "Confirm". */
  title?: string;
  /** Body text — the only required field. */
  message: string;
  /** Confirm button label. Default "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Default "Cancel". */
  cancelLabel?: string;
  /** Red/destructive styling on the confirm button + header. */
  danger?: boolean;
  /** Amber/warning styling — for reversible-but-disruptive actions (redeploy). */
  warn?: boolean;
  /** Optional clean key/value figures shown under the message (count, size…). */
  stats?: { label: string; value: string }[];
}

export class ConfirmService {
  private host: { show(o: ConfirmOpts): Promise<boolean> } | null = null;

  // Creates the single <hope-confirm> stub on first use and appends it to the
  // body. The stub is registered eagerly (tiny); loom's @lazy pulls the real
  // impl + styles only now, and queues this show() call until that chunk loads.
  private getHost() {
    if (!this.host) {
      const el = document.createElement("hope-confirm");
      document.body.appendChild(el);
      this.host = el as unknown as { show(o: ConfirmOpts): Promise<boolean> };
    }
    return this.host;
  }

  /** Resolves true if the user confirms, false otherwise. */
  ask(o: ConfirmOpts): Promise<boolean> {
    return this.getHost().show(o);
  }
}
