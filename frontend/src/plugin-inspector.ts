// PluginInspector — the docked plugin inspector handle. Inspected at
// /plugins/:host/:key; the open/close/apply mechanics live in ResourceInspector.
//
// Keyed by the plugin's STABLE identity (host|project/service), URL-encoded — it
// contains '|' and '/', so it must be a single encoded path segment. That key IS
// the base's "ref", exposed as `.key` for readers that say so.
import { ResourceInspector } from "./resource-inspector";
import { PluginInspectorTarget } from "./events";

export class PluginInspector extends ResourceInspector {
  protected readonly seg = "plugins";
  protected event(host: string, ref: string) {
    return new PluginInspectorTarget(host, ref);
  }

  get key(): string {
    return this.ref;
  }
}
