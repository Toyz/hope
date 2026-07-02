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
@styles(css`
  ${theme}
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

  @mount
  async load() {
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

  // Signal the switch so every mounted view re-fetches; refresh our own host list
  // so the active-host label updates without a page reload.
  private async announce(id: string | null) {
    try {
      this.hosts = (await this.rpc.call<HostView[]>("System", "hosts", [])) || [];
    } catch {
      /* keep the stale list; the emitted event still triggers re-fetches */
    }
    this.emit(new HostChanged(id, this.hostCtx.fleet));
  }

  async pick(id: string) {
    this.open = false;
    if (id === "all") {
      this.hostCtx.fleet = true;
      await this.announce(this.active?.id ?? null); // each page renders its all-hosts view
      return;
    }
    const wasFleet = this.fleetOn;
    this.hostCtx.fleet = false;
    this.hostCtx.activeHost = id; // ambient target the transport reads on every call
    // Leaving the all-hosts view always re-announces, even if the target host is
    // unchanged — otherwise picking "local" from "all" appears to do nothing.
    if (!wasFleet && this.active && id === this.active.id) return;
    this.busy = true;
    try {
      // Keep the server's active flag in sync (drives the picker's highlight).
      await this.rpc.call<{ active: string }>("System", "setActiveHost", [id]);
      await this.announce(id); // every view re-fetches against the new host
    } finally {
      this.busy = false;
    }
  }

  update() {
    const a = this.active;
    const fleet = this.fleetOn;
    const label = fleet ? "all" : a ? (a.kind === "local" ? "local" : a.id) : "—";
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
                    aria-current={!fleet && h.active ? "true" : "false"}
                    onClick={() => this.pick(h.id)}
                  >
                    <span class={`dot ${h.kind} ${h.connected ? "" : "off"}`}></span>
                    <span class="id">{h.kind === "local" ? "local" : h.id}</span>
                    <span class="meta">{!fleet && h.active ? "active" : h.kind}</span>
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
