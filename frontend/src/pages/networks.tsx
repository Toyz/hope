// Networks page: every Docker network on the active host with the containers
// attached to it (the reverse "who's on this network" mapping). Wire: System/networks.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { NetworkInfo } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

@route("/networks")
@component("hope-networks")
@styles(css`
  ${theme}
  ${resourceStyles}
`)
export class NetworksPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor nets: NetworkInfo[] = [];
  @reactive accessor busy = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor open: Record<string, boolean> = {};

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
  }

  private load = async () => {
    this.busy = true;
    try {
      this.nets = (await this.rpc.call<NetworkInfo[]>("System", "networks", [])) || [];
      this.error = "";
    } catch (err: any) {
      this.error = err?.message ?? "Can't list networks.";
    } finally {
      this.busy = false;
    }
  };

  private fleetBack = () => localStorage.getItem("hope.fleet") === "1";
  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };
  private toggle = (id: string) => (this.open = { ...this.open, [id]: !this.open[id] });
  private openUser = (u: { id: string; project: string }) => {
    if (u.project) this.router.navigate(`/stack/${encodeURIComponent(u.project)}`);
    else this.router.navigate(`/container/${encodeURIComponent(u.id)}`);
  };

  private visible() {
    const q = this.query.trim().toLowerCase();
    const list = q ? this.nets.filter((n) => n.name.toLowerCase().includes(q) || n.driver.toLowerCase().includes(q)) : this.nets;
    return list;
  }

  update() {
    const vis = this.visible();
    const attached = this.nets.filter((n) => n.used_by.length).length;
    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> {this.fleetBack() ? "all hosts" : "fleet"}</span></div>
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
              <span class="stat"><i class="k">empty</i><i class="v">{this.nets.length - attached}</i></span>
            </div>
          ) : null}

          {this.nets.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Search networks…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            </div>
          ) : null}

          <div class="rlist">
            {vis.map((n) => (
              <>
                <div class={"rrow" + (n.used_by.length ? "" : " empty")} onClick={() => (n.used_by.length ? this.toggle(n.id) : null)}>
                  <span class={"rdot" + (n.used_by.length ? " on" : "")}></span>
                  <span class="rname">{n.name}</span>
                  <span class="rmeta">{n.driver}{n.scope ? ` · ${n.scope}` : ""}{n.internal ? " · internal" : ""}</span>
                  <span class="grow"></span>
                  <span class="rcount">{n.used_by.length}<span class="t"> {n.used_by.length === 1 ? "container" : "containers"}</span></span>
                  {n.used_by.length ? <loom-icon class={"chev" + (this.open[n.id] ? " up" : "")} name="chevron-down" size={14}></loom-icon> : <span class="chevpad"></span>}
                </div>
                {this.open[n.id] && n.used_by.length ? (
                  <div class="users">
                    {n.used_by.map((u) => (
                      <span class="user" onClick={() => this.openUser(u)}>
                        {u.project ? <b>{u.project}</b> : null}{u.project && (u.service || u.name) ? <span class="sep"> / </span> : null}{u.service || u.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            ))}
          </div>

          {this.nets.length === 0 && !this.error && !this.busy ? <div class="empty">No networks.</div> : null}
        </main>
      </div>
    );
  }
}
