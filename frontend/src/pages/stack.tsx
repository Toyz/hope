// Stack detail — control surface. One project's containers, stack lifecycle,
// and (when readable) the compose file. Terminal-instrument styling.
import { LoomElement, component, styles, css, reactive, prop, watch, mount, unmount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import type { StackSummary, ContainerSummary, ContainerOp, StackOp, OpResult, ComposeFileResult, LogFrame, ContainerStat, ImageUpdate } from "../contracts";
import { theme, markClass, stackSeverity } from "../styles";
import { stripAnsi } from "./container";

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
  .bar .crumb { font: 600 13px/1 var(--mono); letter-spacing: .04em; }
  .bar .grow { flex: 1; }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 24px 24px 64px; max-width: 1080px; margin: 0 auto; }

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
  .caret { display: inline-block; width: 11px; color: var(--mid); font-size: 11px;
    transition: transform .12s ease, color .12s ease; }
  tr.grp:hover .caret { color: var(--hi); }
  tr.grp.open .caret { transform: rotate(90deg); }
  .gname { color: var(--hi); font-weight: 500; }
  .badge { border: 1px solid var(--line2); color: var(--mid); font-size: 11px; padding: 2px 7px; white-space: nowrap; flex-shrink: 0; }
  .upd { font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 3px 6px;
    color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); white-space: nowrap; flex-shrink: 0; }
  tr.grp:hover .badge { border-color: var(--mid); color: var(--hi); }
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

  @media (max-width: 720px) { td.ports, th.ports { display: none; } }
`)
export class StackPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor project = "";
  @reactive accessor stack: StackSummary | null = null;
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
  @reactive accessor updates: Record<string, ImageUpdate> = {};
  @reactive accessor updatesBusy = false;
  @reactive accessor menuOpen = false;
  @reactive accessor openRow = ""; // container id (or "grp:<service>") whose action menu is open
  private logsCtrl: AbortController | null = null;
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
  }

  private closeMenu = () => {
    this.menuOpen = false;
    this.openRow = "";
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
      if (this.stack) this.snapshot(); // auto-fill the CPU/MEM columns
    } catch (err: any) {
      this.error = err?.message ?? "Failed to load.";
    }
  }

  private stackOp = async (op: StackOp) => {
    if (op === "stop" || op === "redeploy") {
      const ok = await this.confirm.ask({
        title: op,
        danger: op === "stop",
        warn: op === "redeploy",
        confirmLabel: op === "stop" ? "Stop stack" : "Redeploy",
        message:
          (op === "stop" ? "Stop" : "Redeploy (recreate)") +
          ` the entire "${this.project}" stack — all ${this.stack?.total ?? ""} containers?`,
      });
      if (!ok) return;
    }
    this.runStackOp(op);
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
    this.runContainerOp(id, op, label);
  };

  private runContainerOp = async (id: string, op: ContainerOp, label: string) => {
    this.busy = `${id}:${op}`;
    this.showToast(`${op} ${label}…`, "", true);
    try {
      await this.rpc.call<OpResult>("Containers", op, [id]);
      this.showToast(`${op} ${label} — done`);
      await this.load();
    } catch (err: any) {
      this.showToast(`${op} ${label} — ${err?.message ?? "failed"}`, "bad");
    } finally {
      this.busy = "";
    }
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

  private runGroupOp = async (g: Group, op: ContainerOp) => {
    this.busy = `grp:${g.service}:${op}`;
    this.showToast(`${op} ${g.service} (${g.items.length})…`, "", true);
    try {
      for (const c of g.items) await this.rpc.call<OpResult>("Containers", op, [c.id]);
      this.showToast(`${op} ${g.service} (${g.items.length}) — done`);
      await this.load();
    } catch (err: any) {
      this.showToast(`${op} ${g.service} — ${err?.message ?? "failed"}`, "bad");
    } finally {
      this.busy = "";
    }
  };

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
      const rows = await this.rpc.call<ContainerStat[]>("Stacks", "stats", [this.project]);
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
      const rows = await this.rpc.call<ImageUpdate[]>("Stacks", "updates", [this.project]);
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
          <div class="s"><loom-link to="/" class="back">‹ fleet</loom-link></div>
          <div class="s"><span class="crumb">{this.project}</span></div>
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
                    <h1>{s.project}</h1>
                  </div>
                  <div class="toolbar">
                    <button class="tbtn" onClick={(e: Event) => this.openLogs("stackLogs", [s.project], `${s.project} · all logs`, e)}>logs</button>
                    <button class="tbtn" disabled={!!this.busy} onClick={() => this.stackOp("restart")}>{this.busy === "stack:restart" ? "restart…" : "restart"}</button>
                    <button class="tbtn" disabled={!!this.busy} onClick={() => this.stackOp("redeploy")}>{this.busy === "stack:redeploy" ? "redeploy…" : "redeploy"}</button>
                    <div class="more">
                      <button class="tbtn" aria-label="more" onClick={(e: Event) => { e.stopPropagation(); this.menuOpen = !this.menuOpen; }}>···</button>
                      {this.menuOpen ? (
                        <div class="menu">
                          <button class="mitem" disabled={this.updatesBusy} onClick={this.checkUpdates}><loom-icon name="search" size={13}></loom-icon><span>{this.updatesBusy ? "checking…" : "check updates"}</span></button>
                          <button class="mitem" disabled={!!this.busy} onClick={() => this.stackOp("start")}><loom-icon name="play" size={13}></loom-icon><span>start stack</span></button>
                          <button class="mitem" disabled={!!this.busy} onClick={() => this.stackOp("pull")}><loom-icon name="download" size={13}></loom-icon><span>pull images</span></button>
                          <button class="mitem danger" disabled={!!this.busy} onClick={() => this.stackOp("stop")}><loom-icon name="stop" size={13}></loom-icon><span>stop stack</span></button>
                          {s.compose_available ? <button class="mitem" onClick={this.viewCompose}><loom-icon name="file" size={13}></loom-icon><span>compose file</span></button> : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div class="summary">
                  <span class="stat"><i class="k">services</i><i class="v">{grp.length}</i></span>
                  <span class="stat"><i class="k">containers</i><i class="v">{s.running}<i class="t">/{s.total}</i></i></span>
                  {stopped > 0 ? <span class="stat"><i class="k">stopped</i><i class="v warnv">{stopped}</i></span> : null}
                  {restarting > 0 ? <span class="stat"><i class="k">restarting</i><i class="v badv">{restarting}</i></span> : null}
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
                  <col style="width:24%" />
                  <col style="width:9%" />
                  <col style="width:7%" />
                  <col style="width:7%" />
                  <col style="width:15%" />
                  <col style="width:22%" />
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
                              {this.updates[c.id]?.status === "outdated" ? <span class="upd" title={this.updates[c.id]?.detail || "update available"}>update</span> : null}
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
                      <tr class={"grp" + (open ? " open" : "")} onClick={() => this.toggle(g.service)}>
                        <td class="svc">
                          <span class="cell">
                            <loom-icon class="caret" name="chevron-right" size={13}></loom-icon>
                            <span class={"mark " + aggMark(g.items)}></span>
                            <span class="gname">{g.service}</span>
                            <span class="badge">{g.items.length} replicas</span>
                            {this.groupUpdate(g.items) === "outdated" ? <span class="upd" title="one or more replicas have an update available">update</span> : null}
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
                                {this.updates[c.id]?.status === "outdated" ? <span class="upd" title={this.updates[c.id]?.detail || "update available"}>update</span> : null}
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
      </div>
    );
  }
}

// Human-readable bytes for the snapshot columns (MiB/GiB).
function mb(b: number): string {
  if (!b) return "0";
  const gb = b / 1073741824;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 1) + "G";
  const m = b / 1048576;
  return m.toFixed(m >= 10 ? 0 : 1) + "M";
}
