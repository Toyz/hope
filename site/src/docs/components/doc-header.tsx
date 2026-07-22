import { LoomElement, component, css, prop, styles } from "@toyz/loom";
import { theme } from "../../theme";

@component("hope-doc-header")
@styles(
  theme,
  css`
    :host {
      display: block;
      border-bottom: 1px solid var(--line);
      background: var(--ink);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 22px 28px 0;
    }
    .mark {
      width: 8px;
      height: 8px;
      flex: none;
      border-radius: 50%;
      background: var(--upd);
    }
    h1 {
      margin: 0;
      color: var(--hi);
      font: 700 18px/1 var(--mono);
      letter-spacing: 0.01em;
    }
    .scope {
      padding: 2px 6px;
      border: 1px solid var(--line2);
      color: var(--dim);
      font: 600 8.5px/1.4 var(--mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    p {
      max-width: 920px;
      margin: 0;
      padding: 14px 28px 18px;
      color: var(--dim);
      font: 11.5px/1.6 var(--mono);
    }
    @media (max-width: 700px) {
      .head {
        padding: 18px 16px 0;
      }
      p {
        padding: 12px 16px 16px;
      }
    }
  `,
)
export class HopeDocHeader extends LoomElement {
  @prop accessor heading = "";
  @prop accessor lead = "";

  update() {
    return (
      <>
        <div class="head">
          <span class="mark"></span>
          <h1>{this.heading}</h1>
          <span class="scope">docs</span>
        </div>
        <p>{this.lead}</p>
      </>
    );
  }
}
