// Stack detail — control surface. One project's containers, stack lifecycle,
// and (when readable) the compose file. Terminal-instrument styling.
import { LoomElement, component, styles, css, reactive, prop, watch, mount, unmount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import { PromptService, type PromptField } from "../prompt";
import type { StackSummary, ContainerSummary, ContainerOp, StackOp, OpResult, ComposeFileResult, LogFrame, OpFrame, ContainerStat, ImageUpdate, UpdatesResult, TunnelView, ConnectorView, ZoneView } from "../contracts";
import { theme, markClass, stackSeverity } from "../styles";
import { stripAnsi } from "./container";

// Internal (container-side) port from a docker port string, for tunnel autofill.
const innerPort = (p: string): string => {
  const arrow = p.indexOf("->");
  return (arrow >= 0 ? p.slice(arrow + 2) : p).split("/")[0].trim();
};

// One fixed action order for every row (single, replica, group) so columns line
// up. Actions that don't apply to a container's state are disabled, not
// reordered or removed.
const ROW_ACTIONS: { op: ContainerOp; label: string; icon: string; danger?: boolean }[] = [
  { op: "start", label: "start", icon: "play" },
  { op: "restart", label: "restart", icon: "rotate" },
  { op: "stop", label: "stop", icon: "stop", danger: true },
  { op: "kill", label: "kill", icon: "x", danger: true },
];

// Group gating: start only if some replica is down; stop/kill only if some up.
function groupActionEnabled(items: ContainerSummary[], op: ContainerOp): boolean {
  if (op === "restart" || op === "pull" || op === "redeploy") return true;
  const up = (c: ContainerSummary) => c.state === "running" || c.state === "restarting";
  if (op === "start") return items.some((c) => !up(c));
  return items.some(up); // stop | kill
}

function actionEnabled(state: string, op: ContainerOp): boolean {
  const running = state === "running" || state === "restarting";
  switch (op) {
    case "start":
      return !running;
    case "stop":
    case "kill":
      return running;
    default:
      return true; // restart works from any state
  }
}

interface Group {
  service: string;
  items: ContainerSummary[];
}

function aggMark(items: ContainerSummary[]): string {
  if (items.some((c) => c.state === "restarting")) return "loop";
  const running = items.filter((c) => c.state === "running").length;
  if (running === items.length) return "ok";
  if (running === 0) return "";
  return "warn";
}

@route("/stack/:project")
@component("hope-stack")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--ink); }

  .bar {
    position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink);
  }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .bar .back:hover { color: var(--hi); }
  .bar .hostcrumb { font: 600 11px/1 var(--mono); letter-spacing: .08em; color: var(--ok); text-transform: lowercase;
    padding: 4px 9px; border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--line)); border-radius: 6px; }
  .bar .crumb { font: 600 13px/1 var(--mono); letter-spacing: .04em; }
  .bar .grow { flex: 1; }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 24px 32px 64px; max-width: 1340px; margin: 0 auto; }

  .shead { margin-bottom: 22px; }
  .row1 { display: flex; align-items: center; gap: 16px; }
  .ttl { display: flex; align-items: center; gap: 12px; }
  .ttl .mark { width: 9px; height: 9px; }
  .ttl h1 { font: 600 22px/1 var(--mono); margin: 0; letter-spacing: .01em; }
  .toolbar { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .tbtn { padding: 8px 13px; background: transparent; border: 1px solid var(--line); color: var(--mid);
    font: 500 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; cursor: pointer; }
  .tbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .tbtn:disabled { opacity: .4; cursor: not-allowed; }
  .more { position: relative; display: flex; }
  .more .tbtn { padding: 8px 11px; letter-spacing: .24em; }
  .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 40; min-width: 184px;
    background: var(--panel); border: 1px solid var(--line2); }
  .mitem { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 11px 14px;
    background: transparent; border: 0; border-bottom: 1px solid var(--line); color: var(--mid);
    font: 500 12px/1 var(--mono); cursor: pointer; }
  .mitem loom-icon { color: var(--dim); flex-shrink: 0; }
  .mitem:last-child { border-bottom: none; }
  .mitem:hover { background: var(--raised); color: var(--hi); }
  .mitem:hover loom-icon { color: var(--mid); }
  .mitem.danger:hover { color: var(--bad); }
  .mitem.danger:hover loom-icon { color: var(--bad); }
  .mitem:disabled { opacity: .4; cursor: not-allowed; }
  .mitem:disabled { opacity: .4; cursor: not-allowed; }

  .summary {
    display: flex; align-items: center; gap: 0; margin-top: 16px;
    border: 1px solid var(--line);
  }
  .summary .stat { display: flex; flex-direction: column; gap: 5px; padding: 11px 16px; border-right: 1px solid var(--line); }
  .summary .k { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .summary .v { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  .summary .v .t { color: var(--dim); }
  .summary .v.warnv { color: var(--warn); }
  .summary .v.badv { color: var(--bad); }
  .summary .v.updv { color: var(--upd); }
  .summary .wd { padding: 0 16px; font: 12px/1 var(--mono); color: var(--faint); word-break: break-all; }

  .logs { margin-bottom: 22px; border: 1px solid var(--line2); }
  .logshead { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px;
    border-bottom: 1px solid var(--line); background: var(--raised); }
  .logshead .label { font: 600 11px/1 var(--mono); letter-spacing: .04em; color: var(--hi); }
  .logsbody { border: 0; height: 50vh; }
  .logsbody.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }

  table { width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--line); }
  thead th { font: 600 10px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); }
  tbody td { padding: 0 14px; height: 46px; border-bottom: 1px solid var(--line); font: 13px/1.3 var(--mono); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--raised); }
  td.svc .cell { display: flex; align-items: center; gap: 10px; min-width: 0; overflow: hidden; }
  tr.crow { cursor: pointer; }
  .link { color: var(--hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  tr.crow:hover .link { color: #fff; }
  td.svc.rep .link { color: var(--mid); }
  /* group (expandable) rows read as headers */
  tr.grp { cursor: pointer; }
  tr.grp td { background: #11161f; }
  tr.grp:hover td { background: var(--raised); }
  tr.grp td.svc .cell { gap: 9px; }
  .caret { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
    color: var(--mid); border: 1px solid var(--line); flex-shrink: 0;
    transition: transform .12s ease, color .12s ease, border-color .12s ease; }
  tr.grp:hover .caret { color: var(--hi); border-color: var(--line2); }
  tr.grp.open .caret { transform: rotate(90deg); color: var(--hi); border-color: var(--line2); }
  .gname { color: var(--hi); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .badge { border: 1px solid var(--line); color: var(--dim); font: 11px/1 var(--mono); padding: 3px 7px; white-space: nowrap; flex-shrink: 0; }
  .badge b { color: var(--hi); font-weight: 600; }
  .upd { font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 3px 6px; background: transparent;
    color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 45%, var(--line)); white-space: nowrap; flex-shrink: 0; cursor: pointer; }
  .upd:hover { background: color-mix(in srgb, var(--upd) 18%, transparent); border-color: var(--upd); }
  .upd.static { cursor: default; }
  .upd.static:hover { background: transparent; border-color: color-mix(in srgb, var(--upd) 45%, var(--line)); }
  .tchipwrap { position: relative; display: inline-flex; }
  .tchip { display: inline-flex; align-items: center; gap: 4px; font: 600 10.5px/1 var(--mono); cursor: pointer;
    color: var(--ok); background: transparent; border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--line)); padding: 3px 7px; white-space: nowrap; flex-shrink: 0; }
  .tchip loom-icon { color: var(--ok); }
  .tchip b { color: var(--mid); font-weight: 600; }
  .tchip:hover { background: color-mix(in srgb, var(--ok) 14%, transparent); border-color: var(--ok); }
  .tmenu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 200px;
    background: var(--panel); border: 1px solid var(--line2); }
  .tmitem { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--line);
    color: var(--hi); text-decoration: none; font: 12px/1 var(--mono); white-space: nowrap; }
  .tmitem:last-child { border-bottom: 0; }
  .tmitem loom-icon { color: var(--ok); }
  .tmitem:hover { background: var(--raised); }
  .tmitem .pth { color: var(--dim); }
  tr.grp:hover .badge { border-color: var(--line2); }
  /* replica (child) rows are indented + dimmer */
  tr.rep td { background: rgba(255,255,255,.012); }
  td.svc.rep .cell { padding-left: 26px; }
  td.svc.rep a { color: var(--mid); }
  .repn { color: var(--faint); margin-left: 7px; }
  td.state { color: var(--mid); white-space: nowrap; }
  .snap { white-space: nowrap; text-align: right; width: 1%; padding-right: 18px; }
  td.snap { color: var(--hi); font: 12px/1 var(--mono); font-variant-numeric: tabular-nums; }
  th.snap { text-align: right; }
  td.statusc { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td.ports { color: var(--faint); font-size: 12px; white-space: nowrap;
    max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .cacts { display: flex; gap: 6px; justify-content: flex-end; }
  .racts { display: flex; gap: 2px; justify-content: flex-end; align-items: center; }
  .ibtn { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; background: transparent;
    border: 1px solid transparent; color: var(--mid); cursor: pointer; }
  .ibtn loom-icon { color: var(--mid); }
  .ibtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ibtn:hover loom-icon { color: var(--hi); }
  .ibtn:disabled { opacity: .25; cursor: not-allowed; }
  .ibtn:disabled:hover { border-color: transparent; background: transparent; }
  .ibtn .bdot { font: 12px/1 var(--mono); color: var(--mid); }
  .rmore { position: relative; display: flex; }
  .kbtn { width: 30px; height: 30px; padding: 0; background: transparent; border: 1px solid transparent;
    color: var(--mid); cursor: pointer; font: 700 14px/1 var(--mono); letter-spacing: -.05em; }
  .kbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .rmore .menu { right: 0; top: calc(100% + 4px); min-width: 140px; }

  .blk { margin-top: 22px; }
  .blk .label { display: block; font: 600 10px/1 var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--dim); margin-bottom: 8px; }
  .err { color: var(--bad); font: 12px/1.5 var(--mono); margin: 14px 0; }

  .toast {
    position: fixed; right: 22px; bottom: 22px; z-index: 60;
    background: var(--raised); border: 1px solid var(--line2); color: var(--hi);
    font: 500 12px/1.4 var(--mono); padding: 11px 15px; max-width: 420px;
    animation: fade .15s ease both;
  }
  .toast.bad { border-color: var(--bad); color: var(--bad); }
  .toast.warn { border-color: var(--warn); color: var(--warn); }

  /* advanced redeploy dialog */
  .rdmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  .rdbox { width: 480px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); border-top: 2px solid var(--warn);
    display: flex; flex-direction: column; max-height: calc(100vh - 40px); }
  .rdhead { display: flex; align-items: center; gap: 10px; padding: 15px 18px 0; }
  .rdhead .rdt { font: 600 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--warn); }
  .rdhead .grow { flex: 1; }
  .rdx { display: inline-grid; place-items: center; width: 28px; height: 28px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .rdx:hover { color: var(--hi); }
  .rdmsg { margin: 0; padding: 12px 18px 14px; font: 13px/1.6 var(--sans); color: var(--hi); }
  .rdbody { overflow: auto; border-top: 1px solid var(--line); }
  .rdrow { display: flex; align-items: center; gap: 10px; padding: 11px 18px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .rdrow:last-child { border-bottom: none; }
  .rdrow:hover { background: var(--raised); }
  .rdrow.off { opacity: .5; }
  .rdrow .rdname { font: 500 13px/1 var(--mono); color: var(--hi); }
  .rdrow .grow { flex: 1; }
  .rdrow .rdpods { font: 11px/1 var(--mono); color: var(--dim); }
  .rdopts { display: flex; align-items: center; gap: 22px; padding: 10px 18px; border-top: 1px solid var(--line2);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .rdopts .ck { width: 14px; height: 14px; }
  .rdacts { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .rdacts .rdnote { font: 11px/1 var(--mono); color: var(--dim); }
  .rdacts .grow { flex: 1; }
  .tbtn.warnbtn { color: #06080d; border-color: var(--warn); background: color-mix(in srgb, var(--warn) 85%, #000); }
  .tbtn.warnbtn:hover { background: var(--warn); }
  .tbtn.warnbtn:disabled { opacity: .4; cursor: not-allowed; }
  .tbtn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .tbtn.danger:hover { color: #fff; background: var(--bad); border-color: var(--bad); }
  .tbtn.danger:disabled { opacity: .4; cursor: not-allowed; color: var(--bad); background: transparent; }
  .tbtn.updbtn { color: #06080d; border-color: var(--upd); background: color-mix(in srgb, var(--upd) 85%, #000); }
  .tbtn.updbtn:hover { background: var(--upd); }
  .tbtn.updbtn:disabled { opacity: .4; cursor: not-allowed; }
  .loosetag { font: 600 10px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim);
    padding: 4px 8px; border: 1px solid var(--line); border-radius: 5px; }
  .rmtoggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap;
    font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim); user-select: none; }
  .rmtoggle:hover { color: var(--hi); }
  .rmtoggle .ck.on { background: var(--bad); border-color: var(--bad); }
  .rdtoggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap;
    font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim); user-select: none; }
  .rdtoggle:hover { color: var(--hi); }
  .rdtoggle .ck.on { background: var(--warn); border-color: var(--warn); }
  .ck { display: inline-block; width: 15px; height: 15px; flex: none; border: 1px solid var(--line2); }
  .ck.on { background: var(--ok); border-color: var(--ok); box-shadow: inset 0 0 0 3px var(--panel); }

  @media (max-width: 720px) { td.ports, th.ports { display: none; } }
`)
export class StackPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(PromptService) accessor prompt!: PromptService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor project = "";
  @reactive accessor stack: StackSummary | null = null;
  @reactive accessor tunnelRoutes: TunnelView[] = [];
  @reactive accessor tunnelConnectors: ConnectorView[] = [];
  @reactive accessor tunnelZones: ZoneView[] = [];
  @reactive accessor tunnelsOn = false;
  @reactive accessor error = "";
  @reactive accessor busy = "";
  @reactive accessor opLog = "";
  @reactive accessor composeText = "";
  @reactive accessor expanded: Record<string, boolean> = {};
  @reactive accessor logsTitle = "";
  @reactive accessor logsLines: string[] = [];
  @reactive accessor wrap = false;
  @reactive accessor toast = "";
  @reactive accessor toastKind = "";
  @reactive accessor stats: Record<string, ContainerStat> = {};
  @reactive accessor statsBusy = false;
  @reactive accessor host = ""; // active host id (shown in the crumb for multi-host)
  @reactive accessor updates: Record<string, ImageUpdate> = {};
  @reactive accessor updatesBusy = false;
  @reactive accessor menuOpen = false;
  @reactive accessor openRow = ""; // container id (or "grp:<service>") whose action menu is open
  @reactive accessor openChip = ""; // service whose public-routes menu is open
  @reactive accessor rdOpen = false; // advanced redeploy dialog
  @reactive accessor rdExcluded: string[] = []; // services excluded from the redeploy
  @reactive accessor rdPull = true; // "pull latest" toggle (default on)
  @reactive accessor rdForce = false; // "force recreate" toggle (default off)
  @reactive accessor stopOpen = false; // stop/remove picker dialog
  @reactive accessor stopExcluded: string[] = []; // services excluded from the stop
  @reactive accessor stopRemove = false; // "also remove" toggle in the stop dialog
  @reactive accessor pullOpen = false; // pull-images picker dialog
  @reactive accessor pullExcluded: string[] = []; // services excluded from the pull

  // The "(ungrouped)" project isn't a real compose stack — it's free-floating
  // containers, so compose-level actions (redeploy/pull/compose file) don't apply.
  get isUngrouped() {
    return this.project === "(ungrouped)";
  }
  private logsCtrl: AbortController | null = null;
  private opCtrl?: AbortController;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private showToast(msg: string, kind = "", sticky = false) {
    this.toast = msg;
    this.toastKind = kind;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (!sticky) this.toastTimer = setTimeout(() => (this.toast = ""), 2800);
  }

  // Route param bound reactively; watching it reloads on any change, including
  // stack -> stack navigation (the outlet re-injects params without remounting).
  @prop({ param: "project" }) accessor routeProject = "";

  @mount
  onMount() {
    if (this.routeProject) this.enter(this.routeProject);
    addEventListener("click", this.closeMenu);
    this.loadActiveHost();
  }

  // True when arrived from the cross-fleet overview, so "back" labels match.
  get fleetBack() {
    return localStorage.getItem("hope.fleet") === "1";
  }

  // Which host this stack lives on, so the crumb shows it in multi-host setups.
  private async loadActiveHost() {
    try {
      const hosts = await this.rpc.call<{ id: string; active: boolean }[]>("System", "hosts", []);
      this.host = (hosts || []).find((h) => h.active)?.id || "";
    } catch {
      this.host = "";
    }
  }

  private closeMenu = () => {
    this.menuOpen = false;
    this.openRow = "";
    this.openChip = "";
  };

  // Common actions stay visible as icons; only kill hides in the kebab menu.
  private rowActions(c: ContainerSummary) {
    const open = this.openRow === c.id;
    const ico = (op: ContainerOp, icon: string, danger = false) => (
      <button class={"ibtn" + (danger ? " danger" : "")} title={op} disabled={!!this.busy || !actionEnabled(c.state, op)}
        onClick={(e: Event) => { e.stopPropagation(); this.containerOp(c.id, op, c.service || c.name); }}>
        {this.busy === `${c.id}:${op}` ? <span class="bdot">…</span> : <loom-icon name={icon} size={14}></loom-icon>}
      </button>
    );
    return (
      <div class="racts">
        <button class="ibtn" title="logs" onClick={(e: Event) => { e.stopPropagation(); this.openLogs("logs", [c.id], c.service || c.name); }}><loom-icon name="terminal" size={14}></loom-icon></button>
        {ico("start", "play")}
        {ico("restart", "rotate")}
        <div class="rmore">
          <button class="kbtn" aria-label="more" onClick={(e: Event) => { e.stopPropagation(); this.openRow = open ? "" : c.id; }}>···</button>
          {open ? (
            <div class="menu">
              {this.tunnelsOn ? (
                <button class="mitem" onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.addTunnel(c.service || c.name, c.ports || []); }}><loom-icon name="link" size={13}></loom-icon><span>add tunnel</span></button>
              ) : null}
              <button class="mitem" disabled={!!this.busy}
                onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.containerOp(c.id, "pull", c.service || c.name); }}><loom-icon name="download" size={13}></loom-icon><span>pull</span></button>
              <button class="mitem" disabled={!!this.busy}
                onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.containerOp(c.id, "redeploy", c.service || c.name); }}><loom-icon name="redeploy" size={13}></loom-icon><span>redeploy</span></button>
              <button class="mitem danger" disabled={!!this.busy || !actionEnabled(c.state, "stop")}
                onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.containerOp(c.id, "stop", c.service || c.name); }}><loom-icon name="stop" size={13}></loom-icon><span>stop</span></button>
              <button class="mitem danger" disabled={!!this.busy || !actionEnabled(c.state, "kill")}
                onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.containerOp(c.id, "kill", c.service || c.name); }}><loom-icon name="x" size={13}></loom-icon><span>kill</span></button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  private groupActions(project: string, g: Group) {
    const open = this.openRow === "grp:" + g.service;
    const ico = (op: ContainerOp, icon: string, danger = false) => (
      <button class={"ibtn" + (danger ? " danger" : "")} title={op} disabled={!!this.busy || !groupActionEnabled(g.items, op)}
        onClick={(e: Event) => { e.stopPropagation(); this.groupOp(g, op, e); }}>
        {this.busy === `grp:${g.service}:${op}` ? <span class="bdot">…</span> : <loom-icon name={icon} size={14}></loom-icon>}
      </button>
    );
    return (
      <div class="racts">
        <button class="ibtn" title="logs" onClick={(e: Event) => { e.stopPropagation(); this.openLogs("serviceLogs", [project, g.service], `${project}/${g.service}`); }}><loom-icon name="terminal" size={14}></loom-icon></button>
        {ico("start", "play")}
        {ico("restart", "rotate")}
        <div class="rmore">
          <button class="kbtn" aria-label="more" onClick={(e: Event) => { e.stopPropagation(); this.openRow = open ? "" : "grp:" + g.service; }}>···</button>
          {open ? (
            <div class="menu">
              {this.tunnelsOn ? (
                <button class="mitem" onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.addTunnel(g.service, g.items[0]?.ports || []); }}><loom-icon name="link" size={13}></loom-icon><span>add tunnel</span></button>
              ) : null}
              <button class="mitem danger" disabled={!!this.busy || !groupActionEnabled(g.items, "stop")}
                onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.groupOp(g, "stop"); }}><loom-icon name="stop" size={13}></loom-icon><span>stop all</span></button>
              <button class="mitem danger" disabled={!!this.busy || !groupActionEnabled(g.items, "kill")}
                onClick={(e: Event) => { e.stopPropagation(); this.openRow = ""; this.groupOp(g, "kill"); }}><loom-icon name="x" size={13}></loom-icon><span>kill all</span></button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  @watch("routeProject")
  private onProject() {
    if (this.routeProject) this.enter(this.routeProject);
  }

  // Refresh the CPU/MEM snapshot periodically while the stack page is open.
  @interval(10000)
  private tickStats() {
    if (this.stack && !this.statsBusy) this.snapshot();
  }

  // Refresh container states (cheap) so transitions show without a reload.
  @interval(5000)
  private tickList() {
    if (this.stack) this.refreshList();
  }

  private async refreshList() {
    try {
      const all = await this.rpc.call<StackSummary[]>("Stacks", "list", []);
      this.stack = all.find((s) => s.project === this.project) ?? this.stack;
    } catch {
      /* keep last good state */
    }
  }

  private enter(project: string) {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    if (project === this.project) return; // already on this stack (mount + watch both fire)
    this.project = project;
    this.stack = null;
    this.stats = {};
    this.updates = {};
    this.closeLogs();
    this.expanded = {};
    this.opLog = "";
    this.composeText = "";
    this.load();
  }

  private async load() {
    try {
      const all = await this.rpc.call<StackSummary[]>("Stacks", "list", []);
      this.stack = all.find((s) => s.project === this.project) ?? null;
      this.error = this.stack ? "" : `Stack "${this.project}" not found.`;
      if (this.stack) {
        this.snapshot(); // auto-fill the CPU/MEM columns
        this.loadUpdates(); // surface cached image-freshness chips immediately
        this.loadTunnels(); // public-route chips (if cloudflare is on)
      }
    } catch (err: any) {
      this.error = err?.message ?? "Failed to load.";
    }
  }

  // Best-effort tunnel data so service rows can show their public hostname +
  // offer "add tunnel". Silently no-ops when the cloudflare integration is off.
  private async loadTunnels() {
    try {
      const [routes, connectors, zones] = await Promise.all([
        this.rpc.call<TunnelView[]>("Tunnels", "tunnels", []),
        this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
        this.rpc.call<ZoneView[]>("Tunnels", "zones", []).catch(() => []),
      ]);
      this.tunnelRoutes = routes || [];
      this.tunnelConnectors = connectors || [];
      this.tunnelZones = zones || [];
      this.tunnelsOn = true;
    } catch {
      this.tunnelsOn = false; // disabled or unreachable — hide tunnel UI
    }
  }

  // Routes whose origin resolves to this stack's service.
  private routesForService(service: string): TunnelView[] {
    return this.tunnelRoutes.filter((t) => t.project === this.project && t.svc_name === service);
  }

  private tunnelChip(service: string) {
    if (!this.tunnelsOn) return null;
    const routes = this.routesForService(service);
    if (!routes.length) return null;
    const first = routes[0];
    const open = this.openChip === service;
    return (
      <span class="tchipwrap">
        <button
          class="tchip"
          title="public routes"
          onClick={(e: Event) => { e.stopPropagation(); this.openChip = open ? "" : service; }}
        >
          <loom-icon name="link" size={11}></loom-icon>{first.hostname}{routes.length > 1 ? <b> +{routes.length - 1}</b> : null}
        </button>
        {open ? (
          <div class="tmenu" onClick={(e: Event) => e.stopPropagation()}>
            {routes.map((r) => (
              <a class="tmitem" href={`https://${r.hostname}`} target="_blank" rel="noreferrer">
                <loom-icon name="link" size={11}></loom-icon>{r.hostname}{r.path ? <span class="pth">{r.path}</span> : null}
              </a>
            ))}
          </div>
        ) : null}
      </span>
    );
  }

  // Add a public route for a service in this stack (target is implied).
  private addTunnel = async (service: string, ports: string[]) => {
    if (!this.tunnelConnectors.length) {
      this.showToast("no connectors — deploy one on the Tunnels page", "bad");
      return;
    }
    const haveZones = this.tunnelZones.length > 0;
    const def = this.tunnelConnectors.find((c) => c.default) || this.tunnelConnectors[0];
    const port = ports.map(innerPort).find(Boolean) || "";
    const fields: PromptField[] = [
      { key: "connector", label: "connector", type: "select", value: def.id, options: this.tunnelConnectors.map((c) => ({ value: c.id, label: (c.title || c.name) + (c.default ? " (shared)" : "") })) },
      { key: "port", label: "port", placeholder: "8080", value: port },
      ...(haveZones
        ? ([
            { key: "sub", label: "subdomain (blank = root domain)", optional: true, placeholder: service },
            { key: "domain", label: "domain", type: "select", placeholder: "pick a domain", options: this.tunnelZones.map((z) => ({ value: z.name, label: z.name })) },
          ] as const)
        : ([{ key: "host_name", label: "hostname", placeholder: "app.example.com" }] as const)),
      { key: "path", label: "path (optional)", optional: true, placeholder: "/api" },
    ];
    const v = await this.prompt.ask({ title: `add tunnel · ${service}`, icon: "link", submitLabel: "Add route", fields });
    if (!v) return;
    const host = (haveZones ? (v.sub.trim() ? `${v.sub.trim()}.${v.domain}` : v.domain) : v.host_name).trim().toLowerCase();
    if (!host) return;
    await this.proc.run(`add tunnel ${host}`, async (emit) => {
      try {
        emit("attaching connector + updating ingress + DNS…");
        const res = await this.rpc.call<OpResult>("Tunnels", "addTunnel", [host, v.port.trim(), v.connector, this.project, service, "", (v.path || "").trim()]);
        if (res && res.ok === false) {
          emit("failed: " + (res.error || "error"));
          return false;
        }
        emit(`route live -> https://${host}`);
        return true;
      } catch (e: any) {
        emit("failed: " + (e?.message ?? "error"));
        return false;
      }
    });
    this.loadTunnels();
  };

  // Pull the cached cluster freshness (cheap) and keep this project's rows.
  private async loadUpdates() {
    try {
      const res = await this.rpc.call<UpdatesResult>("System", "updates", []);
      const map: Record<string, ImageUpdate> = {};
      for (const u of res.updates) {
        if (u.project === this.project) map[u.id] = { id: u.id, image: u.image, status: u.status, detail: u.detail };
      }
      this.updates = map;
    } catch {
      /* updates are optional */
    }
  }

  private outdatedCount(): number {
    return Object.values(this.updates).filter((u) => u.status === "outdated").length;
  }

  // The "update" chip — click it to open the redeploy (update) confirm modal.
  private updChip(c: ContainerSummary) {
    if (this.updates[c.id]?.status !== "outdated") return null;
    return (
      <button
        class="upd"
        title={this.updates[c.id]?.detail || "update available — redeploy to the latest image"}
        onClick={(e: Event) => { e.stopPropagation(); this.containerOp(c.id, "redeploy", c.service || c.name); }}
      >
        update
      </button>
    );
  }

  private stackOp = async (op: StackOp) => {
    if (op === "redeploy") {
      this.rdExcluded = [];
      this.rdPull = true;
      this.rdForce = false;
      this.rdOpen = true;
      return;
    }
    if (op === "stop") {
      const ok = await this.confirm.ask({
        title: "stop",
        danger: true,
        confirmLabel: "Stop stack",
        message: `Stop the entire "${this.project}" stack — all ${this.stack?.total ?? ""} containers?`,
      });
      if (!ok) return;
    }
    this.runStackOp(op);
  };

  // Toggle a whole service in/out of the redeploy.
  private rdToggle = (service: string) => {
    this.rdExcluded = this.rdExcluded.includes(service) ? this.rdExcluded.filter((s) => s !== service) : [...this.rdExcluded, service];
  };

  private rdRun = () => {
    if (!this.stack) return;
    const svcName = (c: ContainerSummary) => c.service || c.name;
    const include = this.stack.containers.filter((c) => !this.rdExcluded.includes(svcName(c)));
    this.rdOpen = false;
    if (!include.length) return;
    // Whole stack -> one efficient stack stream; a subset -> per-container.
    if (include.length === this.stack.containers.length) {
      this.runRedeploy("redeployStack", [this.project], this.project, "stack:redeploy", this.rdPull, this.rdForce);
    } else {
      this.runRedeployList(include.map((c) => c.id), this.project, this.rdPull, this.rdForce);
    }
  };

  // Redeploy a specific set of containers, streaming each into the dialog.
  private runRedeployList = async (ids: string[], label: string, pull = true, force = false) => {
    this.busy = "stack:redeploy";
    try {
      await this.proc.run(`redeploy ${label}`, async (emit, signal) => {
        let ok = true;
        for (const id of ids) {
          if (!(await this.pipeOp(emit, signal, "redeploy", [id, String(pull), String(force)]))) ok = false;
        }
        emit("done");
        return ok;
      });
      await this.load();
    } finally {
      this.busy = "";
    }
  };

  // Redeploy with live output streamed into the shared processing dialog.
  private runRedeploy = async (method: "redeploy" | "redeployStack", args: string[], label: string, busyKey: string, pull = true, force = true) => {
    this.busy = busyKey;
    try {
      await this.proc.run(`redeploy ${label}`, async (emit, signal) => {
        const ok = await this.pipeOp(emit, signal, method, [...args, String(pull), String(force)]);
        emit("done");
        return ok;
      });
      await this.load();
    } finally {
      this.busy = "";
    }
  };

  private runStackOp = async (op: StackOp) => {
    this.busy = `stack:${op}`;
    this.opLog = "";
    this.showToast(`${op} ${this.project}…`, "", true);
    try {
      const res = await this.rpc.call<OpResult>("Stacks", op, [this.project]);
      this.opLog = (res.output ?? "") + (res.error ? "\n" + res.error : "");
      this.showToast(res.ok ? `${op} ${this.project} — done` : `${op} ${this.project} — failed`, res.ok ? "" : "bad");
      await this.load();
    } catch (err: any) {
      this.showToast(`${op} ${this.project} — ${err?.message ?? "failed"}`, "bad");
    } finally {
      this.busy = "";
    }
  };

  private containerOp = async (id: string, op: ContainerOp, label: string) => {
    if (op === "stop" || op === "kill" || op === "redeploy") {
      const ok = await this.confirm.ask({
        title: op,
        danger: op !== "redeploy",
        warn: op === "redeploy",
        confirmLabel: op === "kill" ? "Kill" : op === "stop" ? "Stop" : "Redeploy",
        message:
          op === "redeploy"
            ? `Redeploy "${label}"? Pulls the latest image and recreates the container.`
            : `${op === "kill" ? "Kill" : "Stop"} "${label}"?`,
      });
      if (!ok) return;
    }
    if (op === "redeploy") {
      this.runRedeploy("redeploy", [id], label, `${id}:redeploy`);
      return;
    }
    this.runContainerOp(id, op, label);
  };

  private runContainerOp = (id: string, op: ContainerOp, label: string) => this.runContainerOps([id], op, label, `${id}:${op}`);

  // Universal op runner: every container/group action streams into the shared
  // processing dialog. pull rides the NDJSON Stream/pull (live registry output);
  // the rest are one RPC per id, each reporting its own line.
  private runContainerOps = async (ids: string[], op: ContainerOp, label: string, busyKey: string) => {
    if (!ids.length) return;
    this.busy = busyKey;
    try {
      await this.proc.run(`${op} ${label}`, async (emit, signal) => {
        let ok = true;
        if (op === "pull") {
          ok = await this.pipeOp(emit, signal, "pull", ids);
        } else {
          for (const id of ids) {
            try {
              await this.rpc.call<OpResult>("Containers", op, [id]);
              emit(`${op} ${id.slice(0, 12)} — ok`);
            } catch (e: any) {
              ok = false;
              emit(`${op} ${id.slice(0, 12)} — ${e?.message ?? "failed"}`);
            }
          }
        }
        emit("done");
        return ok;
      });
      await this.load();
    } finally {
      this.busy = "";
    }
  };

  // Run a Stream op, tolerating a mid-stream drop. A hope/agent self-update tears
  // down the very connection streaming progress, so a drop there means "the host
  // is restarting", not a failure — poll until it's back instead of crying EOF.
  private pipeOp = async (emit: (l: string) => void, signal: AbortSignal, method: string, args: string[]): Promise<boolean> => {
    try {
      let ok = true;
      for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", method, args, signal)) {
        if (f.type === "log" && f.data) emit(f.data);
        else if (f.type === "done" && !f.ok) {
          ok = false;
          emit("failed: " + (f.error ?? ""));
        }
      }
      return ok;
    } catch (e: any) {
      if (signal.aborted) throw e;
      emit("connection lost — the host is restarting itself (self-update). reconnecting…");
      await this.waitForReconnect(emit, signal);
      return true;
    }
  };

  // Poll a cheap endpoint until the host answers again (after a self-update).
  private waitForReconnect = async (emit: (l: string) => void, signal: AbortSignal) => {
    for (let i = 0; i < 90 && !signal.aborted; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await this.rpc.call("System", "hosts", []);
        emit("reconnected");
        return;
      } catch {
        /* still down */
      }
    }
    emit("still unreachable — check the host");
  };

  // groups collapses replicas of the same compose service into one entry,
  // preserving first-seen order.
  private groups(s: StackSummary): Group[] {
    const order: string[] = [];
    const map: Record<string, ContainerSummary[]> = {};
    for (const c of s.containers) {
      const k = c.service || c.name;
      if (!map[k]) {
        map[k] = [];
        order.push(k);
      }
      map[k].push(c);
    }
    return order.map((service) => ({ service, items: map[service] }));
  }

  private groupOp = async (g: Group, op: ContainerOp, e?: Event) => {
    e?.stopPropagation();
    if (op === "stop" || op === "kill") {
      const ok = await this.confirm.ask({
        title: op,
        danger: true,
        confirmLabel: op === "kill" ? "Kill all" : "Stop all",
        message: `${op === "kill" ? "Kill" : "Stop"} all ${g.items.length} "${g.service}" replicas?`,
      });
      if (!ok) return;
    }
    this.runGroupOp(g, op);
  };

  private runGroupOp = (g: Group, op: ContainerOp) => this.runContainerOps(g.items.map((c) => c.id), op, g.service, `grp:${g.service}:${op}`);

  private toggle = (service: string) => {
    this.expanded = { ...this.expanded, [service]: !this.expanded[service] };
  };

  private viewCompose = async () => {
    try {
      const res = await this.rpc.call<ComposeFileResult>("Stacks", "composeFile", [this.project]);
      this.composeText = res.content;
    } catch (err: any) {
      this.composeText = err?.message ?? "Compose file unavailable.";
    }
  };

  @unmount
  onUnmount() {
    this.logsCtrl?.abort();
    this.opCtrl?.abort();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    removeEventListener("click", this.closeMenu);
  }

  private openLogs = (method: "logs" | "stackLogs" | "serviceLogs", args: string[], title: string, e?: Event) => {
    e?.stopPropagation();
    this.logsCtrl?.abort();
    this.logsCtrl = new AbortController();
    this.logsTitle = title;
    this.logsLines = [];
    this.streamLogs(method, args, this.logsCtrl.signal);
  };

  private async streamLogs(method: string, args: string[], signal: AbortSignal) {
    try {
      for await (const f of this.rpc.streamWithSignal<LogFrame>("Stream", method, args, signal)) {
        const line = (f.source ? `${f.source}  ` : "") + stripAnsi(f.data).replace(/\n$/, "");
        const next = this.logsLines.concat(line);
        this.logsLines = next.length > 800 ? next.slice(next.length - 800) : next;
        this.scrollBottom();
      }
    } catch (err: any) {
      if (!signal.aborted) this.logsLines = this.logsLines.concat(`stream error: ${err?.message ?? err}`);
    }
  }

  private closeLogs = () => {
    this.logsCtrl?.abort();
    this.logsCtrl = null;
    this.logsTitle = "";
    this.logsLines = [];
  };

  // scrollBottom keeps the log tail pinned to the latest line. Skips if the
  // user has scrolled up to read history.
  private scrollBottom() {
    requestAnimationFrame(() => {
      const el = this.shadowRoot?.querySelector(".logsbody") as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  private openContainer(id: string) {
    this.router.navigate(`/container/${encodeURIComponent(id)}`);
  }

  // Point-in-time CPU/memory snapshot of the stack's running containers.
  private snapshot = async () => {
    this.statsBusy = true;
    try {
      const rows = (await this.rpc.call<ContainerStat[]>("Stacks", "stats", [this.project])) || [];
      const map: Record<string, ContainerStat> = {};
      for (const s of rows) map[s.id] = s;
      this.stats = map;
    } catch (err: any) {
      this.showToast(`snapshot — ${err?.message ?? "failed"}`, "bad");
    } finally {
      this.statsBusy = false;
    }
  };

  // Check each container's image against its registry (network — manual).
  private checkUpdates = async () => {
    this.menuOpen = false;
    this.updatesBusy = true;
    this.showToast(`checking ${this.project} for image updates…`, "", true);
    try {
      const rows = (await this.rpc.call<ImageUpdate[]>("Stacks", "updates", [this.project])) || [];
      const map: Record<string, ImageUpdate> = {};
      for (const u of rows) map[u.id] = u;
      this.updates = map;
      const out = rows.filter((u) => u.status === "outdated").length;
      this.showToast(out ? `${out} container(s) out of date` : `all images up to date`, out ? "warn" : "");
    } catch (err: any) {
      this.showToast(`updates — ${err?.message ?? "failed"}`, "bad");
    } finally {
      this.updatesBusy = false;
    }
  };

  // Worst update status across a replica group (outdated wins).
  private groupUpdate(items: ContainerSummary[]): string {
    let any = false;
    for (const c of items) {
      const u = this.updates[c.id];
      if (u?.status === "outdated") return "outdated";
      if (u) any = true;
    }
    return any ? "current" : "";
  }

  private cpuCell(id: string) {
    const s = this.stats[id];
    return s ? s.cpu_percent.toFixed(1) + "%" : "—";
  }
  private memCell(id: string) {
    const s = this.stats[id];
    return s ? mb(s.mem_used) : "—";
  }
  // Aggregate a replica group's snapshot (sum cpu, sum mem).
  private groupStat(items: ContainerSummary[]) {
    const have = items.map((c) => this.stats[c.id]).filter(Boolean) as ContainerStat[];
    if (!have.length) return { cpu: "—", mem: "—" };
    return {
      cpu: have.reduce((a, s) => a + s.cpu_percent, 0).toFixed(1) + "%",
      mem: mb(have.reduce((a, s) => a + s.mem_used, 0)),
    };
  }

  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  update() {
    const s = this.stack;
    const grp = s ? this.groups(s) : [];
    const restarting = s ? s.containers.filter((c) => c.state === "restarting").length : 0;
    const stopped = s ? s.total - s.running - restarting : 0;
    const sev = s ? stackSeverity(s.running, s.total, s.restarting) : "ok";
    return (
      <div>
        <div class="bar">
          <div class="s"><loom-link to="/" class="back">‹ {this.fleetBack ? "all hosts" : "fleet"}</loom-link></div>
          {this.host && this.host !== "local" ? (
            <div class="s"><span class="hostcrumb">{this.host}</span></div>
          ) : null}
          <div class="s"><span class="crumb">{this.project}</span></div>
                    <hope-nav></hope-nav>
          <div class="grow"></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="err">{this.error}</div> : null}
          {s ? (
            <div>
              <div class="shead">
                <div class="row1">
                  <div class="ttl">
                    <span class={"mark " + sev}></span>
                    <h1>{this.isUngrouped ? "ungrouped" : s.project}</h1>
                    {this.isUngrouped ? <span class="loosetag" title="free-floating containers, not a compose stack">loose</span> : null}
                  </div>
                  <div class="toolbar">
                    {this.isUngrouped ? (
                      <button class="tbtn danger" disabled={!!this.busy} onClick={() => { this.stopExcluded = []; this.stopRemove = false; this.stopOpen = true; }}>stop…</button>
                    ) : (
                      <>
                        <button class="tbtn" onClick={(e: Event) => this.openLogs("stackLogs", [s.project], `${s.project} · all logs`, e)}>logs</button>
                        <button class="tbtn" disabled={!!this.busy} onClick={() => this.stackOp("restart")}>{this.busy === "stack:restart" ? "restart…" : "restart"}</button>
                        <button class="tbtn" disabled={!!this.busy} onClick={() => this.stackOp("redeploy")}>{this.busy === "stack:redeploy" ? "redeploy…" : "redeploy"}</button>
                        <div class="more">
                          <button class="tbtn" aria-label="more" onClick={(e: Event) => { e.stopPropagation(); this.menuOpen = !this.menuOpen; }}>···</button>
                          {this.menuOpen ? (
                            <div class="menu">
                              <button class="mitem" disabled={this.updatesBusy} onClick={this.checkUpdates}><loom-icon name="search" size={13}></loom-icon><span>{this.updatesBusy ? "checking…" : "check updates"}</span></button>
                              <button class="mitem" disabled={!!this.busy} onClick={() => this.stackOp("start")}><loom-icon name="play" size={13}></loom-icon><span>start stack</span></button>
                              <button class="mitem" disabled={!!this.busy} onClick={() => { this.menuOpen = false; this.pullExcluded = []; this.pullOpen = true; }}><loom-icon name="download" size={13}></loom-icon><span>pull images</span></button>
                              <button class="mitem danger" disabled={!!this.busy} onClick={() => { this.menuOpen = false; this.stopExcluded = []; this.stopRemove = false; this.stopOpen = true; }}><loom-icon name="stop" size={13}></loom-icon><span>stop…</span></button>
                              {s.compose_available ? <button class="mitem" onClick={this.viewCompose}><loom-icon name="file" size={13}></loom-icon><span>compose file</span></button> : null}
                            </div>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <div class="summary">
                  <span class="stat"><i class="k">services</i><i class="v">{grp.length}</i></span>
                  <span class="stat"><i class="k">containers</i><i class="v">{s.running}<i class="t">/{s.total}</i></i></span>
                  {stopped > 0 ? <span class="stat"><i class="k">stopped</i><i class="v warnv">{stopped}</i></span> : null}
                  {restarting > 0 ? <span class="stat"><i class="k">restarting</i><i class="v badv">{restarting}</i></span> : null}
                  {this.outdatedCount() > 0 ? <span class="stat"><i class="k">updates</i><i class="v updv">{this.outdatedCount()}</i></span> : null}
                  <span class="wd">{s.working_dir || "—"}</span>
                </div>
              </div>

              {this.logsTitle ? (
                <div class="logs">
                  <div class="logshead">
                    <span class="label">{this.logsTitle}</span>
                    <div class="cacts">
                      <button class="btn" onClick={() => (this.wrap = !this.wrap)}>{this.wrap ? "no wrap" : "wrap"}</button>
                      <button class="btn" onClick={this.closeLogs}>close</button>
                    </div>
                  </div>
                  <pre class={"logsbody" + (this.wrap ? " wrap" : "")}>{this.logsLines.join("\n") || "Waiting for output…"}</pre>
                </div>
              ) : null}

              <table>
                <colgroup>
                  <col style="width:28%" />
                  <col style="width:9%" />
                  <col style="width:7%" />
                  <col style="width:7%" />
                  <col style="width:13%" />
                  <col style="width:20%" />
                  <col style="width:16%" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>State</th>
                    <th class="snap">CPU</th>
                    <th class="snap">MEM</th>
                    <th>Status</th>
                    <th class="ports">Ports</th>
                    <th style="text-align:right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {this.groups(s).flatMap((g) => {
                    if (g.items.length === 1) {
                      const c = g.items[0];
                      return [
                        <tr class="crow" onClick={() => this.openContainer(c.id)}>
                          <td class="svc">
                            <span class="cell">
                              <span class={"mark " + markClass(c.state)}></span>
                              <span class="link">{c.service || c.name}</span>
                              {this.updChip(c)}
                              {this.tunnelChip(c.service || c.name)}
                            </span>
                          </td>
                          <td class="state">{c.state}</td>
                          <td class="snap num">{this.cpuCell(c.id)}</td>
                          <td class="snap num">{this.memCell(c.id)}</td>
                          <td class="statusc">{c.status}</td>
                          <td class="ports">{(c.ports || []).join(", ") || "—"}</td>
                          <td onClick={(e: Event) => e.stopPropagation()}>{this.rowActions(c)}</td>
                        </tr>,
                      ];
                    }

                    const running = g.items.filter((c) => c.state === "running").length;
                    const open = !!this.expanded[g.service];
                    const gs = this.groupStat(g.items);
                    const rows = [
                      <tr class={"grp" + (open ? " open" : "")} onClick={() => this.toggle(g.service)} title={open ? "collapse replicas" : "expand replicas"}>
                        <td class="svc">
                          <span class="cell">
                            <loom-icon class="caret" name="chevron-right" size={14}></loom-icon>
                            <span class={"mark " + aggMark(g.items)}></span>
                            <span class="gname">{g.service}</span>
                            <span class="badge"><b>{g.items.length}</b> pods</span>
                            {this.groupUpdate(g.items) === "outdated" ? <span class="upd static" title="one or more replicas have an update available">update</span> : null}
                            {this.tunnelChip(g.service)}
                          </span>
                        </td>
                        <td class="state">{running}/{g.items.length} up</td>
                        <td class="snap num">{gs.cpu}</td>
                        <td class="snap num">{gs.mem}</td>
                        <td class="statusc"></td>
                        <td class="ports"></td>
                        <td onClick={(e: Event) => e.stopPropagation()}>{this.groupActions(s.project, g)}</td>
                      </tr>,
                    ];
                    if (open) {
                      for (const c of g.items) {
                        rows.push(
                          <tr class="rep crow" onClick={() => this.openContainer(c.id)}>
                            <td class="svc rep">
                              <span class="cell">
                                <span class={"mark " + markClass(c.state)}></span>
                                <span class="link">
                                  {c.service || c.name}
                                  <span class="repn">#{c.number || "—"}</span>
                                </span>
                                {this.updChip(c)}
                              </span>
                            </td>
                            <td class="state">{c.state}</td>
                            <td class="snap num">{this.cpuCell(c.id)}</td>
                            <td class="snap num">{this.memCell(c.id)}</td>
                            <td class="statusc">{c.status}</td>
                            <td class="ports">{(c.ports || []).join(", ") || "—"}</td>
                            <td onClick={(e: Event) => e.stopPropagation()}>{this.rowActions(c)}</td>
                          </tr>,
                        );
                      }
                    }
                    return rows;
                  })}
                </tbody>
              </table>

              {this.opLog ? (
                <div class="blk">
                  <span class="label">output</span>
                  <pre>{this.opLog}</pre>
                </div>
              ) : null}
              {this.composeText ? (
                <div class="blk">
                  <span class="label">compose</span>
                  <pre>{this.composeText}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </main>
        {this.toast ? <div class={"toast " + this.toastKind}>{this.toast}</div> : null}
        {this.rdOpen && s ? this.renderRedeploy(s) : null}
        {this.stopOpen && s ? this.renderStop(s) : null}
        {this.pullOpen && s ? this.renderPull(s) : null}
      </div>
    );
  }

  // Advanced redeploy: a checklist of services so you can skip some (e.g. a
  // database) instead of recreating the whole stack.
  private renderRedeploy(s: StackSummary) {
    const groups = this.groups(s);
    const included = groups.filter((g) => !this.rdExcluded.includes(g.service));
    const count = included.reduce((a, g) => a + g.items.length, 0);
    return (
      <div class="rdmodal" onClick={() => (this.rdOpen = false)}>
        <div class="rdbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="rdhead">
            <loom-icon name="redeploy" size={15} color="var(--warn)"></loom-icon>
            <span class="rdt">redeploy {s.project}</span>
            <span class="grow"></span>
            <button class="rdx" onClick={() => (this.rdOpen = false)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <p class="rdmsg">Recreates each checked service. Uncheck any to leave it as-is.</p>
          <div class="rdbody">
            {groups.map((g) => {
              const on = !this.rdExcluded.includes(g.service);
              return (
                <div class={"rdrow" + (on ? "" : " off")} onClick={() => this.rdToggle(g.service)}>
                  <span class={"ck" + (on ? " on" : "")}></span>
                  <span class={"mark " + aggMark(g.items)}></span>
                  <span class="rdname">{g.service}</span>
                  <span class="grow"></span>
                  {g.items.length > 1 ? <span class="rdpods">{g.items.length} pods</span> : null}
                  {this.groupUpdate(g.items) === "outdated" ? <span class="upd static">update</span> : null}
                </div>
              );
            })}
          </div>
          <div class="rdopts">
            <span class="rdtoggle" title="pull the newest image before recreating" onClick={() => (this.rdPull = !this.rdPull)}>
              <span class={"ck" + (this.rdPull ? " on" : "")}></span>
              <span>pull latest</span>
            </span>
            <span class="rdtoggle" title="recreate even containers already on the current image" onClick={() => (this.rdForce = !this.rdForce)}>
              <span class={"ck" + (this.rdForce ? " on" : "")}></span>
              <span>force recreate</span>
            </span>
          </div>
          <div class="rdacts">
            <span class="rdnote">{count} of {s.total}</span>
            <span class="grow"></span>
            <button class="tbtn" onClick={() => (this.rdOpen = false)}>cancel</button>
            <button class="tbtn warnbtn" disabled={count === 0} onClick={this.rdRun}>redeploy {count}</button>
          </div>
        </div>
      </div>
    );
  }

  private stopToggle = (service: string) => {
    this.stopExcluded = this.stopExcluded.includes(service) ? this.stopExcluded.filter((s) => s !== service) : [...this.stopExcluded, service];
  };

  // Stop (or stop-and-remove) the picked containers, one at a time, streaming
  // progress into the processing dialog. remove deletes the container too.
  private runStop = async (op: "stop" | "remove") => {
    const s = this.stack;
    if (!s) return;
    const svcName = (c: ContainerSummary) => c.service || c.name;
    const ids = s.containers.filter((c) => !this.stopExcluded.includes(svcName(c))).map((c) => c.id);
    if (!ids.length) return;
    if (op === "remove") {
      const ok = await this.confirm.ask({
        title: "stop & remove",
        danger: true,
        confirmLabel: `Remove ${ids.length}`,
        message: `Stop and permanently delete ${ids.length} container(s)? The containers are removed, not just stopped.`,
      });
      if (!ok) return;
    }
    this.stopOpen = false;
    const verb = op === "remove" ? "stop & remove" : "stop";
    await this.proc.run(`${verb} ${this.project}`, async (emit) => {
      let ok = 0;
      let fail = 0;
      for (const id of ids) {
        try {
          await this.rpc.call<OpResult>("Containers", op, [id]);
          ok++;
          emit(`${verb} ${id.slice(0, 12)} — ok`);
        } catch (e: any) {
          fail++;
          emit(`${verb} ${id.slice(0, 12)} — ${e?.message ?? "failed"}`);
        }
      }
      emit(`done — ${ok} ok${fail ? `, ${fail} failed` : ""}`);
      return fail === 0;
    });
    this.stopExcluded = [];
    await this.load();
  };

  // Stop picker: choose which containers to stop, with an option to remove them
  // outright. The default is everything checked (= "stop the whole stack").
  private renderStop(s: StackSummary) {
    const groups = this.groups(s);
    const count = groups.filter((g) => !this.stopExcluded.includes(g.service)).reduce((a, g) => a + g.items.length, 0);
    return (
      <div class="rdmodal" onClick={() => (this.stopOpen = false)}>
        <div class="rdbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="rdhead">
            <loom-icon name="stop" size={15} color="var(--bad)"></loom-icon>
            <span class="rdt">stop {s.project}</span>
            <span class="grow"></span>
            <button class="rdx" onClick={() => (this.stopOpen = false)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <p class="rdmsg">Pick what to stop. <b>Stop &amp; remove</b> also deletes the containers — use it to clean up loose ones.</p>
          <div class="rdbody">
            {groups.map((g) => {
              const on = !this.stopExcluded.includes(g.service);
              const up = g.items.filter((c) => c.state === "running" || c.state === "restarting").length;
              return (
                <div class={"rdrow" + (on ? "" : " off")} onClick={() => this.stopToggle(g.service)}>
                  <span class={"ck" + (on ? " on" : "")}></span>
                  <span class={"mark " + aggMark(g.items)}></span>
                  <span class="rdname">{g.service}</span>
                  <span class="grow"></span>
                  {g.items.length > 1 ? <span class="rdpods">{up}/{g.items.length} up</span> : null}
                </div>
              );
            })}
          </div>
          <div class="rdopts">
            <span class="rmtoggle" title="stop and permanently delete the containers, not just stop them" onClick={() => (this.stopRemove = !this.stopRemove)}>
              <span class={"ck" + (this.stopRemove ? " on" : "")}></span>
              <span>also remove</span>
            </span>
          </div>
          <div class="rdacts">
            <span class="rdnote">{count} of {s.total}</span>
            <span class="grow"></span>
            <button class="tbtn" onClick={() => (this.stopOpen = false)}>cancel</button>
            <button class="tbtn danger" disabled={count === 0} onClick={() => this.runStop(this.stopRemove ? "remove" : "stop")}>
              {this.stopRemove ? "stop & remove" : "stop"} {count}
            </button>
          </div>
        </div>
      </div>
    );
  }

  private pullToggle = (service: string) => {
    this.pullExcluded = this.pullExcluded.includes(service) ? this.pullExcluded.filter((s) => s !== service) : [...this.pullExcluded, service];
  };

  // Pull the latest images for the picked containers, streaming progress into
  // the processing dialog. Does not recreate anything.
  private runPull = async () => {
    const s = this.stack;
    if (!s) return;
    const svcName = (c: ContainerSummary) => c.service || c.name;
    const ids = s.containers.filter((c) => !this.pullExcluded.includes(svcName(c))).map((c) => c.id);
    this.pullOpen = false;
    await this.runContainerOps(ids, "pull", this.project, "stack:pull");
  };

  // Pull picker: choose which services' images to pull. No recreate — just
  // freshen the local images.
  private renderPull(s: StackSummary) {
    const groups = this.groups(s);
    const count = groups.filter((g) => !this.pullExcluded.includes(g.service)).reduce((a, g) => a + g.items.length, 0);
    return (
      <div class="rdmodal" onClick={() => (this.pullOpen = false)}>
        <div class="rdbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="rdhead">
            <loom-icon name="download" size={15} color="var(--upd)"></loom-icon>
            <span class="rdt">pull {s.project}</span>
            <span class="grow"></span>
            <button class="rdx" onClick={() => (this.pullOpen = false)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <p class="rdmsg">Pulls the latest image for each checked service. Containers keep running — nothing is recreated.</p>
          <div class="rdbody">
            {groups.map((g) => {
              const on = !this.pullExcluded.includes(g.service);
              return (
                <div class={"rdrow" + (on ? "" : " off")} onClick={() => this.pullToggle(g.service)}>
                  <span class={"ck" + (on ? " on" : "")}></span>
                  <span class={"mark " + aggMark(g.items)}></span>
                  <span class="rdname">{g.service}</span>
                  <span class="grow"></span>
                  {this.groupUpdate(g.items) === "outdated" ? <span class="upd static">update</span> : null}
                </div>
              );
            })}
          </div>
          <div class="rdacts">
            <span class="rdnote">{count} of {s.total}</span>
            <span class="grow"></span>
            <button class="tbtn" onClick={() => (this.pullOpen = false)}>cancel</button>
            <button class="tbtn updbtn" disabled={count === 0} onClick={this.runPull}>pull {count}</button>
          </div>
        </div>
      </div>
    );
  }
}

// Human-readable bytes for the snapshot columns.
function mb(b: number): string {
  if (!b) return "0 MB";
  const gb = b / 1073741824;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 1) + " GB";
  const m = b / 1048576;
  return m.toFixed(m >= 10 ? 0 : 1) + " MB";
}
