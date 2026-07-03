// Root shell: a routing outlet plus global theme. The outlet cascades `theme`
// into every routed page (adoptStyles), so pages don't carry it themselves;
// non-routed components (modals, nav, footer, select, …) keep @styles(theme).
//
// The root also owns body-scroll locking: any modal emits ModalToggle on the bus
// (see signalModal), and hope-app ref-counts the open ones here — so components
// announce intent and exactly one place touches document.body.
import { LoomElement, component, styles, on } from "@toyz/loom";
import { css } from "@toyz/loom";
import { theme } from "./styles";
import { ModalToggle } from "./events";

@component("hope-app")
@styles(theme, css`
  :host { display: block; min-height: 100vh; background: var(--bg); }
`)
export class HopeApp extends LoomElement {
  private openModals = new Set<object>();
  private prevOverflow = "";
  private prevPad = "";

  // Ref-count open modals; lock on the first, restore on the last. Padding the
  // body by the scrollbar width keeps the layout from shifting when it hides.
  @on(ModalToggle)
  private onModalToggle(e: ModalToggle) {
    const was = this.openModals.size;
    if (e.open) this.openModals.add(e.source);
    else this.openModals.delete(e.source);
    const now = this.openModals.size;
    if (was === 0 && now > 0) this.lockBody();
    else if (was > 0 && now === 0) this.unlockBody();
  }

  private lockBody() {
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    this.prevOverflow = document.body.style.overflow;
    this.prevPad = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (sbw > 0) document.body.style.paddingRight = `${sbw}px`;
  }

  private unlockBody() {
    document.body.style.overflow = this.prevOverflow;
    document.body.style.paddingRight = this.prevPad;
  }

  update() {
    return (
      <div>
        <loom-outlet styles={[theme]}></loom-outlet>
        <hope-footer></hope-footer>
      </div>
    );
  }
}
