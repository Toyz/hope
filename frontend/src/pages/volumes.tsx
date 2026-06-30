// Volumes page: every Docker volume on the active host with the containers
// mounting it (the reverse mapping). Wire: System/volumes.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { VolumeInfo } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

@route("/volumes")
@component("hope-volumes")
@styles(css`
  ${theme}
  ${resourceStyles}
`)
export class VolumesPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor vols: VolumeInfo[] = [];
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
      this.vols = (await this.rpc.call<VolumeInfo[]>("System", "volumes", [])) || [];
      this.error = "";
    } catch (err: any) {
      this.error = err?.message ?? "Can't list volumes.";
    } finally {
      this.busy = false;
    }
  };

  private fleetBack = () => localStorage.getItem("hope.fleet") === "1";
  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };
  private toggle = (name: string) => (this.open = { ...this.open, [name]: !this.open[name] });
  private openUser = (u: { id: string; project: string }) => {
    if (u.project) this.router.navigate(`/stack/${encodeURIComponent(u.project)}`);
    else this.router.navigate(`/container/${encodeURIComponent(u.id)}`);
  };

  private visible() {
    const q = this.query.trim().toLowerCase();
    return q ? this.vols.filter((v) => v.name.toLowerCase().includes(q) || v.driver.toLowerCase().includes(q)) : this.vols;
  }

  update() {
    const vis = this.visible();
    const mounted = this.vols.filter((v) => v.used_by.length).length;
    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> {this.fleetBack() ? "all hosts" : "fleet"}</span></div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/images")}>images</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/networks")}>networks</span></div>
          <div class="s nav"><span class="navlink on" onClick={() => this.router.navigate("/volumes")}>volumes</span></div>
          <div class="grow"></div>
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {this.vols.length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">volumes</i><i class="v">{this.vols.length}</i></span>
              <span class="stat"><i class="k">mounted</i><i class="v">{mounted}</i></span>
              <span class="stat"><i class="k">unused</i><i class="v">{this.vols.length - mounted}</i></span>
            </div>
          ) : null}

          {this.vols.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Search volumes…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            </div>
          ) : null}

          <div class="rlist">
            {vis.map((v) => (
              <>
                <div class={"rrow" + (v.used_by.length ? "" : " empty")} onClick={() => (v.used_by.length ? this.toggle(v.name) : null)}>
                  <span class={"rdot" + (v.used_by.length ? " on" : "")}></span>
                  <span class="rname">{v.name}</span>
                  <span class="rmeta">{v.driver}</span>
                  <span class="grow"></span>
                  <span class="rcount">{v.used_by.length}<span class="t"> {v.used_by.length === 1 ? "container" : "containers"}</span></span>
                  {v.used_by.length ? <loom-icon class={"chev" + (this.open[v.name] ? " up" : "")} name="chevron-down" size={14}></loom-icon> : <span class="chevpad"></span>}
                </div>
                {this.open[v.name] && v.used_by.length ? (
                  <div class="users">
                    {v.used_by.map((u) => (
                      <span class="user" onClick={() => this.openUser(u)}>
                        {u.project ? <b>{u.project}</b> : null}{u.project && (u.service || u.name) ? <span class="sep"> / </span> : null}{u.service || u.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            ))}
          </div>

          {this.vols.length === 0 && !this.error && !this.busy ? <div class="empty">No volumes.</div> : null}
        </main>
      </div>
    );
  }
}
