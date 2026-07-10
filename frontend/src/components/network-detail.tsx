// <hope-network-detail> — the eager, tiny lazy STUB. @lazy defers the modal
// chunk (network-detail-impl) until first mount; loom queues any show() made
// before the chunk lands and replays it. NetworkDetailService is the DI handle.
import { LoomElement, component } from "@toyz/loom";
import { lazy } from "@toyz/loom/element";
import { lazyHost } from "../lazy-host";

export type NetworkDetailOpts = { host?: string; ref: string; onChange?: () => void };

@component("hope-network-detail")
@lazy(() => import("./network-detail-impl"))
export class NetworkDetailModal extends LoomElement {}

// NetworkDetailService — DI handle to the single <hope-network-detail> modal.
export class NetworkDetailService {
  private getHost = lazyHost<{ show(o: NetworkDetailOpts): Promise<void> }>("hope-network-detail");

  open(o: NetworkDetailOpts): void {
    void this.getHost().show(o);
  }
}
