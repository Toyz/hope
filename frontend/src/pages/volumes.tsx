// Volumes page: every Docker volume on the active host with the containers
// mounting it (reverse mapping). Same table + detail-modal design as images.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import type { VolumeInfo } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

const agoStr = (iso: string) => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo`;
  return `${Math.floor(s / 31536000)}y`;
};

type Filter = "all" | "mounted" | "unused";

@route("/volumes")
@component("hope-volumes")
@styles(css`
  ${theme}
  ${resourceStyles}
`)
export class VolumesPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor vols: VolumeInfo[] = [];
  @reactive accessor busy = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor filter: Filter = "all";
  @reactive accessor detail: VolumeInfo | null = null;

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
      this.vols = ((await this.rpc.call<VolumeInfo[]>("System", "volumes", [])) || []).map((v) => ({ ...v, used_by: v.used_by || [] }));
      this.error = "";
    } catch (err: any) {
      this.error = err?.message ?? "Can't list volumes.";
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

  private del = async (v: VolumeInfo) => {
    const inUse = v.used_by.length > 0;
    const ok = await this.confirm.ask({
      title: "remove volume",
      danger: true,
      confirmLabel: "Remove",
      message: inUse
        ? `"${v.name}" is mounted by ${v.used_by.length} container(s) — force-removing deletes its data.`
        : `Remove volume "${v.name}"? Its data is deleted.`,
    });
    if (!ok) return;
    this.detail = null;
    try {
      await this.rpc.call("System", "removeVolume", [v.name]);
      await this.load();
    } catch (err: any) {
      this.error = `remove ${v.name} — ${err?.message ?? "failed"}`;
    }
  };

  private visible() {
    const q = this.query.trim().toLowerCase();
    return this.vols.filter((v) => {
      if (this.filter === "mounted" && !v.used_by.length) return false;
      if (this.filter === "unused" && v.used_by.length) return false;
      if (q && !(v.name + " " + v.driver).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  update() {
    const vis = this.visible();
    const mounted = this.vols.filter((v) => v.used_by.length).length;
    const unused = this.vols.length - mounted;
    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> {localStorage.getItem("hope.fleet") === "1" ? "all hosts" : "fleet"}</span></div>
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
              <span class="stat"><i class="k">unused</i><i class="v">{unused}</i></span>
            </div>
          ) : null}

          {this.vols.length > 0 ? (
            <div class="toolbar">
              <div class="filters">
                {(["all", "mounted", "unused"] as Filter[]).map((f) => (
                  <button class={"fchip" + (this.filter === f ? " on" : "")} onClick={() => (this.filter = f)}>
                    {f}
                    <span class="fn">{f === "all" ? this.vols.length : f === "mounted" ? mounted : unused}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {this.vols.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Search volumes…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            </div>
          ) : null}

          {vis.length > 0 ? (
            <table>
              <colgroup>
                <col class="c-name" />
                <col class="c-meta" />
                <col class="c-use" />
                <col class="c-act" />
              </colgroup>
              <thead>
                <tr><th>Name</th><th>Driver</th><th>Mounted by</th><th></th></tr>
              </thead>
              <tbody>
                {vis.map((v) => (
                  <tr onClick={() => (this.detail = v)}>
                    <td class="rname">{v.name}</td>
                    <td class="rmeta">{v.driver}</td>
                    <td class="use">{v.used_by.length ? <span>{v.used_by[0].service || v.used_by[0].name}{v.used_by.length > 1 ? <span class="ubmore"> +{v.used_by.length - 1}</span> : null}</span> : <span class="none">unused</span>}</td>
                    <td class="r"><button class="rm" title="remove volume" onClick={(e: Event) => { e.stopPropagation(); this.del(v); }}><loom-icon name="x" size={14}></loom-icon></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : this.vols.length === 0 && !this.error && !this.busy ? (
            <div class="empty">No volumes.</div>
          ) : null}
        </main>

        {this.detail ? this.renderDetail(this.detail) : null}
      </div>
    );
  }

  private renderDetail(v: VolumeInfo) {
    return (
      <div class="dmodal" onClick={() => (this.detail = null)}>
        <div class="dbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt">{v.name}</span>
            <span class="grow"></span>
            <button class="dx" onClick={() => (this.detail = null)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="dfacts">
            <span class="st"><i class="sk">driver</i><i class="sv">{v.driver}</i></span>
            <span class="st"><i class="sk">created</i><i class="sv">{agoStr(v.created_at)}</i></span>
            <span class="st"><i class="sk">status</i><i class="sv">{v.used_by.length ? "mounted" : "unused"}</i></span>
            <span class="st"><i class="sk">mounted</i><i class="sv">{v.used_by.length}</i></span>
          </div>
          <div class="dbody">
            <div class="drow"><span class="dk">mountpoint</span><span class="dv">{v.mountpoint || "—"}</span></div>
            <div class="drow top"><span class="dk">mounted by</span>
              <span class="dv">
                {v.used_by.length ? v.used_by.map((u) => (
                  <span class="ub" onClick={() => this.openUser(u)}>{u.project ? <span class="ubp">{u.project} / </span> : null}{u.service || u.name}</span>
                )) : <span class="dim">nothing — safe to remove</span>}
              </span>
            </div>
          </div>
          <div class="dacts">
            {v.used_by.length ? <span class="dnote">mounted — removing force-deletes the data from under the containers</span> : null}
            <span class="grow"></span>
            <button class="pbtn danger" onClick={() => this.del(v)}>remove</button>
          </div>
        </div>
      </div>
    );
  }
}
