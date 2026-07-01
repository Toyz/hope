// ToastService — a shared DI handle to the single <hope-toast> surface. Any page
// flashes a transient message with `toast.show(msg)` / `.ok()` / `.error()`
// instead of each page reimplementing its own toast state.
export class ToastService {
  private host: { show(m: string, kind?: string): void } | null = null;

  private getHost() {
    if (!this.host) {
      const el = document.createElement("hope-toast");
      document.body.appendChild(el);
      this.host = el as unknown as { show(m: string, kind?: string): void };
    }
    return this.host;
  }

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
}
