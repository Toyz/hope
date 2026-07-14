// <hope-connector-inspector> — the docked bottom panel for a Cloudflare tunnel
// connector, opened from a tunnels-page connector band (like the container/image/
// volume/network inspectors, not a modal). Two columns: identity (status/conns/
// routes/tunnel-id/edge/cloudflared) + the networks it's attached to and the
// routes it serves. Self-fetches the connector via Tunnels.connectors on its host.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { ConnectorInspector } from "../connector-inspector";
import { NetworkInspector } from "../network-inspector";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import { ToastService } from "../toast";
import { PromptService } from "../prompt";
import { ConnectorInspectorTarget } from "../events";
import { stackPath, containerPath } from "../host-url";
import type { ConnectorView, TunnelView, OpResult, OpFrame } from "../contracts";
import { theme } from "../styles";

const short = (id: string) => (id && id.length > 12 ? id.slice(0, 12) : id || "—");

@component("hope-connector-inspector")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }

  .bar { display: flex; align-items: stretch; height: 38px; flex: none; border-bottom: 1px solid var(--line); }
  .who { display: flex; align-items: center; gap: 9px; padding: 0 15px; border-right: 1px solid var(--line); min-width: 0; }
  .who loom-icon { color: var(--dim); flex: none; }
  .who .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
  .who .dot.warn { background: var(--warn); } .who .dot.off { background: var(--bad); }
  .who .nm { font: 700 12.5px/1 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who .sub { color: var(--dim); font: 500 10px/1 var(--mono); flex: none; }
  .grow { flex: 1; }
  .acts { display: flex; align-items: stretch; border-left: 1px solid var(--line); }
  .pa { display: inline-grid; place-items: center; width: 40px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .pa:hover { color: var(--hi); background: var(--raised); }
  .pa.upd:hover { color: var(--warn); } .pa.danger:hover { color: var(--bad); }
  .pa:disabled { opacity: .4; cursor: default; }

  .body { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-columns: minmax(320px, 44%) minmax(0, 1fr); }
  .col { min-width: 0; min-height: 0; overflow-y: auto; border-right: 1px solid var(--line); }
  .col:last-child { border-right: 0; }
  .ctitle { padding: 13px 15px 9px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .ctitle.sep { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 13px; }
  .row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 5px 15px; font: 12px/1.5 var(--mono); align-items: baseline; }
  .row .k { color: var(--dim); }
  .row .v { color: var(--hi); min-width: 0; word-break: break-all; font-variant-numeric: tabular-nums; }
  .row .v.ok { color: var(--ok); } .row .v.warn { color: var(--warn); } .row .v.bad { color: var(--bad); }
  .row .v.dim { color: var(--dim); }
  .cols { display: flex; flex-wrap: wrap; gap: 6px; }
  .colo { font: 600 10px/1.6 var(--mono); letter-spacing: .08em; color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line2)); padding: 2px 7px; }
  .nets { display: flex; flex-wrap: wrap; gap: 7px; padding: 2px 15px 14px; }
  .netchip { display: inline-flex; align-items: center; gap: 6px; font: 11.5px/1 var(--mono); color: var(--mid);
    background: transparent; border: 1px solid var(--line); padding: 5px 9px; cursor: pointer; }
  .netchip:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .netchip loom-icon { color: var(--dim); } .netchip:hover loom-icon { color: var(--hi); }

  /* routes table — mirrors the tunnels-page route rows, sized for the panel */
  .rhead, .ub { display: grid; grid-template-columns: minmax(0, 1.4fr) 20px minmax(0, 1.3fr) minmax(0, .7fr); align-items: center; gap: 10px; padding: 0 15px; }
  .rhead { height: 30px; border-bottom: 1px solid var(--line); }
  .rhead span { font: 600 9px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .ub { height: 40px; border-bottom: 1px solid var(--line); cursor: pointer; font: 12px/1 var(--mono); }
  .ub:hover { background: var(--raised); }
  .ub .host { color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ub:hover .host { text-decoration: underline; }
  .ub .arr { color: var(--faint); display: flex; align-items: center; }
  .ub .svc { color: var(--mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .ub .svc .p { color: var(--dim); } .ub .svc .port { color: var(--dim); }
  .ub .path { color: var(--upd); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .ub .path.none { color: var(--faint); }
  .empty { padding: 18px 15px; color: var(--dim); font: 12px/1.4 var(--mono); }
`)
export class HopeConnectorInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(ConnectorInspector) accessor insp!: ConnectorInspector;
  @inject(NetworkInspector) accessor netInsp!: NetworkInspector;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(PromptService) accessor prompt!: PromptService;

  @reactive accessor host = "";
  @reactive accessor id = "";
  @reactive accessor conn: ConnectorView | null = null;
  @reactive accessor routes: TunnelView[] = [];
  @reactive accessor error = "";
  @reactive accessor busy = false;

  @mount
  onMount() { this.host = this.insp.host; this.id = this.insp.id; this.load(); }

  @on(ConnectorInspectorTarget)
  private onTarget(e: ConnectorInspectorTarget) {
    if (!e.id || (e.id === this.id && e.host === this.host)) return;
    this.host = e.host; this.id = e.id; this.conn = null; this.error = "";
    this.load();
  }

  private async load() {
    if (!this.id) return;
    const host = this.host, id = this.id;
    try {
      // One connector by id (host-aware BE lookup), plus its routes.
      const [c, routes] = await Promise.all([
        this.rpc.callOn<ConnectorView>(host, "Tunnels", "connector", [id]),
        this.rpc.callOn<TunnelView[]>(host, "Tunnels", "tunnels", []).catch(() => []),
      ]);
      if (host !== this.host || id !== this.id) return; // switched connector mid-flight
      this.conn = c || null;
      // Routes reference their connector by name; scope them to this connector's
      // name (a connector's own routes all carry its name).
      this.routes = c ? (routes || []).filter((t) => t.connector === c.name) : [];
      this.error = c ? "" : "connector not found on this host";
    } catch (e: any) {
      if (host !== this.host || id !== this.id) return;
      this.error = e?.message ?? "connector not found on this host";
      this.conn = null;
    }
  }

  private openTarget(t: TunnelView) {
    const r = app.get(LoomRouter);
    this.insp.close();
    if (t.container_id && t.project) { r.navigate(containerPath(this.host, t.project, t.container_id)); return; }
    if (t.project) { r.navigate(stackPath(this.host, t.project)); return; }
  }

  // Jump to a network the connector is attached to — hands the docked slot over to
  // the network inspector (deep-linkable /networks/:host/:name).
  private gotoNetwork(name: string) {
    this.netInsp.select(this.host, name);
  }

  private updateConn = async () => {
    const c = this.conn;
    if (!c || this.busy) return;
    const go = await this.confirm.ask({
      title: "update connector",
      confirmLabel: "Pull + recreate",
      message: `Pull the latest cloudflared and recreate "${c.title || c.name}". Its tunnels drop for a few seconds while the container restarts` +
        `${c.default ? " — including hope's own ingress if it's served through this connector" : ""}.`,
    });
    if (!go) return;
    this.busy = true;
    await this.proc.run(`update ${c.title || c.name}`, async (emit, signal) => {
      let ok = true;
      // Recreating the connector that serves hope severs THIS stream mid-flight,
      // so "done" may never arrive — cap the wait and finish optimistically so the
      // dialog can't hang forever.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort);
      const watchdog = setTimeout(() => ac.abort(), 90_000);
      try {
        emit("pulling latest cloudflared…");
        for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "redeploy", [c.id, "true", "true"], ac.signal, this.host)) {
          if (f.type === "log" && f.data) emit(f.data);
          else if (f.type === "done") { if (!f.ok) { ok = false; emit("failed: " + (f.error ?? "")); } break; }
        }
        emit(ok ? "connector updated" : "done");
      } catch {
        // Stream cut (the connector — maybe hope's own — is restarting). The pull
        // + recreate is already underway on the host; treat it as done.
        emit("connection dropped while recreating — the connector is coming back up…");
      } finally {
        clearTimeout(watchdog);
        signal.removeEventListener("abort", onAbort);
      }
      return ok;
    });
    this.busy = false;
    this.insp.onChange?.();
    this.load();
  };

  private rename = async () => {
    const c = this.conn;
    if (!c || this.busy) return;
    const v = await this.prompt.ask({
      title: "rename tunnel",
      icon: "link",
      submitLabel: "Rename",
      fields: [{ key: "name", label: "new name", placeholder: c.title || c.name, value: c.title || c.name }],
    });
    if (!v) return;
    const name = v.name.trim();
    if (!name || name === (c.title || c.name)) return;
    this.busy = true;
    await this.proc.run(`rename ${c.title || c.name}`, async (emit) => {
      try {
        emit("renaming Cloudflare tunnel…");
        const res = await this.rpc.callOn<OpResult>(this.host, "Tunnels", "renameConnector", [c.id, name]);
        if (res && res.ok === false) { emit("failed: " + (res.error || "error")); return false; }
        emit("renamed -> " + name);
        return true;
      } catch (e: any) { emit("failed: " + (e?.message || "error")); return false; }
    });
    this.busy = false;
    this.insp.onChange?.();
    // Renaming changes the connector title (not name/id), so the target stays valid.
    this.load();
  };

  private removeConn = async () => {
    const c = this.conn;
    if (!c || this.busy) return;
    const del = await this.confirm.ask({
      title: "remove connector",
      danger: true,
      confirmLabel: "Remove + delete tunnel",
      message: `Remove connector "${c.title || c.name}"? This stops and deletes the cloudflared container AND deletes its Cloudflare tunnel (${short(c.tunnel_id)}). Its routes stop working.`,
    });
    if (!del) return;
    this.busy = true;
    await this.proc.run(`remove connector ${c.title || c.name}`, async (emit) => {
      try {
        emit("stopping + removing cloudflared…");
        emit("deleting Cloudflare tunnel…");
        await this.rpc.callOn<OpResult>(this.host, "Tunnels", "removeConnector", [c.id, true]);
        emit("removed");
        return true;
      } catch (e: any) { emit("failed: " + (e?.message ?? "error")); return false; }
    });
    this.busy = false;
    this.insp.onChange?.();
    this.insp.close();
  };

  update() {
    if (!this.id) return <div class="empty">Select a connector.</div>;
    const c = this.conn;
    const state = c ? (c.online ? "ok" : c.running ? "warn" : "bad") : "off";
    return (
      <>
        <div class="bar">
          <div class="who">
            <span class={"dot" + (c ? (c.online ? "" : c.running ? " warn" : " off") : " off")}></span>
            <span class="nm">{c?.title || c?.name || "connector"}</span>
            {c ? <span class="sub">{c.connections} conns</span> : null}
          </div>
          <span class="grow"></span>
          <div class="acts">
            {c?.update_ready ? <button class="pa upd" tip={{ text: "update cloudflared", pos: "bottom-end" }} disabled={this.busy} onClick={this.updateConn}><loom-icon name="redeploy" size={14}></loom-icon></button> : null}
            <button class="pa" tip={{ text: "rename tunnel", pos: "bottom-end" }} disabled={this.busy || !c} onClick={this.rename}><loom-icon name="edit" size={14}></loom-icon></button>
            <button class="pa danger" tip={{ text: "remove connector", pos: "bottom-end" }} disabled={this.busy || !c} onClick={this.removeConn}><loom-icon name="trash" size={14}></loom-icon></button>
            <button class="pa" tip={{ text: "close", pos: "bottom-end" }} onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
        </div>

        {this.error || !c ? (
          <div class="empty">{this.error || "loading connector…"}</div>
        ) : (
          <div class="body">
            <div class="col">
              <div class="ctitle">identity</div>
              <div class="row"><span class="k">status</span><span class={"v " + state}>{c.status || (c.running ? "connecting" : "stopped")}</span></div>
              <div class="row"><span class="k">connections</span><span class="v">{c.connections}</span></div>
              <div class="row"><span class="k">routes</span><span class="v">{this.routes.length}</span></div>
              <div class="row"><span class="k">tunnel id</span>{c.tunnel_id ? <span class="v">{c.tunnel_id}</span> : <span class="v dim">—</span>}</div>
              <div class="row"><span class="k">cloudflared</span><span class="v">{c.version || <span class="dim">unknown</span>}{c.update_ready ? <span class="dim"> · update</span> : null}</span></div>
              <div class="row"><span class="k">host</span><span class="v">{this.host}</span></div>
              <div class="row"><span class="k">edge</span><span class="v">{c.colos && c.colos.length ? <span class="cols">{c.colos.map((co) => <span class="colo">{co}</span>)}</span> : <span class="dim">not connected</span>}</span></div>
              <div class="ctitle sep">networks &middot; {c.networks?.length || 0}</div>
              {c.networks && c.networks.length ? (
                <div class="nets">{c.networks.map((n) => (
                  <button class="netchip" onClick={() => this.gotoNetwork(n)}><loom-icon name="link" size={11}></loom-icon>{n}</button>
                ))}</div>
              ) : <div class="empty">none attached yet — added when you publish a route</div>}
            </div>

            <div class="col">
              <div class="ctitle">routes &middot; {this.routes.length}</div>
              {this.routes.length ? (
                <>
                  <div class="rhead"><span>hostname</span><span></span><span>service</span><span>path</span></div>
                  {this.routes.map((t) => (
                    <div class="ub" onClick={() => this.openTarget(t)}>
                      <span class="host">{t.hostname}</span>
                      <span class="arr"><loom-icon name="arrow-right" size={12}></loom-icon></span>
                      <span class="svc">{t.project ? <span><span class="p">{t.project} / </span>{t.svc_name}</span> : (t.container || t.service)}{t.port ? <span class="port">:{t.port}</span> : null}</span>
                      <span class={"path" + (t.path ? "" : " none")}>{t.path || "—"}</span>
                    </div>
                  ))}
                </>
              ) : <div class="empty">no routes yet — add one from the connector below</div>}
            </div>
          </div>
        )}
      </>
    );
  }
}
