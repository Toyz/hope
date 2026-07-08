// Mission-control overview, terminal-instrument style. A tmux-like status bar
// synthesizes fleet state; a flat fleet ribbon shows every stack as a cell
// (dark = nominal, lit = trouble); below, an Attention zone then a quiet Fleet
// list of instrument rows. No glows, no per-row noise. Refreshes every 5s.
import { LoomElement, component, styles, css, reactive, mount, interval, on, app, bus } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter, route } from "@toyz/loom/router";
import { rpc, mutate } from "@toyz/loom-rpc";
import type { RpcMutator } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { withHost } from "../host-url";
import { HostChanged, UpdatesApplied, withRefresh } from "../events";
import { UNGROUPED } from "../const";
import { ProcService } from "../proc";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { System, Stacks } from "../contracts";
import "../components/plugin-widgets"; // registers <hope-plugin-widgets> (self-hides when none)
import type { StackSummary, UpdatesResult, DiskResult, FleetHost, OpFrame } from "../contracts";
import { stackSeverity, severityRank, severityMark, severityTone, healthLabel, type Severity } from "../styles";

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
  :host { display: block; min-height: 100%; background: var(--ink); }

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
  .loadbar { position: sticky; top: 0; z-index: 19; height: 2px; overflow: hidden;
    background: color-mix(in srgb, var(--upd) 18%, transparent); opacity: 0; animation: lbin 0s .2s forwards; }
  .loadbar i { display: block; height: 100%; width: 35%; background: var(--upd); animation: lbslide 1s ease-in-out infinite; }
  @keyframes lbin { to { opacity: 1; } }
  @keyframes lbslide { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }

  /* cross-fleet overview ("all hosts") */
  .fleetsec { margin-bottom: 26px; }
  .fleetsec .hdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dim); }
  /* the dot reports the host's worst state, not its kind */
  .fleetsec .hdot.ok { background: var(--ok); }
  .fleetsec .hdot.warn { background: var(--warn); }
  .fleetsec .hdot.bad { background: var(--bad); }
  .fleetsec .hdot.upd { background: var(--upd); }
  .fleetsec .hdot.off { background: var(--bad); opacity: .5; }
  .fleetsec .khint { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .fleetsec .head.hhead { cursor: pointer; }
  .fleetsec .head .caret { color: var(--dim); flex: none; transition: transform .12s ease; }
  .fleetsec .head:not(.collapsed) .caret { transform: rotate(90deg); }
  .fleetsec .head.hhead:hover .label { color: var(--hi); }


  .row .umark { color: var(--upd); }
  .row .name .svc { color: var(--dim); }
  .row .why.upd { color: var(--upd); }
  .head .n.upd { color: var(--upd); }
  .head .n.warn { color: var(--warn); }
  .head .n.bad { color: var(--bad); }
  .fleetsec .foff { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--bad); }
  .fleetsec .frow-empty { padding: 12px 14px; color: var(--dim); font: 500 12px/1 var(--mono); }
  .fleetsec .ferr { padding: 12px 14px; color: var(--bad); font: 500 12px/1.4 var(--mono); word-break: break-word; }

  main { padding: 0 0 90px; }
  /* header / stats / table come from the shared theme (.vhead/.vstats/.vtable).
     hope-stat renders its own .k/.v, so a clickable stat value is now a bare
     .vlink button slotted straight into the band (no .s .v wrapper) — restyle it
     to match the theme's .vstats .s .v.vlink. */
  .vstats .vlink { background: transparent; border: 0; padding: 0; text-align: left; color: var(--upd); cursor: pointer;
    font: 500 15px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .vstats .vlink:hover { text-decoration: underline; }
  .uchip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--upd) 45%, var(--line));
    background: transparent; color: var(--upd); cursor: pointer; font: 600 9.5px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
  .uchip:hover { background: color-mix(in srgb, var(--upd) 14%, transparent); }
  .uchip:disabled { opacity: .5; cursor: default; }
  .uchip loom-icon { color: var(--upd); }
  .dash { color: var(--faint); }

  /* compact header filter (fleet) */
  .hsearch { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 11px; border: 1px solid var(--line2); }
  .hsearch loom-icon { color: var(--dim); flex: none; }
  .hsearch input { width: 190px; background: transparent; border: 0; color: var(--hi); font: 12px/1 var(--mono); }
  .hsearch input:focus { outline: none; }
  .hsearch input::placeholder { color: var(--dim); }

  /* fleet host cards use the shared .card / .cards system; these are the extras */
  /* align-items:start so a sparse agent card (2 rows) isn't stretched to match a
     dense one (local, +13 more) — that stretch left a big empty void below it. */
  .hcards { padding: 20px 28px 40px; align-items: start; }
  .card-row .uparrow { color: var(--upd); flex: none; }
  .hc-offlbl { color: var(--bad); font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .hc-more, .hc-empty { padding: 8px 14px; color: var(--dim); font: 11px/1 var(--mono); }
  .card-f.hc-ok { color: var(--dim); font: 11px/1 var(--mono); }
  .card-f.hc-ok .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
  .hc-updbtn { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--upd) 45%, var(--line));
    background: transparent; color: var(--upd); cursor: pointer; font: 600 9.5px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
  .hc-updbtn:hover { background: color-mix(in srgb, var(--upd) 14%, transparent); }

  /* updates table */
  .uhead { display: flex; align-items: center; gap: 12px; padding: 20px 28px 10px; }
  .uhead .eyebrow { color: var(--dim); font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; }
  .uhead .ago { color: var(--dim); font: 500 10px/1 var(--mono); }
  .uhead .grow { flex: 1; }
  .uhead .ucount { color: var(--upd); font: 600 12px/1 var(--mono); }
  .usvcs { display: flex; flex-wrap: wrap; gap: 3px 14px; color: var(--dim); font: 12px/1.5 var(--mono); }
  .usvc.more { color: var(--mid); }
  .vtable td.uact { text-align: right; white-space: nowrap; }
  .ubtn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border: 1px solid color-mix(in srgb, var(--upd) 45%, var(--line));
    background: transparent; color: var(--upd); cursor: pointer; font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
  .ubtn:hover { background: color-mix(in srgb, var(--upd) 14%, transparent); }
  .ubtn:disabled { opacity: .5; cursor: default; }


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
  .ck { display: inline-block; width: 15px; height: 15px; flex: none; border: 1px solid var(--line2); cursor: pointer; vertical-align: middle; position: relative; }
  .ck.on { background: var(--upd); border-color: var(--upd); box-shadow: inset 0 0 0 3px var(--panel); }
  .ck.part { border-color: var(--upd); }
  .ck.part::after { content: ""; position: absolute; left: 3px; right: 3px; top: 6px; height: 2px; background: var(--upd); }

  /* hierarchical update picker: host > stack > service rows */
  .urow { display: flex; align-items: center; gap: 11px; padding: 9px 16px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .urow:last-child { border-bottom: 0; }
  .urow:hover { background: var(--raised); }
  .urow .grow { flex: 1; }
  .urow .un { color: var(--dim); font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .urow.uhost { background: color-mix(in srgb, var(--upd) 5%, transparent); }
  .urow.ustack .uname { font: 600 13px/1 var(--mono); color: var(--hi); }
  .urow.usvc { padding-left: 42px; }
  .urow.usvc .usvcname { font: 12px/1 var(--mono); color: var(--mid); }
  .urow.usvc .uimg { color: var(--dim); font: 11px/1 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
  .urow.nested.ustack { padding-left: 42px; }
  .urow.nested.usvc { padding-left: 66px; }
  .uempty { padding: 20px 16px; color: var(--dim); font: 12px/1 var(--mono); }
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
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor query = "";
  @reactive accessor diskBusy = false;
  @reactive accessor updBusy = false;
  @reactive accessor fleetBusy = false;
  // Bulk-update picker: open state + selected group keys (host|project).
  @reactive accessor updModalOpen = false;
  @reactive accessor updSel: string[] = [];
  @reactive accessor updModalHost = ""; // scope the picker to one host ("" = all)
  @reactive accessor updModalProject = ""; // scope the picker to one stack ("" = all)


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

  // Mock-style host header: health dot + hostname + state chip + daemon line, with
  // the host actions (check updates, df) on the right. The single source for these
  // actions — the old status bar + daemon strip are gone on the single-host view.
  private hostHeader(h0: HostSec, first: boolean) {
    const info = this.host;
    const dot = this.hostDotTone(h0);
    const label = !h0.online ? "offline" : h0.loops > 0 ? "restarting" : h0.issues > 0 ? "degraded" : h0.outdated > 0 ? "updates" : "healthy";
    const os = info ? `${info.OperatingSystem || info.OSType || ""}${info.Architecture ? " · " + info.Architecture : ""}` : "";
    return (
      <hope-phead
        heading={(info && info.Name) || this.hostCtx.token || "host"}
        dot={first ? "" : dot}
        scope={this.hostCtx.token || "local"}
        meta={first ? "" : info ? `docker ${info.ServerVersion || "—"}${os ? " · " + os : ""}` : ""}
      >
        {!first ? <hope-chip slot="actions" tone={this.attnTone(h0.loops, h0.issues)}>{label}</hope-chip> : null}
        {!first && h0.ranked.length > 8 ? (
          <div slot="actions" class="hsearch">
            <loom-icon name="search" size={13}></loom-icon>
            <input placeholder="filter stacks…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
          </div>
        ) : null}
        <hope-button slot="actions" icon="rotate" spin={this.updBusy} disabled={this.updBusy} title="check every image for updates" onClick={this.refreshUpdates}>check</hope-button>
        <hope-button slot="actions" icon="database" spin={this.diskBusy} disabled={this.diskBusy} title="compute disk usage" onClick={this.refreshDisk}>{this.diskBusy ? "scanning" : "df"}</hope-button>
        {this.hostStats(h0, first)}
      </hope-phead>
    );
  }

  // Clean single-host stat band (mock-style gap columns, hairline under). Replaces
  // the old bordered daemon strip.
  private hostStats(h0: HostSec, first: boolean) {
    if (first) {
      return (
        <div class="vstats">
          <hope-stat label="stacks"><hope-skel w="30" h="15"></hope-skel></hope-stat>
          <hope-stat label="containers"><hope-skel w="52" h="15"></hope-skel></hope-stat>
          <hope-stat label="images"><hope-skel w="30" h="15"></hope-skel></hope-stat>
          <hope-stat label="cpu"><hope-skel w="56" h="15"></hope-skel></hope-stat>
          <hope-stat label="memory"><hope-skel w="60" h="15"></hope-skel></hope-stat>
        </div>
      );
    }
    const info = this.host;
    const dt = this.diskTotals();
    return (
      <div class="vstats">
        <hope-stat label="stacks" value={String(h0.ranked.length)}></hope-stat>
        <hope-stat label="containers" value={String(h0.up)} sub={"/" + h0.tot}></hope-stat>
        <hope-stat label="images" value={String(info?.Images ?? 0)}></hope-stat>
        <hope-stat label="cpu" value={String(info?.NCPU ?? "—")} sub=" cores"></hope-stat>
        <hope-stat label="memory" value={gb(info?.MemTotal)}></hope-stat>
        {dt ? <hope-stat label="disk" value={gb(dt.total)}></hope-stat> : null}
        {h0.outdated > 0 ? <hope-stat label="updates"><button class="vlink" title="select what to update on this host" onClick={() => this.openUpdModal()}>{h0.outdated}</button></hope-stat> : null}
      </div>
    );
  }

  // The host's stacks as a clean instrument table (single-host view). Each row is
  // a stack; click opens it. Replaces the tile grid to match the explorer mocks.
  private stackTable(h: HostSec) {
    if (!h || h.ranked.length === 0) {
      return this.loaded && !this.query ? <div class="empty">No containers on this daemon.</div> : null;
    }
    return (
      <table class="vtable">
        <thead>
          <tr><th>stack</th><th>state</th><th class="r">containers</th><th>updates</th><th></th></tr>
        </thead>
        <tbody>
          {h.ranked.map((s) => {
            const hasUpd = h.updProjects.has(s.project);
            return (
              <tr onClick={() => this.go(s.project)}>
                <td><span class="nm"><span class={"mark " + severityMark(s.sev, hasUpd)}></span>{s.project}</span></td>
                <td><hope-chip tone={severityTone(s.sev)} size="sm">{healthLabel(s.sev)}</hope-chip></td>
                <td class="r">{s.running}<span class="t" style="color:var(--dim)">/{s.total}</span></td>
                <td>{hasUpd ? <button class="uchip" title="review + update this stack" onClick={(e: Event) => { e.stopPropagation(); this.openUpdModal(undefined, s.project); }}><loom-icon name="download" size={11}></loom-icon>update</button> : <span class="dash">—</span>}</td>
                <td class="chev"><loom-icon name="chevron-right" size={14}></loom-icon></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  // First-load placeholder for the single-host stack table — same columns as
  // stackTable so content swaps in without a layout jump.
  private stackTableSkeleton() {
    return (
      <table class="vtable">
        <thead>
          <tr><th>stack</th><th>state</th><th class="r">containers</th><th>updates</th><th></th></tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3, 4].map(() => (
            <tr style="cursor:default">
              <td><hope-skel w="160" h="13"></hope-skel></td>
              <td><hope-skel w="60" h="16"></hope-skel></td>
              <td class="r"><hope-skel w="40" h="13"></hope-skel></td>
              <td><hope-skel w="20" h="13"></hope-skel></td>
              <td></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // One host, as a card in the fleet ("all hosts") view — rollup dot + name +
  // running count, its top stacks, and issue/update chips. Clicking opens the host.
  private hostCard(h: HostSec) {
    return (
      <div class="card click" onClick={() => this.router.navigate(`/host/${encodeURIComponent(h.id)}`)}>
        <div class="card-h">
          <span class={"dot " + this.hostDotTone(h)}></span>
          <h3>{h.id}</h3>
          <span class="kind">{h.kind}</span>
          <span class="grow"></span>
          {h.online ? <span class="roll">{h.up}<span class="t">/{h.tot}</span></span> : <span class="hc-offlbl">offline</span>}
        </div>
        {h.online ? (
          <div class="card-b">
            {h.ranked.length === 0 ? <div class="hc-empty">no stacks</div> : null}
            {h.ranked.slice(0, 8).map((s) => (
              <div class="card-row click" onClick={(e: Event) => { e.stopPropagation(); this.goCross(h.id, s.project); }}>
                <span class={"mark " + severityMark(s.sev, h.updProjects.has(s.project))}></span>
                <span class="nm">{s.project}</span>
                {h.updProjects.has(s.project) ? <loom-icon class="uparrow" name="download" size={11}></loom-icon> : null}
                <span class="rt">{s.running}<span class="t">/{s.total}</span></span>
              </div>
            ))}
            {h.ranked.length > 8 ? <div class="hc-more">+{h.ranked.length - 8} more</div> : null}
          </div>
        ) : (
          <div class="card-b"><div class="hc-empty">{h.error || "unreachable"}</div></div>
        )}
        {h.online ? (
          h.issues > 0 || h.outdated > 0 ? (
            <div class="card-f">
              {h.issues > 0 ? <hope-chip tone={this.attnTone(h.loops, h.issues)} size="sm">{h.issues} {h.issues === 1 ? "issue" : "issues"}</hope-chip> : null}
              {h.outdated > 0 ? (
                <button class="hc-updbtn" title="review + update this host's outdated stacks" onClick={(e: Event) => { e.stopPropagation(); this.openUpdModal(h.id); }}>
                  <loom-icon name="download" size={11}></loom-icon>{h.outdated} update{h.outdated === 1 ? "" : "s"}
                </button>
              ) : null}
            </div>
          ) : (
            <div class="card-f hc-ok"><span class="dot ok"></span> all healthy &middot; up to date</div>
          )
        ) : null}
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


  // The outdated updates as a host > stack > container tree, scoped to the modal's
  // host/stack. Each leaf is one container (id) we can redeploy on its own — the
  // basis for the granular "pick what to update" picker.
  private updTree(): Array<{ host: string; projects: Array<{ project: string; items: Array<{ id: string; service: string; image: string }> }> }> {
    const src = this.fleetMode
      ? (this.fleet ?? []).map((h) => ({ host: h.id, ups: (h.updates ?? []).filter((u) => u.status === "outdated") }))
      : [{ host: "", ups: this.outdated() }];
    return src
      .filter((h) => !this.updModalHost || h.host === this.updModalHost)
      .map((h) => {
        const byProj: Record<string, Array<{ id: string; service: string; image: string }>> = {};
        for (const u of h.ups) {
          const p = u.project || UNGROUPED;
          (byProj[p] ??= []).push({ id: u.id, service: u.service || u.name || u.image, image: u.image });
        }
        let projects = Object.entries(byProj).map(([project, items]) => ({
          project,
          items: items.sort((a, b) => a.service.localeCompare(b.service)),
        }));
        if (this.updModalProject) projects = projects.filter((p) => p.project === this.updModalProject);
        projects.sort((a, b) => a.project.localeCompare(b.project));
        return { host: h.host, projects };
      })
      .filter((h) => h.projects.length)
      .sort((a, b) => a.host.localeCompare(b.host));
  }
  private updAllIds(): string[] {
    return this.updTree().flatMap((h) => h.projects.flatMap((p) => p.items.map((i) => i.id)));
  }

  // Open the granular picker. Scope it to one host (a host card) or one stack (a
  // stack row); no scope shows the whole fleet. Everything starts selected.
  private openUpdModal = (host?: string, project?: string) => {
    this.updModalHost = host || "";
    this.updModalProject = project || "";
    this.updSel = this.updAllIds();
    this.updModalOpen = true;
  };
  private toggleUpd = (id: string) => {
    this.updSel = this.updSel.includes(id) ? this.updSel.filter((k) => k !== id) : [...this.updSel, id];
  };
  // Toggle a whole set of ids (a stack or a host): if all on, clear them; else add all.
  private toggleUpdSet = (ids: string[]) => {
    const allOn = ids.length > 0 && ids.every((id) => this.updSel.includes(id));
    this.updSel = allOn ? this.updSel.filter((id) => !ids.includes(id)) : [...new Set([...this.updSel, ...ids])];
  };
  // "on" | "part" | "" for a set of ids, for the tri-state checkbox.
  private setState = (ids: string[]): string => {
    const n = ids.filter((id) => this.updSel.includes(id)).length;
    return n === 0 ? "" : n === ids.length ? "on" : "part";
  };

  // Update exactly what's picked — one redeploy per selected container, so each pulls
  // only its own image and recreates only itself. We deliberately do NOT collapse a
  // fully-picked stack into a redeployStack: updTree lists only the OUTDATED containers,
  // so "all items picked" means "all the outdated ones", not "all containers in the
  // stack". redeployStack pulls EVERY image in the project and re-evaluates EVERY
  // container — so updating one outdated service dragged the whole stack (painfully so
  // across a cluster tunnel). A genuine whole-stack redeploy lives on the stack page.
  private bulkUpdate = async () => {
    const jobs: Array<{ host: string; project: string; label: string; method: "redeployStack" | "redeploy"; arg: string }> = [];
    for (const h of this.updTree()) {
      for (const p of h.projects) {
        const picked = p.items.filter((it) => this.updSel.includes(it.id));
        if (picked.length === 0) continue;
        const pfx = (h.host ? h.host + " / " : "") + p.project;
        for (const it of picked) jobs.push({ host: h.host, project: p.project, label: pfx + " / " + it.service, method: "redeploy", arg: it.id });
      }
    }
    if (!jobs.length) return;
    this.updModalOpen = false;
    let ok = true;
    await this.proc.run(`update ${jobs.length} item${jobs.length === 1 ? "" : "s"}`, async (emit, signal) => {
      for (const j of jobs) {
        emit(`── ${j.label} ──`);
        let jok = true;
        for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", j.method, [j.arg, "true", "false"], signal, j.host || undefined)) {
          if (f.type === "log" && f.data) emit(f.data);
          else if (f.type === "done" && !f.ok) { jok = false; emit("failed: " + (f.error ?? "")); }
        }
        if (!jok) { ok = false; continue; }
        // The redeploy pulled latest, so these are current now — patch the rail's
        // dots in place per host+stack (a whole-stack redeploy clears the project;
        // a per-container one clears just that id) instead of a full fleet recrawl.
        const ids = j.method === "redeploy" ? [j.arg] : undefined;
        bus.emit(new UpdatesApplied(j.host || this.hostCtx.token, j.project, ids));
      }
      emit("done");
      return ok;
    });
    // Refresh the dashboard's OWN updates view from the already-updated backend cache
    // (no forced recrawl, no withRefresh — so the rail isn't yanked into a full reload).
    (this.fleetMode ? this.fleetQ : this.updatesQ).refetch();
  };

  private renderUpdModal() {
    const tree = this.updTree();
    const allIds = this.updAllIds();
    const total = this.updSel.filter((id) => allIds.includes(id)).length;
    const title = this.updModalProject ? this.updModalProject : this.updModalHost ? this.updModalHost : "Fleet";
    return (
      <div class="dmodal" onClick={() => (this.updModalOpen = false)}>
        <div class="ubox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="uhead">
            <loom-icon name="download" size={15}></loom-icon>
            <span class="ut">Update</span>
            <hope-chip>{title}</hope-chip>
            <span class="usub">select what to update</span>
            <span class="grow"></span>
            <button class="dx" onClick={() => (this.updModalOpen = false)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="usela" onClick={() => this.toggleUpdSet(allIds)}>
            <span class={"ck " + this.setState(allIds)}></span>
            <span>{this.setState(allIds) === "on" ? "deselect all" : "select all"} &middot; {allIds.length} container{allIds.length === 1 ? "" : "s"}</span>
          </div>
          <div class="ulist">
            {tree.map((h) => {
              const hostIds = h.projects.flatMap((p) => p.items.map((i) => i.id));
              return (
                <>
                  {this.fleetMode && !this.updModalHost ? (
                    <div class="urow uhost" onClick={() => this.toggleUpdSet(hostIds)}>
                      <span class={"ck " + this.setState(hostIds)}></span>
                      <hope-chip host={true}>{h.host}</hope-chip>
                      <span class="grow"></span>
                      <span class="un">{hostIds.length}</span>
                    </div>
                  ) : null}
                  {h.projects.map((p) => {
                    const ids = p.items.map((i) => i.id);
                    const nested = this.fleetMode && !this.updModalHost;
                    return (
                      <>
                        <div class={"urow ustack" + (nested ? " nested" : "")} onClick={() => this.toggleUpdSet(ids)}>
                          <span class={"ck " + this.setState(ids)}></span>
                          <span class="uname">{p.project}</span>
                          <span class="grow"></span>
                          <span class="un">{ids.length}</span>
                        </div>
                        {p.items.map((it) => (
                          <div class={"urow usvc" + (nested ? " nested" : "")} onClick={() => this.toggleUpd(it.id)}>
                            <span class={"ck " + (this.updSel.includes(it.id) ? "on" : "")}></span>
                            <span class="usvcname">{it.service}</span>
                            <span class="grow"></span>
                            <span class="uimg">{it.image}</span>
                          </div>
                        ))}
                      </>
                    );
                  })}
                </>
              );
            })}
            {tree.length === 0 ? <div class="uempty">nothing outdated here</div> : null}
          </div>
          <div class="uacts">
            <span class="grow"></span>
            <button class="pbtn" onClick={() => (this.updModalOpen = false)}>cancel</button>
            <button class="pbtn go" disabled={total === 0} onClick={this.bulkUpdate}>
              <loom-icon name="download" size={12}></loom-icon>update {total}
            </button>
          </div>
        </div>
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
  // The one attention-tone rule: a crash loop is the loudest (red), any other
  // issue is amber, else healthy. Shared by the host dot, the issue chip, and the
  // verdict banner so they never disagree.
  private attnTone(loops: number, issues: number): string {
    return loops > 0 ? "bad" : issues > 0 ? "warn" : "ok";
  }

  // The host dot reports its worst state, worst-first: unreachable, an attention
  // tone (loop/issue), an available update, else healthy. (It used to be tinted by
  // host kind, so an agent showed green even with issues.)
  private hostDotTone(h: HostSec): string {
    if (!h.online) return "off";
    const t = this.attnTone(h.loops, h.issues);
    return t === "ok" && h.outdated > 0 ? "upd" : t;
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
    const vClass = this.attnTone(loops, issues.length);
    const vText = issues.length === 0 ? "nominal" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`;
    const updGroups: any[] = multi ? this.fleetUpdateGroups(this.fleet ?? []) : this.updateGroups();
    const checked = multi ? this.fleetChecked() : this.updates?.checked_at;
    const refresh = multi ? this.refreshFleet : this.refreshUpdates;
    const busy = multi ? this.fleetBusy : this.updBusy;
    const first = this.loading && !this.loaded; // first load, no host/fleet data yet

    return (
      <div>
        {this.loading ? <div class="loadbar"><i></i></div> : null}
        <main>
          {multi ? (
            /* fleet — a card per host is the content; updates + issues live inside
               the cards, not as separate full-width bands */
            <>
              <hope-phead heading="Fleet" dot={first ? "" : (issues.length ? vClass : updC ? "upd" : "ok")} scope="fleet">
                {!first && stackC > 10 ? (
                  <div slot="actions" class="hsearch">
                    <loom-icon name="search" size={13}></loom-icon>
                    <input placeholder="filter stacks…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
                  </div>
                ) : null}
                {!first && issues.length ? <hope-chip slot="actions" tone={vClass}>{vText}</hope-chip> : null}
                <hope-button slot="actions" icon="rotate" spin={busy} disabled={busy} title="check every image for updates" onClick={refresh}>check</hope-button>
                {first ? (
                  <div class="vstats">
                    <hope-stat label="hosts"><hope-skel w="42" h="15"></hope-skel></hope-stat>
                    <hope-stat label="stacks"><hope-skel w="30" h="15"></hope-skel></hope-stat>
                    <hope-stat label="containers"><hope-skel w="52" h="15"></hope-skel></hope-stat>
                    <hope-stat label="issues"><hope-skel w="24" h="15"></hope-skel></hope-stat>
                    <hope-stat label="updates"><hope-skel w="24" h="15"></hope-skel></hope-stat>
                  </div>
                ) : (
                  <div class="vstats">
                    <hope-stat label="hosts" value={String(online)} sub={"/" + secs.length}></hope-stat>
                    <hope-stat label="stacks" value={String(stackC)}></hope-stat>
                    <hope-stat label="containers" value={String(runC)} sub={"/" + totC}></hope-stat>
                    <hope-stat label="issues" value={String(issues.length)} tone={issues.length ? vClass : ""}></hope-stat>
                    <hope-stat label="updates">{updC > 0 ? <button class="vlink" title="select what to update across the fleet" onClick={() => this.openUpdModal()}>{updC}</button> : <span>0</span>}</hope-stat>
                  </div>
                )}
              </hope-phead>
              {this.error ? <div class="empty vpad">{this.error}</div> : null}
              {!this.loaded ? <div class="loading vpad">loading fleet…</div> : null}
              <div class="cards hcards">{secs.map((h) => this.hostCard(h))}</div>
              {this.loaded && stackC === 0 && !this.query && !this.error ? <div class="empty vpad">No stacks across the fleet.</div> : null}
            </>
          ) : secs.length ? (
            /* single host — same shape as fleet: header (+ inline filter) + stats +
               the main content (its stacks as a table; state + update columns carry
               the attention/updates signal, so no separate bands) */
            <>
              {this.hostHeader(secs[0], first)}
              {this.error ? <div class="empty vpad">{this.error}</div> : null}
              {first ? this.stackTableSkeleton() : this.stackTable(secs[0])}
            </>
          ) : null}
          <hope-plugin-widgets></hope-plugin-widgets>
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
