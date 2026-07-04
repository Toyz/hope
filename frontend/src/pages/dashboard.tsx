// Mission-control overview, terminal-instrument style. A tmux-like status bar
// synthesizes fleet state; a flat fleet ribbon shows every stack as a cell
// (dark = nominal, lit = trouble); below, an Attention zone then a quiet Fleet
// list of instrument rows. No glows, no per-row noise. Refreshes every 5s.
import { LoomElement, component, styles, css, reactive, mount, interval, on, app, persist } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, route } from "@toyz/loom/router";
import { rpc, mutate } from "@toyz/loom-rpc";
import type { RpcMutator } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { withHost } from "../host-url";
import { HostChanged, withRefresh } from "../events";
import { UNGROUPED } from "../const";
import { capabilities } from "../caps";
import { ProcService } from "../proc";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { System, Stacks } from "../contracts";
import type { StackSummary, UpdatesResult, DiskResult, FleetHost, OpFrame } from "../contracts";
import { stackSeverity, severityRank, markClass, severityMark, type Severity } from "../styles";

interface Ranked extends StackSummary {
  sev: Severity;
}

// One normalized host section — the single unit the dashboard renders. The
// single-host view is just a fleet of one of these.
interface HostSec {
  id: string;
  kind: string;
  online: boolean;
  error?: string;
  ranked: Ranked[];
  up: number;
  tot: number;
  issues: number;
  loops: number;
  outdated: number;
  updProjects: Set<string>;
  outIds: Set<string>;
}

@route("/host/:host")
@component("hope-dashboard")
@styles(css`
  :host { display: block; min-height: calc(100vh - 48px); background: var(--ink); }

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
  .bar .act button:hover { color: var(--hi); }
  .bar .act button:disabled { opacity: .55; cursor: default; }
  .bar .act .upcheck { display: inline-flex; align-items: center; gap: 7px; }
  .bar .act .upcheck loom-icon { color: var(--upd); }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* thin top loading bar for a refetch. It starts invisible and only fades in
     after .2s (lbin delay), so quick background polls never flash it — a slower
     host-switch fetch does. */
  .loadbar { position: sticky; top: 44px; z-index: 19; height: 2px; overflow: hidden;
    background: color-mix(in srgb, var(--upd) 18%, transparent); opacity: 0; animation: lbin 0s .2s forwards; }
  .loadbar i { display: block; height: 100%; width: 35%; background: var(--upd); animation: lbslide 1s ease-in-out infinite; }
  @keyframes lbin { to { opacity: 1; } }
  @keyframes lbslide { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }

  /* cross-fleet overview ("all hosts") */
  .fleetsec { margin-bottom: 26px; }
  .fleetsec .hdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .fleetsec .hdot.local { background: var(--upd); }
  .fleetsec .hdot.agent { background: var(--ok); }
  .fleetsec .khint { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .fleetsec .head.hhead { cursor: pointer; }
  .fleetsec .head .caret { color: var(--dim); flex: none; transition: transform .12s ease; }
  .fleetsec .head:not(.collapsed) .caret { transform: rotate(90deg); }
  .fleetsec .head.hhead:hover .label { color: var(--hi); }

  /* fleet summary reuses the .hostbar strip; these tint the highlight cells */
  .hostbar .hv.warn { color: var(--warn); }
  .hostbar .hv.bad { color: var(--bad); }
  .hostbar .hv.upd { color: var(--upd); }

  .row .umark { color: var(--upd); }
  .row .name .svc { color: var(--dim); }
  .row .why.upd { color: var(--upd); }
  .head .n.upd { color: var(--upd); }
  .head .n.warn { color: var(--warn); }
  .head .n.bad { color: var(--bad); }
  .fleetsec .foff { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--bad); }
  .fleetsec .frow-empty { padding: 12px 14px; color: var(--dim); font: 500 12px/1 var(--mono); }
  .fleetsec .ferr { padding: 12px 14px; color: var(--bad); font: 500 12px/1.4 var(--mono); word-break: break-word; }

  main { padding: 28px 40px 96px; max-width: 1340px; margin: 0 auto; }

  /* docker host strip */
  .hostbar { display: flex; flex-wrap: wrap; align-items: stretch; border: 1px solid var(--line);
    margin-bottom: 22px; }
  .hostbar .hi { display: flex; flex-direction: column; gap: 5px; padding: 11px 16px; border-right: 1px solid var(--line); }
  .hostbar .hk { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .hostbar .hv { font: 600 13px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  .hostbar .hv .t { color: var(--dim); }
  .cacheprune { display: inline-flex; align-items: center; gap: 6px; background: transparent; border: 0; padding: 0; cursor: pointer;
    font: 600 13px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .cacheprune loom-icon { color: var(--dim); }
  .cacheprune:hover { color: var(--bad); }
  .cacheprune:hover loom-icon { color: var(--bad); }
  .cacheprune:disabled { color: var(--dim); cursor: default; }
  .hostbar .hi.grow { flex: 1; border-right: 0; padding: 0; }
  .hrefresh { display: inline-flex; align-items: center; gap: 7px; align-self: stretch; padding: 0 16px;
    background: transparent; border: 0; border-left: 1px solid var(--line); color: var(--dim);
    font: 600 10px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; cursor: pointer; }
  .hrefresh:hover { color: var(--hi); background: var(--raised); }
  .hrefresh:disabled { opacity: .6; cursor: not-allowed; }


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
  /* .row.urow (not bare .urow) — .row is declared later with equal specificity
     and would otherwise win, snapping this back to the 5-column instrument grid. */
  .row.urow { grid-template-columns: 7px max-content minmax(0, 1fr) auto max-content 14px;
    height: auto; min-height: 46px; padding-top: 9px; padding-bottom: 9px; align-items: center; }
  .urow.static { cursor: default; }
  .urow.static:hover { background: transparent; }
  .urow .name { white-space: nowrap; }
  .urow .upgo { display: inline-flex; align-items: center; gap: 6px; background: transparent;
    border: 1px solid color-mix(in srgb, var(--upd) 45%, var(--line)); color: var(--upd); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 7px 11px; white-space: nowrap; }
  .urow .upgo:hover { color: #06080d; background: var(--upd); border-color: var(--upd); }
  .urow .upgo:disabled { opacity: .5; cursor: default; }
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
  }
  .tile:hover { border-color: var(--line2); background: var(--raised); }
  .tile.off { opacity: .55; }
  .tile .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .tile .nm { display: flex; align-items: center; gap: 9px; min-width: 0; font: 500 13px/1.4 var(--mono); color: var(--hi); }
  .tile .nm .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.4; padding-block: 1px; }
  .tile .ct { font: 13px/1 var(--mono); color: var(--dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tile .ct b { color: var(--hi); font-weight: 600; }
  .tile .ct .tupd { color: var(--upd); display: inline-flex; vertical-align: middle; margin-right: 6px; }
  .tile .seg { --seg-h: 7px; }

  .empty { padding: 44px; text-align: center; color: var(--dim); border: 1px solid var(--line); }

  /* the bar's updates indicator is now a button that opens the bulk picker */
  .upind { display: inline-flex; align-items: center; gap: 7px; height: 100%; padding: 0 16px;
    background: transparent; border: 0; cursor: pointer;
    font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--upd); }
  .upind loom-icon { color: var(--upd); }
  .upind:hover { background: var(--raised); }

  /* bulk-update picker modal */
  .dmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .ubox { width: 620px; max-width: 100%; max-height: 82vh; display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--line2); }
  .uhead { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .uhead loom-icon { color: var(--upd); }
  .uhead .ut { font: 600 14px/1 var(--mono); color: var(--hi); }
  .uhead .usub { font: 11px/1 var(--mono); color: var(--dim); }
  .uhead .grow { flex: 1; }
  .dx { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .dx:hover { color: var(--hi); }
  .usela { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--line);
    font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); cursor: pointer; }
  .usela:hover { color: var(--hi); }
  .ulist { overflow-y: auto; }
  .brow { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .brow:last-child { border-bottom: 0; }
  .brow:hover { background: var(--raised); }
  .brow.on { background: color-mix(in srgb, var(--upd) 8%, transparent); }
  .brow .uname { display: flex; align-items: center; gap: 0; font: 600 13px/1 var(--mono); color: var(--hi); flex: none; min-width: 130px; }
  .brow .usvcs { flex: 1; display: flex; flex-wrap: wrap; gap: 4px 10px; min-width: 0; }
  .brow .usvcs .svc { font: 12px/1.3 var(--mono); color: var(--dim); }
  .brow .usvcs .svc b { color: var(--mid); font-weight: 600; }
  .brow .usvcs .more { color: var(--faint); }
  .brow .ucnt { font: 600 12px/1 var(--mono); color: var(--upd); font-variant-numeric: tabular-nums; }
  .ck { display: inline-block; width: 15px; height: 15px; flex: none; border: 1px solid var(--line2); cursor: pointer; vertical-align: middle; }
  .ck.on { background: var(--upd); border-color: var(--upd); box-shadow: inset 0 0 0 3px var(--panel); }
  .uacts { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .uacts .grow { flex: 1; }
  .pbtn { display: inline-flex; align-items: center; gap: 7px; font: 600 11px/1 var(--mono); letter-spacing: .04em;
    color: var(--mid); background: transparent; border: 1px solid var(--line); padding: 9px 13px; cursor: pointer; }
  .pbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .pbtn.go { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line)); }
  .pbtn.go:hover { color: #06080d; background: var(--upd); border-color: var(--upd); }
  .pbtn.go loom-icon { color: currentColor; }
  .pbtn:disabled { opacity: .4; cursor: not-allowed; }

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
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  @reactive accessor updBusyProj = "";
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor query = "";
  @reactive accessor diskBusy = false;
  @reactive accessor cacheBusy = false;
  @reactive accessor storeOff = false; // state db not mounted → persistence warning
  @reactive accessor storeEphemeral = false; // db on container rootfs → lost on recreate
  @reactive accessor updBusy = false;
  @reactive accessor fleetBusy = false;
  // Collapsed host groups (by host id), persisted so the fleet layout sticks.
  @persist("hope.dash.collapsed") accessor collapsed: string[] = [];
  // Bulk-update picker: open state + selected group keys (host|project).
  @reactive accessor updModalOpen = false;
  @reactive accessor updSel: string[] = [];
  @reactive accessor updModalHost = ""; // scope the picker to one host ("" = all)

  private toggleHost = (id: string) => {
    this.collapsed = this.collapsed.includes(id)
      ? this.collapsed.filter((x) => x !== id)
      : [...this.collapsed, id];
  };

  // Data via loom-rpc @rpc queries (ApiState, SWR); getters expose .data so the
  // render + computed getters read the same names as before.
  @rpc(Stacks, "list", { eager: false }) accessor stacksQ!: ApiState<StackSummary[]>;
  @rpc(System, "fleet", { eager: false }) accessor fleetQ!: ApiState<FleetHost[]>;
  @rpc(System, "updates", { eager: false }) accessor updatesQ!: ApiState<UpdatesResult>;
  @rpc(System, "info", { eager: false }) accessor hostQ!: ApiState<any>;
  @rpc(System, "diskUsage", { eager: false }) accessor diskQ!: ApiState<DiskResult>;
  // Force a server-side recrawl (distinct from the cached read), then refetch.
  @mutate(System, "refreshUpdates") accessor forceUpd!: RpcMutator<[], UpdatesResult>;
  @mutate(System, "refreshFleetUpdates") accessor forceFleet!: RpcMutator<[], FleetHost[]>;
  @mutate(System, "refreshDiskUsage") accessor forceDisk!: RpcMutator<[], DiskResult>;

  get stacks(): StackSummary[] {
    return this.stacksQ.data || [];
  }
  get fleet(): FleetHost[] | null {
    return this.fleetQ.data ?? null;
  }
  get updates(): UpdatesResult | null {
    return this.updatesQ.data ?? null;
  }
  get host(): any {
    return this.hostQ.data ?? null;
  }
  get disk(): DiskResult | null {
    return this.diskQ.data ?? null;
  }
  get loaded(): boolean {
    return this.fleetMode ? !!this.fleetQ.data : !!this.stacksQ.data;
  }
  get error(): string {
    return (this.fleetMode ? this.fleetQ.error : this.stacksQ.error)?.message ?? "";
  }
  // Active query in flight — drives the thin top loading bar (CSS delays its
  // appearance, so the fast 5s poll doesn't flash it; a host switch does).
  get loading(): boolean {
    return this.fleetMode ? this.fleetQ.loading : this.stacksQ.loading;
  }

  // "all hosts" is a client-side view flag (set by the host switcher).
  get fleetMode() {
    return this.hostCtx.fleet;
  }

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
    if (!this.fleetMode) this.loadHost(); // single-host strip; skipped in fleet view
    void capabilities().then((c) => {
      this.storeOff = !c.store_enabled;
      this.storeEphemeral = c.store_ephemeral;
    });
  }

  // Host/fleet switched elsewhere — re-fetch in place (no reload).
  @on(HostChanged)
  onHostChanged() {
    if (!this.auth.isAuthenticated) return;
    this.load();
    if (!this.fleetMode) this.loadHost();
  }

  // Open one of a host's stacks from the fleet overview — the host rides in the
  // target URL, so the stack page loads (and acts) against exactly that host.
  private goCross = (host: string, project: string) => {
    this.router.navigate(withHost(host, `/stack/${encodeURIComponent(project)}`));
  };

  // Force an image-freshness recrawl on every host (fleet "check" button), then
  // refetch the fleet view.
  private refreshFleet = () => withRefresh(async () => {
    this.fleetBusy = true;
    try {
      await this.forceFleet.call();
      this.fleetQ.refetch();
    } catch {
      /* ignore */
    } finally {
      this.fleetBusy = false;
    }
  });

  // Reusable stat strip (the .hostbar look), shared by the single-host host
  // strip and the fleet summary so the markup isn't copy-pasted.
  // Reusable stack card (the .tile with the segmented health bar), shared by the
  // single-host Fleet grid and the all-hosts per-host sections so they're identical.
  private stackTile(s: any, opts: { onClick: () => void; hasUpd: boolean; outIds: Set<string> }) {
    return (
      <div class={"tile" + (s.sev === "down" ? " off" : "")} onClick={opts.onClick}>
        <div class="top">
          <span class="nm">
            <span class={"mark " + severityMark(s.sev, opts.hasUpd)}></span>
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
  // Persistence warning — shown in both the single-host and fleet dashboards
  // when no state db is mounted.
  private storeBanner() {
    if (this.storeEphemeral) {
      return (
        <hope-alert tone="bad">
          State db is on the container's filesystem, not a mounted volume — it will be <b>lost on a recreate</b>. Mount a volume at the <code>[store] path</code> directory.
        </hope-alert>
      );
    }
    if (this.storeOff) {
      return (
        <hope-alert tone="warn">
          No state db mounted — some state (e.g. <b>UI-added registries</b>) won't persist across a restart. Mount a volume and set <code>[store] path</code> to keep it.
        </hope-alert>
      );
    }
    return null;
  }

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
        {
          k: "build cache",
          v: dt.cache > 0 ? (
            <button class="cacheprune" disabled={this.cacheBusy} title="prune the builder cache (reclaims this space)" onClick={this.pruneCache}>
              {this.cacheBusy ? "pruning…" : gb(dt.cache)}<loom-icon name="trash" size={11}></loom-icon>
            </button>
          ) : gb(dt.cache),
        },
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
  private loadHost() {
    this.hostQ.refetch();
    this.diskQ.refetch();
  }

  // Force an immediate cluster-wide image-freshness recrawl, then refetch.
  private refreshUpdates = () => withRefresh(async () => {
    this.updBusy = true;
    try {
      await this.forceUpd.call();
      this.updatesQ.refetch();
    } catch {
      /* ignore */
    } finally {
      this.updBusy = false;
    }
  });

  private refreshDisk = async () => {
    this.diskBusy = true;
    try {
      await this.forceDisk.call();
      this.diskQ.refetch();
    } catch {
      /* ignore */
    } finally {
      this.diskBusy = false;
    }
  };

  private pruneCache = async () => {
    const dt = this.diskTotals();
    const ok = await this.confirm.ask({
      title: "prune build cache",
      danger: true,
      confirmLabel: "Prune",
      message: "Clear the Docker builder cache. Frees disk now; the next image build re-caches from scratch (slower once).",
      stats: [{ label: "reclaims up to", value: dt ? "~" + gb(dt.cache) : "—" }],
    });
    if (!ok) return;
    this.cacheBusy = true;
    try {
      const res = await this.rpc.call<{ reclaimed: number }>("System", "pruneBuildCache", []);
      this.toast.ok(`build cache pruned — freed ${gb(res?.reclaimed || 0)}`);
      this.refreshDisk();
    } catch (err: any) {
      this.toast.error(`prune build cache — ${err?.message ?? "failed"}`);
    } finally {
      this.cacheBusy = false;
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

  private load() {
    if (this.fleetMode) {
      this.fleetQ.refetch();
      return;
    }
    this.stacksQ.refetch();
    this.updatesQ.refetch(); // cluster-wide image freshness (cached crawler) — optional
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
        <span class="name">{opts.host ? <hope-chip host={true} title={opts.host}>{opts.host}</hope-chip> : null}{g.project}</span>
        <span class="svcs">
          {g.services.slice(0, 8).map((s) => (
            <span class="svc">{s.service}{s.count > 1 ? <b> ×{s.count}</b> : null}</span>
          ))}
          {g.services.length > 8 ? <span class="svc more">+{g.services.length - 8}</span> : null}
        </span>
        <span class="why upd">{g.count}</span>
        {linkable ? (
          <button class="upgo" disabled={!!this.updBusyProj} title="pull latest + recreate the outdated containers"
            onClick={(e: Event) => this.updateStack(g.project, opts.host, e)}>
            <loom-icon name="download" size={12}></loom-icon>{this.updBusyProj === g.project ? "…" : "update"}
          </button>
        ) : <span></span>}
        {linkable ? <loom-icon class="chev" name="chevron-right" size={15}></loom-icon> : <span></span>}
      </div>
    );
  }

  // One-click update straight from the dashboard: pull latest + recreate only the
  // outdated containers of a stack (force off), on its host, in the proc dialog.
  private updateStack = async (project: string, host: string | undefined, e: Event) => {
    e.stopPropagation();
    if (this.updBusyProj) return;
    this.updBusyProj = project;
    let ok = false;
    await this.proc.run(`update ${project}`, async (emit, signal) => {
      let sok = true;
      for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "redeployStack", [project, "true", "false"], signal, host)) {
        if (f.type === "log" && f.data) emit(f.data);
        else if (f.type === "done" && !f.ok) { sok = false; emit("failed: " + (f.error ?? "")); }
      }
      ok = sok;
      return sok;
    });
    this.updBusyProj = "";
    if (ok) this.refreshUpdates(); // clear the chip once images are current
  };

  // Shared Attention row (single-host + all-hosts).
  private attentionRow(s: any, opts: { host?: string; onClick: () => void }) {
    return (
      <div class="row" onClick={opts.onClick}>
        <span class={"mark " + s.sev}></span>
        <span class="name">{opts.host ? <hope-chip host={true} title={opts.host}>{opts.host}</hope-chip> : null}{s.project}</span>
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
    this.router.navigate(withHost(this.hostCtx.token, `/container/${encodeURIComponent(id)}`));
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
    this.router.navigate(withHost(this.hostCtx.token, `/stack/${encodeURIComponent(p)}`));
  }


  // Every stack with an update, for the bulk picker (host carried in fleet mode).
  private allUpdateGroups(): Array<{ project: string; host?: string; services: { service: string; count: number }[]; count: number }> {
    return this.fleetMode
      ? this.fleetUpdateGroups(this.fleet ?? [])
      : this.updateGroups().filter((g) => g.project !== UNGROUPED).map((g) => ({ ...g, host: undefined }));
  }
  private updKey = (g: { project: string; host?: string }) => (g.host ? g.host + "|" : "") + g.project;

  // The groups the picker shows — scoped to one host when opened from a host chip.
  private modalGroups() {
    return this.allUpdateGroups().filter((g) => !this.updModalHost || g.host === this.updModalHost);
  }

  // Open the bulk picker. With a host, scope the list to that host (from clicking
  // a host section's update chip); without, show every host. All start selected.
  private openUpdModal = (host?: string) => {
    this.updModalHost = host || "";
    this.updSel = this.modalGroups().map(this.updKey);
    this.updModalOpen = true;
  };
  private toggleUpd = (key: string) => {
    this.updSel = this.updSel.includes(key) ? this.updSel.filter((k) => k !== key) : [...this.updSel, key];
  };

  // Pull latest + recreate the outdated containers of every selected stack, one
  // after another in a single proc dialog so the whole sweep streams in one place.
  private bulkUpdate = async () => {
    const groups = this.modalGroups().filter((g) => this.updSel.includes(this.updKey(g)));
    if (!groups.length) return;
    this.updModalOpen = false;
    let ok = true;
    await this.proc.run(`update ${groups.length} stack${groups.length === 1 ? "" : "s"}`, async (emit, signal) => {
      for (const g of groups) {
        emit(`── ${g.host ? g.host + " / " : ""}${g.project} ──`);
        let sok = true;
        for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "redeployStack", [g.project, "true", "false"], signal, g.host)) {
          if (f.type === "log" && f.data) emit(f.data);
          else if (f.type === "done" && !f.ok) { sok = false; emit("failed: " + (f.error ?? "")); }
        }
        if (!sok) ok = false;
      }
      emit("done");
      return ok;
    });
    this.fleetMode ? this.refreshFleet() : this.refreshUpdates();
  };

  private renderUpdModal() {
    const groups = this.modalGroups();
    const sel = this.updSel;
    const scoped = !!this.updModalHost;
    const allOn = groups.length > 0 && groups.every((g) => sel.includes(this.updKey(g)));
    return (
      <div class="dmodal" onClick={() => (this.updModalOpen = false)}>
        <div class="ubox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="uhead">
            <loom-icon name="download" size={15}></loom-icon>
            <span class="ut">Update stacks</span>
            {scoped ? <hope-chip host={true}>{this.updModalHost}</hope-chip> : null}
            <span class="usub">{groups.length} with newer images</span>
            <span class="grow"></span>
            <button class="dx" onClick={() => (this.updModalOpen = false)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="usela" onClick={() => (this.updSel = allOn ? [] : groups.map(this.updKey))}>
            <span class={"ck" + (allOn ? " on" : "")}></span>
            <span>{allOn ? "deselect all" : "select all"}</span>
          </div>
          <div class="ulist">
            {groups.map((g) => {
              const key = this.updKey(g);
              const on = sel.includes(key);
              return (
                <div class={"brow" + (on ? " on" : "")} onClick={() => this.toggleUpd(key)}>
                  <span class={"ck" + (on ? " on" : "")}></span>
                  <span class="uname">{g.host && !scoped ? <hope-chip host={true}>{g.host}</hope-chip> : null}{g.project}</span>
                  <span class="usvcs">
                    {g.services.slice(0, 6).map((s) => <span class="svc">{s.service}{s.count > 1 ? <b> ×{s.count}</b> : null}</span>)}
                    {g.services.length > 6 ? <span class="svc more">+{g.services.length - 6}</span> : null}
                  </span>
                  <span class="ucnt">{g.count}</span>
                </div>
              );
            })}
          </div>
          <div class="uacts">
            <span class="grow"></span>
            <button class="pbtn" onClick={() => (this.updModalOpen = false)}>cancel</button>
            <button class="pbtn go" disabled={sel.length === 0} onClick={this.bulkUpdate}>
              <loom-icon name="download" size={12}></loom-icon>update {sel.length}
            </button>
          </div>
        </div>
      </div>
    );
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
  private logout = () => this.auth.logout();

  // ── Unified host model ──────────────────────────────────────────────────
  // Both the single-host and all-hosts views are the same thing: a list of host
  // sections (single host = a fleet of one). The bar, ribbon, Attention/Updates,
  // and the grouped grids are all computed from this one shape.
  private hostSections(): HostSec[] {
    const q = this.query.trim().toLowerCase();
    const match = (s: StackSummary) =>
      !q || s.project.toLowerCase().includes(q) || s.containers.some((c) => (c.service || c.name).toLowerCase().includes(q));
    const rank = (list: StackSummary[]): Ranked[] =>
      list
        .filter(match)
        .map((s) => ({ ...s, sev: stackSeverity(s.running, s.total, s.restarting) }))
        .sort((a, b) => severityRank(a.sev) - severityRank(b.sev) || a.project.localeCompare(b.project));

    if (this.fleetMode) {
      // The server returns hosts in map order (non-deterministic); sort so the
      // sections don't shuffle on every fleet reload. Local first, then by id.
      return (this.fleet ?? []).map((h) => {
        const ranked = rank(h.stacks ?? []);
        return {
          id: h.id,
          kind: h.kind,
          online: h.online,
          error: h.error,
          ranked,
          up: (h.stacks ?? []).reduce((a, s) => a + s.running, 0),
          tot: (h.stacks ?? []).reduce((a, s) => a + s.total, 0),
          issues: ranked.filter((s) => s.sev === "loop" || s.sev === "warn").length,
          loops: ranked.filter((s) => s.sev === "loop").length,
          outdated: h.outdated ?? 0,
          updProjects: new Set((h.updates ?? []).filter((u) => u.project).map((u) => u.project)),
          outIds: new Set((h.updates ?? []).map((u) => u.id)),
        };
      }).sort((a, b) => (a.kind === "local" ? 0 : 1) - (b.kind === "local" ? 0 : 1) || a.id.localeCompare(b.id));
    }

    const ranked = rank(this.stacks);
    return [
      {
        id: this.host?.Name || "local",
        kind: "local",
        online: true,
        error: undefined,
        ranked,
        up: ranked.reduce((a, s) => a + s.running, 0),
        tot: ranked.reduce((a, s) => a + s.total, 0),
        issues: ranked.filter((s) => s.sev === "loop" || s.sev === "warn").length,
        loops: ranked.filter((s) => s.sev === "loop").length,
        outdated: this.outdated().length,
        updProjects: this.updSet(),
        outIds: this.outdatedIds(),
      },
    ];
  }

  // One host's stacks. Single host → just the grid (no header). Fleet → a
  // collapsible section headed by the host id + its vitals.
  private hostGroup(h: HostSec, multi: boolean) {
    const open = (project: string) => (multi ? this.goCross(h.id, project) : this.go(project));
    const grid = !h.online ? (
      h.error ? <div class="ferr">{h.error}</div> : null
    ) : h.ranked.length === 0 ? (
      <div class="frow-empty">no stacks</div>
    ) : (
      <div class="grid">
        {h.ranked.map((s) => this.stackTile(s, { onClick: () => open(s.project), hasUpd: h.updProjects.has(s.project), outIds: h.outIds }))}
      </div>
    );
    if (!multi) return grid;
    const collapsed = this.collapsed.includes(h.id);
    return (
      <section class="fleetsec" data-host={h.id}>
        <div class={"head hhead" + (collapsed ? " collapsed" : "")} onClick={() => this.toggleHost(h.id)}>
          <loom-icon class="caret" name="chevron-right" size={14}></loom-icon>
          <span class={"hdot " + h.kind}></span>
          <span class="label">{h.id}</span>
          <span class="khint">{h.kind}</span>
          <span class="rule"></span>
          {h.online ? (
            <>
              {h.issues > 0 ? <hope-chip tone={h.loops > 0 ? "bad" : "warn"} size="sm">{h.issues} {h.issues === 1 ? "issue" : "issues"}</hope-chip> : null}
              {h.outdated > 0 ? <hope-chip tone="upd" size="sm" style="cursor:pointer" title="update this host's outdated stacks" onClick={(e: Event) => { e.stopPropagation(); this.openUpdModal(h.id); }}>{h.outdated} {h.outdated === 1 ? "update" : "updates"}</hope-chip> : null}
              <span class="n">{h.up}<span class="t">/{h.tot}</span></span>
            </>
          ) : (
            <span class="foff">{h.error ? "unreachable" : "offline"}</span>
          )}
        </div>
        {collapsed ? null : grid}
      </section>
    );
  }

  update() {
    const secs = this.hostSections();
    const multi = this.fleetMode;
    // Every stack across every online host, tagged with its host + section.
    const allStacks = secs.flatMap((h) => (h.online ? h.ranked.map((s) => ({ s, host: multi ? h.id : undefined, sec: h })) : []));
    const issues = allStacks.filter((x) => x.s.sev === "loop" || x.s.sev === "warn");
    const stackC = secs.reduce((a, h) => a + h.ranked.length, 0);
    const runC = secs.reduce((a, h) => a + h.up, 0);
    const totC = secs.reduce((a, h) => a + h.tot, 0);
    const updC = secs.reduce((a, h) => a + h.outdated, 0);
    const loops = issues.filter((x) => x.s.sev === "loop").length;
    const online = secs.filter((h) => h.online).length;
    const vClass = loops > 0 ? "bad" : issues.length > 0 ? "warn" : "ok";
    const vText = issues.length === 0 ? "nominal" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`;
    const updGroups: any[] = multi ? this.fleetUpdateGroups(this.fleet ?? []) : this.updateGroups();
    const checked = multi ? this.fleetChecked() : this.updates?.checked_at;
    const refresh = multi ? this.refreshFleet : this.refreshUpdates;
    const busy = multi ? this.fleetBusy : this.updBusy;

    return (
      <div>
        <div class="bar">
          <div class="s brand">HOPE</div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s"><span class="k">{multi ? "all hosts" : "fleet"}</span></div>
          <hope-nav></hope-nav>
          <div class="grow"></div>
          {multi ? <div class="s"><span class="k">hosts</span><span class="v">{online}<span class="t">/{secs.length}</span></span></div> : null}
          <div class="s"><span class="k">stacks</span><span class="v">{stackC}</span></div>
          <div class="s"><span class="k">up</span><span class="v">{runC}<span class="t">/{totC}</span></span></div>
          <div class={"s verdict " + vClass}>
            <span class={"mark " + vClass}></span>
            {vText}
          </div>
          {updC > 0 ? (
            <div class="s act">
              <button class="upind" title="review and update outdated stacks" onClick={() => this.openUpdModal()}>
                <loom-icon name="download" size={13}></loom-icon><span>{updC} updates</span>
              </button>
            </div>
          ) : null}
          <div class="s act">
            <button class="upcheck" disabled={busy} title="check every image for updates now" onClick={refresh}>
              <loom-icon class={busy ? "spin" : ""} name="rotate" size={13}></loom-icon>
              <span>check</span>
            </button>
          </div>
          <div class="s act"><button style="display:inline-flex;align-items:center;gap:6px" onClick={this.logout}><loom-icon name="logout" size={12}></loom-icon>exit</button></div>
        </div>

        {this.loading ? <div class="loadbar"><i></i></div> : null}
        <main>
          {this.storeBanner()}
          {multi
            ? this.statStrip([
                { k: "hosts", v: <>{online}<i class="t">/{secs.length}</i></> },
                { k: "stacks", v: stackC },
                { k: "containers", v: <>{runC}<i class="t">/{totC}</i></> },
                { k: "issues", v: issues.length, cls: issues.length ? vClass : "" },
                { k: "updates", v: updC, cls: updC ? "upd" : "" },
              ])
            : this.host ? this.hostStrip() : null}

          {this.error ? <div class="empty">{this.error}</div> : null}
          {multi && !this.loaded ? <div class="loading">loading fleet…</div> : null}

          {stackC > 0 || this.query ? (
            <hope-search placeholder="Search stacks and services…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
          ) : null}

          {/* the per-stack density ribbon is a single-host view; in fleet mode the
              summary strip + per-host sections carry the same signal without a
              long, host-blind strip. */}
          {!multi && allStacks.length > 0 ? (
            <div class="ribbon">
              {allStacks.map((x) => {
                const hasUpd = x.sec.updProjects.has(x.s.project);
                const cls = (x.s.sev === "ok" || x.s.sev === "down") && hasUpd ? "upd" : x.s.sev;
                return (
                  <i
                    class={cls}
                    data-tip={`${x.s.project}   ${x.s.running}/${x.s.total}${x.s.restarting ? "   ⟳ restarting" : ""}${hasUpd ? "   ↑ update" : ""}`}
                    onClick={() => this.go(x.s.project)}
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
                {issues.map((x) => this.attentionRow(x.s, { host: x.host, onClick: () => (multi ? this.goCross(x.host!, x.s.project) : this.go(x.s.project)) }))}
              </div>
            </section>
          ) : null}

          {updGroups.length > 0 ? (
            <section>
              <div class="head">
                <span class="label">Updates</span>
                <span class="rule"></span>
                {checked ? <span class="ago">checked {ago(checked)}</span> : null}
                <button class="rfr" disabled={busy} title="check now" onClick={refresh}>
                  <loom-icon class={busy ? "spin" : ""} name="rotate" size={13}></loom-icon>
                </button>
                <span class="n upd">{updC}</span>
              </div>
              <div class="rows">
                {updGroups.map((g) => this.updateRow(g, { host: multi ? g.host : undefined, onClick: () => (multi ? this.goCross(g.host, g.project) : this.go(g.project)), linkable: g.project !== UNGROUPED }))}
              </div>
            </section>
          ) : null}

          {secs.map((h) => this.hostGroup(h, multi))}

          {this.loaded && stackC === 0 && !this.query && !this.error ? (
            <div class="empty">{multi ? "No stacks across the fleet." : "No containers on this daemon."}</div>
          ) : null}
        </main>
        {this.updModalOpen ? this.renderUpdModal() : null}
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
