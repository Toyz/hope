// VolumeInspector — the docked volume inspector handle. Inspected at
// /volumes/:host/:name; anonymous volumes deep-link by their hash name (still a
// unique key). The open/close/apply mechanics live in ResourceInspector — a
// volume's "ref" IS its name, exposed as `.name` for readers that say so.
import { ResourceInspector } from "./resource-inspector";
import { VolumeInspectorTarget } from "./events";

export class VolumeInspector extends ResourceInspector {
  protected readonly seg = "volumes";
  protected event(host: string, ref: string) {
    return new VolumeInspectorTarget(host, ref);
  }

  get name(): string {
    return this.ref;
  }
}
