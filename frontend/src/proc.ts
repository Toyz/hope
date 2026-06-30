// ProcService — a DI handle to the single <hope-proc> processing dialog. Any
// page calls proc.run(title, fn) to stream a long operation's progress into a
// shared modal (live log, count, Close-when-done) instead of re-implementing it.
import type { ProcFn } from "./components/proc-dialog";

export class ProcService {
  private host: { run(title: string, fn: ProcFn): Promise<void> } | null = null;

  private getHost() {
    if (!this.host) {
      const el = document.createElement("hope-proc");
      document.body.appendChild(el);
      this.host = el as unknown as { run(title: string, fn: ProcFn): Promise<void> };
    }
    return this.host;
  }

  /** Show the dialog and run fn, streaming its emit() lines. Resolves when fn finishes. */
  run(title: string, fn: ProcFn): Promise<void> {
    return this.getHost().run(title, fn);
  }
}
