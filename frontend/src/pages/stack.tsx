// Stack detail — control surface. One project's containers, stack lifecycle,
// and (when readable) the compose file. Terminal-instrument styling.
import { LoomElement, component, styles, css, reactive, mount, unmount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import type { StackSummary, ContainerSummary, ContainerOp, StackOp, OpResult, ComposeFileResult, LogFrame } from "../contracts";
import { theme, markClass, stackSeverity } from "../styles";
import { stripAnsi } from "./container";

// One fixed action order for every row (single, replica, group) so columns line
// up. Actions that don't apply to a container's state are disabled, not
// reordered or removed.
const ROW_ACTIONS: { op: ContainerOp; label: string; danger?: boolean }[] = [
  { op: "start", label: "start" },
  { op: "restart", label: "restart" },
  { op: "stop", label: "stop", danger: true },
  { op: "kill", label: "kill", danger: true },
];

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

const STACK_OPS: { op: StackOp; label: string; danger?: boolean }[] = [
  { op: "restart", label: "restart" },
  { op: "redeploy", label: "redeploy" },
  { op: "pull", label: "pull" },
  { op: "start", label: "start" },
  { op: "stop", label: "stop", danger: true },
];

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
  .toolbar { display: flex; flex-wrap: wrap; gap: 7px; margin-left: auto; }

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

  table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); }
  thead th { font: 600 10px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); }
  tbody td { padding: 0 14px; height: 46px; border-bottom: 1px solid var(--line); font: 13px/1.3 var(--mono); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--raised); }
  td.svc .cell { display: flex; align-items: center; gap: 10px; }
  td.svc a:hover { color: #fff; }
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
  .badge { border: 1px solid var(--line2); color: var(--mid); font-size: 11px; padding: 2px 7px; }
  tr.grp:hover .badge { border-color: var(--mid); color: var(--hi); }
  /* replica (child) rows are indented + dimmer */
  tr.rep td { background: rgba(255,255,255,.012); }
  td.svc.rep .cell { padding-left: 26px; }
  td.svc.rep a { color: var(--mid); }
  .repn { color: var(--faint); margin-left: 7px; }
  td.state { color: var(--mid); white-space: nowrap; }
  td.statusc { color: var(--dim); white-space: nowrap; }
  td.ports { color: var(--faint); font-size: 12px; white-space: nowrap;
    max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .cacts { display: flex; gap: 6px; justify-content: flex-end; }
  .cacts .btn { padding: 5px 8px; font-size: 11px; }

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
  private logsCtrl: AbortController | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private showToast(msg: string, kind = "") {
    this.toast = msg;
    this.toastKind = kind;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = ""), 2800);
  }

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    const m = location.pathname.match(/^\/stack\/(.+)$/);
    this.project = m ? decodeURIComponent(m[1]) : "";
    this.load();
  }

  private async load() {
    try {
      const all = await this.rpc.call<StackSummary[]>("Stacks", "list", []);
      this.stack = all.find((s) => s.project === this.project) ?? null;
      this.error = this.stack ? "" : `Stack "${this.project}" not found.`;
    } catch (err: any) {
      this.error = err?.message ?? "Failed to load.";
    }
  }

  private stackOp = async (op: StackOp) => {
    if (op === "stop" || op === "redeploy") {
      const ok = await this.confirm.ask({
        title: op,
        danger: op === "stop",
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
    if (op === "stop" || op === "kill") {
      const ok = await this.confirm.ask({
        title: op,
        danger: true,
        confirmLabel: op === "kill" ? "Kill" : "Stop",
        message: `${op === "kill" ? "Kill" : "Stop"} "${label}"?`,
      });
      if (!ok) return;
    }
    this.runContainerOp(id, op, label);
  };

  private runContainerOp = async (id: string, op: ContainerOp, label: string) => {
    this.busy = `${id}:${op}`;
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

  private groupOp = async (g: Group, op: ContainerOp, e: Event) => {
    e.stopPropagation();
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
          <div class="s"><loom-link href="/" class="back">‹ fleet</loom-link></div>
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
                    {STACK_OPS.map((a) => (
                      <button class={"btn" + (a.danger ? " danger" : "")} disabled={!!this.busy} onClick={() => this.stackOp(a.op)}>
                        {this.busy === `stack:${a.op}` ? `${a.label}…` : a.label}
                      </button>
                    ))}
                    <button class="btn" onClick={(e: Event) => this.openLogs("stackLogs", [s.project], `${s.project} · all logs`, e)}>logs</button>
                    {s.compose_available ? <button class="btn" onClick={this.viewCompose}>compose</button> : null}
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
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>State</th>
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
                        <tr>
                          <td class="svc">
                            <span class="cell">
                              <span class={"mark " + markClass(c.state)}></span>
                              <loom-link href={`/container/${encodeURIComponent(c.id)}`}>{c.service || c.name}</loom-link>
                            </span>
                          </td>
                          <td class="state">{c.state}</td>
                          <td class="statusc">{c.status}</td>
                          <td class="ports">{(c.ports || []).join(", ") || "—"}</td>
                          <td>
                            <div class="cacts">
                              <button class="btn" onClick={() => this.openLogs("logs", [c.id], c.service || c.name)}>logs</button>
                              {ROW_ACTIONS.map((a) => (
                                <button class={"btn" + (a.danger ? " danger" : "")} disabled={!!this.busy || !actionEnabled(c.state, a.op)} onClick={() => this.containerOp(c.id, a.op, c.service || c.name)}>
                                  {this.busy === `${c.id}:${a.op}` ? "…" : a.label}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>,
                      ];
                    }

                    const running = g.items.filter((c) => c.state === "running").length;
                    const open = !!this.expanded[g.service];
                    const rows = [
                      <tr class={"grp" + (open ? " open" : "")} onClick={() => this.toggle(g.service)}>
                        <td class="svc">
                          <span class="cell">
                            <loom-icon class="caret" name="chevron-right" size={13}></loom-icon>
                            <span class={"mark " + aggMark(g.items)}></span>
                            <span class="gname">{g.service}</span>
                            <span class="badge">{g.items.length} replicas</span>
                          </span>
                        </td>
                        <td class="state">{running}/{g.items.length} up</td>
                        <td class="statusc"></td>
                        <td class="ports"></td>
                        <td>
                          <div class="cacts">
                            <button class="btn" onClick={(e: Event) => this.openLogs("serviceLogs", [s.project, g.service], `${s.project}/${g.service}`, e)}>logs</button>
                            {ROW_ACTIONS.map((a) => (
                              <button class={"btn" + (a.danger ? " danger" : "")} disabled={!!this.busy} onClick={(e: Event) => this.groupOp(g, a.op, e)}>
                                {this.busy === `grp:${g.service}:${a.op}` ? `${a.label}…` : a.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>,
                    ];
                    if (open) {
                      for (const c of g.items) {
                        rows.push(
                          <tr class="rep">
                            <td class="svc rep">
                              <span class="cell">
                                <span class={"mark " + markClass(c.state)}></span>
                                <loom-link href={`/container/${encodeURIComponent(c.id)}`}>
                                  {c.service || c.name}
                                  <span class="repn">#{c.number || "—"}</span>
                                </loom-link>
                              </span>
                            </td>
                            <td class="state">{c.state}</td>
                            <td class="statusc">{c.status}</td>
                            <td class="ports">{(c.ports || []).join(", ") || "—"}</td>
                            <td>
                              <div class="cacts">
                                <button class="btn" onClick={() => this.openLogs("logs", [c.id], `${c.service || c.name} #${c.number}`)}>logs</button>
                                {ROW_ACTIONS.map((a) => (
                                  <button class={"btn" + (a.danger ? " danger" : "")} disabled={!!this.busy || !actionEnabled(c.state, a.op)} onClick={() => this.containerOp(c.id, a.op, c.service || c.name)}>
                                    {this.busy === `${c.id}:${a.op}` ? "…" : a.label}
                                  </button>
                                ))}
                              </div>
                            </td>
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
