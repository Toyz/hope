// <hope-nav active="images"> — the shared system nav strip (images / networks /
// volumes / agents / tunnels). Used in every page's top bar so the nav is always
// present and identical, instead of each page duplicating the links (and stack/
// container pages dropping them entirely).
import { LoomElement, component, styles, css, reactive, app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";

const ITEMS: [string, string][] = [
  ["images", "/images"],
  ["networks", "/networks"],
  ["volumes", "/volumes"],
  ["agents", "/agents"],
  ["tunnels", "/tunnels"],
];

@component("hope-nav")
@styles(css`
  :host { display: flex; align-items: stretch; }
  .item { display: flex; align-items: center; padding: 0 16px; border-right: 1px solid var(--line); }
  .navlink { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); cursor: pointer; }
  .navlink:hover { color: var(--hi); }
  .navlink.on { color: var(--hi); }
`)
export class HopeNav extends LoomElement {
  @reactive accessor active = "";
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  update() {
    return (
      <div style="display:flex; align-items:stretch">
        {ITEMS.map(([label, path]) => (
          <div class="item"><span class={"navlink" + (this.active === label ? " on" : "")} onClick={() => this.router.navigate(path)}>{label}</span></div>
        ))}
      </div>
    );
  }
}
