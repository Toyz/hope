// <hope-host-switch> — the active-host picker for the status bar. Lists the
// local daemon plus every connected agent and flips which one the whole UI
// operates on. Switching is global server state; after SetActiveHost (or a fleet
// toggle) we emit HostChanged on the bus so every mounted view re-fetches in
// place — no full-page reload, SPA state preserved.
import { LoomElement, component, styles, css, reactive, mount, on } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { HostContext } from "../host-context";
import { HostChanged } from "../events";
import type { HostView } from "../contracts";
import { theme } from "../styles";

@component("hope-host-switch")
@styles(theme, css`
  :host { display: inline-flex; position: relative; font: 600 11px/1 var(--mono); height: 100%; }

  .btn {
    display: inline-flex; align-items: center; gap: 8px; height: 100%;
    padding: 0 16px; background: transparent; border: 0; cursor: pointer;
    color: var(--dim); letter-spacing: .14em; text-transform: uppercase;
    transition: background .12s, color .12s;
  }
  .btn:hover { color: var(--hi); background: var(--raised); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.local { background: var(--upd); }
  .dot.agent { background: var(--ok); }
  .dot.all { background: linear-gradient(135deg, var(--upd) 0 50%, var(--ok) 50% 100%); }
  .dot.off { background: var(--bad); }
  .cur { color: var(--dim); font-weight: 600; }
  .cur b { color: var(--hi); font-weight: 700; letter-spacing: .04em; text-transform: none; }
  .car { color: var(--dim); transition: transform .15s ease, color .12s; }
  .btn:hover .car { color: var(--hi); }
  .car.up { transform: rotate(180deg); }

  .menu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 40;
    min-width: 220px; padding: 4px;
    background: var(--ink); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: 0 14px 40px rgba(0,0,0,.5);
  }
  .item {
    display: flex; align-items: center; gap: 9px; width: 100%;
    padding: 9px 10px; background: none; border: 0; border-radius: 6px;
    text-align: left; cursor: pointer; color: var(--hi); font: 600 12px/1.2 var(--mono);
  }
  .item:hover { background: rgba(255,255,255,.05); }
  .item .id { letter-spacing: .02em; }
  .item .meta { margin-left: auto; color: var(--dim); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
  .item[aria-current="true"] { color: var(--hi); }
  .item[aria-current="true"] .meta { color: var(--ok); }
  .empty { padding: 10px; color: var(--dim); font-size: 11px; }
`)
export class HostSwitch extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(HostContext) accessor hostCtx!: HostContext;

  @reactive accessor hosts: HostView[] = [];
  @reactive accessor open = false;
  @reactive accessor busy = false;
  // Mirror of the URL host token. hostCtx.token is another service's reactive, so
  // reading it in update() isn't tracked here — mirror it into our own reactive on
  // HostChanged so the label re-renders immediately when the host switches.
  @reactive accessor tok = "";

  @on(HostChanged)
  private onHostChanged() {
    this.tok = this.hostCtx.token;
  }

  @mount
  async load() {
    this.tok = this.hostCtx.token;
    try {
      this.hosts = (await this.rpc.call<HostView[]>("System", "hosts", [])) || [];
    } catch {
      this.hosts = [];
    }
  }

  get active(): HostView | null {
    return this.hosts.find((h) => h.active) || this.hosts[0] || null;
  }

  toggle = (e: Event) => {
    e.stopPropagation();
    this.open = !this.open;
    if (this.open) void this.refreshHosts(); // fresh list + active highlight on open
  };

  // Close when clicking elsewhere (the toggle + menu stopPropagation so their own
  // clicks don't reach here). Auto-unbinds on disconnect.
  @on(document, "click")
  onClickAway() {
    this.open = false;
  }

  // "all" is a dashboard VIEW (cross-fleet overview), not a server-active host —
  // it's tracked client-side (HostContext) so it doesn't disturb which host the
  // other pages operate on.
  get fleetOn() {
    return this.hostCtx.fleet;
  }

  // Refresh our own host list so the active-host highlight updates in place.
  private async refreshHosts() {
    try {
      this.hosts = (await this.rpc.call<HostView[]>("System", "hosts", [])) || [];
    } catch {
      /* keep the stale list */
    }
  }

  pick(id: string) {
    this.open = false;
    // Both setters navigate — the URL carries the host from here on, so the target
    // is bookmarkable and can never diverge from the address bar. RouteChanged then
    // emits HostChanged and every mounted view refetches in place.
    if (id === "all") this.hostCtx.fleet = true; // the all-hosts overview
    else this.hostCtx.activeHost = id;
  }

  update() {
    // The URL host token is the truth: "" (default -> local) | a host id | "all".
    const fleet = this.tok === "all";
    const curId = fleet ? "" : this.tok || "local";
    const a = fleet ? null : this.hosts.find((h) => h.id === curId) || null;
    const label = fleet ? "all" : a ? (a.kind === "local" ? "local" : a.id) : curId;
    const kind = fleet ? "all" : a?.kind === "agent" ? "agent" : "local";
    const multi = this.hosts.length > 1; // only worth an "all" view with >1 host
    return (
      <>
        <button class="btn" onClick={this.toggle} title="Switch Docker host">
          <span class={`dot ${kind}`}></span>
          <span class="cur">host <b>{label}</b></span>
          <loom-icon class={"car" + (this.open ? " up" : "")} name="chevron-down" size={12}></loom-icon>
        </button>
        {this.open ? (
          <div class="menu" onClick={(e: Event) => e.stopPropagation()}>
            {this.hosts.length === 0 ? (
              <div class="empty">No hosts</div>
            ) : (
              <>
                {multi ? (
                  <button class="item" aria-current={fleet ? "true" : "false"} onClick={() => this.pick("all")}>
                    <span class="dot all"></span>
                    <span class="id">all hosts</span>
                    <span class="meta">{fleet ? "active" : "overview"}</span>
                  </button>
                ) : null}
                {this.hosts.map((h) => (
                  <button
                    class="item"
                    aria-current={!fleet && h.id === curId ? "true" : "false"}
                    onClick={() => this.pick(h.id)}
                  >
                    <span class={`dot ${h.kind} ${h.connected ? "" : "off"}`}></span>
                    <span class="id">{h.kind === "local" ? "local" : h.id}</span>
                    <span class="meta">{!fleet && h.id === curId ? "active" : h.kind}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        ) : null}
      </>
    );
  }
}
