// Networks page: every Docker network on the active host with the containers
// attached to it (reverse mapping). Same table + detail-modal design as images.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { HostChanged } from "../events";
import { ConfirmService } from "../confirm";
import { PromptService } from "../prompt";
import { ToastService } from "../toast";
import { ProcService } from "../proc";
import type { NetworkInfo } from "../contracts";
import { theme } from "../styles";
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
  ${theme}
  ${resourceStyles}
`)
export class NetworksPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(ProcService) accessor proc!: ProcService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor nets: (NetworkInfo & { host?: string })[] = [];
  @reactive accessor busy = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor detail: (NetworkInfo & { host?: string }) | null = null;
  @reactive accessor selected: string[] = []; // keys: host|id (empty networks only)

  private key = (n: NetworkInfo & { host?: string }) => (n.host ? n.host + "|" : "") + n.id;
  private removable = () => this.visible().filter((n) => !n.used_by.length);
  private toggleSel = (k: string, e: Event) => {
    e.stopPropagation();
    this.selected = this.selected.includes(k) ? this.selected.filter((x) => x !== k) : [...this.selected, k];
  };
  private selectAllVisible = () => {
    const keys = this.removable().map((n) => this.key(n));
    this.selected = keys.length > 0 && keys.every((k) => this.selected.includes(k)) ? this.selected.filter((k) => !keys.includes(k)) : Array.from(new Set([...this.selected, ...keys]));
  };
  private clearSel = () => (this.selected = []);
  private removeSelected = async () => {
    const nets = this.nets.filter((n) => this.selected.includes(this.key(n)));
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
          if (n.host) await this.rpc.call("System", "setActiveHost", [n.host]);
          await this.rpc.call("System", "removeNetwork", [n.id]);
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
    await this.load();
  };

  get fleetMode() {
    return this.hostCtx.fleet;
  }

  // Host/fleet switched elsewhere — re-fetch in place (no reload).
  @on(HostChanged)
  onHostChanged() {
    if (this.auth.isAuthenticated) this.load();
  }

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
    this.busy = true;
    try {
      await this.rpc.call("Deploy", "createNetwork", [v.name.trim(), v.driver || "bridge", v.subnet.trim(), v.gateway.trim(), v.internal === "true", v.attachable === "true", v.ipv6 === "true"]);
      this.toast.ok("created network " + v.name.trim());
      await this.load();
    } catch (err: any) {
      this.toast.error("create failed: " + (err?.message ?? "error"));
    } finally {
      this.busy = false;
    }
  };

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
  }

  private load = async () => {
    if (this.fleetMode) return this.loadFleet();
    this.busy = true;
    try {
      this.nets = ((await this.rpc.call<NetworkInfo[]>("System", "networks", [])) || []).map((n) => ({ ...n, used_by: n.used_by || [] }));
      this.error = "";
    } catch (err: any) {
      this.error = err?.message ?? "Can't list networks.";
    } finally {
      this.busy = false;
    }
  };

  private loadFleet = async () => {
    this.busy = true;
    try {
      const hosts = (await this.rpc.call<import("../contracts").FleetNetworksHost[]>("System", "fleetNetworks", [])) || [];
      const combined: (NetworkInfo & { host?: string })[] = [];
      for (const h of hosts) {
        if (!h.online) continue;
        for (const n of h.networks || []) combined.push({ ...n, used_by: n.used_by || [], host: h.id });
      }
      combined.sort((a, b) => b.used_by.length - a.used_by.length || a.name.localeCompare(b.name));
      this.nets = combined;
      this.error = "";
    } catch (err: any) {
      this.error = err?.message ?? "Can't list networks.";
    } finally {
      this.busy = false;
    }
  };

  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };
  private openUser = (u: { id: string; project: string }) => {
    this.detail = null;
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
        if (n.host) await this.rpc.call("System", "setActiveHost", [n.host]);
        emit("deleting network " + label + "…");
        await this.rpc.call("System", "removeNetwork", [n.id]);
        emit("removed " + label);
        return true;
      } catch (err: any) {
        emit("failed: " + (err?.message ?? "error"));
        this.error = `remove ${n.name} — ${err?.message ?? "failed"}`;
        return false;
      }
    });
    await this.load();
  };

  private visible() {
    const q = this.query.trim().toLowerCase();
    return q ? this.nets.filter((n) => n.name.toLowerCase().includes(q) || n.driver.toLowerCase().includes(q)) : this.nets;
  }

  update() {
    const vis = this.visible();
    const attached = this.nets.filter((n) => n.used_by.length).length;
    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> {this.fleetMode ? "all hosts" : "fleet"}</span></div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
                              <hope-nav active="networks"></hope-nav>
          <div class="grow"></div>
          <div class="s act"><button style="display:inline-flex;align-items:center;gap:6px" disabled={this.busy} onClick={this.createNet}><loom-icon name="plus" size={12}></loom-icon> create</button></div>
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {this.nets.length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">networks</i><i class="v">{this.nets.length}</i></span>
              <span class="stat"><i class="k">attached</i><i class="v">{attached}</i></span>
              <span class="stat"><i class="k">empty</i><i class={"v" + (this.nets.length - attached > 0 ? " warnv" : "")}>{this.nets.length - attached}</i></span>
            </div>
          ) : null}

          {this.selected.length > 0 ? (
            <div class="toolbar">
              <div class="grow"></div>
              <div class="selbar">
                <span class="seln">{this.selected.length} selected</span>
                <button class="pbtn danger" disabled={this.busy} onClick={this.removeSelected}>remove</button>
                <button class="pbtn" onClick={this.clearSel}>clear</button>
              </div>
            </div>
          ) : null}

          {this.nets.length > 0 ? (
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
          ) : this.nets.length === 0 && !this.error && !this.busy ? (
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
