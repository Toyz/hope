// <hope-image-detail> — the eager, tiny lazy STUB. @lazy defers the heavy modal
// chunk (image-detail-impl) until the element first mounts; loom queues any
// show() made before the chunk lands and replays it. The ImageDetailService is
// the DI handle pages use to open the modal from anywhere an image is shown.
import { LoomElement, component } from "@toyz/loom";
import { lazy } from "@toyz/loom/element";

export type ImageDetailOpts = { host?: string; ref: string; onChange?: () => void };

@component("hope-image-detail")
@lazy(() => import("./image-detail-impl"))
export class ImageDetailModal extends LoomElement {}

// ImageDetailService — DI handle to the single <hope-image-detail> modal. Any
// page shows image detail with imageDetail.open({ host, ref, onChange }).
export class ImageDetailService {
  private host: { show(o: ImageDetailOpts): Promise<void> } | null = null;

  private getHost() {
    if (!this.host) {
      const el = document.createElement("hope-image-detail");
      document.body.appendChild(el);
      this.host = el as unknown as { show(o: ImageDetailOpts): Promise<void> };
    }
    return this.host;
  }

  /** Fetch + show the image (by id/tag/digest) on its host. onChange fires after a mutation. */
  open(o: ImageDetailOpts): void {
    void this.getHost().show(o);
  }
}
