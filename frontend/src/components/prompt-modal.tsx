// <hope-prompt> — eager, tiny lazy STUB for the input dialog. @lazy defers the
// real impl chunk until first mount; loom queues any show() call until it lands.
import { LoomElement, component } from "@toyz/loom";
import { lazy } from "@toyz/loom/element";

@component("hope-prompt")
@lazy(() => import("./prompt-modal-impl"))
export class PromptModal extends LoomElement {}
