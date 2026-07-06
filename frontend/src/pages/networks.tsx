// Networks page: every Docker network on the active host (or the whole fleet)
// with the containers attached to it. Data is loom-rpc @rpc queries (SWR: the
// list stays put through a refetch, no blank/pop); create is an @mutate;
// cross-host bulk removal uses callOn (per-item host target). Shared list
// mechanics live in ResourcePage.
import {
  component,
  css,
  mount,
  on,
  prop,
  reactive,
  styles,
  watch,
} from "@toyz/loom";
import type { RpcMutator } from "@toyz/loom-rpc";
import { mutate, rpc } from "@toyz/loom-rpc";
import { inject } from "@toyz/loom/di";
import type { ApiState } from "@toyz/loom/query";
import { route } from "@toyz/loom/router";
import type { FleetNetworksHost, NetworkInfo } from "../contracts";
import { Deploy, System } from "../contracts";
import { NetworkInspectorTarget } from "../events";
import { shortId } from "../format";
import { NetworkInspector } from "../network-inspector";
import { theme } from "../styles";
import { HopeTransport } from "../transport";
import { ResourcePage } from "./resource-page";

@route("/networks/:host")
@route("/networks/:host/:id")
@component("hope-networks")
@styles(
  theme,
  css`
    :host {
      display: block;
      min-height: 100%;
      background: var(--ink);
    }

    /* attachment instrument */
    .disk {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 26px;
      align-items: center;
      padding: 20px 28px 18px;
      border-bottom: 1px solid var(--line);
    }
    .diskmain {
      min-width: 0;
    }
    .disktotal {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 12px;
    }
    .disktotal .big {
      font: 600 26px/1 var(--mono);
      color: var(--hi);
    }
    .disktotal .lbl {
      font: 600 9.5px/1 var(--mono);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--dim);
    }
    .meter {
      display: flex;
      height: 8px;
      width: 100%;
      background: var(--line);
      overflow: hidden;
    }
    .meter i {
      display: block;
      height: 100%;
    }
    .meter .inuse {
      background: var(--upd);
    }
    .meter .unused {
      background: var(--faint);
    }
    .legend {
      display: flex;
      gap: 22px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .lg {
      display: flex;
      align-items: center;
      gap: 8px;
      font: 11.5px/1 var(--mono);
      color: var(--mid);
    }
    .lg .sw {
      width: 9px;
      height: 9px;
      flex: none;
    }
    .lg .sw.inuse {
      background: var(--upd);
    }
    .lg .sw.unused {
      background: var(--faint);
    }
    .lg b {
      color: var(--hi);
      font-weight: 600;
    }
    .lg .sz {
      color: var(--dim);
    }
    .reclaim {
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding-left: 26px;
      border-left: 1px solid var(--line);
      text-align: right;
    }
    .reclaim .k {
      font: 600 9.5px/1 var(--mono);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--dim);
    }
    .reclaim .v {
      font: 600 22px/1 var(--mono);
      color: var(--warn);
    }
    .reclaim .v.zero {
      color: var(--dim);
    }
    .reclaim .sub {
      font: 11px/1 var(--mono);
      color: var(--dim);
    }

    .vtools {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 28px;
      border-bottom: 1px solid var(--line);
    }
    .vtools .grow {
      flex: 1;
    }
    .seg {
      display: flex;
    }
    .seg button {
      height: 28px;
      padding: 0 12px;
      background: transparent;
      border: 1px solid var(--line);
      border-right: 0;
      color: var(--dim);
      font: 500 11px/1 var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
    }
    .seg button:last-child {
      border-right: 1px solid var(--line);
    }
    .seg button .n {
      color: var(--faint);
      font-variant-numeric: tabular-nums;
    }
    .seg button:hover {
      color: var(--mid);
    }
    .seg button.on {
      color: var(--hi);
      background: var(--raised);
      border-color: var(--line2);
    }
    .seg button.on .n {
      color: var(--mid);
    }
    .vtools hope-search {
      flex: 0 0 300px;
      max-width: 42%;
    }

    .rows {
      padding-bottom: 24px;
    }
    .rhead,
    .nrow {
      display: grid;
      grid-template-columns:
        minmax(0, 1.8fr) 128px 72px 84px minmax(0, 1fr)
        34px;
      align-items: center;
      gap: 18px;
      padding: 0 28px;
    }
    .rhead {
      height: 36px;
      border-bottom: 1px solid var(--line);
    }
    .rhead span {
      font: 600 9.5px/1 var(--mono);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--dim);
    }
    .nrow {
      height: 52px;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
      position: relative;
    }
    .nrow:hover {
      background: var(--raised);
    }
    .nrow.on {
      background: color-mix(in srgb, var(--upd) 12%, transparent);
    }
    .nrow.on::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--upd);
    }
    .nname {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .nname .hostchip {
      font: 9.5px/1.6 var(--mono);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--upd);
      border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line2));
      padding: 2px 6px;
      flex: none;
    }
    .nname .nm {
      color: var(--hi);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* attach bar — how many containers ride this network */
    .attbar {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .attbar .track {
      flex: 1;
      height: 4px;
      background: var(--line);
      overflow: hidden;
    }
    .attbar .track i {
      display: block;
      height: 100%;
      background: var(--upd);
    }
    .attbar .c {
      color: var(--mid);
      font-variant-numeric: tabular-nums;
      width: 20px;
      text-align: right;
    }
    .driver,
    .scope {
      color: var(--dim);
    }
    .attby {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .attby .svc {
      color: var(--mid);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .attby .svc .proj {
      color: var(--dim);
    }
    .attby .svc .extra {
      color: var(--dim);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border: 1px solid var(--line2);
      font: 10px/1.6 var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--dim);
    }
    .pill::before {
      content: "";
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }
    .rmc {
      text-align: right;
    }
    .rm {
      display: inline-grid;
      place-items: center;
      width: 26px;
      height: 26px;
      padding: 0;
      background: transparent;
      border: 1px solid transparent;
      color: var(--dim);
      cursor: pointer;
      opacity: 0;
    }
    .nrow:hover .rm {
      opacity: 1;
    }
    .rm:hover {
      color: var(--bad);
      border-color: color-mix(in srgb, var(--bad) 50%, var(--line2));
    }
    .empty {
      padding: 40px 28px;
      text-align: center;
      color: var(--dim);
      font: 12.5px/1.5 var(--mono);
    }
  `,
)
export class NetworksPage extends ResourcePage<NetworkInfo> {
  // For cross-host removal only — each item may live on a different host, which
  // @mutate's ambient (single) host target can't express.
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(NetworkInspector) accessor netInsp!: NetworkInspector;

  @rpc(System, "networks", { eager: false }) accessor singleQ!: ApiState<
    NetworkInfo[]
  >;
  @rpc(System, "fleetNetworks", { eager: false }) accessor fleetQ!: ApiState<
    FleetNetworksHost[]
  >;
  @mutate(Deploy, "createNetwork")
  accessor mkNet!: RpcMutator<
    [string, string, string, string, boolean, boolean, boolean, string, string],
    NetworkInfo
  >;

  @prop({ param: "id" }) accessor routeNet = "";

  // Fleet mode opens the inspector in place (no URL id), so mirror the docked
  // target off the bus to highlight the open row. Cleared when it closes.
  @reactive accessor inspHost = "";
  @reactive accessor inspRef = "";
  @on(NetworkInspectorTarget) private onInspOpen(e: NetworkInspectorTarget) {
    this.inspHost = e.ref ? e.host : "";
    this.inspRef = e.ref;
  }

  @reactive accessor filter: "all" | "attached" | "empty" = "all";

  @mount
  private onNetMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.refresh();
    this.syncNet();
  }

  @watch("routeNet") private onNetParam() {
    this.syncNet();
  }
  private syncNet() {
    if (this.routeNet) {
      this.netInsp.onChange = () => this.refresh();
      this.netInsp.apply(this.hostCtx.token, decodeURIComponent(this.routeNet));
    } else if (this.netInsp.isOpen) {
      this.netInsp.apply("", "");
    }
  }

  // Selection keys: host|id (empty networks only).
  protected key = (n: NetworkInfo & { host?: string }) =>
    (n.host ? n.host + "|" : "") + n.id;

  protected refresh() {
    void (this.fleetMode ? this.fleetQ : this.singleQ).refetch();
  }
  protected loading() {
    return this.fleetMode ? this.fleetQ.loading : this.singleQ.loading;
  }
  private err() {
    return (
      (this.fleetMode ? this.fleetQ.error : this.singleQ.error)?.message ?? ""
    );
  }

  protected items(): (NetworkInfo & { host?: string })[] {
    if (this.fleetMode) {
      const out: (NetworkInfo & { host?: string })[] = [];
      for (const h of this.fleetQ.data || []) {
        if (!h.online) continue;
        for (const n of h.networks || [])
          out.push({ ...n, used_by: n.used_by || [], host: h.id });
      }
      out.sort(
        (a, b) =>
          b.used_by.length - a.used_by.length || a.name.localeCompare(b.name),
      );
      return out;
    }
    return (this.singleQ.data || []).map((n) => ({
      ...n,
      used_by: n.used_by || [],
    }));
  }

  protected visible() {
    const q = this.query.trim().toLowerCase();
    return this.items().filter((n) => {
      if (this.filter === "attached" && !n.used_by.length) return false;
      if (this.filter === "empty" && n.used_by.length) return false;
      if (q && !(n.name + " " + n.driver).toLowerCase().includes(q))
        return false;
      return true;
    });
  }

  private removeSelected = async () => {
    const nets = this.items().filter((n) =>
      this.selected.includes(this.key(n)),
    );
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
          await this.rpc.callOn(n.host || "", "System", "removeNetwork", [
            n.id,
          ]);
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
        {
          key: "driver",
          label: "driver",
          type: "select",
          value: "bridge",
          options: [
            { value: "bridge", label: "bridge" },
            { value: "overlay", label: "overlay" },
            { value: "macvlan", label: "macvlan" },
            { value: "ipvlan", label: "ipvlan" },
          ],
        },
        {
          key: "subnet",
          label: "subnet (optional)",
          optional: true,
          placeholder: "172.28.0.0/16",
        },
        {
          key: "gateway",
          label: "gateway (optional)",
          optional: true,
          placeholder: "172.28.0.1",
        },
        {
          key: "internal",
          label: "internal (no outbound)",
          type: "toggle",
          optional: true,
        },
        {
          key: "attachable",
          label: "attachable",
          type: "toggle",
          optional: true,
        },
        { key: "ipv6", label: "enable IPv6", type: "toggle", optional: true },
        {
          key: "options",
          label: "driver options",
          type: "kv",
          optional: true,
          addLabel: "option",
          placeholder: "parent=eth0\nmtu=1500",
          dependsOn: "driver",
          defaultFrom: (vals) =>
            vals.driver === "macvlan"
              ? "parent=eth0\nmacvlan_mode=bridge"
              : vals.driver === "ipvlan"
                ? "parent=eth0\nipvlan_mode=l2"
                : vals.driver === "overlay"
                  ? "encrypted=true"
                  : "",
        },
        {
          key: "labels",
          label: "labels",
          type: "kv",
          optional: true,
          addLabel: "label",
          placeholder: "team=platform",
        },
      ],
    });
    if (!v) return;
    try {
      await this.mkNet.call(
        v.name.trim(),
        v.driver || "bridge",
        v.subnet.trim(),
        v.gateway.trim(),
        v.internal === "true",
        v.attachable === "true",
        v.ipv6 === "true",
        v.options || "",
        v.labels || "",
      );
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
    const empty = items.length - attached;
    const totalConns = items.reduce((a, n) => a + n.used_by.length, 0);
    const maxConn = Math.max(1, ...vis.map((n) => n.used_by.length));
    const fleet = this.fleetMode;
    const openRef = this.routeNet ? decodeURIComponent(this.routeNet) : "";
    const error = this.err();
    const busy = this.loading();
    const sel = this.selected.length;
    const pct = (n: number) => (items.length ? (n / items.length) * 100 : 0);
    const first = busy && items.length === 0; // first load, nothing to show yet
    return (
      <div>
        <hope-phead
          heading="Networks"
          scope={fleet ? "fleet" : this.hostCtx.token || "local"}
          meta={
            first
              ? "docker networks"
              : fleet
                ? "aggregated across the fleet"
                : `${items.length} network${items.length === 1 ? "" : "s"} on this daemon`
          }
        >
          <hope-button
            slot="actions"
            icon="plus"
            disabled={busy}
            onClick={this.createNet}
          >
            create
          </hope-button>
          {sel > 0 ? (
            <>
              <hope-button
                slot="actions"
                tone="danger"
                onClick={this.removeSelected}
              >
                remove {sel}
              </hope-button>
              <hope-button slot="actions" onClick={this.clearSel}>
                clear
              </hope-button>
            </>
          ) : null}
          <hope-button
            slot="actions"
            icon="rotate"
            spin={this.refreshing}
            disabled={busy}
            onClick={this.userRefresh}
          ></hope-button>

          {first ? (
            <div class="disk">
              <div class="diskmain">
                <div class="disktotal">
                  <hope-skel w="52" h="26"></hope-skel>
                  <hope-skel w="150" h="10"></hope-skel>
                </div>
                <hope-skel h="8"></hope-skel>
                <div class="legend">
                  <hope-skel w="90" h="11"></hope-skel>
                  <hope-skel w="80" h="11"></hope-skel>
                </div>
              </div>
            </div>
          ) : items.length > 0 ? (
            <div class="disk">
              <div class="diskmain">
                <div class="disktotal">
                  <span class="big num">{items.length}</span>
                  <span class="lbl">
                    networks &middot; {totalConns} attachments
                  </span>
                </div>
                <div class="meter">
                  <i class="inuse" style={`width:${pct(attached)}%`}></i>
                  <i class="unused" style={`width:${pct(empty)}%`}></i>
                </div>
                <div class="legend">
                  <span class="lg">
                    <span class="sw inuse"></span>attached <b>{attached}</b>
                  </span>
                  <span class="lg">
                    <span class="sw unused"></span>empty <b>{empty}</b>
                  </span>
                </div>
              </div>
              <div class="reclaim">
                <span class="k">removable</span>
                <span class={"v num" + (empty ? "" : " zero")}>{empty}</span>
                <span class="sub">empty networks</span>
              </div>
            </div>
          ) : null}
        </hope-phead>

        {error ? <div class="empty">{error}</div> : null}

        {items.length > 0 ? (
          <div class="vtools">
            <div class="seg">
              {(["all", "attached", "empty"] as const).map((f) => (
                <button
                  class={this.filter === f ? "on" : ""}
                  onClick={() => (this.filter = f)}
                >
                  {f}
                  <span class="n">
                    {f === "all"
                      ? items.length
                      : f === "attached"
                        ? attached
                        : empty}
                  </span>
                </button>
              ))}
            </div>
            <span class="grow"></span>
            <hope-search
              placeholder="Search networks…"
              text={this.query}
              onSearch={(e: any) => (this.query = e.detail)}
            ></hope-search>
          </div>
        ) : null}

        {first ? (
          <div class="rows">
            <div class="rhead">
              <span>name</span>
              <span>attached</span>
              <span></span>
              <span>driver</span>
              <span>scope</span>
              <span></span>
            </div>
            {[0, 1, 2, 3, 4].map(() => (
              <div class="nrow" style="cursor:default">
                <div class="nname">
                  <hope-skel w="180" h="12"></hope-skel>
                </div>
                <div class="attbar">
                  <span class="track"></span>
                </div>
                <div class="driver">
                  <hope-skel w="50" h="12"></hope-skel>
                </div>
                <div class="scope">
                  <hope-skel w="46" h="12"></hope-skel>
                </div>
                <div class="attby">
                  <hope-skel w="120" h="12"></hope-skel>
                </div>
                <div class="rmc"></div>
              </div>
            ))}
          </div>
        ) : vis.length > 0 ? (
          <div class="rows">
            <div class="rhead">
              <span>name</span>
              <span>attached</span>
              <span></span>
              <span>driver</span>
              <span>scope</span>
              <span></span>
            </div>
            {vis.map((n) => {
              const c = n.used_by.length;
              return (
                <div
                  class={"nrow" + (openRef === n.name || (fleet && this.inspRef === n.name && this.inspHost === (n.host || "")) ? " on" : "")}
                  onClick={() =>
                    this.netInsp.select(
                      n.host || this.hostCtx.token,
                      n.name,
                      () => this.refresh(),
                    )
                  }
                >
                  <div class="nname">
                    {n.host ? <span class="hostchip">{n.host}</span> : null}
                    <span class="nm" title={n.name}>
                      {n.name}
                    </span>
                  </div>
                  <div class="attbar">
                    <span class="track">
                      <i
                        style={`width:${c ? Math.max(4, (c / maxConn) * 100) : 0}%`}
                      ></i>
                    </span>
                    <span class="c">{c || ""}</span>
                  </div>
                  <div class="driver">{n.driver}</div>
                  <div class="scope">{n.scope}</div>
                  <div class="attby">
                    {c ? (
                      <span class="svc">
                        {n.used_by[0].project ? (
                          <span class="proj">{n.used_by[0].project} / </span>
                        ) : null}
                        {n.used_by[0].service ||
                          n.used_by[0].name ||
                          shortId(n.used_by[0].id)}
                        {c > 1 ? <span class="extra"> +{c - 1}</span> : null}
                      </span>
                    ) : (
                      <span class="pill">empty</span>
                    )}
                  </div>
                  <div class="rmc">
                    {c ? null : (
                      <button
                        class="rm"
                        title="remove network"
                        onClick={(e: Event) => {
                          e.stopPropagation();
                          this.del(n);
                        }}
                      >
                        <loom-icon name="x" size={14}></loom-icon>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : items.length === 0 && !error && !busy ? (
          <div class="empty">No networks.</div>
        ) : !first && !error ? (
          <div class="empty">
            {this.query ? (
              <span>
                No networks match <b>{this.query}</b>.
              </span>
            ) : this.filter === "attached" ? (
              "No attached networks — nothing is riding a user network."
            ) : this.filter === "empty" ? (
              "No empty networks — every network has a container."
            ) : (
              "No networks."
            )}
          </div>
        ) : null}
      </div>
    );
  }
}
