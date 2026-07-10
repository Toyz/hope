// Root shell of the explorer UI (VSCode-inspired): a system banner + top bar, a
// resizable left scope-rail, the routing outlet as the main area, and — when a
// container is inspected — a resizable bottom panel (like the editor terminal),
// not a right column. The outlet cascades `theme` into every routed page.
//
// Chrome is suppressed pre-auth and on /login so the login page renders bare.
//
// The root also owns body-scroll locking: any modal emits ModalToggle on the bus
// (see signalModal), and hope-app ref-counts the open ones here.
import { LoomElement, component, styles, reactive, on, persist, mount, unmount } from "@toyz/loom";
import { css } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { RouteChanged } from "@toyz/loom/router";
import { AuthStore } from "./auth-store";
import { HopeTransport } from "./transport";
import { EventFeed } from "./event-feed";
import "./components/consent-modal"; // registers <hope-consent>
import { theme } from "./styles";
import { ModalToggle, InspectorTarget, LogPanelTarget, ImageInspectorTarget, VolumeInspectorTarget, NetworkInspectorTarget, ConnectorInspectorTarget, PluginInspectorTarget } from "./events";

@component("hope-app")
@styles(theme, css`
  :host { display: block; height: 100vh; overflow: hidden; background: var(--ink); }

  /* bare (login / pre-auth) — just the outlet, no shell chrome */
  .bare { height: 100vh; overflow: auto; }

  /* explorer shell: banner + top bar span; resizable rail | main below */
  .shell { height: 100vh; display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr);
    grid-template-rows: auto 46px minmax(0, 1fr); }
  .shell > .sysb { grid-column: 1 / -1; }
  .shell > .top { grid-column: 1 / -1; }
  .shell > .rail { position: relative; min-height: 0; }

  /* drag handles — thin, invisible until hover, VSCode-style */
  .rzx { position: absolute; top: 0; right: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 40; }
  .rzx::after { content: ""; position: absolute; inset: 0 2px; background: transparent; transition: background .12s; }
  .rzx:hover::after, .rzx:active::after { background: color-mix(in srgb, var(--upd) 55%, transparent); }

  /* main splits vertically: scrolling content over an optional bottom panel */
  .shell > .main { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .content { flex: 1; min-height: 0; overflow-y: auto; }
  .rzy { flex: none; height: 7px; position: relative; cursor: row-resize; background: var(--line); }
  .rzy::after { content: ""; position: absolute; inset: 3px 0; background: transparent; transition: background .12s; }
  .rzy:hover::after, .rzy:active::after { background: color-mix(in srgb, var(--upd) 55%, transparent); }
  .panel { flex: none; height: var(--panel-h); min-height: 120px; min-width: 0; overflow: hidden; }
`)
export class HopeApp extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @reactive accessor path = location.pathname;
  @reactive accessor inspOpen = false;
  @reactive accessor logsOpen = false;
  @reactive accessor imgOpen = false;
  @reactive accessor volOpen = false;
  @reactive accessor netOpen = false;
  @reactive accessor connOpen = false;
  @reactive accessor pluginOpen = false;
  @persist("hope.railw") accessor railW = 268;
  @persist("hope.panelh") accessor panelH = 320;

  private openModals = new Set<object>();
  private prevOverflow = "";
  private prevPad = "";

  @on(RouteChanged)
  private onRoute(e: RouteChanged) { this.path = e.path; }

  // The one app-lifetime subscription to the server event feed: it re-emits server
  // changes onto the loom bus so the rail/pages update live. Started once here (the
  // always-mounted root); it idles until a token exists, so starting pre-login is
  // fine.
  private feed?: EventFeed;
  @mount private startFeed() { this.feed = new EventFeed(this.rpc, this.auth); this.feed.start(); }
  @unmount private stopFeed() { this.feed?.stop(); }

  // The docked bottom slot holds either the container inspector or the
  // multi-source log viewer — opening one supersedes the other.
  @on(InspectorTarget)
  private onInspect(e: InspectorTarget) { this.inspOpen = !!e.id; if (e.id) { this.logsOpen = false; this.imgOpen = false; this.volOpen = false; this.netOpen = false; this.connOpen = false; this.pluginOpen = false; } }

  @on(LogPanelTarget)
  private onLogs(e: LogPanelTarget) { this.logsOpen = !!e.method; if (e.method) { this.inspOpen = false; this.imgOpen = false; this.volOpen = false; this.netOpen = false; this.connOpen = false; this.pluginOpen = false; } }

  @on(ImageInspectorTarget)
  private onImage(e: ImageInspectorTarget) { this.imgOpen = !!e.ref; if (e.ref) { this.inspOpen = false; this.logsOpen = false; this.volOpen = false; this.netOpen = false; this.connOpen = false; this.pluginOpen = false; } }

  @on(VolumeInspectorTarget)
  private onVolume(e: VolumeInspectorTarget) { this.volOpen = !!e.name; if (e.name) { this.inspOpen = false; this.logsOpen = false; this.imgOpen = false; this.netOpen = false; this.connOpen = false; this.pluginOpen = false; } }

  @on(NetworkInspectorTarget)
  private onNetwork(e: NetworkInspectorTarget) { this.netOpen = !!e.ref; if (e.ref) { this.inspOpen = false; this.logsOpen = false; this.imgOpen = false; this.volOpen = false; this.connOpen = false; this.pluginOpen = false; } }

  @on(ConnectorInspectorTarget)
  private onConnector(e: ConnectorInspectorTarget) { this.connOpen = !!e.id; if (e.id) { this.inspOpen = false; this.logsOpen = false; this.imgOpen = false; this.volOpen = false; this.netOpen = false; this.pluginOpen = false; } }

  @on(PluginInspectorTarget)
  private onPlugin(e: PluginInspectorTarget) { this.pluginOpen = !!e.key; if (e.key) { this.inspOpen = false; this.logsOpen = false; this.imgOpen = false; this.volOpen = false; this.netOpen = false; this.connOpen = false; } }

  // Drag the rail's right edge to resize its width (clamped, persisted).
  private startRail = (e: PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const sw = this.railW;
    const move = (ev: PointerEvent) => { this.railW = Math.max(200, Math.min(480, sw + ev.clientX - sx)); };
    this.drag(move);
  };
  // Drag the divider to resize the bottom panel height (up = taller).
  private startPanel = (e: PointerEvent) => {
    e.preventDefault();
    const sy = e.clientY;
    const sh = this.panelH;
    const move = (ev: PointerEvent) => { this.panelH = Math.max(120, Math.min(window.innerHeight - 220, sh - (ev.clientY - sy))); };
    this.drag(move);
  };
  private drag(move: (e: PointerEvent) => void) {
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  @on(ModalToggle)
  private onModalToggle(e: ModalToggle) {
    const was = this.openModals.size;
    if (e.open) this.openModals.add(e.source);
    else this.openModals.delete(e.source);
    const now = this.openModals.size;
    if (was === 0 && now > 0) this.lockBody();
    else if (was > 0 && now === 0) this.unlockBody();
  }

  private lockBody() {
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    this.prevOverflow = document.body.style.overflow;
    this.prevPad = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (sbw > 0) document.body.style.paddingRight = `${sbw}px`;
  }

  private unlockBody() {
    document.body.style.overflow = this.prevOverflow;
    document.body.style.paddingRight = this.prevPad;
  }

  private bare(): boolean {
    return this.path === "/login" || !this.auth.isAuthenticated;
  }

  update() {
    if (this.bare()) {
      return (
        <div class="bare">
          <loom-outlet styles={[theme]}></loom-outlet>
        </div>
      );
    }
    return (
      <div class="shell" style={`--rail-w:${this.railW}px;--panel-h:${this.panelH}px`}>
        <div class="sysb"><hope-sysbanner></hope-sysbanner></div>
        <div class="top"><hope-topbar></hope-topbar></div>
        <div class="rail">
          <hope-rail></hope-rail>
          <div class="rzx" onPointerDown={this.startRail}></div>
        </div>
        <div class="main">
          <div class="content">
            <loom-outlet styles={[theme]}></loom-outlet>
          </div>
          {this.inspOpen || this.logsOpen || this.imgOpen || this.volOpen || this.netOpen || this.connOpen || this.pluginOpen ? (
            <>
              <div class="rzy" onPointerDown={this.startPanel}></div>
              <div class="panel">{this.logsOpen ? <hope-logs></hope-logs> : this.imgOpen ? <hope-image-inspector></hope-image-inspector> : this.volOpen ? <hope-volume-inspector></hope-volume-inspector> : this.netOpen ? <hope-network-inspector></hope-network-inspector> : this.connOpen ? <hope-connector-inspector></hope-connector-inspector> : this.pluginOpen ? <hope-plugin-inspector></hope-plugin-inspector> : <hope-inspector></hope-inspector>}</div>
            </>
          ) : null}
        </div>
        <hope-palette></hope-palette>
        <hope-consent></hope-consent>
      </div>
    );
  }
}
