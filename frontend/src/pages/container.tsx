// Container detail — identity, a live overview, stat gauges, the log terminal,
// and raw inspect. Inspect drives the header/overview; logs + stats stream over
// NDJSON and tear down on unmount.
import { LoomElement, component, styles, css, reactive, prop, watch, mount, unmount, interval, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { HopeTransport } from "../transport";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import type { LogFrame, StackSummary, ContainerSummary, ContainerOp, UpdatesResult, OpFrame } from "../contracts";
import { theme, markClass } from "../styles";

type Tab = "logs" | "stats" | "inspect";
const MAX_LINES = 600;

@route("/container/:id")
@component("hope-container")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--ink); }

  .bar {
    position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink);
  }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { display: flex; align-items: center; gap: 5px; color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .back:hover { color: var(--hi); }
  .bar .hostcrumb { font: 600 11px/1 var(--mono); letter-spacing: .08em; color: var(--ok); text-transform: lowercase;
    padding: 4px 9px; border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--line)); border-radius: 6px; }
  .ov .v.slink loom-icon { vertical-align: -1px; }
  .bar .crumb { font: 600 13px/1 var(--mono); letter-spacing: .04em; }
  .bar .crumb .p { color: var(--mid); cursor: pointer; }
  .bar .crumb .p:hover { color: var(--hi); }
  .bar .crumb .sep { color: var(--dim); }
  .bar .repl { padding: 0; position: relative; }
  .rbtn { height: 44px; display: flex; align-items: center; gap: 7px; padding: 0 14px; background: transparent;
    border: 0; color: var(--mid); font: 600 12px/1 var(--mono); cursor: pointer; }
  .rbtn:hover { color: var(--hi); background: var(--raised); }
  .rof { color: var(--dim); }
  .rmenu { position: absolute; top: 44px; left: 0; min-width: 260px; z-index: 30;
    background: var(--panel); border: 1px solid var(--line2); max-height: 70vh; overflow: auto; }
  .ritem { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line);
    cursor: pointer; font: 12px/1 var(--mono); }
  .ritem:last-child { border-bottom: none; }
  .ritem:hover, .ritem.cur { background: var(--raised); }
  .ritem .rn { color: var(--hi); font-weight: 600; width: 30px; }
  .ritem .rid { color: var(--dim); flex: 1; }
  .ritem .rst { color: var(--mid); }
  .rbadge { font: 600 12px/1 var(--mono); color: var(--mid); border: 1px solid var(--line); padding: 6px 9px; }
  .updchip { display: inline-flex; align-items: center; gap: 6px; font: 600 10px/1 var(--mono); letter-spacing: .12em;
    text-transform: uppercase; padding: 6px 10px; background: transparent; cursor: pointer;
    color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 45%, var(--line)); }
  .updchip loom-icon { color: var(--upd); }
  .updchip:hover { background: color-mix(in srgb, var(--upd) 16%, transparent); border-color: var(--upd); }
  .updchip:disabled { opacity: .5; cursor: not-allowed; }
  .bar .grow { flex: 1; }
  .idrow { display: flex; align-items: center; gap: 16px; }
  .idrow .id { flex: 0 1 auto; }
  .toolbar { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .tbtn { padding: 8px 13px; background: transparent; border: 1px solid var(--line); color: var(--mid);
    font: 500 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; cursor: pointer; }
  .tbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .tbtn:disabled { opacity: .4; cursor: not-allowed; }
  .more { position: relative; display: flex; }
  .more .tbtn { padding: 8px 11px; letter-spacing: .24em; }
  .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 40; min-width: 168px;
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
  .toast { position: fixed; right: 22px; bottom: 22px; z-index: 60; background: var(--raised);
    border: 1px solid var(--line2); color: var(--hi); font: 500 12px/1.4 var(--mono); padding: 11px 15px;
    max-width: 420px; }
  .toast.bad { border-color: var(--bad); color: var(--bad); }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 26px 28px 56px; max-width: 1120px; margin: 0 auto; }

  /* identity */
  .id { display: flex; align-items: center; gap: 13px; margin-bottom: 4px; }
  .id .mark { width: 9px; height: 9px; flex: none; }
  .id h1 { font: 600 22px/1 var(--mono); margin: 0; }
  .id .state { display: flex; align-items: center; gap: 8px; font: 600 11px/1 var(--mono);
    letter-spacing: .12em; text-transform: uppercase; padding: 6px 11px; border: 1px solid var(--line); }
  .id .state.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .id .state.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .sub { font: 12px/1 var(--mono); color: var(--dim); margin-bottom: 20px; }

  /* overview readout — short metrics strip */
  .ov { display: flex; flex-wrap: wrap; border: 1px solid var(--line); margin-bottom: 14px; }
  .ov .c { display: flex; flex-direction: column; gap: 6px; padding: 12px 18px; border-right: 1px solid var(--line); min-width: 0; }
  .ov .c:last-child { border-right: 0; }
  .ov .k { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .ov .v { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov .v.warn { color: var(--warn); }
  .ov .v.bad { color: var(--bad); }
  .ov .v.slink { color: var(--hi); cursor: pointer; }
  .ov .v.slink:hover { color: #fff; text-decoration: underline; }

  /* long values — image / ports / id as full-width rows */
  .kv { border: 1px solid var(--line); margin-bottom: 22px; }
  .kv .r { display: flex; gap: 18px; align-items: baseline; padding: 11px 16px; border-bottom: 1px solid var(--line); }
  .kv .r:last-child { border-bottom: 0; }
  .kv .k { flex: 0 0 92px; font: 600 9.5px/1.6 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .kv .v { flex: 1; min-width: 0; font: 13px/1.5 var(--mono); color: var(--hi); word-break: break-all; }
  .kv .v.dim { color: var(--mid); }

  .netblk { border: 1px solid var(--line); margin-bottom: 22px; }
  .netlbl { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    padding: 11px 16px; border-bottom: 1px solid var(--line); }
  .netrow { display: flex; flex-wrap: wrap; gap: 9px 24px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .netrow:last-child { border-bottom: 0; }
  .netrow .nn { font: 600 13px/1 var(--mono); color: var(--hi); min-width: 150px; }
  .netrow .nn.slink { cursor: pointer; }
  .netrow .nn.slink:hover { color: #fff; text-decoration: underline; }
  .netrow .nf { font: 12.5px/1 var(--mono); color: var(--hi); }
  .netrow .nf i { color: var(--dim); font-style: normal; margin-right: 7px; text-transform: uppercase; font-size: 9px; letter-spacing: .12em; }

  .tabs { display: flex; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
  .tabs button {
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim);
    background: transparent; border: 0; border-bottom: 2px solid transparent;
    padding: 11px 16px; margin-bottom: -1px; cursor: pointer;
  }
  .tabs button:hover { color: var(--mid); }
  .tabs button.active { color: var(--hi); border-bottom-color: var(--hi); }
  .tabs .wrapbtn { margin-left: auto; border-bottom-color: transparent; color: var(--dim); }
  .tabs .wrapbtn:hover { color: var(--hi); }

  pre.logs { height: 62vh; }
  pre.logs.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }

  /* stats — two hero gauges + a secondary metric strip */
  .heroes { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  .hero { border: 1px solid var(--line); padding: 18px 20px; }
  .hero .hk { font: 600 10px/1 var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--dim); }
  .hero .hv { font: 600 32px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--hi); margin: 16px 0 14px; }
  .hero .hsub { font: 12px/1 var(--mono); color: var(--dim); margin-top: 11px; font-variant-numeric: tabular-nums; }
  .meter { height: 6px; background: var(--faint); overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--ok); transition: width .3s ease; }
  .meter i.warn { background: var(--warn); }
  .meter i.bad { background: var(--bad); }
  .mstrip { display: flex; flex-wrap: wrap; border: 1px solid var(--line); }
  .mstrip .m { flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: 8px; padding: 13px 16px; border-right: 1px solid var(--line); }
  .mstrip .m:last-child { border-right: 0; }
  .mstrip .mk { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .mstrip .mv { font: 600 14px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  @media (max-width: 620px) { .heroes { grid-template-columns: 1fr; } }

  .err { color: var(--bad); font: 12px/1.5 var(--mono); margin-bottom: 12px; }

  .subtabs { display: flex; gap: 6px; margin-bottom: 14px; }
  .subtabs button { font: 500 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
    color: var(--dim); background: transparent; border: 1px solid var(--line); padding: 6px 12px; cursor: pointer; }
  .subtabs button:hover { color: var(--hi); border-color: var(--line2); }
  .subtabs button.on { color: var(--hi); border-color: var(--line2); background: var(--raised); }

  pre.inspect { margin: 0; border: 1px solid var(--line); background: var(--panel); padding: 16px 18px;
    height: 60vh; overflow: auto; font: 12.5px/1.6 var(--mono); color: var(--hi); }
  pre.inspect .key { color: #9aa4b4; }
  pre.inspect .str { color: #6fd0a0; }
  pre.inspect .num { color: #e0a23b; }
  pre.inspect .bool { color: #f06464; }
  pre.inspect .null { color: #5a6376; }

  /* pretty inspect — clean, scalable, searchable table */
  .pview { border: 1px solid var(--line); }
  .psearch { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--line); color: var(--dim); position: sticky; top: 0; background: var(--ink); z-index: 1; }
  .psearch input { flex: 1; background: transparent; border: 0; color: var(--hi); font: 13px/1 var(--mono); outline: none; }
  .psearch input::placeholder { color: var(--dim); }
  .psearch .pn { font: 11px/1 var(--mono); color: var(--dim); }
  .pscroll { max-height: 58vh; overflow: auto; }
  .ptable { width: 100%; border-collapse: collapse; }
  .ptable td { padding: 8px 14px; border-bottom: 1px solid var(--line); vertical-align: top; font: 12.5px/1.5 var(--mono); }
  .ptable tr:last-child td { border-bottom: none; }
  .ptable tr:hover td { background: var(--raised); }
  .ptable .pk { width: 38%; color: var(--mid); white-space: nowrap; }
  .ptable .pv { color: var(--hi); font-family: var(--sans); word-break: break-all; }
  .ppill { display: inline-block; font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 3px 8px; }
  .ppill.on { color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .ppill.off { color: var(--dim); border: 1px solid var(--line); }
  .pnum { color: #e0a23b; font-family: var(--mono); }
  .pmuted { color: var(--dim); }
  .pempty { padding: 32px; text-align: center; color: var(--dim); font: 12.5px/1.5 var(--mono); }

  @media (max-width: 720px) { main { padding: 20px 16px 48px; } }
`)
export class ContainerPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor id = "";
  @reactive accessor info: any = null;
  @reactive accessor tab: Tab = "logs";
  @reactive accessor logLines: string[] = [];
  @reactive accessor cpu = "—";
  @reactive accessor cpuBar = 0;
  @reactive accessor memUsed = "—";
  @reactive accessor memLimit = "—";
  @reactive accessor memBar = 0;
  @reactive accessor netRx = "—";
  @reactive accessor netTx = "—";
  @reactive accessor blkR = "—";
  @reactive accessor blkW = "—";
  @reactive accessor pids = "—";
  @reactive accessor hasStats = false;
  @reactive accessor error = "";
  @reactive accessor wrap = false;
  @reactive accessor inspectMode: "pretty" | "raw" = "pretty";
  @reactive accessor inspectQuery = "";
  @reactive accessor siblings: ContainerSummary[] = [];
  @reactive accessor dropOpen = false;
  @reactive accessor cbusy = ""; // op currently running
  @reactive accessor actOpen = false; // action kebab menu
  @reactive accessor toast = "";
  @reactive accessor toastKind = "";
  @reactive accessor outdated = false; // image has a newer version on the registry

  // The route param, bound reactively. Watching it reloads the page on any
  // change — including container -> container (replica switches), which the
  // outlet handles by re-injecting params without re-mounting.
  @prop({ param: "id" }) accessor routeId = "";

  private ctrl = new AbortController();

  @reactive accessor host = ""; // active host id (shown in the crumb for multi-host)

  // True when arrived from the cross-fleet overview, so "back" labels match.
  get fleetBack() {
    return localStorage.getItem("hope.fleet") === "1";
  }

  @mount
  onMount() {
    addEventListener("click", this.closeDrop);
    if (this.routeId) this.enter(this.routeId);
    this.loadActiveHost();
  }

  // Which host this container lives on, for the crumb in multi-host setups.
  private async loadActiveHost() {
    try {
      const hosts = await this.rpc.call<{ id: string; active: boolean }[]>("System", "hosts", []);
      this.host = (hosts || []).find((h) => h.active)?.id || "";
    } catch {
      this.host = "";
    }
  }

  @watch("routeId")
  private onRouteId() {
    if (this.routeId) this.enter(this.routeId);
  }

  private closeDrop = () => {
    this.dropOpen = false;
    this.actOpen = false;
  };

  private containerOp = async (op: ContainerOp) => {
    // Redeploy streams its pull/recreate output into the shared processing
    // dialog (same modal as the stack page), so it gets its own path.
    if (op === "redeploy") {
      this.actOpen = false;
      const ok = await this.confirm.ask({
        title: "redeploy",
        warn: true,
        confirmLabel: "Redeploy",
        message: `Redeploy "${this.service()}"? Pulls the latest image and recreates the container.`,
      });
      if (!ok) return;
      return this.redeployStreaming();
    }
    if (op === "stop" || op === "kill") {
      const ok = await this.confirm.ask({
        title: op,
        danger: true,
        confirmLabel: op === "kill" ? "Kill" : "Stop",
        message: `${op === "kill" ? "Kill" : "Stop"} "${this.service()}"?`,
      });
      if (!ok) return;
    }
    this.actOpen = false;
    this.cbusy = op;
    this.error = "";
    const verb = op === "pull" ? "pulling" : op;
    this.showToast(`${verb} ${this.service()}…`, "", true);
    try {
      await this.rpc.call("Containers", op, [this.id]);
      this.showToast(`${op} ${this.service()} — done`);
      await this.loadInfo();
    } catch (err: any) {
      this.showToast(`${op} ${this.service()} — ${err?.message ?? "failed"}`, "bad");
    } finally {
      this.cbusy = "";
    }
  };

  // Redeploy this container with live pull/recreate output in the processing
  // dialog (the redeploy-style modal used across hope), then hop to the new id.
  private redeployStreaming = async () => {
    this.cbusy = "redeploy";
    this.error = "";
    try {
      await this.proc.run(`redeploy ${this.service()}`, async (emit, signal) => {
        let ok = true;
        for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "redeploy", [this.id], signal)) {
          if (f.type === "log" && f.data) emit(f.data);
          else if (f.type === "done" && !f.ok) {
            ok = false;
            emit("failed: " + (f.error ?? ""));
          }
        }
        emit("done");
        return ok;
      });
      // Recreate gives the container a new id — hop to it.
      const newId = await this.findRecreated();
      if (newId && newId !== this.id) {
        this.router.navigate(`/container/${encodeURIComponent(newId)}`);
        return;
      }
      await this.loadInfo();
    } catch (err: any) {
      this.showToast(`redeploy ${this.service()} — ${err?.message ?? "failed"}`, "bad");
    } finally {
      this.cbusy = "";
    }
  };

  // After a recreate, find the new container for this same project/service/replica.
  private async findRecreated(): Promise<string> {
    const proj = this.project();
    const svc = this.labels()["com.docker.compose.service"];
    const num = this.currentNumber();
    try {
      const stacks = await this.rpc.call<StackSummary[]>("Stacks", "list", []);
      const st = stacks.find((s) => s.project === proj);
      const match = (st?.containers ?? []).find((c) => c.service === svc && c.number === num);
      return match?.id ?? "";
    } catch {
      return "";
    }
  }

  private toastTimer: any = 0;
  private showToast(msg: string, kind = "", sticky = false) {
    this.toast = msg;
    this.toastKind = kind;
    clearTimeout(this.toastTimer);
    if (!sticky) this.toastTimer = setTimeout(() => (this.toast = ""), 3500);
  }

  private enter(id: string) {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    if (id === this.id && this.info) return;
    this.id = id;
    this.ctrl.abort();
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    // Swap the container's data + restart its streams. Keep the active tab and
    // the replica list (siblings are shared across a set) so switching a pod is
    // a smooth data swap, not a page reset.
    this.info = null;
    this.dropOpen = false;
    this.outdated = false;
    this.logLines = [];
    this.cpu = this.memUsed = this.memLimit = this.netRx = this.netTx = this.blkR = this.blkW = this.pids = "—";
    this.cpuBar = this.memBar = 0;
    this.hasStats = false;
    this.error = "";
    this.loadInfo();
    this.runLogs(signal);
    this.runStats(signal);
  }

  @unmount
  onUnmount() {
    this.ctrl.abort();
    removeEventListener("click", this.closeDrop);
    clearTimeout(this.toastTimer);
  }

  private async loadInfo() {
    try {
      this.info = await this.rpc.call<any>("Containers", "inspect", [this.id]);
      await this.loadSiblings();
      this.loadUpdateStatus();
    } catch {
      /* header falls back to the id */
    }
  }

  // Find the other pods in this container's replica set (same compose service).
  private async loadSiblings() {
    const proj = this.project();
    const svc = this.labels()["com.docker.compose.service"];
    if (!proj || !svc) {
      this.siblings = [];
      return;
    }
    try {
      const stacks = await this.rpc.call<StackSummary[]>("Stacks", "list", []);
      const st = stacks.find((s) => s.project === proj);
      this.siblings = (st?.containers ?? []).filter((c) => c.service === svc).sort((a, b) => a.number - b.number);
    } catch {
      this.siblings = [];
    }
  }

  // Cached cluster freshness — is this container's image out of date?
  private async loadUpdateStatus() {
    try {
      const res = await this.rpc.call<UpdatesResult>("System", "updates", []);
      this.outdated = res.updates.find((u) => u.id === this.id)?.status === "outdated";
    } catch {
      this.outdated = false;
    }
  }

  private openSibling(id: string) {
    this.dropOpen = false;
    if (id !== this.id) this.router.navigate(`/container/${encodeURIComponent(id)}`);
  }

  private currentNumber(): number {
    const n = this.labels()["com.docker.compose.container-number"];
    return n ? parseInt(n, 10) : 0;
  }

  private async runLogs(signal: AbortSignal) {
    try {
      for await (const f of this.rpc.streamWithSignal<LogFrame>("Stream", "logs", [this.id], signal)) {
        const next = this.logLines.concat(stripAnsi(f.data).replace(/\n$/, ""));
        this.logLines = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        requestAnimationFrame(() => {
          const el = this.shadowRoot?.querySelector("pre.logs") as HTMLElement | null;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    } catch (err: any) {
      // Ignore aborts from switching containers — only surface real failures.
      if (!signal.aborted) this.error = `logs: ${err?.message ?? err}`;
    }
  }

  private async runStats(signal: AbortSignal) {
    try {
      for await (const s of this.rpc.streamWithSignal<any>("Stream", "stats", [this.id], signal)) {
        this.applyStats(s);
      }
    } catch (err: any) {
      if (!signal.aborted) this.error = `stats: ${err?.message ?? err}`;
    }
  }

  private applyStats(s: any) {
    try {
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
      const cpus = s.cpu_stats.online_cpus || (s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1);
      if (sysDelta > 0 && cpuDelta >= 0) {
        this.cpu = ((cpuDelta / sysDelta) * cpus * 100).toFixed(1) + "%";
        this.cpuBar = Math.min(100, (cpuDelta / sysDelta) * 100);
      }
      const used = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.cache ?? 0);
      const limit = s.memory_stats.limit ?? 0;
      this.memUsed = mb(used);
      this.memLimit = mb(limit);
      this.memBar = limit ? Math.min(100, (used / limit) * 100) : 0;

      let rx = 0, tx = 0;
      for (const n of Object.values<any>(s.networks ?? {})) {
        rx += n.rx_bytes ?? 0;
        tx += n.tx_bytes ?? 0;
      }
      this.netRx = bytes(rx);
      this.netTx = bytes(tx);

      let r = 0, w = 0;
      for (const e of s.blkio_stats?.io_service_bytes_recursive ?? []) {
        if (e.op === "Read" || e.op === "read") r += e.value ?? 0;
        if (e.op === "Write" || e.op === "write") w += e.value ?? 0;
      }
      this.blkR = bytes(r);
      this.blkW = bytes(w);
      this.pids = String(s.pids_stats?.current ?? "—");
      this.hasStats = true;
    } catch {
      /* partial frame */
    }
  }

  // Poll inspect so state/health transitions (e.g. "starting" -> "running")
  // appear without a manual refresh.
  @interval(5000)
  private pollInfo() {
    if (!this.id || !this.info) return;
    this.rpc
      .call<any>("Containers", "inspect", [this.id])
      .then((i) => (this.info = i))
      .catch(() => {});
  }

  private selectTab = (t: Tab) => {
    this.tab = t;
  };

  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  // Raw: syntax-highlighted JSON (a real DOM node so we can set innerHTML).
  private renderInspect() {
    const pre = document.createElement("pre");
    pre.className = "inspect";
    pre.innerHTML = this.info ? highlightJson(this.info) : "Loading…";
    return pre;
  }

  // Pretty: a clean, scalable, searchable table built dynamically from inspect.
  // The whole config is flattened to dotted key paths so every value is one
  // readable row, and a search filters by key OR value.
  private renderPretty() {
    const i = this.info;
    if (!i || typeof i !== "object") return <div class="pempty">Loading…</div>;
    const rows = flatten(i);
    const q = this.inspectQuery.trim().toLowerCase();
    const filtered = q
      ? rows.filter(([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q))
      : rows;
    return (
      <div class="pview">
        <div class="psearch">
          <loom-icon name="search" size={14}></loom-icon>
          <input
            type="text"
            placeholder="Search keys and values…"
            value={this.inspectQuery}
            onInput={(e: any) => (this.inspectQuery = e.target.value)}
          />
          <span class="pn">{filtered.length}</span>
        </div>
        <div class="pscroll">
          <table class="ptable">
            <tbody>
              {filtered.map(([k, v]) => (
                <tr>
                  <td class="pk">{k}</td>
                  <td class="pv">{fmtVal(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 ? <div class="pempty">No matches.</div> : null}
        </div>
      </div>
    );
  }

  private meterClass(pct: number) {
    return pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
  }

  // ---- derived header fields from inspect ----
  private labels() {
    return this.info?.Config?.Labels ?? {};
  }
  private service() {
    return this.labels()["com.docker.compose.service"] || (this.info?.Name || "").replace(/^\//, "") || this.id.slice(0, 12);
  }
  private project() {
    return this.labels()["com.docker.compose.project"] || "";
  }
  // Loose (no-compose) containers belong to the "(ungrouped)" pseudo-stack.
  private stackId() {
    return this.project() || "(ungrouped)";
  }
  private state(): string {
    return this.info?.State?.Status ?? "";
  }
  private health(): string {
    return this.info?.State?.Health?.Status ?? "";
  }
  private ports(): string {
    const p = this.info?.NetworkSettings?.Ports ?? {};
    const out: string[] = [];
    for (const [k, v] of Object.entries<any>(p)) {
      if (v && v.length) for (const b of v) out.push(`${b.HostIp || "0.0.0.0"}:${b.HostPort}->${k}`);
      else out.push(k);
    }
    return out.join(", ") || "—";
  }

  // The networks this container is attached to, with its address on each.
  private netList() {
    const nets = this.info?.NetworkSettings?.Networks ?? {};
    return Object.entries<any>(nets).map(([name, n]) => ({
      name,
      ip: n?.IPAddress || n?.GlobalIPv6Address || "",
      gateway: n?.Gateway || n?.IPv6Gateway || "",
      mac: n?.MacAddress || "",
      aliases: ((n?.Aliases as string[]) || []).filter((a) => a && !this.id.startsWith(a)),
    }));
  }

  update() {
    const running = this.state() === "running";
    return (
      <div>
        <div class="bar">
          <div class="s">
            <span class="back" onClick={() => this.router.navigate(`/stack/${encodeURIComponent(this.stackId())}`)}>
              <loom-icon name="chevron-left" size={13}></loom-icon> back
            </span>
          </div>
          {this.host && this.host !== "local" ? (
            <div class="s"><span class="hostcrumb">{this.host}</span></div>
          ) : null}
          <div class="s">
            <span class="crumb">
              <span class="p" onClick={() => this.router.navigate("/")}>{this.fleetBack ? "all hosts" : "fleet"}</span>
              <span class="sep"> / </span>
              <span class="p" onClick={() => this.router.navigate(`/stack/${encodeURIComponent(this.stackId())}`)}>
                {this.project() || "ungrouped"}
              </span>
              <span class="sep"> / </span>
              {this.service()}
            </span>
          </div>
          {this.siblings.length > 1 ? (
            <div class="s repl">
              <button class="rbtn" onClick={(e: Event) => { e.stopPropagation(); this.dropOpen = !this.dropOpen; }}>
                replica #{this.currentNumber()}<span class="rof"> / {this.siblings.length}</span>
                <loom-icon name="chevron-down" size={12}></loom-icon>
              </button>
              {this.dropOpen ? (
                <div class="rmenu">
                  {this.siblings.map((c) => (
                    <div class={"ritem" + (c.id === this.id ? " cur" : "")} onClick={() => this.openSibling(c.id)}>
                      <span class={"mark " + markClass(c.state)}></span>
                      <span class="rn">#{c.number}</span>
                      <span class="rid">{c.id.slice(0, 12)}</span>
                      <span class="rst">{c.state}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div class="grow"></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="err">{this.error}</div> : null}

          <div class="idrow">
            <div class="id">
              <span class={"mark " + markClass(this.state())}></span>
              <h1>{this.service()}</h1>
              {this.siblings.length > 1 ? <span class="rbadge">#{this.currentNumber()}</span> : null}
              {this.state() ? (
                <span class={"state " + (running ? "ok" : "bad")}>{this.state()}</span>
              ) : null}
              {this.outdated ? (
                <button class="updchip" disabled={!!this.cbusy} title="a newer image is available — redeploy to update" onClick={() => this.containerOp("redeploy")}>
                  <loom-icon name="download" size={12}></loom-icon>update available
                </button>
              ) : null}
            </div>
            <div class="toolbar">
              <button class="tbtn" disabled={!!this.cbusy || running} onClick={() => this.containerOp("start")}>{this.cbusy === "start" ? "start…" : "start"}</button>
              <button class="tbtn" disabled={!!this.cbusy} onClick={() => this.containerOp("restart")}>{this.cbusy === "restart" ? "restart…" : "restart"}</button>
              <button class="tbtn" disabled={!!this.cbusy} onClick={() => this.containerOp("redeploy")}>{this.cbusy === "redeploy" ? "redeploy…" : "redeploy"}</button>
              <div class="more">
                <button class="tbtn" aria-label="more" onClick={(e: Event) => { e.stopPropagation(); this.actOpen = !this.actOpen; }}>···</button>
                {this.actOpen ? (
                  <div class="menu">
                    <button class="mitem" disabled={!!this.cbusy} onClick={() => this.containerOp("pull")}><loom-icon name="download" size={13}></loom-icon><span>pull image</span></button>
                    <button class="mitem danger" disabled={!!this.cbusy || !running} onClick={() => this.containerOp("stop")}><loom-icon name="stop" size={13}></loom-icon><span>stop</span></button>
                    <button class="mitem danger" disabled={!!this.cbusy || !running} onClick={() => this.containerOp("kill")}><loom-icon name="x" size={13}></loom-icon><span>kill</span></button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div class="sub">{this.id.slice(0, 24)}</div>

          <div class="ov">
            <div class="c"><span class="k">Uptime</span><span class="v">{uptime(this.info?.State?.StartedAt)}</span></div>
            <div class="c">
              <span class="k">Restarts</span>
              <span class={"v" + ((this.info?.RestartCount ?? 0) > 0 ? " warn" : "")}>{this.info?.RestartCount ?? 0}</span>
            </div>
            <div class="c">
              <span class="k">Health</span>
              <span class={"v" + (this.health() === "unhealthy" ? " bad" : this.health() === "starting" ? " warn" : "")}>
                {this.health() || "—"}
              </span>
            </div>
            {this.project() ? (
              <div class="c">
                <span class="k">Stack</span>
                <span class="v slink" onClick={() => this.router.navigate(`/stack/${encodeURIComponent(this.project())}`)}>
                  {this.project()} <loom-icon name="chevron-right" size={12}></loom-icon>
                </span>
              </div>
            ) : null}
          </div>

          <div class="kv">
            <div class="r"><span class="k">Image</span><span class="v">{this.info?.Config?.Image ?? "—"}</span></div>
            <div class="r"><span class="k">Ports</span><span class="v">{this.ports()}</span></div>
            <div class="r"><span class="k">Container</span><span class="v dim">{this.id}</span></div>
          </div>

          {this.netList().length ? (
            <div class="netblk">
              <div class="netlbl">Networks</div>
              {this.netList().map((n) => (
                <div class="netrow">
                  <span class="nn slink" title="manage networks" onClick={() => this.router.navigate("/networks")}>{n.name}</span>
                  <span class="nf"><i>ip</i>{n.ip || "—"}</span>
                  <span class="nf"><i>gateway</i>{n.gateway || "—"}</span>
                  {n.aliases.length ? <span class="nf"><i>aliases</i>{n.aliases.join(", ")}</span> : null}
                  {n.mac ? <span class="nf"><i>mac</i>{n.mac}</span> : null}
                </div>
              ))}
            </div>
          ) : null}

          <div class="tabs">
            {(["logs", "stats", "inspect"] as Tab[]).map((t) => (
              <button class={this.tab === t ? "active" : ""} onClick={() => this.selectTab(t)}>{t}</button>
            ))}
            {this.tab === "logs" ? (
              <button class="wrapbtn" onClick={() => (this.wrap = !this.wrap)}>{this.wrap ? "no wrap" : "wrap"}</button>
            ) : null}
          </div>

          {this.tab === "logs" ? (
            <pre class={"logs" + (this.wrap ? " wrap" : "")}>{this.logLines.join("\n") || "Waiting for output…"}</pre>
          ) : null}

          {this.tab === "stats" ? (
            <div class="stats">
              <div class="heroes">
                <div class="hero">
                  <div class="hk">CPU</div>
                  <div class="hv">{this.cpu}</div>
                  <div class="meter"><i class={this.meterClass(this.cpuBar)} style={`width:${this.cpuBar}%`}></i></div>
                  <div class="hsub">{this.hasStats ? `${this.cpuBar.toFixed(0)}% of one core` : "live while running"}</div>
                </div>
                <div class="hero">
                  <div class="hk">Memory</div>
                  <div class="hv">{this.hasStats ? `${this.memBar.toFixed(0)}%` : "—"}</div>
                  <div class="meter"><i class={this.meterClass(this.memBar)} style={`width:${this.memBar}%`}></i></div>
                  <div class="hsub">{this.memUsed} / {this.memLimit}</div>
                </div>
              </div>
              <div class="mstrip">
                <div class="m"><i class="mk">Net rx</i><i class="mv">{this.netRx}</i></div>
                <div class="m"><i class="mk">Net tx</i><i class="mv">{this.netTx}</i></div>
                <div class="m"><i class="mk">Block read</i><i class="mv">{this.blkR}</i></div>
                <div class="m"><i class="mk">Block write</i><i class="mv">{this.blkW}</i></div>
                <div class="m"><i class="mk">PIDs</i><i class="mv">{this.pids}</i></div>
              </div>
            </div>
          ) : null}

          {this.tab === "inspect" ? (
            <div>
              <div class="subtabs">
                <button class={this.inspectMode === "pretty" ? "on" : ""} onClick={() => (this.inspectMode = "pretty")}>pretty</button>
                <button class={this.inspectMode === "raw" ? "on" : ""} onClick={() => (this.inspectMode = "raw")}>raw</button>
              </div>
              {this.inspectMode === "raw" ? this.renderInspect() : this.renderPretty()}
            </div>
          ) : null}
        </main>
        {this.toast ? <div class={"toast " + this.toastKind}>{this.toast}</div> : null}
      </div>
    );
  }
}

function mb(b: number): string {
  return (b / 1024 / 1024).toFixed(0) + " MB";
}

function bytes(n: number): string {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + " " + u[i];
}

function uptime(startedAt?: string): string {
  if (!startedAt) return "—";
  const t = new Date(startedAt).getTime();
  if (!t) return "—";
  let s = Math.max(0, (Date.now() - t) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Strip ANSI color/escape sequences so colored logger output renders cleanly.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// flatten walks an object into [dottedPath, leafValue] rows. Nested objects and
// arrays become dotted/indexed paths so every value is one table row.
function flatten(obj: any, prefix = ""): [string, any][] {
  const rows: [string, any][] = [];
  const entries: [string, any][] = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj ?? {});
  for (const [k, v] of entries) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      if (v.length === 0) rows.push([path, "(empty list)"]);
      else if (v.every((x) => x === null || typeof x !== "object")) {
        // array of primitives → one joined row instead of .0 / .1 / .2
        rows.push([path, v.map((x) => (x === null ? "null" : String(x))).join(", ")]);
      } else {
        // array of objects → one summarized row per element, not a field explosion
        v.forEach((el, idx) => {
          if (el !== null && typeof el === "object") rows.push([`${path}.${idx}`, summarize(el)]);
          else rows.push([`${path}.${idx}`, el]);
        });
      }
    } else if (v !== null && typeof v === "object") {
      if (Object.keys(v).length === 0) rows.push([path, "(empty)"]);
      else rows.push(...flatten(v, path));
    } else {
      rows.push([path, v]);
    }
  }
  return rows;
}

// summarize collapses an object into a one-line "k=v · k=v" summary of its
// primitive fields — used for array-of-object rows (e.g. each Mount).
function summarize(obj: any): string {
  const parts = Object.entries(obj)
    .filter(([, x]) => x === null || typeof x !== "object")
    .map(([k, x]) => `${k}=${x === null ? "null" : x}`);
  return parts.join("  ·  ") || "{…}";
}

// fmtVal renders a leaf value as readable JSX (boolean pills, dim null, etc).
function fmtVal(v: any): any {
  if (v === null || v === undefined || v === "") return <span class="pmuted">—</span>;
  if (typeof v === "boolean") return <span class={"ppill " + (v ? "on" : "off")}>{String(v)}</span>;
  if (typeof v === "number") return <span class="pnum">{v}</span>;
  return String(v);
}

// highlightJson returns HTML with token spans for syntax-highlighted JSON.
function highlightJson(obj: unknown): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const json = esc(JSON.stringify(obj, null, 2));
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = "num";
      if (/^"/.test(m)) cls = /:$/.test(m) ? "key" : "str";
      else if (/true|false/.test(m)) cls = "bool";
      else if (/null/.test(m)) cls = "null";
      return `<span class="${cls}">${m}</span>`;
    },
  );
}
