// Mission-control overview, terminal-instrument style. A tmux-like status bar
// synthesizes fleet state; a flat fleet ribbon shows every stack as a cell
// (dark = nominal, lit = trouble); below, an Attention zone then a quiet Fleet
// list of instrument rows. No glows, no per-row noise. Refreshes every 5s.
import { LoomElement, component, styles, css, reactive, mount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, route } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { StackSummary, UpdatesResult, DiskResult } from "../contracts";
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
  @reactive accessor showUngrouped = false;
  @reactive accessor query = "";
  @reactive accessor updates: UpdatesResult | null = null;
  @reactive accessor host: any = null;
  @reactive accessor disk: DiskResult | null = null;
  @reactive accessor diskBusy = false;
  @reactive accessor updBusy = false;

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
    this.loadHost(); // host identity + cached disk usage — once, not on the tick
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
      (u) => u.status === "outdated" && (this.showUngrouped || (u.project !== "" && u.project !== UNGROUPED)),
    );
  }

  // Collapse outdated containers into per-stack groups (services deduped, with
  // replica counts) so a fleet with dozens of updates reads as a few rows.
  private updateGroups() {
    const byProj: Record<string, Record<string, number>> = {};
    for (const u of this.outdated()) {
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
    let list = this.showUngrouped ? this.stacks : this.stacks.filter((s) => s.project !== UNGROUPED);
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
  private hasUngrouped(): boolean {
    return this.stacks.some((s) => s.project === UNGROUPED);
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

  update() {
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
          {this.hasUngrouped() ? (
            <div class="s act">
              <button onClick={() => (this.showUngrouped = !this.showUngrouped)}>
                {this.showUngrouped ? "hide loose" : "loose"}
              </button>
            </div>
          ) : null}
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.host ? (
            <div class="hostbar">
              <span class="hi"><i class="hk">host</i><i class="hv">{this.host.Name || "—"}</i></span>
              <span class="hi"><i class="hk">docker</i><i class="hv">{this.host.ServerVersion || "—"}</i></span>
              <span class="hi"><i class="hk">os</i><i class="hv">{this.host.OperatingSystem || this.host.OSType}{this.host.Architecture ? ` · ${this.host.Architecture}` : ""}</i></span>
              <span class="hi"><i class="hk">cpu</i><i class="hv">{this.host.NCPU ?? "—"}</i></span>
              <span class="hi"><i class="hk">mem</i><i class="hv">{gb(this.host.MemTotal)}</i></span>
              <span class="hi"><i class="hk">containers</i><i class="hv">{this.host.ContainersRunning ?? 0}<i class="t">/{this.host.Containers ?? 0}</i></i></span>
              <span class="hi"><i class="hk">images</i><i class="hv">{this.host.Images ?? 0}</i></span>
              {this.diskTotals() ? (
                <>
                  <span class="hi"><i class="hk">disk</i><i class="hv">{gb(this.diskTotals()!.total)}</i></span>
                  <span class="hi"><i class="hk">volumes</i><i class="hv">{gb(this.diskTotals()!.volumes)}</i></span>
                  <span class="hi"><i class="hk">build cache</i><i class="hv">{gb(this.diskTotals()!.cache)}</i></span>
                </>
              ) : null}
              <span class="hi grow"></span>
              <button class="hrefresh" disabled={this.diskBusy} title={this.disk?.checked_at ? `disk usage · ${ago(this.disk.checked_at)}` : "compute disk usage"} onClick={this.refreshDisk}>
                <loom-icon name="rotate" size={13}></loom-icon>{this.diskBusy ? "scanning…" : "df"}
              </button>
            </div>
          ) : null}

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
                <span class="n">{issues.length}</span>
              </div>
              <div class="rows">
                {issues.map((s) => (
                  <div class="row" onClick={() => this.go(s.project)}>
                    <span class={"mark " + s.sev}></span>
                    <span class="name">{s.project}</span>
                    <span class={"why " + (s.sev === "loop" ? "bad" : "warn")}>
                      {s.sev === "loop"
                        ? `${s.containers.filter((c) => c.state === "restarting").length} restarting`
                        : `${s.total - s.running} down`}
                    </span>
                    <span class="count">
                      {s.running}
                      <span class="t">/{s.total}</span>
                    </span>
                    <loom-icon class="chev" name="chevron-right" size={15}></loom-icon>
                  </div>
                ))}
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
                <span class="n">{this.outdated().length}</span>
              </div>
              <div class="rows">
                {this.updateGroups().map((g) => {
                  const linkable = g.project !== UNGROUPED;
                  return (
                    <div class={"row urow" + (linkable ? "" : " static")} onClick={() => (linkable ? this.go(g.project) : null)}>
                      <span class="mark upd"></span>
                      <span class="name">{g.project}</span>
                      <span class="svcs">
                        {g.services.map((s) => (
                          <span class="svc">{s.service}{s.count > 1 ? <b> ×{s.count}</b> : null}</span>
                        ))}
                      </span>
                      <span class="why upd">{g.count}</span>
                      {linkable ? <loom-icon class="chev" name="chevron-right" size={15}></loom-icon> : <span></span>}
                    </div>
                  );
                })}
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
                {nominal.map((s) => (
                  <div class={"tile" + (s.sev === "down" ? " off" : "")} onClick={() => this.go(s.project)}>
                    <div class="top">
                      <span class="nm">
                        <span class={"mark " + (s.sev === "ok" ? (upd.has(s.project) ? "upd" : "ok") : "")}></span>
                        <span class="t">{s.project}</span>
                      </span>
                      <span class="ct">
                        {upd.has(s.project) ? <span class="tupd" title="updates available"><loom-icon name="download" size={12}></loom-icon></span> : null}
                        <b>{s.running}</b>
                        <span class="s">/{s.total}</span>
                      </span>
                    </div>
                    {this.segs(s, outIds)}
                  </div>
                ))}
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
