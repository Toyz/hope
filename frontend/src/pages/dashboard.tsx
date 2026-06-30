// Mission-control overview, terminal-instrument style. A tmux-like status bar
// synthesizes fleet state; a flat fleet ribbon shows every stack as a cell
// (dark = nominal, lit = trouble); below, an Attention zone then a quiet Fleet
// list of instrument rows. No glows, no per-row noise. Refreshes every 5s.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, route } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { StackSummary, UpdatesResult, DiskResult, FleetHost } from "../contracts";
import { theme, stackSeverity, severityRank, markClass, type Severity } from "../styles";

interface Ranked extends StackSummary {
  sev: Severity;
}

const UNGROUPED = "(ungrouped)";

@route("/")
@component("hope-dashboard")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--ink); }

  /* ── status bar (tmux/vim airline) ── */
  .bar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink);
  }
  .bar .s {
    display: flex; align-items: center; gap: 8px; padding: 0 16px;
    border-right: 1px solid var(--line); white-space: nowrap;
  }
  .bar .brand { font: 700 13px/1 var(--mono); letter-spacing: .28em; color: var(--hi); }
  .bar .k { font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .bar .v { font-size: 13px; color: var(--hi); font-variant-numeric: tabular-nums; }
  .bar .v .t { color: var(--dim); }
  .bar .grow { flex: 1; border-right: 1px solid var(--line); }
  .bar .verdict { gap: 9px; font-size: 11px; letter-spacing: .16em; text-transform: uppercase; }
  .bar .verdict.ok { color: var(--ok); }
  .bar .verdict.warn { color: var(--warn); }
  .bar .verdict.bad { color: var(--bad); }
  .bar .nav .navlink { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); cursor: pointer; }
  .bar .nav .navlink:hover { color: var(--hi); }
  .bar .upd { gap: 7px; color: var(--upd); font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .bar .upd loom-icon { color: var(--upd); }
  .bar .act { padding: 0; border-right: 1px solid var(--line); }
  .bar .act button {
    height: 100%; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer;
  }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }
  .bar .act button:disabled { opacity: .55; cursor: default; }
  .bar .act .upcheck { display: inline-flex; align-items: center; gap: 7px; }
  .bar .act .upcheck loom-icon { color: var(--upd); }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* cross-fleet overview ("all hosts") */
  .fleetsec { margin-bottom: 26px; }
  .fleetsec .hdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .fleetsec .hdot.local { background: var(--upd); }
  .fleetsec .hdot.agent { background: var(--ok); }
  .fleetsec .khint { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .fleetsec .fbadge { font: 600 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; }
  .fleetsec .fbadge.warn { color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); }
  .fleetsec .fbadge.bad { color: var(--bad); border: 1px solid color-mix(in srgb, var(--bad) 45%, transparent); }
  .fleetsec .fbadge.upd { color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 45%, transparent); }

  /* fleet summary reuses the .hostbar strip; these tint the highlight cells */
  .hostbar .hv.warn { color: var(--warn); }
  .hostbar .hv.bad { color: var(--bad); }
  .hostbar .hv.upd { color: var(--upd); }

  /* cross-host rows prefix the name with a small host pill, so the grid (and
     thus the service chips + count column) stays identical to the per-host view */
  .row .name .htag { display: inline-block; box-sizing: border-box; width: 92px; margin-right: 9px; vertical-align: middle;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; text-align: center;
    color: var(--dim); padding: 4px 7px; border: 1px solid var(--line); border-radius: 5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .umark { color: var(--upd); }
  .row .name .svc { color: var(--dim); }
  .row .why.upd { color: var(--upd); }
  .head .n.upd { color: var(--upd); }
  .head .n.warn { color: var(--warn); }
  .head .n.bad { color: var(--bad); }
  .fleetsec .foff { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--bad); }
  .fleetsec .frow-empty { padding: 12px 14px; color: var(--dim); font: 500 12px/1 var(--mono); }
  .fleetsec .ferr { padding: 12px 14px; color: var(--bad); font: 500 12px/1.4 var(--mono); word-break: break-word; }

  main { padding: 30px 40px 96px; max-width: 1340px; margin: 0 auto; }

  /* docker host strip */
  .hostbar { display: flex; flex-wrap: wrap; align-items: stretch; border: 1px solid var(--line);
    margin-bottom: 22px; }
  .hostbar .hi { display: flex; flex-direction: column; gap: 5px; padding: 11px 16px; border-right: 1px solid var(--line); }
  .hostbar .hk { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .hostbar .hv { font: 600 13px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  .hostbar .hv .t { color: var(--dim); }
  .hostbar .hi.grow { flex: 1; border-right: 0; padding: 0; }
  .hrefresh { display: inline-flex; align-items: center; gap: 7px; align-self: stretch; padding: 0 16px;
    background: transparent; border: 0; border-left: 1px solid var(--line); color: var(--dim);
    font: 600 10px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; cursor: pointer; }
  .hrefresh:hover { color: var(--hi); background: var(--raised); }
  .hrefresh:disabled { opacity: .6; cursor: not-allowed; }

  /* search */
  .search { position: relative; margin-bottom: 22px; }
  .search input {
    width: 100%; background: var(--panel); border: 1px solid var(--line); color: var(--hi);
    font: 13px/1 var(--mono); padding: 12px 13px 12px 38px; border-radius: 0;
  }
  .search input::placeholder { color: var(--dim); }
  .search input:focus { outline: none; border-color: var(--line2); }
  .search .ico { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--dim); display: flex; }
  .search .clear { position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    background: transparent; border: 0; color: var(--dim); cursor: pointer; font: 11px/1 var(--mono);
    letter-spacing: .1em; text-transform: uppercase; padding: 5px; }
  .search .clear:hover { color: var(--hi); }

  /* ── fleet ribbon ── */
  .ribbon { display: flex; gap: 3px; height: 14px; margin: 6px 0 28px; }
  .ribbon i { flex: 1 1 0; background: #1B3A2D; cursor: pointer; transition: opacity .1s; }
  .ribbon i.ok { background: #244B39; }
  .ribbon i.down { background: var(--faint); }
  .ribbon i.warn { background: var(--warn); }
  .ribbon i.bad, .ribbon i.loop { background: var(--bad); }
  .ribbon i.upd { background: var(--upd); }
  .ribbon i:hover { opacity: .7; }
  /* ribbon sits under the bar → tooltip points DOWN, not up into the bar */
  .ribbon [data-tip]:hover::after { top: calc(100% + 8px); bottom: auto; }

  /* ── section ── */
  section { margin-bottom: 34px; }
  .head { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; }
  .head .label { font: 600 10px/1 var(--mono); letter-spacing: .22em; text-transform: uppercase; color: var(--dim); }
  .head .rule { flex: 1; height: 1px; background: var(--line); }
  .head .n { font: 600 11px/1 var(--mono); color: var(--dim); }
  .head .ago { font: 11px/1 var(--mono); color: var(--dim); }
  .head .rfr { display: inline-flex; align-items: center; padding: 4px; background: transparent; border: 0;
    color: var(--dim); cursor: pointer; }
  .head .rfr:hover { color: var(--hi); }
  .head .rfr:disabled { cursor: not-allowed; }
  .head .rfr .spin { animation: spin .9s linear infinite; }

  /* updates rows — grouped by stack, services as chips */
  .urow { grid-template-columns: 7px max-content minmax(0, 1fr) auto 14px;
    height: auto; min-height: 46px; padding-top: 9px; padding-bottom: 9px; align-items: center; }
  .urow.static { cursor: default; }
  .urow.static:hover { background: transparent; }
  .urow .name { white-space: nowrap; }
  .urow .svcs { display: flex; flex-wrap: wrap; gap: 6px; }
  .urow .svc { font: 11px/1 var(--mono); color: var(--mid); border: 1px solid var(--line); padding: 4px 7px; white-space: nowrap; }
  .urow .svc b { color: var(--hi); font-weight: 600; }
  .urow .why.upd { color: var(--upd); font: 600 13px/1 var(--mono); font-variant-numeric: tabular-nums; text-transform: none; letter-spacing: 0; }

  /* ── instrument rows ── */
  .rows { border: 1px solid var(--line); }
  .row {
    display: grid; grid-template-columns: 7px 1fr auto 84px 14px;
    align-items: center; gap: 16px;
    padding: 0 16px; height: 42px;
    border-bottom: 1px solid var(--line); cursor: pointer;
    animation: fade .15s ease both;
  }
  .row:last-child { border-bottom: none; }
  .row:hover { background: var(--raised); }
  .row .name { font: 500 13px/1 var(--mono); color: var(--hi); letter-spacing: .01em; }
  .row:hover .name { color: #fff; }
  .row .why { font: 12px/1 var(--mono); text-align: right; }
  .row .why.bad { color: var(--bad); }
  .row .why.warn { color: var(--warn); }
  .row .count { font: 13px/1 var(--mono); text-align: right; color: var(--hi); font-variant-numeric: tabular-nums; }
  .row .count .t { color: var(--dim); }
  .row .chev { color: var(--faint); justify-self: end; }
  .row:hover .chev { color: var(--mid); }
  .row .seg { --seg-h: 7px; }

  /* fleet tiles — dense board instead of one tall list */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(246px, 1fr)); gap: 14px; }
  .tile {
    border: 1px solid var(--line); background: var(--panel);
    padding: 16px 16px 17px; cursor: pointer; display: flex; flex-direction: column; gap: 15px;
    transition: border-color .12s ease, background .12s ease;
    animation: fade .18s ease both;
  }
  .tile:hover { border-color: var(--line2); background: var(--raised); }
  .tile.off { opacity: .55; }
  .tile .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .tile .nm { display: flex; align-items: center; gap: 9px; min-width: 0; font: 500 13px/1.1 var(--mono); color: var(--hi); }
  .tile .nm .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile .ct { font: 13px/1 var(--mono); color: var(--dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tile .ct b { color: var(--hi); font-weight: 600; }
  .tile .ct .tupd { color: var(--upd); display: inline-flex; vertical-align: middle; margin-right: 6px; }
  .tile .seg { --seg-h: 7px; }

  .empty { padding: 44px; text-align: center; color: var(--dim); border: 1px solid var(--line); }

  @media (max-width: 720px) {
    .bar .grow + .s, .bar .k { display: none; }
    .row { grid-template-columns: 7px 1fr auto 14px; }
    .row .why.hide-m { display: none; }
    main { padding: 18px 14px 60px; }
  }
`)
export class DashboardPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor stacks: StackSummary[] = [];
  @reactive accessor error = "";
  @reactive accessor loaded = false;
  @reactive accessor query = "";
  @reactive accessor updates: UpdatesResult | null = null;
  @reactive accessor host: any = null;
  @reactive accessor disk: DiskResult | null = null;
  @reactive accessor diskBusy = false;
  @reactive accessor updBusy = false;
  @reactive accessor fleet: FleetHost[] | null = null; // cross-host overview ("all hosts")
  @reactive accessor fleetBusy = false;

  // "all hosts" is a client-side view flag (set by the host switcher).
  get fleetMode() {
    return localStorage.getItem("hope.fleet") === "1";
  }

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
    if (!this.fleetMode) this.loadHost(); // single-host strip; skipped in fleet view
  }

  // Switch the active host to `host`, then open one of its stacks (used from the
  // fleet overview where each stack belongs to a specific host).
  private goCross = async (host: string, project: string) => {
    try {
      await this.rpc.call("System", "setActiveHost", [host]);
    } catch {
      /* fall through — navigation still attempts the active host */
    }
    // Keep the fleet flag set so "back" returns to the all-hosts overview, not a
    // single-host dashboard. The stack/container pages still operate on the host
    // we just activated.
    this.router.navigate(`/stack/${encodeURIComponent(project)}`);
  };

  private async loadFleet() {
    try {
      this.fleet = (await this.rpc.call<FleetHost[]>("System", "fleet", [])) || [];
      this.error = "";
      this.loaded = true;
    } catch (err: any) {
      this.error = err?.message ?? "Can't reach the daemon.";
    }
  }

  // Force an image-freshness recrawl on every host (fleet "check" button).
  private refreshFleet = async () => {
    this.fleetBusy = true;
    try {
      this.fleet = (await this.rpc.call<FleetHost[]>("System", "refreshFleetUpdates", [])) || [];
    } catch {
      /* ignore */
    } finally {
      this.fleetBusy = false;
    }
  };

  // Reusable stat strip (the .hostbar look), shared by the single-host host
  // strip and the fleet summary so the markup isn't copy-pasted.
  // Reusable stack card (the .tile with the segmented health bar), shared by the
  // single-host Fleet grid and the all-hosts per-host sections so they're identical.
  private stackTile(s: any, opts: { onClick: () => void; hasUpd: boolean; outIds: Set<string> }) {
    return (
      <div class={"tile" + (s.sev === "down" ? " off" : "")} onClick={opts.onClick}>
        <div class="top">
          <span class="nm">
            <span class={"mark " + (s.sev === "ok" ? (opts.hasUpd ? "upd" : "ok") : s.sev === "down" ? "" : s.sev)}></span>
            <span class="t">{s.project}</span>
          </span>
          <span class="ct">
            {opts.hasUpd ? <span class="tupd" title="updates available"><loom-icon name="download" size={12}></loom-icon></span> : null}
            <b>{s.running}</b>
            <span class="s">/{s.total}</span>
          </span>
        </div>
        {this.segs(s, opts.outIds)}
      </div>
    );
  }

  // The single-host Docker daemon strip, built from the shared statStrip.
  private hostStrip() {
    const h = this.host;
    const dt = this.diskTotals();
    const cells: Array<{ k: string; v: any; cls?: string }> = [
      { k: "host", v: h.Name || "—" },
      { k: "docker", v: h.ServerVersion || "—" },
      { k: "os", v: `${h.OperatingSystem || h.OSType}${h.Architecture ? " · " + h.Architecture : ""}` },
      { k: "cpu", v: h.NCPU ?? "—" },
      { k: "mem", v: gb(h.MemTotal) },
      { k: "containers", v: <>{h.ContainersRunning ?? 0}<i class="t">/{h.Containers ?? 0}</i></> },
      { k: "images", v: h.Images ?? 0 },
    ];
    if (dt) {
      cells.push(
        { k: "disk", v: gb(dt.total) },
        { k: "volumes", v: gb(dt.volumes) },
        { k: "build cache", v: gb(dt.cache) },
      );
    }
    return this.statStrip(
      cells,
      <button class="hrefresh" disabled={this.diskBusy} title={this.disk?.checked_at ? `disk usage · ${ago(this.disk.checked_at)}` : "compute disk usage"} onClick={this.refreshDisk}>
        <loom-icon name="rotate" size={13}></loom-icon>{this.diskBusy ? "scanning…" : "df"}
      </button>,
    );
  }

  private statStrip(cells: Array<{ k: string; v: any; cls?: string }>, tail?: any) {
    return (
      <div class="hostbar">
        {cells.map((c) => (
          <span class="hi"><i class="hk">{c.k}</i><i class={"hv " + (c.cls ?? "")}>{c.v}</i></span>
        ))}
        {tail ? <><span class="hi grow"></span>{tail}</> : null}
      </div>
    );
  }

  // Docker host identity + cached disk usage. Both cheap (df is cached
  // server-side, crawled hourly); fetched once on mount.
  private async loadHost() {
    try {
      this.host = await this.rpc.call<any>("System", "info", []);
    } catch {
      /* host strip stays hidden */
    }
    try {
      this.disk = await this.rpc.call<DiskResult>("System", "diskUsage", []);
    } catch {
      /* storage cells stay hidden */
    }
  }

  // Force an immediate cluster-wide image-freshness recrawl.
  private refreshUpdates = async () => {
    this.updBusy = true;
    try {
      this.updates = await this.rpc.call<UpdatesResult>("System", "refreshUpdates", []);
    } catch {
      /* ignore */
    } finally {
      this.updBusy = false;
    }
  };

  private refreshDisk = async () => {
    this.diskBusy = true;
    try {
      this.disk = await this.rpc.call<DiskResult>("System", "refreshDiskUsage", []);
    } catch {
      /* ignore */
    } finally {
      this.diskBusy = false;
    }
  };

  private diskTotals() {
    const d = this.disk?.usage;
    if (!d) return null;
    const images = d.LayersSize || 0;
    const volumes = (d.Volumes || []).reduce((a: number, v: any) => a + (v?.UsageData?.Size > 0 ? v.UsageData.Size : 0), 0);
    const cache = (d.BuildCache || []).reduce((a: number, b: any) => a + (b?.Size || 0), 0);
    const containers = (d.Containers || []).reduce((a: number, c: any) => a + (c?.SizeRw || 0), 0);
    return { images, volumes, cache, containers, total: images + volumes + cache + containers };
  }

  @interval(5000)
  tick() {
    if (this.auth.isAuthenticated) this.load();
  }

  private async load() {
    if (this.fleetMode) return this.loadFleet();
    try {
      this.stacks = await this.rpc.call<StackSummary[]>("Stacks", "list", []);
      this.error = "";
      this.loaded = true;
    } catch (err: any) {
      this.error = err?.message ?? "Can't reach the daemon.";
    }
    // Cluster-wide image freshness (cached by the backend crawler) — optional.
    try {
      this.updates = await this.rpc.call<UpdatesResult>("System", "updates", []);
    } catch {
      /* updates section just stays hidden */
    }
  }

  private outdated() {
    return (this.updates?.updates ?? []).filter(
      (u) => u.status === "outdated",
    );
  }

  // Collapse outdated containers into per-stack groups (services deduped, with
  // replica counts) so a fleet with dozens of updates reads as a few rows.
  // Group a flat list of outdated items into project -> services, shared by the
  // single-host and per-host (fleet) Updates sections so they're identical.
  private groupUpdates(items: any[]) {
    const byProj: Record<string, Record<string, number>> = {};
    for (const u of items) {
      const p = u.project || UNGROUPED;
      const s = u.service || u.name || u.image;
      (byProj[p] ??= {})[s] = (byProj[p][s] ?? 0) + 1;
    }
    return Object.entries(byProj)
      .map(([project, svc]) => ({
        project,
        count: Object.values(svc).reduce((a, b) => a + b, 0),
        services: Object.entries(svc)
          .map(([service, count]) => ({ service, count }))
          .sort((a, b) => b.count - a.count || a.service.localeCompare(b.service)),
      }))
      .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
  }

  private updateGroups() {
    return this.groupUpdates(this.outdated());
  }

  // Cross-fleet equivalent of updateGroups: outdated services grouped by
  // host+project, so the fleet Updates section renders like the per-host one.
  private fleetUpdateGroups(f: FleetHost[]) {
    const groups: { host: string; project: string; services: { service: string; count: number }[]; count: number }[] = [];
    for (const h of f) {
      const byProj: Record<string, Record<string, number>> = {};
      for (const u of h.updates ?? []) {
        const p = u.project || UNGROUPED;
        const s = u.service || u.name || u.image;
        (byProj[p] ??= {})[s] = (byProj[p][s] ?? 0) + 1;
      }
      for (const [project, svc] of Object.entries(byProj)) {
        groups.push({
          host: h.id,
          project,
          count: Object.values(svc).reduce((a, b) => a + b, 0),
          services: Object.entries(svc)
            .map(([service, count]) => ({ service, count }))
            .sort((a, b) => b.count - a.count || a.service.localeCompare(b.service)),
        });
      }
    }
    return groups.sort((a, b) => b.count - a.count || a.host.localeCompare(b.host) || a.project.localeCompare(b.project));
  }

  // The oldest (stalest) per-host check time across the fleet — so "checked
  // Xm ago" reflects the worst case, not the freshest host.
  private fleetChecked(): string {
    let oldest = "";
    for (const h of this.fleet ?? []) {
      if (!h.online || !h.checked_at) continue;
      if (!oldest || h.checked_at < oldest) oldest = h.checked_at;
    }
    return oldest;
  }

  // Shared Updates row, used by the single-host and all-hosts views so their
  // contents are identical (the all view just adds a host tag).
  private updateRow(
    g: { project: string; services: { service: string; count: number }[]; count: number },
    opts: { host?: string; onClick: () => void; linkable?: boolean },
  ) {
    const linkable = opts.linkable ?? true;
    return (
      <div class={"row urow" + (linkable ? "" : " static")} onClick={() => (linkable ? opts.onClick() : null)}>
        <span class="mark upd"></span>
        <span class="name">{opts.host ? <span class="htag" title={opts.host}>{opts.host}</span> : null}{g.project}</span>
        <span class="svcs">
          {g.services.slice(0, 8).map((s) => (
            <span class="svc">{s.service}{s.count > 1 ? <b> ×{s.count}</b> : null}</span>
          ))}
          {g.services.length > 8 ? <span class="svc more">+{g.services.length - 8}</span> : null}
        </span>
        <span class="why upd">{g.count}</span>
        {linkable ? <loom-icon class="chev" name="chevron-right" size={15}></loom-icon> : <span></span>}
      </div>
    );
  }

  // Shared Attention row (single-host + all-hosts).
  private attentionRow(s: any, opts: { host?: string; onClick: () => void }) {
    return (
      <div class="row" onClick={opts.onClick}>
        <span class={"mark " + s.sev}></span>
        <span class="name">{opts.host ? <span class="htag" title={opts.host}>{opts.host}</span> : null}{s.project}</span>
        <span class={"why " + (s.sev === "loop" ? "bad" : "warn")}>
          {s.sev === "loop"
            ? `${s.containers.filter((c: any) => c.state === "restarting").length} restarting`
            : `${s.total - s.running} down`}
        </span>
        <span class="count">{s.running}<span class="t">/{s.total}</span></span>
        <loom-icon class="chev" name="chevron-right" size={15}></loom-icon>
      </div>
    );
  }

  private openContainer(id: string) {
    this.router.navigate(`/container/${encodeURIComponent(id)}`);
  }

  // Projects with at least one outdated container (respects the loose flag).
  private updSet(): Set<string> {
    const s = new Set<string>();
    for (const u of this.outdated()) if (u.project) s.add(u.project);
    return s;
  }

  private visible(): StackSummary[] {
    let list = this.stacks;
    const q = this.query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.project.toLowerCase().includes(q) ||
          s.containers.some((c) => (c.service || c.name).toLowerCase().includes(q)),
      );
    }
    return list;
  }
  private ranked(): Ranked[] {
    return this.visible()
      .map((s) => ({ ...s, sev: stackSeverity(s.running, s.total, s.restarting) }))
      .sort((a, b) => severityRank(a.sev) - severityRank(b.sev) || a.project.localeCompare(b.project));
  }

  private go(p: string) {
    this.router.navigate(`/stack/${encodeURIComponent(p)}`);
  }

  // segs renders a stack's containers as a thin heat-bar (one cell per
  // container, colored by state) — texture + density on each tile.
  private segs(s: StackSummary, outIds: Set<string>) {
    return (
      <div class="seg">
        {s.containers.map((c) => {
          const st = markClass(c.state);
          // running-but-outdated reads as an update; down/restarting stays as-is.
          const cls = st === "ok" && outIds.has(c.id) ? "upd" : st;
          return <i class={cls}></i>;
        })}
      </div>
    );
  }

  // All outdated container ids (for tile heat-bars; not loose-filtered).
  private outdatedIds(): Set<string> {
    return new Set((this.updates?.updates ?? []).filter((u) => u.status === "outdated").map((u) => u.id));
  }
  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  // Cross-fleet overview: one section per host (local + agents), each listing
  // that host's stacks. Same visual language as the single-host dashboard.
  private renderFleet() {
    const f = this.fleet ?? [];
    const hosts = f.length;
    const online = f.filter((h) => h.online).length;
    let runC = 0,
      totC = 0,
      stackC = 0,
      updC = 0;
    const problems: { host: string; s: any }[] = [];
    const fupdates: { host: string; u: any }[] = [];
    for (const h of f) {
      const ups = h.updates ?? [];
      updC += ups.length;
      for (const u of ups) fupdates.push({ host: h.id, u });
      for (const s of h.stacks) {
        runC += s.running;
        totC += s.total;
        stackC++;
        const sev = stackSeverity(s.running, s.total, s.restarting);
        if (sev === "loop" || sev === "warn") problems.push({ host: h.id, s: { ...s, sev } });
      }
    }
    problems.sort((a, b) => severityRank(b.s.sev) - severityRank(a.s.sev));
    const vClass = problems.some((p) => p.s.sev === "loop") ? "bad" : problems.length ? "warn" : "ok";
    return (
      <div>
        <div class="bar">
          <div class="s brand">HOPE</div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s"><span class="k">all hosts</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/images")}>images</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/networks")}>networks</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/volumes")}>volumes</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/agents")}>agents</span></div>
          <div class="grow"></div>
          <div class="s"><span class="k">hosts</span><span class="v">{online}<span class="t">/{hosts}</span></span></div>
          <div class="s"><span class="k">stacks</span><span class="v">{stackC}</span></div>
          <div class="s"><span class="k">up</span><span class="v">{runC}<span class="t">/{totC}</span></span></div>
          <div class={"s verdict " + vClass}>
            <span class={"mark " + vClass}></span>
            {problems.length === 0 ? "nominal" : `${problems.length} ${problems.length === 1 ? "issue" : "issues"}`}
          </div>
          {updC > 0 ? (
            <div class="s upd"><loom-icon name="download" size={13}></loom-icon><span>{updC} updates</span></div>
          ) : null}
          <div class="s act">
            <button class="upcheck" disabled={this.fleetBusy} title="recheck every host for image updates" onClick={this.refreshFleet}>
              <loom-icon class={this.fleetBusy ? "spin" : ""} name="rotate" size={13}></loom-icon>
              <span>check</span>
            </button>
          </div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>
        <main>
          {!this.loaded ? <div class="loading">loading fleet…</div> : null}
          {this.error ? <div class="err">{this.error}</div> : null}

          {this.statStrip([
            { k: "hosts", v: <>{online}<i class="t">/{hosts}</i></> },
            { k: "stacks", v: stackC },
            { k: "containers", v: <>{runC}<i class="t">/{totC}</i></> },
            { k: "issues", v: problems.length, cls: problems.length ? vClass : "" },
            { k: "updates", v: updC, cls: updC ? "upd" : "" },
          ])}

          {problems.length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Attention</span>
                <span class="rule"></span>
                <span class={"n " + vClass}>{problems.length}</span>
              </div>
              <div class="rows">
                {problems.map((p) => this.attentionRow(p.s, { host: p.host, onClick: () => this.goCross(p.host, p.s.project) }))}
              </div>
            </section>
          ) : null}

          {fupdates.length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Updates</span>
                <span class="rule"></span>
                {this.fleetChecked() ? <span class="ago">checked {ago(this.fleetChecked())}</span> : null}
                <button class="rfr" disabled={this.fleetBusy} title="recheck every host" onClick={this.refreshFleet}>
                  <loom-icon class={this.fleetBusy ? "spin" : ""} name="rotate" size={13}></loom-icon>
                </button>
                <span class="n upd">{fupdates.length}</span>
              </div>
              <div class="rows">
                {this.fleetUpdateGroups(f).map((g) =>
                  this.updateRow(g, { host: g.host, onClick: () => this.goCross(g.host, g.project) }),
                )}
              </div>
            </section>
          ) : null}

          {f.map((h) => this.renderFleetHost(h))}
        </main>
      </div>
    );
  }

  private renderFleetHost(h: FleetHost) {
    const ranked = (h.stacks ?? [])
      .filter(() => true)
      .map((s) => ({ ...s, sev: stackSeverity(s.running, s.total, s.restarting) }))
      .sort((a, b) => severityRank(b.sev) - severityRank(a.sev));
    const up = (h.stacks ?? []).reduce((a, s) => a + s.running, 0);
    const tot = (h.stacks ?? []).reduce((a, s) => a + s.total, 0);
    const loops = ranked.filter((s) => s.sev === "loop").length;
    const issues = ranked.filter((s) => s.sev === "loop" || s.sev === "warn").length;
    // Per-host update context for the cards (which projects have updates; which
    // container ids are outdated) — same inputs the single-host grid uses.
    const hostUpd = new Set((h.updates ?? []).filter((u) => u.project).map((u) => u.project));
    const hostOut = new Set((h.updates ?? []).map((u) => u.id));
    return (
      <section class="fleetsec">
        <div class="head">
          <span class={"hdot " + h.kind}></span>
          <span class="label">{h.id}</span>
          <span class="khint">{h.kind}</span>
          <span class="rule"></span>
          {h.online ? (
            <>
              {issues > 0 ? <span class={"fbadge " + (loops > 0 ? "bad" : "warn")}>{issues} {issues === 1 ? "issue" : "issues"}</span> : null}
              {h.outdated > 0 ? <span class="fbadge upd">{h.outdated} {h.outdated === 1 ? "update" : "updates"}</span> : null}
              <span class="n">{up}<span class="t">/{tot}</span></span>
            </>
          ) : (
            <span class="foff">{h.error ? "unreachable" : "offline"}</span>
          )}
        </div>
        {h.online ? (
          ranked.length === 0 ? (
            <div class="frow-empty">no stacks</div>
          ) : (
            <div class="grid">
              {ranked.map((s) =>
                this.stackTile(s, {
                  onClick: () => this.goCross(h.id, s.project),
                  hasUpd: hostUpd.has(s.project),
                  outIds: hostOut,
                }),
              )}
            </div>
          )
        ) : h.error ? (
          <div class="ferr">{h.error}</div>
        ) : null}
      </section>
    );
  }

  update() {
    if (this.fleetMode) return this.renderFleet();
    const all = this.ranked();
    const vis = this.visible();
    const upd = this.updSet();
    const outIds = this.outdatedIds();
    const issues = all.filter((s) => s.sev === "loop" || s.sev === "warn");
    const nominal = all.filter((s) => s.sev === "ok" || s.sev === "down");
    const runC = vis.reduce((a, s) => a + s.running, 0);
    const totC = vis.reduce((a, s) => a + s.total, 0);
    const loops = all.filter((s) => s.sev === "loop").length;
    const vClass = loops > 0 ? "bad" : issues.length > 0 ? "warn" : "ok";
    const vText = issues.length === 0 ? "nominal" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`;

    return (
      <div>
        <div class="bar">
          <div class="s brand">HOPE</div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s"><span class="k">fleet</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/images")}>images</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/networks")}>networks</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/volumes")}>volumes</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/agents")}>agents</span></div>
          <div class="grow"></div>
          <div class="s"><span class="k">stacks</span><span class="v">{vis.length}</span></div>
          <div class="s"><span class="k">up</span><span class="v">{runC}<span class="t">/{totC}</span></span></div>
          <div class={"s verdict " + vClass}>
            <span class={"mark " + (vClass === "ok" ? "ok" : vClass)}></span>
            {vText}
          </div>
          {this.outdated().length > 0 ? (
            <div class="s upd"><loom-icon name="download" size={13}></loom-icon><span>{this.outdated().length} updates</span></div>
          ) : null}
          <div class="s act">
            <button class="upcheck" disabled={this.updBusy} title="check all images for updates now" onClick={this.refreshUpdates}>
              <loom-icon class={this.updBusy ? "spin" : ""} name="rotate" size={13}></loom-icon>
              <span>check</span>
            </button>
          </div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.host ? this.hostStrip() : null}

          {this.error ? <div class="empty">{this.error}</div> : null}

          {this.stacks.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input
                type="text"
                placeholder="Search stacks and services…"
                value={this.query}
                onInput={(e: any) => (this.query = e.target.value)}
              />
              {this.query ? <button class="clear" onClick={() => (this.query = "")}>clear</button> : null}
            </div>
          ) : null}

          {all.length > 0 ? (
            <div class="ribbon">
              {all.map((s) => {
                const hasUpd = upd.has(s.project);
                const cls = (s.sev === "ok" || s.sev === "down") && hasUpd ? "upd" : s.sev;
                return (
                  <i
                    class={cls}
                    data-tip={`${s.project}   ${s.running}/${s.total}${s.restarting ? "   ⟳ restarting" : ""}${hasUpd ? "   ↑ update" : ""}`}
                    onClick={() => this.go(s.project)}
                  ></i>
                );
              })}
            </div>
          ) : null}

          {issues.length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Attention</span>
                <span class="rule"></span>
                <span class={"n " + vClass}>{issues.length}</span>
              </div>
              <div class="rows">
                {issues.map((s) => this.attentionRow(s, { onClick: () => this.go(s.project) }))}
              </div>
            </section>
          ) : null}

          {this.outdated().length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Updates</span>
                <span class="rule"></span>
                {this.updates?.checked_at ? <span class="ago">checked {ago(this.updates.checked_at)}</span> : null}
                <button class="rfr" disabled={this.updBusy} title="check now" onClick={this.refreshUpdates}>
                  <loom-icon class={this.updBusy ? "spin" : ""} name="rotate" size={13}></loom-icon>
                </button>
                <span class="n upd">{this.outdated().length}</span>
              </div>
              <div class="rows">
                {this.updateGroups().map((g) =>
                  this.updateRow(g, { onClick: () => this.go(g.project), linkable: g.project !== UNGROUPED }),
                )}
              </div>
            </section>
          ) : null}

          {nominal.length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Fleet</span>
                <span class="rule"></span>
                <span class="n">{nominal.length}</span>
              </div>
              <div class="grid">
                {nominal.map((s) => this.stackTile(s, { onClick: () => this.go(s.project), hasUpd: upd.has(s.project), outIds }))}
              </div>
            </section>
          ) : null}

          {this.loaded && all.length === 0 && !this.error ? (
            <div class="empty">No containers on this daemon.</div>
          ) : null}
        </main>
      </div>
    );
  }
}

// Bytes → a compact GiB/MiB label for the host memory readout.
function gb(b: number): string {
  if (!b || b <= 0) return "—";
  const g = b / 1073741824;
  if (g >= 1) return g.toFixed(g >= 100 ? 0 : 1) + " GiB";
  return Math.round(b / 1048576) + " MiB";
}

// Relative time for the "checked Xm ago" label on the updates section.
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return "pending";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
