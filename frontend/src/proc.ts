// ProcService — a DI handle to the single <hope-proc> processing dialog. Any
// page calls proc.run(title, fn) to stream a long operation's progress into a
// shared modal (live log, count, Close-when-done) instead of re-implementing it.
import type { ProcFn } from "./components/proc-dialog";
import { lazyHost } from "./lazy-host";

export class ProcService {
  private getHost = lazyHost<{ run(title: string, fn: ProcFn): Promise<void> }>("hope-proc");

  /** Show the dialog and run fn, streaming its emit() lines. Resolves when fn finishes. */
  run(title: string, fn: ProcFn): Promise<void> {
    return this.getHost().run(title, fn);
  }
}
