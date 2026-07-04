// <hope-rail> — the persistent left scope-rail: the fleet as a live tree
// (fleet -> host -> stack -> container). It's the navigation spine of the explorer
// shell — selection mirrors the URL (host in /host/:host, /stack/:host/:project,
// /container/:host/:id) and clicking a node navigates there. Health rolls up: a
// host's dot is the worst of its stacks. Expansion is remembered per session.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { persist } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { withHost } from "../host-url";
import { Refreshing } from "../events";
import type { FleetHost, StackSummary } from "../contracts";
import { theme, stackSeverity, severityRank, type Severity } from "../styles";

// A host's roll-up state: the worst of its stacks, or offline.
function hostTone(h: FleetHost): string {
  if (!h.online) return "off";
  let worst: Severity = "ok";
  for (const s of h.stacks || []) {
    const sev = stackSeverity(s.running, s.total, s.restarting);
    if (severityRank(sev) < severityRank(worst)) worst = sev;
  }
  if (worst === "ok") return h.outdated > 0 ? "upd" : "ok";
  return worst === "warn" ? "warn" : "bad";
}
function stackTone(s: StackSummary): string {
  const sev = stackSeverity(s.running, s.total, s.restarting);
  return sev === "ok" ? "ok" : sev === "warn" ? "warn" : "bad";
}
function ctrTone(state: string): string {
  if (state === "running") return "ok";
  if (state === "restarting") return "bad";
  return "off";
}

@component("hope-rail")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; overflow: hidden;
    background: var(--panel); border-right: 1px solid var(--line); }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 0 8px; }
  /* resources + fleet stay pinned below the (scrolling) topology so a host with a
     lot of stacks can't push them out of reach */
  .pinned { flex: none; border-top: 1px solid var(--line); padding: 10px 0 8px; }
  .grp { display: flex; align-items: center; justify-content: space-between; padding: 0 12px; margin: 0 0 6px; }
  .grp.mt { margin-top: 16px; }
  .eyebrow { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .scope { color: var(--dim); font: 500 9.5px/1 var(--mono); letter-spacing: .1em; }

  .node { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 12px; cursor: pointer;
    position: relative; color: var(--mid); white-space: nowrap; font: 500 12.5px/1 var(--mono); }
  .node:hover { background: var(--raised); color: var(--hi); }
  .node.sel { background: color-mix(in srgb, var(--upd) 15%, transparent); color: var(--hi); }
  .node.sel::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--upd); }
  .node .label { overflow: hidden; text-overflow: ellipsis; }
  .node .meta { margin-left: auto; color: var(--dim); font-size: 10.5px; letter-spacing: .04em; }
  .caret { width: 10px; flex: none; color: var(--dim); font-size: 9px; transition: transform .12s ease; }
  .caret.open { transform: rotate(90deg); }
  .caret.leaf { visibility: hidden; }
  .h1 { padding-left: 12px; }
  .h2 { padding-left: 30px; }
  .h3 { padding-left: 48px; }

  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dim); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .dot.bad { background: var(--bad); } .dot.upd { background: var(--upd); }
  .dot.off { background: var(--bad); opacity: .4; }

  .rlink { display: flex; align-items: center; gap: 9px; height: 26px; padding: 0 12px 0 14px; cursor: pointer;
    color: var(--mid); font: 500 12.5px/1 var(--mono); }
  .rlink:hover { background: var(--raised); color: var(--hi); }
  .rlink.dis { color: var(--dim); cursor: default; }
  .rlink.dis:hover { background: transparent; color: var(--dim); }
  .rlink loom-icon { color: var(--dim); }
  .rlink .hint { margin-left: auto; font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }

  .foot { border-top: 1px solid var(--line); padding: 10px; }
  .deploy { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 34px; border: 1px solid var(--upd);
    background: color-mix(in srgb, var(--upd) 12%, transparent); color: var(--upd); cursor: pointer;
    font: 700 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .deploy:hover { background: color-mix(in srgb, var(--upd) 20%, transparent); }
  .empty { padding: 14px 12px; color: var(--dim); font-size: 11px; }
`)
export class HopeRail extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;

  @reactive accessor fleet: FleetHost[] = [];
  @reactive accessor curPath = location.pathname;
  // Expanded host ids and "host/project" stack keys, remembered across the session.
  @persist("hope.rail.hosts") accessor openHosts: string[] = [];
  @persist("hope.rail.stacks") accessor openStacks: string[] = [];

  private get router(): LoomRouter { return app.get(LoomRouter); }

  @mount
  async load() {
    try {
      this.fleet = (await this.rpc.call<FleetHost[]>("System", "fleet", [])) || [];
    } catch { /* keep last */ }
  }

  @on(RouteChanged)
  private onRoute(e: RouteChanged) {
    this.curPath = e.path;
    // Auto-expand the branch the URL points at so the current node is visible.
    const host = e.params.host;
    const project = e.params.project;
    if (host && host !== "all" && !this.openHosts.includes(host)) this.openHosts = [...this.openHosts, host];
    if (host && project) {
      const key = host + "/" + project;
      if (!this.openStacks.includes(key)) this.openStacks = [...this.openStacks, key];
    }
  }

  // Refetch on the shared refresh beat so the tree stays live with the pages.
  @on(Refreshing)
  private onRefresh(e: Refreshing) { if (!e.active) void this.load(); }

  private toggleHost(id: string, e: Event) {
    e.stopPropagation();
    this.openHosts = this.openHosts.includes(id) ? this.openHosts.filter((h) => h !== id) : [...this.openHosts, id];
  }
  private toggleStack(key: string, e: Event) {
    e.stopPropagation();
    this.openStacks = this.openStacks.includes(key) ? this.openStacks.filter((k) => k !== key) : [...this.openStacks, key];
  }

  // Which host/stack/container the URL is on (for the selected highlight).
  private cur() {
    const p = this.curPath.split("/");
    if (p[1] === "host") return { host: p[2] || "", project: "", cid: "" };
    if (p[1] === "stack") return { host: p[2] || "", project: p[3] || "", cid: "" };
    if (p[1] === "container") return { host: p[2] || "", project: "", cid: p[3] || "" };
    return { host: "", project: "", cid: "" };
  }

  update() {
    const sel = this.cur();
    return (
      <>
        <div class="scroll">
          <div class="grp"><span class="eyebrow">topology</span><span class="scope">{this.fleet.length} host{this.fleet.length === 1 ? "" : "s"}</span></div>
          {this.fleet.length === 0 ? <div class="empty">no hosts</div> : this.fleet.map((h) => this.renderHost(h, sel))}
        </div>
        <div class="pinned">
          <div class="grp"><span class="eyebrow">resources</span>{sel.host && sel.host !== "all" ? <span class="scope">{sel.host}</span> : null}</div>
          {this.renderResources(sel.host)}

          <div class="grp mt"><span class="eyebrow">fleet</span></div>
          <div class="rlink" onClick={() => this.router.navigate("/agents")}><loom-icon name="server" size={13}></loom-icon><span>agents</span></div>
        </div>
        <div class="foot">
          <button class="deploy" onClick={() => this.router.navigate(withHost(sel.host || "local", "/deploy"))}>
            <loom-icon name="rocket" size={13}></loom-icon> deploy
          </button>
        </div>
      </>
    );
  }

  private renderHost(h: FleetHost, sel: { host: string; project: string; cid: string }) {
    const open = this.openHosts.includes(h.id) && h.online;
    const on = sel.host === h.id && !sel.project && !sel.cid;
    return (
      <>
        <div class={"node h1" + (on ? " sel" : "")} onClick={() => this.router.navigate(`/host/${encodeURIComponent(h.id)}`)}>
          <span class={"caret" + (open ? " open" : "") + (h.online ? "" : " leaf")} onClick={(e: Event) => this.toggleHost(h.id, e)}><loom-icon name="chevron-right" size={11}></loom-icon></span>
          <span class={"dot " + hostTone(h)}></span>
          <span class="label" style={h.online ? "" : "color:var(--dim)"}>{h.id}</span>
          <span class="meta">{h.online ? h.kind : "offline"}</span>
        </div>
        {open ? (h.stacks || []).map((s) => this.renderStack(h.id, s, sel)) : null}
      </>
    );
  }

  private renderStack(hostId: string, s: StackSummary, sel: { host: string; project: string; cid: string }) {
    const key = hostId + "/" + s.project;
    const open = this.openStacks.includes(key);
    const on = sel.host === hostId && sel.project === s.project;
    return (
      <>
        <div class={"node h2" + (on ? " sel" : "")} onClick={() => this.router.navigate(withHost(hostId, `/stack/${encodeURIComponent(s.project)}`))}>
          <span class={"caret" + (open ? " open" : "")} onClick={(e: Event) => this.toggleStack(key, e)}><loom-icon name="chevron-right" size={11}></loom-icon></span>
          <span class={"dot " + stackTone(s)}></span>
          <span class="label">{s.project}</span>
          <span class="meta">{s.running}/{s.total}</span>
        </div>
        {open ? (s.containers || []).map((c) => {
          const con = sel.host === hostId && sel.cid === c.id;
          return (
            <div class={"node h3" + (con ? " sel" : "")} onClick={() => this.router.navigate(withHost(hostId, `/container/${encodeURIComponent(c.id)}`))}>
              <span class="caret leaf"></span>
              <span class={"dot " + ctrTone(c.state)}></span>
              <span class="label">{c.service || c.name}</span>
            </div>
          );
        }) : null}
      </>
    );
  }

  private renderResources(host: string) {
    const items: [string, string][] = [["box", "images"], ["database", "volumes"], ["link", "networks"], ["globe", "tunnels"]];
    if (!host || host === "all") {
      return items.map(([, label]) => (
        <div class="rlink dis"><loom-icon name={label === "images" ? "box" : label === "volumes" ? "database" : label === "networks" ? "link" : "globe"} size={13}></loom-icon><span>{label}</span><span class="hint">pick a host</span></div>
      ));
    }
    return items.map(([icon, label]) => (
      <div class="rlink" onClick={() => this.router.navigate(withHost(host, "/" + label))}><loom-icon name={icon} size={13}></loom-icon><span>{label}</span></div>
    ));
  }
}
