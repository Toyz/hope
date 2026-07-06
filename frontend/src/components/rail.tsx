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
import { Refreshing, PluginsChanged, UpdatesApplied } from "../events";
import { capabilities } from "../caps";
import type { FleetHost, StackSummary, ContainerSummary, ClusterUpdate } from "../contracts";
import { theme, stackSeverity, severityRank, type Severity } from "../styles";

// An enabled plugin's custom page tree (mirrors pluginhost.PluginPages). A node is
// a navigable page (path) or a group (children).
interface PluginPageNode { title: string; icon?: string; path?: string; children?: PluginPageNode[] }
interface PluginPages { key: string; name: string; host: string; icon?: string; pages: PluginPageNode[] }

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
// A stack's dot: real trouble (loop/warn/down) wins; an otherwise-healthy stack
// with an image update shows the blue update dot.
function stackTone(s: StackSummary, hasUpd: boolean): string {
  const sev = stackSeverity(s.running, s.total, s.restarting);
  if (sev === "ok") return hasUpd ? "upd" : "ok";
  return sev === "warn" ? "warn" : "bad";
}
function ctrTone(state: string, hasUpd: boolean): string {
  if (state === "running") return hasUpd ? "upd" : "ok";
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
  .h2 { padding-left: 28px; }
  .h3 { padding-left: 44px; }
  .h4 { padding-left: 60px; }
  .h5 { padding-left: 76px; }
  .repn { color: var(--dim); font-size: 10.5px; margin-left: 6px; }

  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dim); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .dot.bad { background: var(--bad); } .dot.upd { background: var(--upd); }
  .dot.off { background: var(--bad); opacity: .4; }

  .rlink { display: flex; align-items: center; gap: 9px; height: 26px; padding: 0 12px 0 14px; cursor: pointer;
    color: var(--mid); font: 500 12.5px/1 var(--mono); text-decoration: none; }
  .rlink:hover { background: var(--raised); color: var(--hi); }
  .rlink.on { background: color-mix(in srgb, var(--upd) 15%, transparent); color: var(--hi); position: relative; }
  .rlink.on::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--upd); }
  .rlink.on loom-icon { color: var(--hi); }
  .node loom-icon { color: var(--dim); flex: none; }
  .rlink loom-icon { color: var(--dim); }
  .rlink .hint { margin-left: auto; font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }

  .foot { border-top: 1px solid var(--line); padding: 10px; }
  .deploy { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 34px; border: 1px solid var(--upd);
    background: color-mix(in srgb, var(--upd) 12%, transparent); color: var(--upd); cursor: pointer;
    font: 700 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .deploy:hover { background: color-mix(in srgb, var(--upd) 20%, transparent); }
  .fbrand { display: flex; align-items: center; gap: 7px; padding: 12px 4px 2px; }
  .fbrand .fdot { width: 6px; height: 6px; border-radius: 50%; background: var(--upd); flex: none; }
  .fbrand b { font: 700 11px/1 var(--mono); letter-spacing: .04em; color: var(--hi); }
  .fbrand .ftag { font: 10px/1.4 var(--mono); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 14px 12px; color: var(--dim); font-size: 11px; }
`)
export class HopeRail extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;

  @reactive accessor fleet: FleetHost[] = [];
  @reactive accessor apiOn = false; // API explorer enabled (config) — show its rail link
  @reactive accessor pluginsOn = false; // container-plugin system enabled — show its rail link
  @reactive accessor pluginPages: PluginPages[] = []; // enabled plugins' custom pages (nested)
  @reactive accessor curPath = location.pathname;
  // Expanded host ids and "host/project" stack keys, remembered across the session.
  @persist("hope.rail.hosts") accessor openHosts: string[] = [];
  @persist("hope.rail.stacks") accessor openStacks: string[] = [];
  // Expanded replica groups, keyed "host/project/service".
  @persist("hope.rail.svcs") accessor openSvcs: string[] = [];
  // Expanded plugin containers + page groups, keyed by plugin key / group path.
  @persist("hope.rail.pages") accessor openPages: string[] = [];
  @persist("hope.rail.fleet") accessor openFleet = true;

  // Worst state across the fleet, for the "fleet" root dot (min severity rank).
  private fleetTone(): string {
    const rank: Record<string, number> = { off: 0, bad: 0, warn: 1, upd: 2, ok: 3 };
    let worst = "ok";
    for (const h of this.fleet) {
      const t = hostTone(h);
      if ((rank[t] ?? 3) < (rank[worst] ?? 3)) worst = t === "off" ? "bad" : t;
    }
    return worst;
  }

  private get router(): LoomRouter { return app.get(LoomRouter); }

  @mount
  async load() {
    void capabilities().then((c) => {
      this.apiOn = !!c.api_enabled;
      this.pluginsOn = !!c.plugins_enabled;
      this.refetchPages();
    });
    try {
      this.fleet = (await this.rpc.call<FleetHost[]>("System", "fleet", [])) || [];
    } catch { /* keep last */ }
  }

  private refetchPages() {
    if (!this.pluginsOn) return;
    void this.rpc.call<PluginPages[]>("Plugins", "pages", []).then((p) => (this.pluginPages = p || [])).catch(() => {});
  }

  // A plugin was enabled/disabled/forgotten — refetch its pages immediately.
  @on(PluginsChanged) private onPluginsChanged() { this.refetchPages(); }

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
    // On a plugin page, expand its host + stack + the plugin container + the
    // ancestor page groups so the active page is revealed.
    const ps = this.pluginSel();
    if (ps) {
      if (ps.host && !this.openHosts.includes(ps.host)) this.openHosts = [...this.openHosts, ps.host];
      const skey = ps.host + "/" + ps.project;
      if (!this.openStacks.includes(skey)) this.openStacks = [...this.openStacks, skey];
      const pkey = `${ps.host}|${ps.project}/${ps.service}`;
      const opens = [pkey]; // the plugin container
      const segs = ps.path.split(".");
      for (let i = 2; i < segs.length; i++) opens.push(pkey + ":" + segs.slice(0, i).join(".")); // ancestor groups
      this.openPages = Array.from(new Set([...this.openPages, ...opens]));
    }
  }

  // Refetch on the shared refresh beat so the tree stays live with the pages.
  @on(Refreshing)
  private onRefresh(e: Refreshing) { if (!e.active) void this.load(); }

  // A container/stack was just updated — patch the affected host's outdated
  // markers in place instead of reloading the whole fleet map. The backend has
  // already flipped those refs to "current", so dropping their outdated rows and
  // recomputing the host's count matches server truth; the next full load (or a
  // background crawl) reconciles container identity.
  @on(UpdatesApplied)
  private onUpdatesApplied(e: UpdatesApplied) {
    let touched = false;
    const fleet = this.fleet.map((h) => {
      if (h.id !== e.host) return h;
      // Specific containers → match by id (globally unique, so this also covers
      // ungrouped rows whose project is ""); a whole-stack redeploy → by project.
      const cleared = (u: ClusterUpdate) => (e.ids ? e.ids.includes(u.id) : u.project === e.project);
      const updates = (h.updates || []).filter((u) => !(u.status === "outdated" && cleared(u)));
      if (updates.length === (h.updates || []).length) return h; // nothing cleared
      touched = true;
      return { ...h, updates, outdated: updates.filter((u) => u.status === "outdated").length };
    });
    if (touched) this.fleet = fleet;
  }

  private toggleHost(id: string, e: Event) {
    e.stopPropagation();
    this.openHosts = this.openHosts.includes(id) ? this.openHosts.filter((h) => h !== id) : [...this.openHosts, id];
  }
  private toggleStack(key: string, e: Event) {
    e.stopPropagation();
    this.openStacks = this.openStacks.includes(key) ? this.openStacks.filter((k) => k !== key) : [...this.openStacks, key];
  }
  private toggleSvc(key: string, e: Event) {
    e.stopPropagation();
    this.openSvcs = this.openSvcs.includes(key) ? this.openSvcs.filter((k) => k !== key) : [...this.openSvcs, key];
  }
  private togglePages(id: string, e: Event) {
    e.stopPropagation();
    this.openPages = this.openPages.includes(id) ? this.openPages.filter((k) => k !== id) : [...this.openPages, id];
  }

  // When the URL is a plugin page (/plugin/:key/:path), the host/project/service
  // the plugin lives on + the active page path — so the whole branch highlights.
  private pluginSel(): { host: string; project: string; service: string; path: string } | null {
    const p = this.curPath.split("/");
    if (p[1] !== "plugin" || !p[2] || !p[3]) return null;
    const key = decodeURIComponent(p[2]); // host|project/service
    const bar = key.indexOf("|");
    const rest = bar >= 0 ? key.slice(bar + 1) : "";
    const slash = rest.indexOf("/");
    return {
      host: bar >= 0 ? key.slice(0, bar) : "",
      project: slash >= 0 ? rest.slice(0, slash) : rest,
      service: slash >= 0 ? rest.slice(slash + 1) : "",
      path: p[3],
    };
  }

  // Which host/stack/container the URL is on (for the selected highlight).
  private cur() {
    const p = this.curPath.split("/");
    const page = p[1] || "";
    // /stack/:host/:project[/:container] — container is the deep-link target now.
    if (page === "stack") return { page, host: p[2] || "", project: p[3] || "", cid: decodeURIComponent(p[4] || "") };
    if (page === "container") return { page, host: p[2] || "", project: "", cid: p[3] || "" };
    // host dashboard + every host-scoped resource page carries the host at p[2],
    // so the rail keeps its scope (and Resources stay enabled) on those pages too.
    if (["host", "images", "volumes", "networks", "tunnels", "deploy", "plugins"].includes(page)) {
      return { page, host: p[2] || "", project: "", cid: "" };
    }
    // A plugin page: derive host + project from the plugin key so the owning
    // stack (and container, by service) highlight as the active branch.
    if (page === "plugin") {
      const ps = this.pluginSel();
      if (ps) return { page, host: ps.host, project: ps.project, cid: "" };
    }
    return { page, host: "", project: "", cid: "" };
  }

  update() {
    const sel = this.cur();
    return (
      <>
        <div class="scroll">
          <div class="grp"><span class="eyebrow">topology</span><span class="scope">{this.fleet.length} host{this.fleet.length === 1 ? "" : "s"}</span></div>
          {this.fleet.length === 0 ? (
            <div class="empty">no hosts</div>
          ) : (
            <>
              <div class={"node h1" + (sel.host === "all" ? " sel" : "")} onClick={() => this.router.navigate("/host/all")}>
                <span class={"caret" + (this.openFleet ? " open" : "")} onClick={(e: Event) => { e.stopPropagation(); this.openFleet = !this.openFleet; }}><loom-icon name="chevron-right" size={11}></loom-icon></span>
                <span class={"dot " + this.fleetTone()}></span>
                <span class="label">fleet</span>
                <span class="meta">all</span>
              </div>
              {this.openFleet ? this.fleet.map((h) => this.renderHost(h, sel)) : null}
            </>
          )}
        </div>
        <div class="pinned">
          <div class="grp"><span class="eyebrow">resources</span><span class="scope">{sel.host && sel.host !== "all" ? sel.host : "fleet"}</span></div>
          {this.renderResources(sel.host)}

          <div class="grp mt"><span class="eyebrow">system</span></div>
          <div class={"rlink" + (sel.page === "agents" ? " on" : "")} onClick={() => this.router.navigate("/agents")}><loom-icon name="server" size={13}></loom-icon><span>agents</span></div>
          <div class={"rlink" + (sel.page === "registries" ? " on" : "")} onClick={() => this.router.navigate("/registries")}><loom-icon name="database" size={13}></loom-icon><span>registries</span></div>
          {this.apiOn ? <div class={"rlink" + (sel.page === "api-docs" ? " on" : "")} onClick={() => this.router.navigate("/api-docs")}><loom-icon name="terminal" size={13}></loom-icon><span>api</span></div> : null}
          <a class="rlink" href="https://github.com/toyz/hope" target="_blank" rel="noreferrer"><loom-icon name="link" size={13}></loom-icon><span>github</span></a>
        </div>
        <div class="foot">
          <button class="deploy" onClick={() => this.router.navigate(withHost(sel.host || "local", "/deploy"))}>
            <loom-icon name="rocket" size={13}></loom-icon> deploy
          </button>
          <div class="fbrand"><span class="fdot"></span><b>hope</b><span class="ftag">open-source docker cluster manager</span></div>
        </div>
      </>
    );
  }

  private renderHost(h: FleetHost, sel: { host: string; project: string; cid: string }) {
    const open = this.openHosts.includes(h.id) && h.online;
    const on = sel.host === h.id && !sel.project && !sel.cid;
    // Which of this host's stacks / containers have an image update, so the tree
    // dots can flag them (blue) even when the container is healthy.
    const outdated = (h.updates || []).filter((u) => u.status === "outdated");
    const outProjects = new Set(outdated.map((u) => u.project || ""));
    const outIds = new Set(outdated.map((u) => u.id));
    return (
      <>
        <div class={"node h2" + (on ? " sel" : "")} onClick={() => this.router.navigate(`/host/${encodeURIComponent(h.id)}`)}>
          <span class={"caret" + (open ? " open" : "") + (h.online ? "" : " leaf")} onClick={(e: Event) => this.toggleHost(h.id, e)}><loom-icon name="chevron-right" size={11}></loom-icon></span>
          <span class={"dot " + hostTone(h)}></span>
          <span class="label" style={h.online ? "" : "color:var(--dim)"}>{h.id}</span>
          <span class="meta">{h.online ? h.kind : "offline"}</span>
        </div>
        {open ? (h.stacks || []).map((s) => this.renderStack(h.id, s, sel, outProjects, outIds)) : null}
      </>
    );
  }

  private renderStack(hostId: string, s: StackSummary, sel: { host: string; project: string; cid: string }, outProjects: Set<string>, outIds: Set<string>) {
    const key = hostId + "/" + s.project;
    const open = this.openStacks.includes(key);
    const on = sel.host === hostId && sel.project === s.project;
    return (
      <>
        <div class={"node h3" + (on ? " sel" : "")} onClick={() => this.router.navigate(withHost(hostId, `/stack/${encodeURIComponent(s.project)}`))}>
          <span class={"caret" + (open ? " open" : "")} onClick={(e: Event) => this.toggleStack(key, e)}><loom-icon name="chevron-right" size={11}></loom-icon></span>
          <span class={"dot " + stackTone(s, outProjects.has(s.project))}></span>
          <span class="label">{s.project}</span>
          <span class="meta">{s.running}/{s.total}</span>
        </div>
        {open ? this.renderContainers(hostId, s, sel, outIds) : null}
      </>
    );
  }

  // Containers under a stack, grouped by compose service so replicas collapse into
  // one expandable node instead of stacking as N flat rows with the same name.
  private renderContainers(hostId: string, s: StackSummary, sel: { host: string; project: string; cid: string }, outIds: Set<string>) {
    const svcOrder: string[] = [];
    const bySvc = new Map<string, ContainerSummary[]>();
    for (const c of s.containers || []) {
      const svc = c.service || c.name;
      if (!bySvc.has(svc)) { bySvc.set(svc, []); svcOrder.push(svc); }
      bySvc.get(svc)!.push(c);
    }
    const cnav = (c: ContainerSummary) => this.router.navigate(withHost(hostId, `/stack/${encodeURIComponent(s.project)}/${encodeURIComponent(c.id)}`));
    return svcOrder.map((svc) => {
      const reps = bySvc.get(svc)!;
      if (reps.length === 1) {
        const c = reps[0];
        const pp = this.pluginPagesFor(hostId, s.project, svc);
        const ps = this.pluginSel();
        const pact = !!pp && !!ps && ps.host === hostId && ps.project === s.project && ps.service === svc;
        const con = (sel.host === hostId && sel.cid === c.id) || pact;
        const pgOpen = !!pp && this.openPages.includes(pp.key);
        return (
          <>
            <div class={"node h4" + (con ? " sel" : "")} onClick={() => cnav(c)}>
              {pp
                ? <span class={"caret" + (pgOpen ? " open" : "")} onClick={(e: Event) => this.togglePages(pp.key, e)}><loom-icon name="chevron-right" size={11}></loom-icon></span>
                : <span class="caret leaf"></span>}
              <span class={"dot " + ctrTone(c.state, outIds.has(c.id))}></span>
              <span class="label">{svc}</span>
            </div>
            {pp && pgOpen ? this.renderContainerPages(hostId, s.project, svc, 76) : null}
          </>
        );
      }
      // Replica group: one service node with a count that expands to its replicas.
      const key = hostId + "/" + s.project + "/" + svc;
      const rOpen = this.openSvcs.includes(key);
      const running = reps.filter((c) => c.state === "running").length;
      const anyUpd = reps.some((c) => outIds.has(c.id));
      const worst = reps.some((c) => c.state === "restarting") ? "bad" : running === reps.length ? (anyUpd ? "upd" : "ok") : running === 0 ? "off" : "warn";
      // Mark the group with the same active style as everything else when the
      // active container is one of its replicas (so it's consistent, not a bespoke
      // bar-only variant).
      const grpActive = sel.host === hostId && reps.some((c) => c.id === sel.cid);
      return (
        <>
          <div class={"node h4" + (grpActive ? " sel" : "")} onClick={(e: Event) => this.toggleSvc(key, e)}>
            <span class={"caret" + (rOpen ? " open" : "")}><loom-icon name="chevron-right" size={11}></loom-icon></span>
            <span class={"dot " + worst}></span>
            <span class="label">{svc}</span>
            <span class="meta">{running}/{reps.length}</span>
          </div>
          {rOpen ? reps.map((c) => {
            const con = sel.host === hostId && sel.cid === c.id;
            return (
              <div class={"node h5" + (con ? " sel" : "")} onClick={() => cnav(c)}>
                <span class="caret leaf"></span>
                <span class={"dot " + ctrTone(c.state, outIds.has(c.id))}></span>
                <span class="label">{svc}<span class="repn">#{c.number || "—"}</span></span>
              </div>
            );
          }) : null}
          {rOpen ? this.renderContainerPages(hostId, s.project, svc, 76) : null}
        </>
      );
    });
  }

  // The plugin (with custom pages) that owns a given container identity, if any.
  private pluginPagesFor(hostId: string, project: string, service: string): PluginPages | undefined {
    const key = `${hostId}|${project}/${service}`;
    return this.pluginPages.find((p) => p.key === key);
  }

  // A plugin's page tree, rendered as topology nodes directly UNDER its container.
  private renderContainerPages(hostId: string, project: string, service: string, pad: number) {
    const pp = this.pluginPagesFor(hostId, project, service);
    if (!pp) return null;
    return pp.pages.map((n) => this.renderTopoPageNode(pp.key, n, pad));
  }

  private renderTopoPageNode(key: string, n: PluginPageNode, pad: number): any {
    const ps = this.pluginSel();
    // Active branch: exact for the leaf, prefix for its ancestor groups.
    const active = !!ps && !!n.path && (ps.path === n.path || ps.path.startsWith(n.path + "."));
    if (n.children && n.children.length) {
      const gid = key + ":" + n.path;
      const open = this.openPages.includes(gid);
      return (
        <>
          <div class={"node" + (active ? " sel" : "")} style={`padding-left:${pad}px`}>
            <span class={"caret" + (open ? " open" : "")} onClick={(e: Event) => this.togglePages(gid, e)}><loom-icon name="chevron-right" size={11}></loom-icon></span>
            <loom-icon name={n.icon || "box"} size={12}></loom-icon>
            <span class="label">{n.title}</span>
          </div>
          {open ? n.children.map((c) => this.renderTopoPageNode(key, c, pad + 16)) : null}
        </>
      );
    }
    const to = `/plugin/${encodeURIComponent(key)}/${n.path}`;
    return (
      <div class={"node" + (active ? " sel" : "")} style={`padding-left:${pad}px`} onClick={() => this.router.navigate(to)}>
        <span class="caret leaf"></span>
        <loom-icon name={n.icon || "file"} size={12}></loom-icon>
        <span class="label">{n.title}</span>
      </div>
    );
  }

  private renderResources(host: string) {
    const items: [string, string][] = [["box", "images"], ["database", "volumes"], ["link", "networks"], ["globe", "tunnels"]];
    // Plugins are a per-host resource too (a host's plugin containers) — surfaced
    // here when the feature is on, alongside the cross-fleet system page.
    if (this.pluginsOn) items.push(["plugin", "plugins"]);
    // Fleet root (host "all" or none) targets the cross-fleet aggregate view — the
    // resource pages support /<resource>/all, so there's no reason to gate them.
    const target = host || "all";
    const page = this.curPath.split("/")[1];
    return items.map(([icon, label]) => (
      <div class={"rlink" + (page === label ? " on" : "")} onClick={() => this.router.navigate(withHost(target, "/" + label))}>
        <loom-icon name={icon} size={13}></loom-icon><span>{label}</span>
      </div>
    ));
  }
}
