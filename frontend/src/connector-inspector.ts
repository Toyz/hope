// ConnectorInspector — DI handle + state for the docked connector inspector
// (Cloudflare tunnel connector detail). URL-driven like the others: a connector
// is inspected at /tunnels/:host/:id, so opening one NAVIGATES and the tunnels
// page's route param drives the panel. onChange refetches after a mutation.
//
// Keyed by connector id, NOT name — connector names are local to a stack and not
// forced unique, so a name would be ambiguous.
import { app, bus } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { ConnectorInspectorTarget } from "./events";
import { withHost } from "./host-url";

export class ConnectorInspector {
  host = "";
  id = "";
  onChange: (() => void) | null = null;

  constructor() {
    bus.on(RouteChanged, (e: RouteChanged) => {
      const p = (e.path || "").split("/");
      const onConn = p[1] === "tunnels" && !!p[3];
      if (!onConn && this.isOpen) this.apply("", "");
    });
  }

  get isOpen(): boolean {
    return this.id !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  select(host: string, id: string, onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    const r = this.router();
    if (r) {
      r.navigate(withHost(host, `/tunnels/${encodeURIComponent(id)}`));
      return;
    }
    this.apply(host, id);
  }

  dismiss() {
    const r = this.router();
    if (r) {
      r.navigate(withHost(this.host || "local", "/tunnels"));
      return;
    }
    this.apply("", "");
  }

  apply(host: string, id: string) {
    this.host = host;
    this.id = id;
    bus.emit(new ConnectorInspectorTarget(host, id));
  }

  close() {
    this.dismiss();
  }
}
