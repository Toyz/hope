// Networks page: every Docker network on the active host with the containers
// attached to it (reverse mapping). Same table + detail-modal design as images.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
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
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor nets: (NetworkInfo & { host?: string })[] = [];
  @reactive accessor busy = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor detail: (NetworkInfo & { host?: string }) | null = null;

  get fleetMode() {
    return localStorage.getItem("hope.fleet") === "1";
  }

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
    const ok = await this.confirm.ask({
      title: "remove network",
      danger: true,
      confirmLabel: "Remove",
      message: `Remove network "${n.name}"?`,
    });
    if (!ok) return;
    this.detail = null;
    try {
      if (n.host) await this.rpc.call("System", "setActiveHost", [n.host]);
      await this.rpc.call("System", "removeNetwork", [n.id]);
      await this.load();
    } catch (err: any) {
      this.error = `remove ${n.name} — ${err?.message ?? "failed"}`;
    }
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
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> {localStorage.getItem("hope.fleet") === "1" ? "all hosts" : "fleet"}</span></div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/images")}>images</span></div>
          <div class="s nav"><span class="navlink on" onClick={() => this.router.navigate("/networks")}>networks</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/volumes")}>volumes</span></div>
          <div class="grow"></div>
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

          {this.nets.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Search networks…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            </div>
          ) : null}

          {vis.length > 0 ? (
            <table>
              <colgroup>
                <col class="c-name" />
                <col class="c-meta" />
                <col class="c-meta" />
                <col class="c-use" />
                <col class="c-act" />
              </colgroup>
              <thead>
                <tr><th>Name</th><th>Driver</th><th>Scope</th><th>Attached</th><th></th></tr>
              </thead>
              <tbody>
                {vis.map((n) => (
                  <tr onClick={() => (this.detail = n)}>
                    <td class="rname">{n.host ? <span class="htag">{n.host}</span> : null}{n.name}{n.internal ? <span class="chip" style="margin-left:8px">internal</span> : null}</td>
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
