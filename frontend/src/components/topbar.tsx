// <hope-topbar> — the explorer shell's top strip: brand, a breadcrumb of the
// current scope (fleet / host / stack|resource), a command/search stub, and the
// global refresh + exit. Navigation itself lives in the rail; this bar is
// orientation + global actions.
import { LoomElement, component, styles, css, reactive, on, mount, app, bus } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { withHost } from "../host-url";
import { PaletteToggle, PageCrumbs, pluginCrumbs } from "../events";
import "./alerts-bell"; // registers <hope-alerts-bell>
import { modLabel } from "../platform";
import { theme } from "../styles";

type Crumb = { label: string; to?: string; muted?: boolean };

@component("hope-topbar")
@styles(theme, css`
  :host { display: flex; align-items: center; gap: 14px; height: 100%; padding: 0 14px;
    background: var(--panel); border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: baseline; gap: 8px; }
  .brand b { font: 700 14px/1 var(--mono); letter-spacing: .02em; color: var(--hi); }
  .brand .v { color: var(--dim); font: 500 10px/1 var(--mono); letter-spacing: .1em; }

  .crumb { display: flex; align-items: center; gap: 8px; font: 500 12px/1 var(--mono); }
  .crumb .c { color: var(--dim); cursor: pointer; }
  .crumb .c:hover { color: var(--hi); }
  .crumb .c.cur { color: var(--hi); cursor: default; }
  .crumb .c.cur:hover { color: var(--hi); }
  .crumb .sep { color: var(--line2); }

  .search { margin-left: auto; display: flex; align-items: center; gap: 9px; width: min(340px, 34vw); height: 30px;
    padding: 0 10px; background: var(--ink); border: 1px solid var(--line2); color: var(--dim); cursor: text; }
  .search:hover { border-color: var(--dim); }
  .search span.q { color: var(--mid); font: 400 12px/1 var(--mono); }
  .search .k { margin-left: auto; border: 1px solid var(--line2); padding: 1px 5px; font: 500 10px/1 var(--mono); }

  .btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border: 1px solid var(--line2);
    background: transparent; color: var(--mid); cursor: pointer; font: 600 10.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .btn:hover { color: var(--hi); border-color: var(--dim); }
`)
export class HopeTopbar extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @reactive accessor path = location.pathname;
  @reactive accessor pageCrumbs: { label: string; to?: string }[] | null = null; // plugin-supplied trail

  private get router(): LoomRouter { return app.get(LoomRouter); }

  // Read the persisted crumbs on mount so a full page reload (where the page may have
  // emitted before this subscribed) still shows the author trail.
  @mount private onMount() { this.pageCrumbs = pluginCrumbs.value; }

  @on(RouteChanged)
  private onRoute(e: RouteChanged) {
    this.path = e.path;
    // Clear on every navigation; the destination plugin page re-emits its own crumbs
    // on load (this avoids showing the previous page's trail during plugin->plugin nav).
    this.pageCrumbs = null;
    pluginCrumbs.value = null;
  }

  @on(PageCrumbs)
  private onPageCrumbs(e: PageCrumbs) { this.pageCrumbs = e.crumbs; }

  // Turn the current path into a scope breadcrumb.
  private crumbs(): Crumb[] {
    const p = this.path.split("/").filter(Boolean);
    const out: Crumb[] = [{ label: "fleet", to: "/" }];
    if (p.length === 0) { out[0].muted = false; return out; }
    // A plugin page can supply its own author-declared trail (already absolute).
    if (p[0] === "plugin" && this.pageCrumbs && this.pageCrumbs.length) {
      out.push({ label: "plugins", to: "/plugins" });
      for (const c of this.pageCrumbs) out.push({ label: c.label, to: c.to });
      out[out.length - 1].muted = true;
      return out;
    }
    const [page, host, third] = p;
    if (page === "host" && host) {
      out.push({ label: host === "all" ? "all hosts" : host, to: `/host/${host}` });
    } else if (page === "stack" && host && third) {
      out.push({ label: host, to: `/host/${host}` });
      out.push({ label: decodeURIComponent(third), to: withHost(host, `/stack/${third}`) });
    } else if (page === "container" && host && third) {
      out.push({ label: host, to: `/host/${host}` });
      out.push({ label: third.slice(0, 12), muted: true });
    } else if (["images", "volumes", "networks", "tunnels", "deploy"].includes(page) && host) {
      out.push({ label: host, to: `/host/${host}` });
      out.push({ label: page });
    } else {
      out.push({ label: page });
    }
    out[out.length - 1].muted = true; // last = current, not a link
    return out;
  }

  update() {
    const crumbs = this.crumbs();
    return (
      <>
        <div class="brand"><b>hope</b><span class="v">{__HOPE_VERSION__}</span></div>
        <div class="crumb">
          {crumbs.map((c, i) => (
            <>
              {i > 0 ? <span class="sep">/</span> : null}
              <span class={"c" + (c.muted ? " cur" : "")} onClick={() => (!c.muted && c.to ? this.router.navigate(c.to) : null)}>{c.label}</span>
            </>
          ))}
        </div>
        <div class="search" title={`jump to (${modLabel("K")})`} onClick={() => bus.emit(new PaletteToggle())}>
          <loom-icon name="search" size={13}></loom-icon>
          <span class="q">Jump to host, stack, container…</span>
          <span class="k">{modLabel("K")}</span>
        </div>
        <hope-alerts-bell></hope-alerts-bell>
        <hope-refresh></hope-refresh>
        <button class="btn" onClick={() => this.auth.logout()}><loom-icon name="logout" size={12}></loom-icon> exit</button>
      </>
    );
  }
}
