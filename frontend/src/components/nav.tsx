// <hope-nav active="images"> — the shared system nav strip (deploy / images /
// networks / volumes / agents / tunnels / api). Used in every page's top bar.
// On wide screens it's a horizontal strip; on narrow it collapses to a single
// menu button + dropdown so the bar never overflows.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { media } from "@toyz/loom/element";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { capabilities } from "../caps";
import { HostContext } from "../host-context";
import { HOST_PAGES, withHost } from "../host-url";
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
  .navlink { position: relative; display: inline-flex; align-items: center; gap: 7px; font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); cursor: pointer; white-space: nowrap; }
  .navlink loom-icon { color: var(--dim); transition: color .12s ease, transform .16s cubic-bezier(.34, 1.56, .64, 1); }
  .navlink:hover, .navlink:hover loom-icon { color: var(--hi); }
  .navlink.on, .navlink.on loom-icon { color: var(--hi); }
  /* a hairline that draws in from the left on hover — like selecting a channel
     on an instrument. Stays lit for the active item. */
  .navlink::after { content: ""; position: absolute; left: 0; right: 0; bottom: -6px; height: 1px;
    background: var(--upd); transform: scaleX(0); transform-origin: left;
    transition: transform .2s cubic-bezier(.4, 0, .2, 1); }
  .navlink:hover::after, .navlink.on::after { transform: scaleX(1); }
  .navlink.on::after { background: var(--hi); }
  /* the icon settles up a hair — grounded, not floaty */
  .navlink:hover loom-icon { transform: translateY(-1px); }
  @media (prefers-reduced-motion: reduce) {
    .navlink loom-icon, .navlink::after { transition: none; }
    .navlink:hover loom-icon { transform: none; }
  }

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
  @reactive accessor curPath = location.pathname; // reactive current route

  // Re-highlight on every navigation (the nav can outlive a route swap).
  @on(RouteChanged)
  private onRoute(e: RouteChanged) { this.curPath = e.path; }
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
  // Host-scoped destinations carry the current host token so switching pages stays
  // on the same host (or the fleet view), never silently jumping to the default.
  private go(path: string) {
    this.open = false;
    if (path.startsWith("/rpc/")) { location.href = path; return; }
    const token = app.has(HostContext) ? app.get(HostContext).token : "";
    const hostScoped = HOST_PAGES.has(path.split("/")[1] ?? "");
    this.router.navigate(hostScoped && token ? withHost(token, path) : path);
  }

  private items(): [string, string][] {
    return this.apiOn ? [...ITEMS, ["api", "/api-docs"] as [string, string]] : ITEMS;
  }

  // The active item is derived from the current route (so every page lights the
  // right tab without passing it), unless a caller sets `active` explicitly.
  private activeLabel(): string {
    if (this.active) return this.active;
    const p = this.curPath;
    for (const [label, path] of this.items()) if (p === path || p.startsWith(path + "/")) return label;
    return "";
  }

  update() {
    const items = this.items();
    const active = this.activeLabel();
    if (this.compact) {
      const cur = items.find(([l]) => l === active)?.[0] || "menu";
      return (
        <div style="position:relative; display:flex; align-items:stretch">
          <button class="menubtn" onClick={(e: Event) => { e.stopPropagation(); this.open = !this.open; }}>
            <loom-icon name="menu" size={14}></loom-icon>{cur}
          </button>
          {this.open ? (
            <div class="drop" onClick={(e: Event) => e.stopPropagation()}>
              {items.map(([label, path]) => (
                <span class={"navlink" + (active === label ? " on" : "")} onClick={() => this.go(path)}><loom-icon name={NAV_ICONS[label]} size={13}></loom-icon>{label}</span>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <div class="strip">
        {items.map(([label, path]) => (
          <div class="item"><span class={"navlink" + (active === label ? " on" : "")} onClick={() => this.go(path)}><loom-icon name={NAV_ICONS[label]} size={13}></loom-icon>{label}</span></div>
        ))}
      </div>
    );
  }
}
