// <hope-inspector> — the docked bottom panel (VSCode-style) for a container: a
// toolbar with detail tabs (info / logs / mounts / env / networks / labels /
// inspect) on the left and the container's actions on the right, over the tab
// content. Opened from a stack row (Inspector.open).
//
// SECURITY: docker surfaces (env, command args, inspect) carry secrets in
// plaintext. Every derived view reads from redactInspect(inspect) — secrets are
// masked unless the operator arms the "reveal" toggle. Never render raw inspect
// directly. It targets a specific container on a specific host, so its calls
// carry that host explicitly.
import { LoomElement, component, styles, css, reactive, mount, unmount, on, query } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { capabilities } from "../caps";
import type { Surface } from "./plugin-surface";
import { Inspector } from "../inspector";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import { PromptService } from "../prompt";
import { ToastService } from "../toast";
import { NetworkDetailService } from "./network-detail";
import { ImageInspector } from "../image-inspector";
import { InspectorTarget, PluginsChanged, withRefresh } from "../events";
import { promptAddRoute } from "../add-route";
import { redactInspect, redactCmd } from "../redact";
import { parseStats } from "../stats";
import { shortId, uptime, flatten, friendlyTime, parseLogLine, stripAnsi } from "../format";
import type { LogFrame, TopResult, TunnelView } from "../contracts";
import { theme } from "../styles";
type Tab = "info" | "logs" | "processes" | "mounts" | "env" | "networks" | "labels" | "inspect" | `plugin:${string}`;
const TABS: Tab[] = ["info", "logs", "processes", "mounts", "env", "networks", "labels", "inspect"];

@component("hope-inspector")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; overflow: hidden; background: var(--panel); }

  .bar { display: flex; align-items: stretch; height: 38px; flex: none; border-bottom: 1px solid var(--line); }
  .who { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-right: 1px solid var(--line); }
  .who .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
  .who .dot.ok { background: var(--ok); } .who .dot.warn { background: var(--warn); }
  .who .dot.bad { background: var(--bad); } .who .dot.off { background: var(--dim); }
  .who .nm { font: 700 12.5px/1 var(--mono); color: var(--hi); }
  .who .sub { color: var(--dim); font: 500 10px/1 var(--mono); }

  /* replica switcher — the name becomes a compact dropdown when >1 replica */
  .repsel { position: relative; display: flex; }
  .rtrig { display: flex; align-items: center; gap: 8px; padding: 0; background: transparent; border: 0; cursor: pointer; font: inherit; }
  .rtrig:disabled { cursor: default; }
  .rtrig .nm { font: 700 12.5px/1 var(--mono); color: var(--hi); }
  .repsel.multi .rtrig:hover .nm { color: #fff; }
  .rtrig .rcaret { color: var(--dim); }
  /* reserve the caret's width even for single-instance containers so the header
     never reflows when the (async) sibling list arrives */
  .repsel:not(.multi) .rcaret { visibility: hidden; }
  .repsel.multi .rtrig:hover .rcaret { color: var(--hi); }
  .rnum { color: var(--dim); font: 600 10px/1 var(--mono); }
  .rmenu { position: absolute; left: -8px; top: calc(100% + 9px); z-index: 60; min-width: 230px;
    background: var(--panel); border: 1px solid var(--line2); box-shadow: 0 10px 28px rgba(0,0,0,.45); }
  .ropt { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent;
    border: 0; border-bottom: 1px solid var(--line); padding: 9px 12px; cursor: pointer; }
  .ropt:last-child { border-bottom: 0; }
  .ropt:hover { background: var(--raised); }
  .ropt.on { background: color-mix(in srgb, var(--upd) 12%, transparent); }
  .ropt .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dim); }
  .ropt .dot.ok { background: var(--ok); } .ropt .dot.bad { background: var(--bad); } .ropt .dot.off { background: var(--dim); }
  .ropt .nm { font: 600 12px/1 var(--mono); color: var(--mid); }
  .ropt:hover .nm, .ropt.on .nm { color: var(--hi); }
  .ropt .sub { margin-left: auto; color: var(--dim); font: 500 10px/1 var(--mono); }
  .tabs { display: flex; align-items: stretch; }
  .tab { display: inline-flex; align-items: center; padding: 0 13px; color: var(--dim); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--mid); }
  .tab.on { color: var(--hi); border-bottom-color: var(--upd); }
  .grow { flex: 1; }
  .acts { display: flex; align-items: stretch; border-left: 1px solid var(--line); }
  .pa { display: inline-flex; align-items: center; justify-content: center; width: 40px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .pa:hover { color: var(--hi); background: var(--raised); }
  .pa.danger:hover { color: var(--bad); }
  /* reveal-secrets control: always caution-amber (it exposes sensitive data);
     turns bad-red while armed to signal secrets are currently visible */
  .pa.caution { color: var(--warn); }
  .pa.caution:hover { color: var(--warn); }
  .pa.caution.armed { color: var(--bad); }
  .pa.caution.armed:hover { color: var(--bad); }
  .pa:disabled { opacity: .4; cursor: default; }

  .body { flex: 1; min-height: 0; overflow-y: auto; }
  .log { padding: 8px 0 14px; font: 400 11.5px/1.65 var(--mono); }
  .log .ln { display: flex; align-items: baseline; gap: 12px; padding: 1px 14px; }
  .log .ln:hover { background: var(--raised); }
  .log .lts { flex: none; color: var(--dim); font-variant-numeric: tabular-nums; }
  .log .lmsg { color: var(--mid); white-space: pre-wrap; word-break: break-word; min-width: 0; }
  .log .lmsg mark { background: color-mix(in srgb, var(--upd) 40%, transparent); color: var(--hi); border-radius: 2px; padding: 0 1px; }
  .cursor { display: inline-block; width: 7px; height: 12px; background: var(--upd); vertical-align: -2px; animation: blink 1.1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }

  /* info tab — a monitoring console: full-width vitals strip over a 3-col detail grid */
  .vitals { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
  .vital { padding: 12px 15px; border-right: 1px solid var(--line); min-width: 0; }
  .vital:last-child { border-right: 0; }
  .vital .vk { color: var(--dim); font: 600 8.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .vital .vv { margin-top: 9px; display: flex; align-items: center; gap: 6px; color: var(--hi); font: 500 15px/1 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vital .vv loom-icon { flex: none; color: var(--dim); }
  .vital .vbar { margin-top: 10px; height: 3px; background: var(--line); overflow: hidden; }
  .vital .vbar i { display: block; height: 100%; background: var(--upd); transition: width .3s ease, background .3s; }
  .vital.warn .vbar i { background: var(--warn); }
  .vital.bad .vbar i { background: var(--bad); }

  .dgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
  .dcol { min-width: 0; border-right: 1px solid var(--line); }
  .dcol:last-child { border-right: 0; }
  .dtitle { padding: 14px 15px 10px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .drow { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 12px; padding: 6px 15px; font: 12px/1.5 var(--mono); align-items: baseline; }
  .drow:last-child { padding-bottom: 14px; }
  .drow .dk { color: var(--dim); }
  .drow .dv { color: var(--hi); min-width: 0; word-break: break-word; }
  .drow .dv.wrap { white-space: pre-wrap; }
  .drow .dv.dim { color: var(--dim); }
  .imglink { display: inline-flex; align-items: center; gap: 7px; background: transparent; border: 0; padding: 0; color: var(--upd); cursor: pointer; font: inherit; text-align: left; word-break: break-all; }
  .imglink:hover { text-decoration: underline; }
  .imglink loom-icon { color: var(--dim); flex: none; }
  /* public ingress band: full-width list of tunnel routes serving this container */
  .ingress { border-top: 1px solid var(--line); }
  .inghead { display: flex; align-items: center; padding-right: 12px; }
  .inghead .grow { flex: 1; }
  .ingadd { display: inline-flex; align-items: center; gap: 6px; background: transparent; border: 1px solid var(--line2);
    color: var(--mid); cursor: pointer; font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: 6px 10px; }
  .ingadd:hover { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .ingadd loom-icon { color: var(--dim); } .ingadd:hover loom-icon { color: var(--upd); }
  .ingnone { padding: 4px 15px 15px; color: var(--dim); font: 12px/1.5 var(--mono); } .ingnone b { color: var(--hi); }
  .ingrows { display: flex; flex-direction: column; padding: 0 0 8px; }
  .ingrow { display: flex; align-items: stretch; border-top: 1px solid var(--line); }
  .ingrow:first-child { border-top: 0; }
  .ingrow:hover { background: var(--raised); }
  .ingmain { flex: 1; display: flex; align-items: center; gap: 10px; padding: 9px 15px; text-decoration: none; min-width: 0; }
  .ingrow .lk { color: var(--ok); flex: none; }
  .ingrow .ihost { color: var(--hi); font: 12.5px/1 var(--mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ingmain:hover .ihost { text-decoration: underline; }
  .ingrow .ihost .ipath { color: var(--upd); }
  .ingrow .arr { color: var(--faint); flex: none; }
  .ingrow .ito { color: var(--mid); font: 12px/1 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ingrow .ito .iport { color: var(--dim); }
  .ingrow .grow { flex: 1; }
  .ingrow .ext { color: var(--faint); flex: none; } .ingmain:hover .ext { color: var(--mid); }
  .ingrm { flex: none; display: inline-grid; place-items: center; width: 40px; background: transparent; border: 0;
    border-left: 1px solid var(--line); color: var(--dim); cursor: pointer; }
  .ingrm:hover { color: var(--bad); background: color-mix(in srgb, var(--bad) 10%, transparent); }
  .cpwrap { display: flex; align-items: baseline; gap: 8px; }
  .cpwrap .copy { flex: none; background: transparent; border: 0; color: var(--dim); cursor: pointer; display: inline-flex; }
  .cpwrap .copy:hover { color: var(--hi); }

  /* state / health pills — encode status in form + color, not just text */
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid var(--line2);
    font: 600 10px/1 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--mid); }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line2)); } .pill.ok::before { background: var(--ok); }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line2)); } .pill.warn::before { background: var(--warn); }
  .pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line2)); } .pill.bad::before { background: var(--bad); }

  .raw-search { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
  .raw-search loom-icon { color: var(--dim); }
  .raw-search input { flex: 1; background: transparent; border: 0; color: var(--hi); font: 12px/1 var(--mono); }
  .raw-search input:focus { outline: none; }

  /* inspect — grouped, collapsible, searchable config viewer */
  .jgroup { border-bottom: 1px solid var(--line); }
  .jghead { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 11px 14px;
    background: transparent; border: 0; color: var(--hi); font: 600 11.5px/1 var(--mono); letter-spacing: .04em; cursor: pointer; }
  .jghead:hover { background: var(--raised); }
  .jghead:disabled { cursor: default; }
  .jghead .jcaret { color: var(--dim); transition: transform .12s ease; flex: none; }
  .jghead.open .jcaret { transform: rotate(90deg); }
  .jghead .jgname { flex: 1; text-transform: uppercase; letter-spacing: .1em; font-size: 10px; color: var(--dim); }
  .jghead .jgn { font: 600 9.5px/1.4 var(--mono); color: var(--dim); border: 1px solid var(--line2); padding: 2px 7px; }
  .jgt { width: 100%; border-collapse: collapse; border-top: 1px solid var(--line); }
  .jgt td { padding: 6px 14px; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); font: 12px/1.5 var(--mono); vertical-align: top; }
  .jgt tr:last-child td { border-bottom: 0; }
  .jgt .jk { width: 34%; padding-left: 34px; color: var(--dim); white-space: nowrap; }
  .jgt .jv { color: var(--hi); word-break: break-word; }
  .jmuted { color: var(--dim); }
  .jnum { color: var(--upd); }
  .jbool { display: inline-block; padding: 1px 7px; border: 1px solid var(--line2); font: 600 9.5px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .05em; }
  .jbool.on { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line2)); }
  .jbool.off { color: var(--dim); }

  .ptable { width: 100%; border-collapse: collapse; }
  .ptable th { position: sticky; top: 0; background: var(--panel); text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line);
    color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; white-space: nowrap; }
  .ptable td { padding: 7px 14px; border-bottom: 1px solid var(--line); color: var(--mid); font: 12px/1.5 var(--mono); vertical-align: top; white-space: nowrap; }
  .ptable td.cmd { color: var(--hi); white-space: pre-wrap; word-break: break-word; }
  .ptable tr.rowlink { cursor: pointer; }
  .ptable tr.rowlink:hover td { background: var(--raised); color: var(--hi); }
  .ptable td.chev { width: 28px; text-align: right; color: var(--dim); }

  /* generic definition rows — env, labels (aligned key/value, quiet separators) */
  .rows { padding-bottom: 6px; }
  .rowi { display: grid; grid-template-columns: minmax(140px, 32%) minmax(0, 1fr); gap: 14px; padding: 7px 15px;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); font: 12px/1.55 var(--mono); align-items: baseline; }
  .rowi:hover { background: var(--raised); }
  .rowi .rk { color: var(--dim); word-break: break-all; }
  .rowi .rv { color: var(--hi); min-width: 0; word-break: break-word; white-space: pre-wrap; }
  .rowi .rv.masked { color: var(--warn); }

  /* small square tag chip (mount mode, mount type) */
  .tag { display: inline-block; padding: 2px 7px; border: 1px solid var(--line2); color: var(--dim);
    font: 600 9.5px/1.4 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
  .tag.ro { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line2)); }
  .tag.rw { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line2)); }

  .rcount { color: var(--dim); font: 11px/1 var(--mono); white-space: nowrap; }
  .raw-search .copy { flex: none; background: transparent; border: 0; color: var(--dim); cursor: pointer; display: inline-flex; }
  .raw-search .copy:hover { color: var(--hi); }

  .empty { padding: 20px 14px; color: var(--dim); font: 12px/1.4 var(--mono); }
  .empty b { color: var(--hi); }
`)
export class HopeInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(Inspector) accessor insp!: Inspector;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(NetworkDetailService) accessor networkDetail!: NetworkDetailService;
  @inject(ImageInspector) accessor imageInsp!: ImageInspector;

  @reactive accessor host = "";
  @reactive accessor id = "";
  @reactive accessor name = "";
  @reactive accessor tab: Tab = "info"; // a static tab, or `plugin:<key>` for a plugin surface
  @reactive accessor pluginsOn = false;
  @reactive accessor pluginSurfaces: Surface[] = [];
  @reactive accessor pluginNonce = 0; // bumped on plugin-tab entry to force a surface refetch
  @reactive accessor lines: string[] = [];
  @reactive accessor logQ = ""; // logs-tab search term (filter + highlight)
  @reactive accessor raw: any = null; // full docker inspect (never rendered un-redacted)
  @reactive accessor reveal = false; // operator armed secret reveal
  @reactive accessor rawQ = "";
  @reactive accessor secOpen: Record<string, boolean> = { State: true, Config: true };
  @reactive accessor cpu = "—";
  @reactive accessor mem = "—";
  @reactive accessor cpuBar = 0;
  @reactive accessor memBar = 0;
  @reactive accessor netRx = "—";
  @reactive accessor netTx = "—";
  @reactive accessor pids = "—";
  @reactive accessor procs: TopResult | null = null;
  @reactive accessor procErr = "";
  // Sibling replicas of the open container (same project+service), for the header
  // replica switcher. Empty for single-instance services.
  @reactive accessor routes: TunnelView[] = []; // public tunnel routes served by this container
  @reactive accessor canRoute = false; // tunnels enabled + at least one connector on this host
  private conns: any[] = []; // prefetched connectors (so the add-route dialog opens instantly)
  private zones: any[] = []; // prefetched zones
  @reactive accessor siblings: { id: string; number: number; state: string }[] = [];
  @reactive accessor repOpen = false;
  @reactive accessor busy = "";
  @query(".body") accessor bodyEl!: HTMLElement | null;
  private lac?: AbortController;
  private sac?: AbortController;
  private pinned = true;

  @mount
  onMount() {
    this.host = this.insp.host;
    this.id = this.insp.id;
    this.name = this.insp.name;
    const t = this.insp.takeTab();
    if (t) this.tab = t as Tab;
    this.load();
  }

  @unmount
  onUnmount() { this.lac?.abort(); this.sac?.abort(); }

  // A plugin was enabled/disabled/forgotten — refetch this container's plugin tabs.
  @on(PluginsChanged) private onPluginsChanged() { if (this.id && this.pluginsOn) this.loadSurfaces(); }

  @on(InspectorTarget)
  private onTarget(e: InspectorTarget) {
    // Honor a requested tab even when it's the same container (e.g. the logs
    // button on the already-docked container).
    const t = this.insp.takeTab() || e.tab;
    if (!e.id || e.id === this.id) {
      if (t) { this.tab = t as Tab; if (t === "logs") this.scrollLogs(); if (t === "processes") this.loadProcs(); }
      return;
    }
    this.host = e.host; this.id = e.id; this.name = e.name;
    this.pluginSurfaces = [];
    if (t) this.tab = t as Tab;
    else if (this.tab.startsWith("plugin:")) this.tab = "info"; // stale plugin tab from the previous container
    this.raw = null; this.reveal = false; this.rawQ = ""; this.logQ = ""; this.secOpen = { State: true, Config: true };
    this.cpu = "—"; this.mem = "—"; this.cpuBar = 0; this.memBar = 0;
    this.netRx = "—"; this.netTx = "—"; this.pids = "—";
    this.procs = null; this.procErr = "";
    this.routes = []; this.canRoute = false;
    this.siblings = []; this.repOpen = false;
    this.load();
  }

  private load() {
    this.startLogs();
    this.startStats();
    // Re-fetch the active tab's own data too — switching containers resets it, and
    // lazy tabs (processes) only load on tab-click, so without this they hang on
    // "loading…" after a container switch.
    if (this.tab === "processes") this.loadProcs();
    const ihost = this.host, iid = this.id;
    void this.rpc.callOn<any>(ihost, "Containers", "inspect", [iid]).then((r) => {
      if (ihost !== this.host || iid !== this.id) return; // switched away mid-flight — don't render A's config under B
      this.raw = r; if (!this.name) this.name = this.deriveName(r); this.loadSiblings();
    }).catch(() => {});
    this.loadRoutes();
    void capabilities().then((c) => { this.pluginsOn = !!c.plugins_enabled; if (this.pluginsOn) this.loadSurfaces(); });
  }

  // Enabled plugins whose container-surface match applies to this container —
  // rendered as extra tabs (the plugin's panel & metrics live here).
  private loadSurfaces = async () => {
    const host = this.host, id = this.id;
    try {
      const s = await this.rpc.call<Surface[]>("Plugins", "surfaces", [{ host, container_id: id }]);
      if (host === this.host && id === this.id) this.pluginSurfaces = s || [];
    } catch {
      if (host === this.host && id === this.id) this.pluginSurfaces = [];
    }
  };

  // Tunnel routes whose origin resolves to THIS container — so the info tab can
  // show where it's publicly served and add a new route. Best-effort (tunnels may
  // be disabled → canRoute stays false and the section hides).
  private async loadRoutes() {
    try {
      const [rs, cons, zones] = await Promise.all([
        this.rpc.callOn<TunnelView[]>(this.host, "Tunnels", "tunnels", []),
        this.rpc.callOn<any[]>(this.host, "Tunnels", "connectors", []).catch(() => []),
        this.rpc.callOn<any[]>(this.host, "Tunnels", "zones", []).catch(() => []),
      ]);
      this.routes = (rs || []).filter((r) => r.container_id && r.container_id === this.id);
      this.conns = cons || [];
      this.zones = zones || [];
      this.canRoute = this.conns.length > 0;
    } catch { this.routes = []; this.conns = []; this.zones = []; this.canRoute = false; }
  }

  // Add a public route to this container, from the container viewer (so ingress is
  // managed where the container lives, not a separate stack modal). Targets the
  // compose service when labeled, else this loose container by id.
  private addRoute = async () => {
    const L = this.raw?.Config?.Labels || {};
    const project = L["com.docker.compose.project"] || "";
    const service = L["com.docker.compose.service"] || "";
    const ports = Object.keys(this.raw?.Config?.ExposedPorts || {});
    const base = { host: this.host, ports, connectors: this.conns, zones: this.zones };
    const ok = await promptAddRoute(
      { rpc: this.rpc, prompt: this.prompt, proc: this.proc, toast: this.toast },
      project && service
        ? { ...base, project, service, label: service }
        : { ...base, container: this.id, label: this.name || shortId(this.id) },
    );
    if (ok) this.loadRoutes();
  };

  // Remove a public route from the container viewer (drops its ingress + DNS).
  private removeRoute = async (r: TunnelView, e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await this.confirm.ask({
      title: "remove route",
      danger: true,
      confirmLabel: "Remove",
      message: `Remove the route ${r.hostname}${r.path || ""}? Drops the tunnel ingress rule and deletes its DNS record.`,
    });
    if (!ok) return;
    await this.proc.run(`remove route ${r.hostname}`, async (emit) => {
      try {
        emit("dropping ingress rule + DNS…");
        await this.rpc.callOn(this.host, "Tunnels", "removeTunnel", [r.hostname, r.path || ""]);
        emit("removed");
        return true;
      } catch (err: any) {
        emit("failed: " + (err?.message ?? "error"));
        return false;
      }
    });
    this.loadRoutes();
  };

  // On a cold deep-link/refresh the panel opens before the stack list resolves,
  // so name is empty — derive it from the container's own inspect (compose service
  // label, else the docker name) instead of showing the "container" fallback.
  private deriveName(r: any): string {
    return r?.Config?.Labels?.["com.docker.compose.service"] || (r?.Name || "").replace(/^\//, "") || "";
  }

  // Populate the replica switcher: other containers of this project+service. Only
  // a multi-replica service yields a list (single-instance → no dropdown).
  private async loadSiblings() {
    const L = this.raw?.Config?.Labels || {};
    const proj = L["com.docker.compose.project"];
    const svc = L["com.docker.compose.service"];
    if (!proj || !svc) { this.siblings = []; return; }
    try {
      const stacks = await this.rpc.callOn<any[]>(this.host, "Stacks", "list", []);
      const reps = ((stacks || []).find((s) => s.project === proj)?.containers ?? []).filter((c: any) => c.service === svc);
      this.siblings = reps.length > 1
        ? reps.map((c: any) => ({ id: c.id, number: c.number ?? 0, state: c.state })).sort((a: any, b: any) => a.number - b.number)
        : [];
    } catch { this.siblings = []; }
  }

  // Switch the panel to another replica — via the URL, so the row + address bar
  // follow. Close the dropdown first.
  private switchRep = (id: string) => {
    this.repOpen = false;
    if (id !== this.id) this.insp.select(this.host, this.insp.project, id, this.name);
  };
  private toggleRep = (e: Event) => { e.stopPropagation(); this.repOpen = !this.repOpen; };

  @on(document, "click")
  private closeRep() { if (this.repOpen) this.repOpen = false; }

  private repTone(state: string): string {
    if (state === "running") return "ok";
    if (state === "restarting") return "bad";
    return "off";
  }
  private curSib() { return this.siblings.find((s) => s.id === this.id); }
  // From the compose label so it's present the instant `raw` loads (no wait on the
  // sibling list) — that async wait was the source of the header pop-in.
  private curNumber(): number | string {
    return this.curSib()?.number ?? this.raw?.Config?.Labels?.["com.docker.compose.container-number"] ?? "";
  }
  private curState(): string { return this.curSib()?.state || this.raw?.State?.Status || ""; }

  private pick = (t: Tab) => { this.tab = t; if (t === "logs") this.scrollLogs(); if (t === "processes") this.loadProcs(); if (t.startsWith("plugin:")) this.pluginNonce++; };

  // docker top — live process list. Redacted like everything else: the command
  // column is argv and can carry --token=… secrets, unmasked only when armed.
  private loadProcs = async () => {
    this.procErr = "";
    try {
      this.procs = await this.rpc.callOn<TopResult>(this.host, "Containers", "top", [this.id]);
    } catch (e: any) {
      this.procs = null;
      this.procErr = e?.message ?? "container is not running";
    }
  };

  // The command/argv column (docker top titles it CMD/COMMAND/ARGS) — the only
  // secret-bearing one; falls back to the last column.
  private cmdColIdx(titles: string[]): number {
    const i = titles.findIndex((t) => /^(cmd|command|args?)$/i.test(t.trim()));
    return i === -1 ? titles.length - 1 : i;
  }

  // The inspect object every view reads from — redacted unless the operator armed
  // reveal. Nothing derives from this.raw directly.
  private view(): any {
    if (!this.raw) return null;
    return this.reveal ? this.raw : redactInspect(this.raw);
  }

  private startLogs() {
    this.lac?.abort();
    this.lines = [];
    if (!this.id) return;
    const ac = new AbortController();
    this.lac = ac;
    void (async () => {
      try {
        for await (const f of this.rpc.streamWithSignal<LogFrame>("Stream", "logs", [this.id], ac.signal, this.host)) {
          if (f.type === "ping") continue;
          const next = this.lines.concat(stripAnsi(f.data).replace(/\n$/, ""));
          this.lines = next.length > 500 ? next.slice(next.length - 500) : next;
          this.scrollLogs();
        }
      } catch { /* aborted/closed */ }
    })();
  }

  private startStats() {
    this.sac?.abort();
    if (!this.id) return;
    const ac = new AbortController();
    this.sac = ac;
    void (async () => {
      try {
        for await (const s of this.rpc.streamWithSignal<any>("Stream", "stats", [this.id], ac.signal, this.host)) {
          this.applyStats(s);
        }
      } catch { /* aborted/closed */ }
    })();
  }

  private applyStats(s: any) {
    const p = parseStats(s);
    if (p.cpu !== undefined) { this.cpu = p.cpu; this.cpuBar = p.cpuBar!; }
    if (p.mem !== undefined) { this.mem = p.mem; this.memBar = p.memBar!; }
    if (p.rx !== undefined) { this.netRx = p.rx; this.netTx = p.tx!; }
    if (s?.pids_stats?.current != null) this.pids = String(s.pids_stats.current);
  }

  private command(): string {
    const cfg = this.raw?.Config || {};
    const s = ([...(cfg.Entrypoint || []), ...(cfg.Cmd || [])]).join(" ");
    return this.reveal ? s : redactCmd(s);
  }

  private onScroll = () => {
    const el = this.bodyEl;
    if (el) this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  private scrollLogs() {
    if (this.tab !== "logs" || !this.pinned) return;
    requestAnimationFrame(() => { const el = this.bodyEl; if (el) el.scrollTop = el.scrollHeight; });
  }

  // Wrap each case-insensitive occurrence of `q` in <mark> so a search term stands
  // out in place. Returns the plain string when there's nothing to highlight.
  private highlight(text: string, q: string): any {
    if (!q) return text;
    const low = text.toLowerCase();
    const ql = q.toLowerCase();
    const out: any[] = [];
    let i = 0;
    for (let idx = low.indexOf(ql); idx !== -1; idx = low.indexOf(ql, i)) {
      if (idx > i) out.push(text.slice(i, idx));
      out.push(<mark>{text.slice(idx, idx + q.length)}</mark>);
      i = idx + q.length;
    }
    if (i < text.length) out.push(text.slice(i));
    return out;
  }

  private op = async (o: string) => {
    if (this.busy) return;
    const label = o === "redeploy" ? "Redeploy" : o === "restart" ? "Restart" : o === "stop" ? "Stop" : o;
    const ok = await this.confirm.ask({
      title: label + " container",
      danger: o === "stop" || o === "redeploy",
      confirmLabel: label + " " + this.name,
      message: o === "redeploy"
        ? `Redeploy "${this.name}"? Pulls the latest image and recreates the container.`
        : `${label} "${this.name}"?`,
    });
    if (!ok) return;
    this.busy = o;
    void withRefresh(async () => {
      try {
        await this.rpc.callOn(this.host, "Containers", o, [this.id]);
        // Redeploy recreates the container → new id. Hop the panel to it (same
        // stack/service/replica) so the URL and inspector follow, like the old UI.
        if (o === "redeploy") {
          const nid = await this.findRecreated();
          if (nid && nid !== this.id) this.insp.select(this.host, this.insp.project, nid, this.name);
          else this.insp.close();
        }
      } finally {
        this.busy = "";
      }
    });
  };

  // After a recreate, resolve the new container id for the same project/service/
  // replica from the current inspect labels.
  private async findRecreated(): Promise<string> {
    const L = this.raw?.Config?.Labels || {};
    const proj = L["com.docker.compose.project"];
    const svc = L["com.docker.compose.service"];
    const num = L["com.docker.compose.container-number"];
    if (!proj || !svc) return "";
    try {
      const stacks = await this.rpc.callOn<any[]>(this.host, "Stacks", "list", []);
      const st = (stacks || []).find((s) => s.project === proj);
      const reps = (st?.containers ?? []).filter((c: any) => c.service === svc);
      const match = reps.find((c: any) => String(c.number ?? "") === String(num ?? "")) || reps[0];
      return match?.id ?? "";
    } catch {
      return "";
    }
  }

  // One labeled detail row inside a .dcol. Renders "—" dimmed when empty.
  private row(k: string, v: any, cls = "") {
    const empty = v == null || v === "" || v === "—";
    return <div class="drow"><div class="dk">{k}</div><div class={"dv " + cls + (empty ? " dim" : "")}>{empty ? "—" : v}</div></div>;
  }

  // Map a docker state/health word to a pill tone (ok/warn/bad/neutral).
  private stateTone(s: string): string {
    const w = (s || "").toLowerCase();
    if (w === "running") return "ok";
    if (w === "restarting" || w === "created" || w === "paused" || w === "removing") return "warn";
    if (w === "exited" || w === "dead") return "bad";
    return "";
  }
  private healthTone(s: string): string {
    const w = (s || "").toLowerCase();
    if (w === "healthy") return "ok";
    if (w === "unhealthy") return "bad";
    if (w === "starting") return "warn";
    return "";
  }
  private pill(text: string, tone: string) {
    return <span class={"pill " + tone}>{text}</span>;
  }
  private copyId = () => { navigator.clipboard?.writeText(this.id).catch(() => {}); };

  // fmtVal renders a leaf value as readable JSX (boolean pills, dim null, numbers).
  private fmtVal(x: any): any {
    if (x === null || x === undefined || x === "") return <span class="jmuted">—</span>;
    if (typeof x === "boolean") return <span class={"jbool " + (x ? "on" : "off")}>{String(x)}</span>;
    if (typeof x === "number") return <span class="jnum">{x}</span>;
    return String(x);
  }

  // The grouped, collapsible, searchable inspect viewer (ported from the old
  // container page). `v` is the already-redacted inspect object.
  private renderInspect(v: any) {
    const rows = flatten(v);
    const q = this.rawQ.trim().toLowerCase();
    const filtered = q ? rows.filter(([k, val]) => k.toLowerCase().includes(q) || String(val).toLowerCase().includes(q)) : rows;
    const groups = new Map<string, [string, any][]>();
    for (const [k, val] of filtered) {
      const dot = k.indexOf(".");
      const top = dot === -1 ? k : k.slice(0, dot);
      const rest = dot === -1 ? "" : k.slice(dot + 1);
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top)!.push([rest, val]);
    }
    const PRIORITY = ["State", "Config", "HostConfig", "NetworkSettings", "Mounts", "Name", "Image", "Created", "RestartCount"];
    const sections = [...groups.keys()].sort((a, b) => {
      const ia = PRIORITY.indexOf(a);
      const ib = PRIORITY.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });
    return (
      <div class="jview">
        <div class="raw-search">
          <loom-icon name="search" size={13}></loom-icon>
          <input placeholder="filter keys and values…" value={this.rawQ} onInput={(e: any) => (this.rawQ = e.target.value)} />
          <span class="rcount">{filtered.length} field{filtered.length === 1 ? "" : "s"}</span>
        </div>
        {sections.length === 0 ? <div class="empty">no matches</div> : null}
        {sections.map((top) => {
          const list = groups.get(top)!;
          const open = !!q || !!this.secOpen[top];
          return (
            <div class="jgroup">
              <button class={"jghead" + (open ? " open" : "")} disabled={!!q} onClick={() => (this.secOpen = { ...this.secOpen, [top]: !open })}>
                <loom-icon class="jcaret" name="chevron-right" size={13}></loom-icon>
                <span class="jgname">{top}</span>
                <span class="jgn">{list.length}</span>
              </button>
              {open ? (
                <table class="jgt"><tbody>{list.map(([k, val]) => <tr><td class="jk">{k || top}</td><td class="jv">{this.fmtVal(val)}</td></tr>)}</tbody></table>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  private renderBody() {
    const t = this.tab;
    if (t.startsWith("plugin:")) {
      const s = this.pluginSurfaces.find((x) => `plugin:${x.key}` === t);
      return s ? <hope-plugin-surface host={this.host} surface={s} reloadTick={this.pluginNonce}></hope-plugin-surface> : <div class="empty">plugin panel unavailable</div>;
    }
    if (t === "logs") {
      const term = this.logQ.trim();
      const q = term.toLowerCase();
      const parsed = this.lines.map((l) => parseLogLine(l));
      const shown = q ? parsed.filter((p) => p.msg.toLowerCase().includes(q) || (p.ts && p.ts.toLowerCase().includes(q))) : parsed;
      return (
        <>
          <div class="raw-search">
            <loom-icon name="search" size={13}></loom-icon>
            <input placeholder="search logs&hellip;" value={this.logQ} onInput={(e: any) => (this.logQ = e.target.value)} />
            {q ? <button class="copy" title="clear" onClick={() => (this.logQ = "")}><loom-icon name="x" size={13}></loom-icon></button> : null}
            <span class="rcount">{q ? `${shown.length} / ${parsed.length}` : `${parsed.length} line${parsed.length === 1 ? "" : "s"}`}</span>
          </div>
          <div class="log">
            {parsed.length === 0 ? (
              <div class="empty">Waiting for output&hellip;</div>
            ) : shown.length === 0 ? (
              <div class="empty">No lines match &ldquo;{term}&rdquo;.</div>
            ) : shown.map((p) => (
              <div class="ln">{p.ts ? <span class="lts">{p.ts}</span> : null}<span class="lmsg">{q ? this.highlight(p.msg, term) : p.msg}</span></div>
            ))}
            {shown.length > 0 && !q ? <span class="cursor"></span> : null}
          </div>
        </>
      );
    }
    const v = this.view();
    if (!v) return <div class="empty">loading&hellip;</div>;
    const cfg = v.Config || {};
    const st = v.State || {};

    if (t === "info") {
      const state = st.Status || "—";
      const health = st.Health?.Status || "";
      const started = friendlyTime(st.StartedAt);
      const memBad = this.memBar >= 90;
      const memWarn = this.memBar >= 75;
      const cpuBad = this.cpuBar >= 90;
      const cpuWarn = this.cpuBar >= 75;
      const cmd = this.command();
      const entry = (cfg.Entrypoint || []).join(" ");
      return (
        <div class="info">
          <div class="vitals">
            <div class={"vital" + (cpuBad ? " bad" : cpuWarn ? " warn" : "")}>
              <div class="vk">cpu</div>
              <div class="vv">{this.cpu}</div>
              <div class="vbar"><i style={`width:${this.cpuBar}%`}></i></div>
            </div>
            <div class={"vital" + (memBad ? " bad" : memWarn ? " warn" : "")}>
              <div class="vk">memory</div>
              <div class="vv">{this.mem}</div>
              <div class="vbar"><i style={`width:${this.memBar}%`}></i></div>
            </div>
            <div class="vital"><div class="vk">net in</div><div class="vv"><loom-icon name="arrow-down" size="13"></loom-icon>{this.netRx}</div></div>
            <div class="vital"><div class="vk">net out</div><div class="vv"><loom-icon name="arrow-up" size="13"></loom-icon>{this.netTx}</div></div>
            <div class="vital"><div class="vk">pids</div><div class="vv">{this.pids}</div></div>
            <div class="vital"><div class="vk">uptime</div><div class="vv">{uptime(st.StartedAt)}</div></div>
          </div>
          <div class="dgrid">
            <div class="dcol">
              <div class="dtitle">runtime</div>
              <div class="drow"><div class="dk">state</div><div class="dv">{this.pill(state, this.stateTone(state))}</div></div>
              <div class="drow"><div class="dk">health</div><div class="dv">{health ? this.pill(health, this.healthTone(health)) : <span class="dim">none</span>}</div></div>
              {this.row("started", started)}
              {this.row("restarts", v.RestartCount ?? 0)}
            </div>
            <div class="dcol">
              <div class="dtitle">identity</div>
              <div class="drow"><div class="dk">image</div><div class="dv">{cfg.Image ? <button class="imglink" onClick={() => this.imageInsp.select(this.host, this.raw?.Image || cfg.Image)}>{cfg.Image}<loom-icon name="box" size={12}></loom-icon></button> : <span class="dim">—</span>}</div></div>
              <div class="drow">
                <div class="dk">id</div>
                <div class="dv"><span class="cpwrap">{shortId(this.id)}<hope-tip text="copy full id"><button class="copy" onClick={this.copyId}><loom-icon name="copy" size="13"></loom-icon></button></hope-tip></span></div>
              </div>
              {this.row("name", this.name)}
              {this.row("host", this.host)}
            </div>
            <div class="dcol">
              <div class="dtitle">execution</div>
              {this.row("command", cmd, "wrap")}
              {this.row("entrypoint", entry, "wrap")}
              {this.row("working dir", cfg.WorkingDir)}
              {this.row("user", cfg.User)}
            </div>
          </div>
          {this.canRoute || this.routes.length ? (
            <div class="ingress">
              <div class="inghead">
                <span class="dtitle">public ingress{this.routes.length ? " · " + this.routes.length : ""}</span>
                <span class="grow"></span>
                {this.canRoute ? <button class="ingadd" onClick={this.addRoute}><loom-icon name="plus" size={12}></loom-icon> add route</button> : null}
              </div>
              {this.routes.length ? (
                <div class="ingrows">
                  {this.routes.map((r) => (
                    <div class="ingrow">
                      <a class="ingmain" href={`https://${r.hostname}${r.path || ""}`} target="_blank" rel="noreferrer">
                        <loom-icon class="lk" name="lock" size={13}></loom-icon>
                        <span class="ihost">{r.hostname}{r.path ? <span class="ipath">{r.path}</span> : null}</span>
                        <loom-icon class="arr" name="arrow-right" size={13}></loom-icon>
                        <span class="ito">{r.svc_name || r.container || "this container"}{r.port ? <span class="iport">:{r.port}</span> : null}</span>
                        <span class="grow"></span>
                        <loom-icon class="ext" name="link" size={13}></loom-icon>
                      </a>
                      <hope-tip text="remove route" pos="bottom-end"><button class="ingrm" onClick={(e: Event) => this.removeRoute(r, e)}><loom-icon name="trash" size={13}></loom-icon></button></hope-tip>
                    </div>
                  ))}
                </div>
              ) : (
                <div class="ingnone">Not publicly routed. <b>Add a route</b> to expose it through a Cloudflare tunnel.</div>
              )}
            </div>
          ) : null}
        </div>
      );
    }
    if (t === "processes") {
      if (this.procErr) return <div class="empty">{this.procErr}</div>;
      if (!this.procs) return <div class="empty">loading&hellip;</div>;
      const titles = this.procs.titles || [];
      const cmdCol = this.cmdColIdx(titles);
      const rows = this.procs.processes || [];
      if (!rows.length) return <div class="empty">no processes</div>;
      return (
        <table class="ptable">
          <thead><tr>{titles.map((h) => <th>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr>{r.map((c, i) => <td class={i === cmdCol ? "cmd" : ""}>{i === cmdCol && !this.reveal ? redactCmd(c) : c}</td>)}</tr>)}</tbody>
        </table>
      );
    }
    if (t === "env") {
      const env: string[] = cfg.Env || [];
      if (!env.length) return <div class="empty">no environment variables</div>;
      return <div class="rows">{env.map((e) => {
        const i = e.indexOf("=");
        const k = i < 0 ? e : e.slice(0, i);
        const val = i < 0 ? "" : e.slice(i + 1);
        const masked = val.includes("•");
        return <div class="rowi"><div class="rk">{k}</div>{val ? <div class={"rv" + (masked ? " masked" : "")}>{val}</div> : <div class="rv dim">(empty)</div>}</div>;
      })}</div>;
    }
    if (t === "mounts") {
      const mounts: any[] = v.Mounts || [];
      if (!mounts.length) return <div class="empty">no mounts</div>;
      return (
        <table class="ptable">
          <thead><tr><th>type</th><th>source</th><th>destination</th><th>mode</th></tr></thead>
          <tbody>{mounts.map((m) => {
            const ro = m.RW === false;
            return (
              <tr>
                <td>{m.Type || (m.Name ? "volume" : "bind")}</td>
                <td class="cmd">{m.Name || m.Source || "—"}</td>
                <td class="cmd">{m.Destination || "—"}</td>
                <td><span class={"tag " + (ro ? "ro" : "rw")}>{ro ? "ro" : "rw"}</span></td>
              </tr>
            );
          })}</tbody>
        </table>
      );
    }
    if (t === "networks") {
      const nets = v.NetworkSettings?.Networks || {};
      const keys = Object.keys(nets);
      if (!keys.length) return <div class="empty">no networks</div>;
      return (
        <table class="ptable">
          <thead><tr><th>network</th><th>ip address</th><th>gateway</th><th>mac</th><th></th></tr></thead>
          <tbody>{keys.map((n) => {
            const d = nets[n] || {};
            return (
              <tr class="rowlink" onClick={() => this.networkDetail.open({ host: this.host, ref: n })}>
                <td class="cmd">{n}</td>
                <td>{d.IPAddress ? d.IPAddress + (d.IPPrefixLen ? "/" + d.IPPrefixLen : "") : "—"}</td>
                <td>{d.Gateway || "—"}</td>
                <td>{d.MacAddress || "—"}</td>
                <td class="chev"><loom-icon name="chevron-right" size={12}></loom-icon></td>
              </tr>
            );
          })}</tbody>
        </table>
      );
    }
    if (t === "labels") {
      const labels = cfg.Labels || {};
      const keys = Object.keys(labels).sort();
      if (!keys.length) return <div class="empty">no labels</div>;
      return <div class="rows">{keys.map((k) => <div class="rowi"><div class="rk">{k}</div><div class="rv">{labels[k] || <span class="dim">(empty)</span>}</div></div>)}</div>;
    }
    // inspect — the full config flattened to dotted paths, grouped by top-level
    // section (State, Config, NetworkSettings…) into collapsible tables, with a
    // key+value filter. Values already redacted via view().
    return this.renderInspect(v);
  }

  update() {
    if (!this.id) return <div class="empty">Select a container.</div>;
    return (
      <>
        <div class="bar">
          <div class="who">
            {(() => {
              const multi = this.siblings.length > 1;
              const num = this.curNumber();
              return (
                <div class={"repsel" + (multi ? " multi" : "")}>
                  <button class="rtrig" disabled={!multi} onClick={multi ? this.toggleRep : undefined}>
                    <span class={"dot " + this.repTone(this.curState())}></span>
                    <span class="nm">{this.name || "container"}</span>
                    {num !== "" ? <span class="rnum">#{num}</span> : null}
                    <loom-icon class="rcaret" name="chevron-down" size={11}></loom-icon>
                  </button>
                  {multi && this.repOpen ? (
                    <div class="rmenu" onClick={(e: Event) => e.stopPropagation()}>
                      {this.siblings.map((s) => (
                        <button class={"ropt" + (s.id === this.id ? " on" : "")} onClick={() => this.switchRep(s.id)}>
                          <span class={"dot " + this.repTone(s.state)}></span>
                          <span class="nm">{this.name}</span>
                          <span class="rnum">#{s.number}</span>
                          <span class="sub">{s.id.slice(0, 10)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })()}
            <span class="sub">{this.host} &middot; {this.id.slice(0, 10)}</span>
          </div>
          <div class="tabs">
            {TABS.map((t) => <span class={"tab" + (this.tab === t ? " on" : "")} onClick={() => this.pick(t)}>{t}</span>)}
            {this.pluginSurfaces.map((s) => {
              const t: Tab = `plugin:${s.key}`;
              return <span class={"tab" + (this.tab === t ? " on" : "")} onClick={() => this.pick(t)}>{s.title || s.name}</span>;
            })}
          </div>
          <span class="grow"></span>
          <div class="acts">
            <hope-tip text={this.reveal ? "hide secrets" : "reveal secrets (env, tokens, command)"} pos="bottom-end">
              <button class={"pa caution" + (this.reveal ? " armed" : "")} onClick={() => (this.reveal = !this.reveal)}><loom-icon name={this.reveal ? "x" : "alert"} size={14}></loom-icon></button>
            </hope-tip>
            <hope-tip text="restart" pos="bottom-end"><button class="pa" disabled={!!this.busy} onClick={() => this.op("restart")}><loom-icon name="rotate" size={14}></loom-icon></button></hope-tip>
            <hope-tip text="redeploy (pull + recreate)" pos="bottom-end"><button class="pa" disabled={!!this.busy} onClick={() => this.op("redeploy")}><loom-icon name="redeploy" size={14}></loom-icon></button></hope-tip>
            <hope-tip text="stop" pos="bottom-end"><button class="pa danger" disabled={!!this.busy} onClick={() => this.op("stop")}><loom-icon name="stop" size={14}></loom-icon></button></hope-tip>
            <hope-tip text="close" pos="bottom-end"><button class="pa" onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></button></hope-tip>
          </div>
        </div>
        <div class="body" onScroll={this.onScroll}>{this.renderBody()}</div>
      </>
    );
  }
}
