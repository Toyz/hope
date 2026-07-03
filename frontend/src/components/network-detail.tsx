// <hope-network-detail> — the eager, tiny lazy STUB. @lazy defers the modal
// chunk (network-detail-impl) until first mount; loom queues any show() made
// before the chunk lands and replays it. NetworkDetailService is the DI handle.
import { LoomElement, component } from "@toyz/loom";
import { lazy } from "@toyz/loom/element";

export type NetworkDetailOpts = { host?: string; ref: string; onChange?: () => void };

@component("hope-network-detail")
@lazy(() => import("./network-detail-impl"))
export class NetworkDetailModal extends LoomElement {}

// NetworkDetailService — DI handle to the single <hope-network-detail> modal.
export class NetworkDetailService {
  private host: { show(o: NetworkDetailOpts): Promise<void> } | null = null;

  private getHost() {
    if (!this.host) {
      const el = document.createElement("hope-network-detail");
      document.body.appendChild(el);
      this.host = el as unknown as { show(o: NetworkDetailOpts): Promise<void> };
    }
    return this.host;
  }

  open(o: NetworkDetailOpts): void {
    void this.getHost().show(o);
  }
}
