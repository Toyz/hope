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
import { NetworkDetailService } from "../components/network-detail";
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
  @inject(NetworkDetailService) accessor networkDetail!: NetworkDetailService;

  @rpc(System, "networks", { eager: false }) accessor singleQ!: ApiState<NetworkInfo[]>;
  @rpc(System, "fleetNetworks", { eager: false }) accessor fleetQ!: ApiState<FleetNetworksHost[]>;
  @mutate(Deploy, "createNetwork")
  accessor mkNet!: RpcMutator<[string, string, string, string, boolean, boolean, boolean, string, string], NetworkInfo>;

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
        { key: "driver", label: "driver", type: "select", value: "bridge", options: [{ value: "bridge", label: "bridge" }, { value: "overlay", label: "overlay" }, { value: "macvlan", label: "macvlan" }, { value: "ipvlan", label: "ipvlan" }] },
        { key: "subnet", label: "subnet (optional)", optional: true, placeholder: "172.28.0.0/16" },
        { key: "gateway", label: "gateway (optional)", optional: true, placeholder: "172.28.0.1" },
        { key: "internal", label: "internal (no outbound)", type: "toggle", optional: true },
        { key: "attachable", label: "attachable", type: "toggle", optional: true },
        { key: "ipv6", label: "enable IPv6", type: "toggle", optional: true },
        {
          key: "options", label: "driver options", type: "kv", optional: true, addLabel: "option",
          placeholder: "parent=eth0\nmtu=1500",
          dependsOn: "driver",
          defaultFrom: (vals) =>
            vals.driver === "macvlan" ? "parent=eth0\nmacvlan_mode=bridge"
              : vals.driver === "ipvlan" ? "parent=eth0\nipvlan_mode=l2"
                : vals.driver === "overlay" ? "encrypted=true"
                  : "",
        },
        { key: "labels", label: "labels", type: "kv", optional: true, addLabel: "label", placeholder: "team=platform" },
      ],
    });
    if (!v) return;
    try {
      await this.mkNet.call(v.name.trim(), v.driver || "bridge", v.subnet.trim(), v.gateway.trim(), v.internal === "true", v.attachable === "true", v.ipv6 === "true", v.options || "", v.labels || "");
      this.toast.ok("created network " + v.name.trim());
      this.refresh();
    } catch (err: any) {
      this.toast.error("create failed: " + (err?.message ?? "error"));
    }
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
            <hope-search placeholder="Search networks…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
          ) : null}

          {vis.length > 0 ? (
            <hope-table>
              <table>
                <colgroup>
                  <col style="width:40px" /><col /><col style="width:120px" /><col style="width:110px" /><col style="width:28%" /><col style="width:52px" />
                </colgroup>
                <thead>
                  <tr>
                    <th class="pl"><span class={"ck" + (this.removable().length > 0 && this.removable().every((n) => this.selected.includes(this.key(n))) ? " on" : "")} onClick={this.selectAllVisible}></span></th>
                    <th>Name</th><th>Driver</th><th>Scope</th><th>Attached</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {vis.map((n) => (
                    <tr class={"click" + (this.selected.includes(this.key(n)) ? " sel" : "")} onClick={() => this.networkDetail.open({ host: n.host, ref: n.name, onChange: () => this.refresh() })}>
                      {n.used_by.length ? <td class="pl"></td> : (
                        <td class="pl" onClick={(e: Event) => this.toggleSel(this.key(n), e)}><span class={"ck" + (this.selected.includes(this.key(n)) ? " on" : "")}></span></td>
                      )}
                      <td class="hi">{n.host ? <hope-chip host={true} title={n.host}>{n.host}</hope-chip> : null}{n.name}</td>
                      <td class="dim">{n.driver}</td>
                      <td class="dim">{n.scope}</td>
                      <td>{n.used_by.length ? <span>{n.used_by[0].service || n.used_by[0].name}{n.used_by.length > 1 ? <span class="dim"> +{n.used_by.length - 1}</span> : null}</span> : <span class="dim">—</span>}</td>
                      <td class="r">{!n.used_by.length ? <button class="rm" title="remove network" onClick={(e: Event) => { e.stopPropagation(); this.del(n); }}><loom-icon name="x" size={14}></loom-icon></button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </hope-table>
          ) : items.length === 0 && !error && !busy ? (
            <div class="empty">No networks.</div>
          ) : null}
        </main>
      </div>
    );
  }
}
