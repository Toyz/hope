// NetworkInspector — DI handle + state for the docked network inspector. URL-driven
// like the other inspectors: a network is inspected at /networks/:host/:name, so
// opening one NAVIGATES (select/dismiss) and the networks page's route param drives
// the panel (apply). onChange lets the page refetch after a remove.
import { app, bus } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { NetworkInspectorTarget } from "./events";
import { withHost } from "./host-url";

export class NetworkInspector {
  host = "";
  ref = "";
  onChange: (() => void) | null = null;

  constructor() {
    bus.on(RouteChanged, (e: RouteChanged) => {
      const p = (e.path || "").split("/");
      const onNet = p[1] === "networks" && !!p[3];
      if (!onNet && this.isOpen) this.apply("", "");
    });
  }

  get isOpen(): boolean {
    return this.ref !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  select(host: string, ref: string, onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    const r = this.router();
    if (r) {
      r.navigate(withHost(host, `/networks/${encodeURIComponent(ref)}`));
      return;
    }
    this.apply(host, ref);
  }

  dismiss() {
    const r = this.router();
    if (r) {
      r.navigate(withHost(this.host || "local", "/networks"));
      return;
    }
    this.apply("", "");
  }

  apply(host: string, ref: string) {
    this.host = host;
    this.ref = ref;
    bus.emit(new NetworkInspectorTarget(host, ref));
  }

  close() {
    this.dismiss();
  }
}
