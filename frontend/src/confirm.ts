// ConfirmService — a small DI service for promise-based confirmations. Any page
// gates a destructive action with `await confirm.ask({...})`. It mounts a single
// <hope-confirm> stub on first use; loom's @lazy loads the real modal chunk on
// demand and queues this show() until it lands (see components/confirm-modal*).
import { lazyHost } from "./lazy-host";

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
  // The single <hope-confirm> stub, created on first use. The stub is registered
  // eagerly (tiny); loom's @lazy pulls the real impl + styles only now, and queues
  // this show() call until that chunk loads.
  private getHost = lazyHost<{ show(o: ConfirmOpts): Promise<boolean> }>("hope-confirm");

  /** Resolves true if the user confirms, false otherwise. */
  ask(o: ConfirmOpts): Promise<boolean> {
    return this.getHost().show(o);
  }
}
