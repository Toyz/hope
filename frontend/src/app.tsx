// Root shell: a routing outlet plus global theme. Pages render their own
// topbars. The element tag <hope-app> is referenced from index.html.
import { LoomElement, component, styles } from "@toyz/loom";
import { css } from "@toyz/loom";
import { theme } from "./styles";

@component("hope-app")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--bg); }
`)
export class HopeApp extends LoomElement {
  update() {
    return <loom-outlet></loom-outlet>;
  }
}
