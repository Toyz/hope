// ToastService — a shared DI handle to the single <hope-toast> surface. Any page
// flashes a transient message with `toast.show(msg)` / `.ok()` / `.error()`
// instead of each page reimplementing its own toast state. For a "doing X…" that
// resolves, `toast.progress(msg)` returns a handle whose `.done()/.error()`
// replaces the sticky message in place.
type Host = {
  show(m: string, kind?: string, sticky?: boolean): number;
  replace(id: number, m: string, kind?: string, sticky?: boolean): void;
  dismiss(id: number): void;
};

export interface ToastProgress {
  update(msg: string, kind?: string): void; // still in progress
  done(msg: string, kind?: string): void; // resolved -> auto-dismisses
  error(msg: string): void; // failed -> auto-dismisses (bad)
  clear(): void; // remove with no final message
}

import { lazyHost } from "./lazy-host";

export class ToastService {
  private getHost = lazyHost<Host>("hope-toast");

  show(msg: string, kind = "") {
    this.getHost().show(msg, kind);
  }
  ok(msg: string) {
    this.show(msg, "ok");
  }
  warn(msg: string) {
    this.show(msg, "warn");
  }
  error(msg: string) {
    this.show(msg, "bad");
  }

  // A sticky toast that stays until the returned handle resolves it.
  progress(msg: string, kind = ""): ToastProgress {
    const h = this.getHost();
    const id = h.show(msg, kind, true);
    return {
      update: (m, k = "") => h.replace(id, m, k, true),
      done: (m, k = "") => h.replace(id, m, k, false),
      error: (m) => h.replace(id, m, "bad", false),
      clear: () => h.dismiss(id),
    };
  }
}
