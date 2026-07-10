// <hope-network-inspector> — the docked bottom panel for a network, opened from a
// networks-page row (like the container/image/volume inspectors, not a modal).
// Two columns: identity (driver/scope/subnet/gateway/flags) + what's attached, and
// driver options + labels. Fetches the single network via System.network.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { NetworkInspector } from "../network-inspector";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { NetworkInspectorTarget } from "../events";
import { containerPath } from "../host-url";
import { UNGROUPED } from "../const";
import { shortId, networkFlags } from "../format";
import { removeResource } from "../resource-actions";
import type { NetworkInfo, ResourceUser } from "../contracts";
import { theme } from "../styles";

@component("hope-network-inspector")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }

  .bar { display: flex; align-items: stretch; height: 38px; flex: none; border-bottom: 1px solid var(--line); }
  .who { display: flex; align-items: center; gap: 9px; padding: 0 15px; border-right: 1px solid var(--line); min-width: 0; }
  .who loom-icon { color: var(--dim); flex: none; }
  .who .nm { font: 700 12.5px/1 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who .sub { color: var(--dim); font: 500 10px/1 var(--mono); flex: none; }
  .grow { flex: 1; }
  .acts { display: flex; align-items: stretch; border-left: 1px solid var(--line); }
  .pa { display: inline-grid; place-items: center; width: 40px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .pa:hover { color: var(--hi); background: var(--raised); }
  .pa.danger:hover { color: var(--bad); }
  .pa:disabled { opacity: .4; cursor: default; }

  .body { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-columns: minmax(320px, 44%) minmax(0, 1fr); }
  .col { min-width: 0; min-height: 0; overflow-y: auto; border-right: 1px solid var(--line); }
  .col:last-child { border-right: 0; }
  .ctitle { padding: 13px 15px 9px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .ctitle.sep { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 13px; }
  .row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 5px 15px; font: 12px/1.5 var(--mono); align-items: baseline; }
  .row .k { color: var(--dim); }
  .row .v { color: var(--hi); min-width: 0; word-break: break-all; font-variant-numeric: tabular-nums; }
  .row .v.dim { color: var(--dim); }
  .flags { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { display: inline-block; padding: 2px 8px; border: 1px solid var(--line2); color: var(--mid); font: 10px/1.6 var(--mono); letter-spacing: .05em; text-transform: uppercase; }
  .ubs { display: flex; flex-wrap: wrap; gap: 7px; padding: 2px 15px 14px; }
  .ub { display: inline-flex; align-items: baseline; padding: 5px 9px; background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer; font: 11.5px/1 var(--mono); }
  .ub:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ub .p { color: var(--dim); }
  .kv { padding: 2px 15px 14px; }
  .empty { padding: 18px 15px; color: var(--dim); font: 12px/1.4 var(--mono); }
`)
export class HopeNetworkInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(NetworkInspector) accessor insp!: NetworkInspector;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;

  @reactive accessor host = "";
  @reactive accessor ref = "";
  @reactive accessor net: NetworkInfo | null = null;
  @reactive accessor error = "";
  @reactive accessor busy = false;

  @mount
  onMount() { this.host = this.insp.host; this.ref = this.insp.ref; this.load(); }

  @on(NetworkInspectorTarget)
  private onTarget(e: NetworkInspectorTarget) {
    if (!e.ref || (e.ref === this.ref && e.host === this.host)) return;
    this.host = e.host; this.ref = e.ref; this.net = null; this.error = "";
    this.load();
  }

  private async load() {
    if (!this.ref) return;
    try {
      const n = await this.rpc.callOn<NetworkInfo>(this.host, "System", "network", [this.ref]);
      this.net = { ...n, used_by: n.used_by || [] };
      this.error = "";
    } catch (e: any) {
      this.error = e?.message ?? "network not found on this host";
      this.net = null;
    }
  }

  private gotoContainer(u: ResourceUser) {
    this.insp.close();
    app.get(LoomRouter).navigate(containerPath(this.host, u.project || UNGROUPED, u.id));
  }

  private removeNet = async () => {
    const n = this.net;
    if (!n || this.busy) return;
    await removeResource(
      { confirm: this.confirm, rpc: this.rpc, toast: this.toast, onDone: () => this.insp.onChange?.(), close: () => this.insp.close(), setBusy: (b) => (this.busy = b) },
      { kind: "network", name: n.name, host: this.host, method: "removeNetwork", args: [n.id], message: `Remove the ${n.name} network.` },
    );
  };

  update() {
    if (!this.ref) return <div class="empty">Select a network.</div>;
    const n = this.net;
    const attached = !!n && n.used_by.length > 0;
    const flags = networkFlags(n);
    return (
      <>
        <div class="bar">
          <div class="who">
            <loom-icon name="link" size={14}></loom-icon>
            <span class="nm">{this.ref}</span>
            {n ? <span class="sub">{n.driver}</span> : null}
          </div>
          <span class="grow"></span>
          <div class="acts">
            <hope-tip text={attached ? "detach its containers first" : "remove network"} pos="bottom-end"><button class="pa danger" disabled={this.busy || attached} onClick={this.removeNet}><loom-icon name="trash" size={14}></loom-icon></button></hope-tip>
            <hope-tip text="close" pos="bottom-end"><button class="pa" onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></button></hope-tip>
          </div>
        </div>

        {this.error || !n ? (
          <div class="empty">{this.error || "loading network…"}</div>
        ) : (
          <div class="body">
            <div class="col">
              <div class="ctitle">identity</div>
              <div class="row"><span class="k">driver</span><span class="v">{n.driver}</span></div>
              <div class="row"><span class="k">scope</span><span class="v">{n.scope || "—"}</span></div>
              <div class="row"><span class="k">subnet</span>{n.subnet ? <span class="v">{n.subnet}</span> : <span class="v dim">—</span>}</div>
              <div class="row"><span class="k">gateway</span>{n.gateway ? <span class="v">{n.gateway}</span> : <span class="v dim">—</span>}</div>
              <div class="row"><span class="k">flags</span><span class="v">{flags.length ? <span class="flags">{flags.map((f) => <span class="tag">{f}</span>)}</span> : <span class="dim">none</span>}</span></div>
              <div class="ctitle sep">attached &middot; {n.used_by.length}</div>
              {n.used_by.length ? (
                <div class="ubs">{n.used_by.map((u) => <button class="ub" onClick={() => this.gotoContainer(u)}>{u.project ? <span class="p">{u.project} / </span> : null}{u.service || u.name || shortId(u.id)}</button>)}</div>
              ) : <div class="empty">nothing attached — safe to remove</div>}
            </div>

            <div class="col">
              {n.options && Object.keys(n.options).length ? (<><div class="ctitle">driver options</div><div class="kv"><hope-kvlist data={n.options}></hope-kvlist></div></>) : null}
              {n.labels && Object.keys(n.labels).length ? (<><div class="ctitle sep">labels</div><div class="kv"><hope-kvlist data={n.labels}></hope-kvlist></div></>) : null}
              {!(n.options && Object.keys(n.options).length) && !(n.labels && Object.keys(n.labels).length) ? <div class="empty">no options or labels</div> : null}
            </div>
          </div>
        )}
      </>
    );
  }
}
