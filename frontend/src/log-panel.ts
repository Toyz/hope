// LogPanel — the DI handle + state for the docked MULTI-SOURCE log viewer
// (stack/service logs merged across containers). Distinct from the container
// Inspector: it targets a Stream route (stackLogs/serviceLogs) rather than a
// single container. It shares the docked bottom slot with the inspector — opening
// it strips any docked container from the URL so the (route-driven) inspector
// releases the slot and can't re-assert it on a re-render. State lives here; every
// change fires LogPanelTarget so the shell and a mounted <hope-logs> react.
import { app, bus } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { LogPanelTarget } from "./events";
import { withHost } from "./host-url";

export class LogPanel {
  host = "";
  title = "";
  method = ""; // "stackLogs" | "serviceLogs" | ""
  args: string[] = [];
  project = ""; // the stack this view is scoped to (args[0])

  constructor() {
    // Close when the user genuinely leaves: a different stack/project, a container
    // URL (the inspector takes the slot), or a non-stack page. Staying on the same
    // stack (including the strip-navigation we do on open) keeps it open.
    bus.on(RouteChanged, (e: RouteChanged) => {
      if (!this.isOpen) return;
      const p = (e.path || "").split("/");
      const onStack = p[1] === "stack";
      const proj = onStack ? decodeURIComponent(p[3] || "") : "";
      const container = onStack ? p[4] : "";
      if (!onStack || proj !== this.project || container) this.close();
    });
  }

  get isOpen(): boolean {
    return this.method !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  open(host: string, title: string, method: string, args: string[]) {
    this.host = host;
    this.title = title;
    this.method = method;
    this.args = args;
    this.project = args[0] || "";
    // Release any docked container: navigate to the bare stack URL (same project,
    // no container). The inspector's route-driven state clears, and this same-stack
    // nav is explicitly kept open by the RouteChanged guard above.
    const r = this.router();
    if (r && this.project) r.navigate(withHost(host, `/stack/${encodeURIComponent(this.project)}`));
    bus.emit(new LogPanelTarget(host, title, method, args));
  }

  close() {
    this.host = "";
    this.title = "";
    this.method = "";
    this.args = [];
    this.project = "";
    bus.emit(new LogPanelTarget("", "", "", []));
  }
}
