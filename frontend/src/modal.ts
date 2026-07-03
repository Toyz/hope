// signalModal — a modal announces its open/closed state on the bus. The root
// shell (hope-app) owns the actual body-scroll lock, ref-counting across stacked
// modals; components never touch document.body. Call from a @watch on the open
// flag, and from @unmount with false so navigating away never leaks the lock.
import { bus } from "@toyz/loom";
import { ModalToggle } from "./events";

export function signalModal(source: object, open: boolean): void {
  bus.emit(new ModalToggle(source, open));
}
