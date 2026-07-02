// Networks page: every Docker network on the active host (or the whole fleet)
// with the containers attached to it. Data is loom-rpc @rpc queries (SWR: the
// list stays put through a refetch, no blank/pop); create is an @mutate;
// cross-host bulk removal uses callOn (per-item host target). Shared list
// mechanics live in ResourcePage.
import { component, styles, css } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route } from "@toyz/loom/router";
import { rpc, mutate } from "@toyz/loom-rpc";
import type { RpcMutator } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { appBar } from "../app-bar";
import { ResourcePage } from "./resource-page";
import { HopeTransport } from "../transport";
import { System, Deploy } from "../contracts";
import type { NetworkInfo, FleetNetworksHost } from "../contracts";
import { resourceStyles } from "./resource-styles";

const ago = (unix: number) => {
  if (!unix) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo`;
  return `${Math.floor(s / 31536000)}y`;
};

@route("/networks")
@component("hope-networks")
@styles(css`
  ${resourceStyles}
`)
export class NetworksPage extends ResourcePage<NetworkInfo> {
  // For cross-host removal only — each item may live on a different host, which
  // @mutate's ambient (single) host target can't express.
  @inject(HopeTransport) accessor rpc!: HopeTransport;

  @rpc(System, "networks", { eager: false }) accessor singleQ!: ApiState<NetworkInfo[]>;
  @rpc(System, "fleetNetworks", { eager: false }) accessor fleetQ!: ApiState<FleetNetworksHost[]>;
  @mutate(Deploy, "createNetwork")
  accessor mkNet!: RpcMutator<[string, string, string, string, boolean, boolean, boolean], NetworkInfo>;

  // Selection keys: host|id (empty networks only).
  protected key = (n: NetworkInfo & { host?: string }) => (n.host ? n.host + "|" : "") + n.id;

  protected refresh() {
    void (this.fleetMode ? this.fleetQ : this.singleQ).refetch();
  }
  protected loading() {
    return this.fleetMode ? this.fleetQ.loading : this.singleQ.loading;
  }
  private err() {
    return (this.fleetMode ? this.fleetQ.error : this.singleQ.error)?.message ?? "";
  }

  protected items(): (NetworkInfo & { host?: string })[] {
    if (this.fleetMode) {
      const out: (NetworkInfo & { host?: string })[] = [];
      for (const h of this.fleetQ.data || []) {
        if (!h.online) continue;
        for (const n of h.networks || []) out.push({ ...n, used_by: n.used_by || [], host: h.id });
      }
      out.sort((a, b) => b.used_by.length - a.used_by.length || a.name.localeCompare(b.name));
      return out;
    }
    return (this.singleQ.data || []).map((n) => ({ ...n, used_by: n.used_by || [] }));
  }

  protected visible() {
    const q = this.query.trim().toLowerCase();
    const list = this.items();
    return q ? list.filter((n) => n.name.toLowerCase().includes(q) || n.driver.toLowerCase().includes(q)) : list;
  }

  private removeSelected = async () => {
    const nets = this.items().filter((n) => this.selected.includes(this.key(n)));
    if (!nets.length) return;
    const ok = await this.confirm.ask({
      title: "remove networks",
      danger: true,
      confirmLabel: `Remove ${nets.length}`,
      message: `Remove ${nets.length} empty network(s)?`,
      stats: [{ label: "networks", value: String(nets.length) }],
    });
    if (!ok) return;
    await this.proc.run("removing selected networks", async (emit) => {
      let okv = true;
      for (const n of nets) {
        const label = (n.host ? n.host + " / " : "") + n.name;
        try {
          await this.rpc.callOn(n.host || "", "System", "removeNetwork", [n.id]);
          emit("removed " + label);
        } catch (err: any) {
          emit("skip " + label + " — " + (err?.message ?? "failed"));
          okv = false;
        }
      }
      emit("done");
      return okv;
    });
    this.selected = [];
    this.refresh();
  };

  private createNet = async () => {
    const v = await this.prompt.ask({
      title: "create network",
      icon: "link",
      submitLabel: "Create",
      fields: [
        { key: "name", label: "name", placeholder: "my-net" },
        { key: "driver", label: "driver", type: "select", value: "bridge", options: [{ value: "bridge", label: "bridge" }, { value: "overlay", label: "overlay" }, { value: "macvlan", label: "macvlan" }] },
        { key: "subnet", label: "subnet (optional)", optional: true, placeholder: "172.28.0.0/16" },
        { key: "gateway", label: "gateway (optional)", optional: true, placeholder: "172.28.0.1" },
        { key: "internal", label: "internal (no outbound)", type: "toggle", optional: true },
        { key: "attachable", label: "attachable", type: "toggle", optional: true },
        { key: "ipv6", label: "enable IPv6", type: "toggle", optional: true },
      ],
    });
    if (!v) return;
    try {
      await this.mkNet.call(v.name.trim(), v.driver || "bridge", v.subnet.trim(), v.gateway.trim(), v.internal === "true", v.attachable === "true", v.ipv6 === "true");
      this.toast.ok("created network " + v.name.trim());
      this.refresh();
    } catch (err: any) {
      this.toast.error("create failed: " + (err?.message ?? "error"));
    }
  };

  private openUser = (u: { id: string; project: string }) => {
    // In the all-hosts view the item lives on a specific host — point the
    // ambient target there so the stack/container page loads against it.
    const host = this.detail?.host;
    this.detail = null;
    if (host) this.hostCtx.activeHost = host;
    if (u.project) this.router.navigate(`/stack/${encodeURIComponent(u.project)}`);
    else this.router.navigate(`/container/${encodeURIComponent(u.id)}`);
  };

  private del = async (n: NetworkInfo & { host?: string }) => {
    const inUse = n.used_by.length > 0;
    const ok = await this.confirm.ask({
      title: "remove network",
      danger: true,
      confirmLabel: "Remove",
      message: inUse
        ? `"${n.name}" has ${n.used_by.length} attached container(s) — remove them first.`
        : `Remove network "${n.name}"?`,
      stats: [
        { label: "network", value: n.name },
        ...(n.host ? [{ label: "host", value: n.host }] : []),
        { label: "driver", value: n.driver },
        { label: "attached", value: String(n.used_by.length) },
      ],
    });
    if (!ok) return;
    this.detail = null;
    const label = (n.host ? n.host + " / " : "") + n.name;
    await this.proc.run(`remove ${n.name}`, async (emit) => {
      try {
        emit("deleting network " + label + "…");
        await this.rpc.callOn(n.host || "", "System", "removeNetwork", [n.id]);
        emit("removed " + label);
        return true;
      } catch (err: any) {
        emit("failed: " + (err?.message ?? "error"));
        return false;
      }
    });
    this.refresh();
  };

  update() {
    const items = this.items();
    const vis = this.visible();
    const attached = items.filter((n) => n.used_by.length).length;
    const error = this.err();
    const busy = this.loading();
    return (
      <div>
        {appBar("networks", [
          <div class="s act"><button style="display:inline-flex;align-items:center;gap:6px" disabled={busy} onClick={this.createNet}><loom-icon name="plus" size={12}></loom-icon> create</button></div>,
          <div class="s act"><button disabled={busy} onClick={() => this.refresh()}>{busy ? "…" : "refresh"}</button></div>,
        ])}

        <main>
          {error ? <div class="empty">{error}</div> : null}

          {items.length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">networks</i><i class="v">{items.length}</i></span>
              <span class="stat"><i class="k">attached</i><i class="v">{attached}</i></span>
              <span class="stat"><i class="k">empty</i><i class={"v" + (items.length - attached > 0 ? " warnv" : "")}>{items.length - attached}</i></span>
            </div>
          ) : null}

          {this.selected.length > 0 ? (
            <div class="toolbar">
              <div class="grow"></div>
              <div class="selbar">
                <span class="seln">{this.selected.length} selected</span>
                <button class="pbtn danger" disabled={busy} onClick={this.removeSelected}>remove</button>
                <button class="pbtn" onClick={this.clearSel}>clear</button>
              </div>
            </div>
          ) : null}

          {items.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Search networks…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            </div>
          ) : null}

          {vis.length > 0 ? (
            <table>
              <colgroup>
                <col class="c-sel" />
                <col class="c-name" />
                <col class="c-meta" />
                <col class="c-meta" />
                <col class="c-use" />
                <col class="c-act" />
              </colgroup>
              <thead>
                <tr>
                  <th class="sel"><span class={"ck" + (this.removable().length > 0 && this.removable().every((n) => this.selected.includes(this.key(n))) ? " on" : "")} onClick={this.selectAllVisible}></span></th>
                  <th>Name</th><th>Driver</th><th>Scope</th><th>Attached</th><th></th>
                </tr>
              </thead>
              <tbody>
                {vis.map((n) => (
                  <tr class={this.selected.includes(this.key(n)) ? "sel" : ""} onClick={() => (this.detail = n)}>
                    {n.used_by.length ? <td class="sel"></td> : (
                      <td class="sel" onClick={(e: Event) => this.toggleSel(this.key(n), e)}><span class={"ck" + (this.selected.includes(this.key(n)) ? " on" : "")}></span></td>
                    )}
                    <td class="rname">{n.host ? <span class="htag" title={n.host}>{n.host}</span> : null}{n.name}{n.internal ? <span class="chip" style="margin-left:8px">internal</span> : null}</td>
                    <td class="rmeta">{n.driver}</td>
                    <td class="rmeta">{n.scope}</td>
                    <td class="use">{n.used_by.length ? <span>{n.used_by[0].service || n.used_by[0].name}{n.used_by.length > 1 ? <span class="ubmore"> +{n.used_by.length - 1}</span> : null}</span> : <span class="none">—</span>}</td>
                    <td class="r">{!n.used_by.length ? <button class="rm" title="remove network" onClick={(e: Event) => { e.stopPropagation(); this.del(n); }}><loom-icon name="x" size={14}></loom-icon></button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : items.length === 0 && !error && !busy ? (
            <div class="empty">No networks.</div>
          ) : null}
        </main>

        {this.detail ? this.renderDetail(this.detail) : null}
      </div>
    );
  }

  private renderDetail(n: NetworkInfo & { host?: string }) {
    return (
      <div class="dmodal" onClick={() => (this.detail = null)}>
        <div class="dbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt">{n.name}</span>
            <span class="grow"></span>
            <button class="dx" onClick={() => (this.detail = null)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="dfacts">
            {n.host ? <span class="st"><i class="sk">host</i><i class="sv">{n.host}</i></span> : null}
            <span class="st"><i class="sk">driver</i><i class="sv">{n.driver}</i></span>
            <span class="st"><i class="sk">scope</i><i class="sv">{n.scope}</i></span>
            <span class="st"><i class="sk">created</i><i class="sv">{ago(n.created)}</i></span>
            <span class="st"><i class="sk">attached</i><i class="sv">{n.used_by.length}</i></span>
          </div>
          <div class="dbody">
            <div class="drow"><span class="dk">id</span><span class="dv">{n.id.slice(0, 12)}</span></div>
            {n.subnet ? <div class="drow"><span class="dk">subnet</span><span class="dv">{n.subnet}</span></div> : null}
            {n.gateway ? <div class="drow"><span class="dk">gateway</span><span class="dv">{n.gateway}</span></div> : null}
            <div class="drow"><span class="dk">flags</span><span class="dv">{[n.internal ? "internal" : "", n.ipv6 ? "ipv6" : "", n.attachable ? "attachable" : ""].filter(Boolean).join(" · ") || <span class="dim">none</span>}</span></div>
            {n.options && Object.keys(n.options).length ? (
              <div class="drow top"><span class="dk">options</span><span class="dv">{Object.entries(n.options).map(([k, v]) => <span class="opt">{k}={v}</span>)}</span></div>
            ) : null}
            <div class="drow top"><span class="dk">attached</span>
              <span class="dv">
                {n.used_by.length ? n.used_by.map((u) => (
                  <span class="ub" onClick={() => this.openUser(u)}>{u.project ? <span class="ubp">{u.project} / </span> : null}{u.service || u.name}</span>
                )) : <span class="dim">nothing — safe to remove</span>}
              </span>
            </div>
          </div>
          <div class="dacts">
            {n.used_by.length ? <span class="dnote">detach its containers before removing</span> : null}
            <span class="grow"></span>
            {n.used_by.length ? null : <button class="pbtn danger" onClick={() => this.del(n)}>remove</button>}
          </div>
        </div>
      </div>
    );
  }
}
