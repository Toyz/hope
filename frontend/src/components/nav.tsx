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
  .nav { display: flex; align-items: center; gap: 16px; padding: 0 18px; border-right: 1px solid var(--line); }
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
      <div class="nav">
        {ITEMS.map(([label, path]) => (
          <span class={"navlink" + (this.active === label ? " on" : "")} onClick={() => this.router.navigate(path)}>{label}</span>
        ))}
      </div>
    );
  }
}
