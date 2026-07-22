import { LoomElement, component, css, prop, styles } from "@toyz/loom";

@component("hope-doc-note")
@styles(css`
  :host {
    display: block;
    max-width: 964px;
    margin: 14px 28px;
    padding: 10px 12px;
    border: 1px solid var(--line2);
    color: var(--dim);
    background: color-mix(in srgb, var(--upd) 7%, transparent);
    font: 11.5px/1.65 var(--mono);
  }
  :host([tone="warn"]) {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 42%, var(--line));
    background: color-mix(in srgb, var(--warn) 7%, transparent);
  }
  @media (max-width: 700px) {
    :host {
      margin: 12px 16px;
    }
  }
`)
export class HopeDocNote extends LoomElement {
  @prop accessor tone: "info" | "warn" = "info";

  update() {
    return <slot></slot>;
  }
}
