// Root shell of the explorer UI: a persistent top bar + left scope-rail wrapping
// the routing outlet (the "main" zone). The outlet cascades `theme` into every
// routed page (adoptStyles), so pages don't carry it themselves.
//
// Chrome is suppressed pre-auth and on /login so the login page renders bare.
//
// The root also owns body-scroll locking: any modal emits ModalToggle on the bus
// (see signalModal), and hope-app ref-counts the open ones here — so components
// announce intent and exactly one place touches document.body.
import { LoomElement, component, styles, reactive, on } from "@toyz/loom";
import { css } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { RouteChanged } from "@toyz/loom/router";
import { AuthStore } from "./auth-store";
import { theme } from "./styles";
import { ModalToggle } from "./events";

@component("hope-app")
@styles(theme, css`
  :host { display: block; height: 100vh; overflow: hidden; background: var(--ink); }

  /* bare (login / pre-auth) — just the outlet, no shell chrome */
  .bare { height: 100vh; overflow: auto; }

  /* explorer shell: top bar spans, rail + main below */
  .shell { height: 100vh; display: grid;
    grid-template-columns: 268px minmax(0, 1fr);
    grid-template-rows: 46px minmax(0, 1fr); }
  .shell > .top { grid-column: 1 / -1; }
  .shell > .rail { min-height: 0; }
  .shell > .main { min-width: 0; overflow-y: auto; }
`)
export class HopeApp extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @reactive accessor path = location.pathname;

  private openModals = new Set<object>();
  private prevOverflow = "";
  private prevPad = "";

  @on(RouteChanged)
  private onRoute(e: RouteChanged) { this.path = e.path; }

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

  private bare(): boolean {
    return this.path === "/login" || !this.auth.isAuthenticated;
  }

  update() {
    if (this.bare()) {
      return (
        <div class="bare">
          <loom-outlet styles={[theme]}></loom-outlet>
        </div>
      );
    }
    return (
      <div class="shell">
        <div class="top"><hope-topbar></hope-topbar></div>
        <div class="rail"><hope-rail></hope-rail></div>
        <div class="main">
          <loom-outlet styles={[theme]}></loom-outlet>
          <hope-footer></hope-footer>
        </div>
      </div>
    );
  }
}
