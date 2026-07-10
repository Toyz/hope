// <hope-network-detail> — the network inspector modal, reusable from anywhere a
// network is shown (container networks list, networks page). Opened via
// NetworkDetailService.open({ host, ref }): fetches the network on that host
// (System.network, by id/name) and shows driver/scope/subnet/gateway/flags,
// options + labels (via <hope-kvlist>), and the attached containers. Mirrors the
// image-detail modal so both read the same.
import { LoomElement, styles, css, reactive, watch, unmount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { theme } from "../styles";
import { HopeTransport } from "../transport";
import { HostContext } from "../host-context";
import { withHost } from "../host-url";
import { networkFlags } from "../format";
import { UNGROUPED } from "../const";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { signalModal } from "../modal";
import type { NetworkInfo } from "../contracts";
import type { NetworkDetailOpts } from "./network-detail";

@styles(theme, css`
  :host { display: contents; }
  .dmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .dbox { width: 600px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); }
  .dhead { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line); }
  .dhead .dt { font: 600 14px/1.2 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dhead .grow { flex: 1; }
  .dx { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .dx:hover { color: var(--hi); }
  .dfacts { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .dfacts .st { display: flex; flex-direction: column; gap: 5px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .dfacts .sk { font: 600 9px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .dfacts .sv { font: 600 14px/1 var(--mono); color: var(--hi); font-style: normal; }
  .dbody { padding: 6px 18px 12px; }
  .drow { display: flex; gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .drow:last-child { border-bottom: 0; }
  .drow.top { align-items: flex-start; }
  .dk { flex: 0 0 84px; font: 600 10px/1.8 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .dv { flex: 1; min-width: 0; font: 12.5px/1.6 var(--mono); color: var(--hi); display: flex; flex-wrap: wrap; align-items: center; }
  .dv .dim { color: var(--dim); }
  .dv .flags { display: inline-flex; flex-wrap: wrap; gap: 6px; }
  .dv .tag { padding: 2px 8px; border: 1px solid var(--line2); color: var(--mid);
    font: 10px/1.6 var(--mono); letter-spacing: .05em; text-transform: uppercase; }
  .ub { display: inline-block; font: 12px/1 var(--mono); color: var(--mid); border: 1px solid var(--line); padding: 5px 8px; margin: 0 6px 6px 0; cursor: pointer; }
  .ub:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ub .ubp { color: var(--dim); }
  .dacts { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .dacts .grow { flex: 1; }
  .dnote { font: 11px/1.4 var(--mono); color: var(--warn); max-width: 360px; }
  .dstate { padding: 30px 18px; text-align: center; color: var(--dim); font: 12.5px/1.5 var(--mono); }
  .dstate.err { color: var(--bad); }
`)
export default class NetworkDetailModal extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;

  @reactive accessor open = false;
  @reactive accessor loading = false;
  @reactive accessor info: NetworkInfo | null = null;
  @reactive accessor host = "";
  @reactive accessor error = "";
  private onChange?: () => void;

  @watch("open") private lockBody() { signalModal(this, this.open); }
  @unmount private releaseBody() { signalModal(this, false); }

  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  async show(o: NetworkDetailOpts) {
    this.host = o.host || "";
    this.onChange = o.onChange;
    this.open = true;
    this.info = null;
    this.error = "";
    this.loading = true;
    try {
      this.info = await this.rpc.callOn<NetworkInfo>(this.host, "System", "network", [o.ref]);
    } catch (e: any) {
      this.error = e?.message ?? "failed to load network";
    } finally {
      this.loading = false;
    }
  }

  private close = () => {
    this.open = false;
    this.info = null;
    this.error = "";
  };

  private gotoContainer = (u: { id: string; project: string }) => {
    const host = this.host || this.hostCtx.token;
    this.close();
    this.router.navigate(withHost(host, `/stack/${encodeURIComponent(u.project || UNGROUPED)}/${encodeURIComponent(u.id)}`));
  };

  private removeNet = async () => {
    const n = this.info;
    if (!n) return;
    const ok = await this.confirm.ask({
      title: "remove network",
      danger: true,
      confirmLabel: "Remove",
      message: `Remove the ${n.name} network.`,
      stats: [{ label: "network", value: n.name }, ...(this.host ? [{ label: "host", value: this.host }] : [])],
    });
    if (!ok) return;
    try {
      await this.rpc.callOn(this.host, "System", "removeNetwork", [n.id]);
      this.toast.ok(`removed ${n.name}`);
      this.onChange?.();
      this.close();
    } catch (err: any) {
      this.toast.error(`remove ${n.name} — ${err?.message ?? "failed"}`);
    }
  };

  update() {
    if (!this.open) return <div></div>;
    const n = this.info;
    const flags = networkFlags(n);
    return (
      <div class="dmodal" onClick={this.close}>
        <div class="dbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt" title={n?.name || "network"}>{n?.name || "network"}</span>
            <span class="grow"></span>
            <button class="dx" onClick={this.close}><loom-icon name="x" size={15}></loom-icon></button>
          </div>

          {this.loading ? (
            <div class="dstate">loading network…</div>
          ) : this.error || !n ? (
            <div class="dstate err">{this.error || "network not found on this host"}</div>
          ) : (
            <>
              <div class="dfacts">
                {this.host ? <span class="st"><i class="sk">host</i><i class="sv">{this.host}</i></span> : null}
                <span class="st"><i class="sk">driver</i><i class="sv">{n.driver || "—"}</i></span>
                {n.scope ? <span class="st"><i class="sk">scope</i><i class="sv">{n.scope}</i></span> : null}
                <span class="st"><i class="sk">attached</i><i class="sv">{n.used_by.length}</i></span>
              </div>
              <div class="dbody">
                <div class="drow"><span class="dk">id</span><span class="dv">{n.id.slice(0, 12)}</span></div>
                {n.subnet ? <div class="drow"><span class="dk">subnet</span><span class="dv">{n.subnet}</span></div> : null}
                {n.gateway ? <div class="drow"><span class="dk">gateway</span><span class="dv">{n.gateway}</span></div> : null}
                <div class="drow"><span class="dk">flags</span><span class="dv">{flags.length ? <span class="flags">{flags.map((f) => <span class="tag">{f}</span>)}</span> : <span class="dim">none</span>}</span></div>
                {n.options && Object.keys(n.options).length ? (
                  <div class="drow top"><span class="dk">options</span><span class="dv"><hope-kvlist data={n.options}></hope-kvlist></span></div>
                ) : null}
                {n.labels && Object.keys(n.labels).length ? (
                  <div class="drow top"><span class="dk">labels</span><span class="dv"><hope-kvlist data={n.labels}></hope-kvlist></span></div>
                ) : null}
                <div class="drow top"><span class="dk">attached</span>
                  <span class="dv">
                    {n.used_by.length ? (
                      n.used_by.map((u) => (
                        <span class="ub" onClick={() => this.gotoContainer(u)}>
                          {u.project ? <span class="ubp">{u.project} / </span> : null}
                          {u.service || u.name}
                        </span>
                      ))
                    ) : (
                      <span class="dim">nothing — safe to remove</span>
                    )}
                  </span>
                </div>
              </div>
              <div class="dacts">
                {n.used_by.length ? <span class="dnote">detach its containers before removing</span> : null}
                <span class="grow"></span>
                {n.used_by.length ? null : <hope-button tone="danger" icon="trash" onClick={this.removeNet}>remove</hope-button>}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
}
