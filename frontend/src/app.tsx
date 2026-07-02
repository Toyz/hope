// Root shell: a routing outlet plus global theme. The outlet cascades `theme`
// into every routed page (adoptStyles), so pages don't carry it themselves;
// non-routed components (modals, nav, footer, select, …) keep @styles(theme).
import { LoomElement, component, styles } from "@toyz/loom";
import { css } from "@toyz/loom";
import { theme } from "./styles";

@component("hope-app")
@styles(theme, css`
  :host { display: block; min-height: 100vh; background: var(--bg); }
`)
export class HopeApp extends LoomElement {
  update() {
    return (
      <div>
        <loom-outlet styles={[theme]}></loom-outlet>
        <hope-footer></hope-footer>
      </div>
    );
  }
}
