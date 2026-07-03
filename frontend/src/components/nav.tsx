// <hope-nav active="images"> — the shared system nav strip (deploy / images /
// networks / volumes / agents / tunnels / api). Used in every page's top bar.
// On wide screens it's a horizontal strip; on narrow it collapses to a single
// menu button + dropdown so the bar never overflows.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { media } from "@toyz/loom/element";
import { LoomRouter } from "@toyz/loom/router";
import { capabilities } from "../caps";
import { theme } from "../styles";

const ITEMS: [string, string][] = [
  ["deploy", "/deploy"],
  ["images", "/images"],
  ["networks", "/networks"],
  ["volumes", "/volumes"],
  ["agents", "/agents"],
  ["tunnels", "/tunnels"],
];

// Icon per nav item (registered in icons.ts).
const NAV_ICONS: Record<string, string> = {
  deploy: "rocket",
  images: "box",
  networks: "link",
  volumes: "database",
  agents: "server",
  tunnels: "globe",
  api: "code",
};

@component("hope-nav")
@styles(theme, css`
  :host { display: flex; align-items: stretch; position: relative; }
  .strip { display: flex; align-items: stretch; }
  .item { display: flex; align-items: center; padding: 0 14px; border-right: 1px solid var(--line); }
  .navlink { display: inline-flex; align-items: center; gap: 7px; font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); cursor: pointer; white-space: nowrap; }
  .navlink loom-icon { color: var(--dim); transition: color .1s; }
  .navlink:hover, .navlink:hover loom-icon { color: var(--hi); }
  .navlink.on, .navlink.on loom-icon { color: var(--hi); }

  /* compact (narrow): a single menu button that opens a dropdown */
  .menubtn { display: inline-flex; align-items: center; gap: 8px; height: 100%; padding: 0 14px;
    border: 0; border-right: 1px solid var(--line); background: transparent; color: var(--dim); cursor: pointer;
    font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .menubtn:hover { color: var(--hi); background: var(--raised); }
  .menubtn loom-icon { color: var(--dim); }
  .menubtn:hover loom-icon { color: var(--hi); }
  .drop { position: absolute; top: 100%; left: 0; z-index: 50; min-width: 180px;
    background: var(--ink); border: 1px solid var(--line); box-shadow: 0 14px 40px rgba(0,0,0,.5); }
  .drop .navlink { display: block; padding: 12px 15px; border-bottom: 1px solid var(--line); }
  .drop .navlink:last-child { border-bottom: 0; }
  .drop .navlink.on { background: var(--raised); }
`)
export class HopeNav extends LoomElement {
  @reactive accessor active = "";
  @reactive accessor apiOn = false;
  @reactive accessor open = false;
  // True on narrow viewports — collapse the strip into the menu dropdown.
  @media("(max-width: 860px)") accessor compact = false;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @mount
  onMount() {
    capabilities().then((c) => (this.apiOn = !!c.api_enabled));
  }

  // Close the dropdown on any outside click (auto-unbinds on disconnect).
  @on(document, "click")
  private close() {
    this.open = false;
  }

  // /rpc/* is a server route (sov's explorer UI); everything else is an SPA route.
  private go(path: string) {
    this.open = false;
    if (path.startsWith("/rpc/")) location.href = path;
    else this.router.navigate(path);
  }

  private items(): [string, string][] {
    return this.apiOn ? [...ITEMS, ["api", "/api-docs"] as [string, string]] : ITEMS;
  }

  update() {
    const items = this.items();
    if (this.compact) {
      const cur = items.find(([l]) => l === this.active)?.[0] || "menu";
      return (
        <div style="position:relative; display:flex; align-items:stretch">
          <button class="menubtn" onClick={(e: Event) => { e.stopPropagation(); this.open = !this.open; }}>
            <loom-icon name="menu" size={14}></loom-icon>{cur}
          </button>
          {this.open ? (
            <div class="drop" onClick={(e: Event) => e.stopPropagation()}>
              {items.map(([label, path]) => (
                <span class={"navlink" + (this.active === label ? " on" : "")} onClick={() => this.go(path)}><loom-icon name={NAV_ICONS[label]} size={13}></loom-icon>{label}</span>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <div class="strip">
        {items.map(([label, path]) => (
          <div class="item"><span class={"navlink" + (this.active === label ? " on" : "")} onClick={() => this.go(path)}><loom-icon name={NAV_ICONS[label]} size={13}></loom-icon>{label}</span></div>
        ))}
      </div>
    );
  }
}
