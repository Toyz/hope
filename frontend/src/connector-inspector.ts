// ConnectorInspector — the docked connector inspector handle (Cloudflare tunnel
// connector detail). Inspected at /tunnels/:host/:id; the open/close/apply
// mechanics live in ResourceInspector.
//
// Keyed by connector id, NOT name — connector names are local to a stack and not
// forced unique, so a name would be ambiguous. That id IS the base's "ref",
// exposed as `.id` for readers that say so.
import { ResourceInspector } from "./resource-inspector";
import { ConnectorInspectorTarget } from "./events";

export class ConnectorInspector extends ResourceInspector {
  protected readonly seg = "tunnels";
  protected event(host: string, ref: string) {
    return new ConnectorInspectorTarget(host, ref);
  }

  get id(): string {
    return this.ref;
  }
}
