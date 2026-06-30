// <hope-confirm> — the eager, tiny lazy STUB. @lazy defers the real impl chunk
// (confirm-modal-impl) until the element first mounts; loom queues any show()
// call made before the chunk lands and replays it against the impl. The stub
// carries no styles or render of its own — all weight is in the lazy chunk.
import { LoomElement, component } from "@toyz/loom";
import { lazy } from "@toyz/loom/element";

@component("hope-confirm")
@lazy(() => import("./confirm-modal-impl"))
export class ConfirmModal extends LoomElement {}
