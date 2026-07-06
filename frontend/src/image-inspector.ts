// ImageInspector — the docked image inspector handle. Inspected at
// /images/:host/:id (deep-linkable, and how a container's image field jumps
// here); all the open/close/apply mechanics live in ResourceInspector.
import { ResourceInspector } from "./resource-inspector";
import { ImageInspectorTarget } from "./events";

export class ImageInspector extends ResourceInspector {
  protected readonly seg = "images";
  protected event(host: string, ref: string) {
    return new ImageInspectorTarget(host, ref);
  }
}
