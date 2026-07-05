// PluginInspector — DI handle + state for the docked plugin inspector. URL-driven
// like the others: a plugin is inspected at /plugins/:host/:key, so opening one
// NAVIGATES and the plugins page's route param drives the panel. onChange refetches
// the list after a mutation (enable/disable/forget).
//
// Keyed by the plugin's STABLE identity (host|project/service), URL-encoded — it
// contains '|' and '/', so it must be a single encoded path segment.
import { app, bus } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { PluginInspectorTarget } from "./events";
import { withHost } from "./host-url";

export class PluginInspector {
  host = "";
  key = "";
  onChange: (() => void) | null = null;

  constructor() {
    bus.on(RouteChanged, (e: RouteChanged) => {
      const p = (e.path || "").split("/");
      const onPlugin = p[1] === "plugins" && !!p[3]; // /plugins/:host/:key
      if (!onPlugin && this.isOpen) this.apply("", "");
    });
  }

  get isOpen(): boolean {
    return this.key !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  select(host: string, key: string, onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    const r = this.router();
    if (r) {
      r.navigate(withHost(host, `/plugins/${encodeURIComponent(key)}`));
      return;
    }
    this.apply(host, key);
  }

  dismiss() {
    const r = this.router();
    if (r) {
      r.navigate(withHost(this.host || "local", "/plugins"));
      return;
    }
    this.apply("", "");
  }

  apply(host: string, key: string) {
    this.host = host;
    this.key = key;
    bus.emit(new PluginInspectorTarget(host, key));
  }

  close() {
    this.dismiss();
  }
}
