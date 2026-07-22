import { LoomElement, component, css, styles } from "@toyz/loom";
import { route } from "@toyz/loom/router";

@route("*")
@component("hope-page-not-found")
@styles(css`
  :host {
    display: grid;
    min-height: 70vh;
    place-items: center;
    text-align: center;
  }
  h1 {
    font: 700 32px/1 var(--mono);
  }
  p {
    color: var(--dim);
    font: 12px/1.6 var(--mono);
  }
`)
export class NotFoundPage extends LoomElement {
  update() {
    return (
      <div>
        <h1>not found</h1>
        <p>The requested documentation page does not exist.</p>
        <loom-link to="/">back to overview</loom-link>
      </div>
    );
  }
}
