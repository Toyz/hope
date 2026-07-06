// NetworkInspector — the docked network inspector handle. Inspected at
// /networks/:host/:name; the open/close/apply mechanics live in ResourceInspector.
import { ResourceInspector } from "./resource-inspector";
import { NetworkInspectorTarget } from "./events";

export class NetworkInspector extends ResourceInspector {
  protected readonly seg = "networks";
  protected event(host: string, ref: string) {
    return new NetworkInspectorTarget(host, ref);
  }
}
