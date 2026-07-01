// Volumes page: every Docker volume on the active host with the containers
// mounting it (reverse mapping). Same table + detail-modal design as images.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import { PromptService } from "../prompt";
import { ToastService } from "../toast";
import type { VolumeInfo } from "../contracts";
import { theme } from "../styles";
import { resourceStyles } from "./resource-styles";

const bytes = (n: number) => {
  if (n < 0) return "—";
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

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
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ToastService) accessor toast!: ToastService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  private createVol = async () => {
    const v = await this.prompt.ask({
      title: "create volume",
      icon: "copy",
      submitLabel: "Create",
      fields: [
        { key: "name", label: "name", placeholder: "my-data" },
        { key: "driver", label: "driver", type: "select", value: "local", options: [{ value: "local", label: "local" }] },
      ],
    });
    if (!v) return;
    this.busy = true;
    try {
      await this.rpc.call("Deploy", "createVolume", [v.name.trim(), v.driver || "local"]);
      this.toast.ok("created volume " + v.name.trim());
      await this.load();
    } catch (err: any) {
      this.toast.error("create failed: " + (err?.message ?? "error"));
    } finally {
      this.busy = false;
    }
  };

  @reactive accessor vols: (VolumeInfo & { host?: string })[] = [];
  @reactive accessor busy = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor filter: Filter = "all";
  @reactive accessor detail: (VolumeInfo & { host?: string }) | null = null;
  @reactive accessor selected: string[] = []; // volume names (unused only)

  // Only unused volumes are selectable for bulk removal.
  private removable = () => this.visible().filter((v) => !v.used_by.length);
  private toggleSel = (name: string, e: Event) => {
    e.stopPropagation();
    this.selected = this.selected.includes(name) ? this.selected.filter((n) => n !== name) : [...this.selected, name];
  };
  private selectAllVisible = () => {
    const names = this.removable().map((v) => v.name);
    this.selected = names.every((n) => this.selected.includes(n)) ? [] : names;
  };
  private clearSel = () => (this.selected = []);
  private removeSelected = async () => {
    const vols = this.vols.filter((v) => this.selected.includes(v.name));
    if (!vols.length) return;
    const ok = await this.confirm.ask({
      title: "remove volumes",
      danger: true,
      confirmLabel: `Remove ${vols.length}`,
      message: `Remove ${vols.length} unused volume(s)? Their data is deleted.`,
    });
    if (!ok) return;
    this.busy = true;
    try {
      for (const v of vols) {
        if (v.host) await this.rpc.call("System", "setActiveHost", [v.host]);
        await this.rpc.call("System", "removeVolume", [v.name]);
      }
      this.selected = [];
      await this.load();
    } catch (err: any) {
      this.error = err?.message ?? "remove failed";
    } finally {
      this.busy = false;
    }
  };

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
      this.vols = ((await this.rpc.call<VolumeInfo[]>("System", "volumes", [])) || [])
        .map((v) => ({ ...v, used_by: v.used_by || [] }))
        .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
      this.error = "";
    } catch (err: any) {
      this.error = err?.message ?? "Can't list volumes.";
    } finally {
      this.busy = false;
    }
  };

  private loadFleet = async () => {
    this.busy = true;
    try {
      const hosts = (await this.rpc.call<import("../contracts").FleetVolumesHost[]>("System", "fleetVolumes", [])) || [];
      const combined: (VolumeInfo & { host?: string })[] = [];
      for (const h of hosts) {
        if (!h.online) continue;
        for (const v of h.volumes || []) combined.push({ ...v, used_by: v.used_by || [], host: h.id });
      }
      combined.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
      this.vols = combined;
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

  private del = async (v: VolumeInfo & { host?: string }) => {
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
      if (v.host) await this.rpc.call("System", "setActiveHost", [v.host]);
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
                              <hope-nav active="volumes"></hope-nav>
          <div class="grow"></div>
          <div class="s act"><button disabled={this.busy} onClick={this.createVol}>+ create</button></div>
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {this.vols.length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">volumes</i><i class="v">{this.vols.length}</i></span>
              <span class="stat"><i class="k">total size</i><i class="v">{bytes(this.vols.reduce((a, v) => a + (v.size > 0 ? v.size : 0), 0))}</i></span>
              <span class="stat"><i class="k">mounted</i><i class="v">{mounted}</i></span>
              <span class="stat"><i class="k">unused</i><i class={"v" + (unused > 0 ? " warnv" : "")}>{unused}</i></span>
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
              <div class="grow"></div>
              {this.selected.length > 0 ? (
                <div class="selbar">
                  <span class="seln">{this.selected.length} selected</span>
                  <button class="pbtn danger" disabled={this.busy} onClick={this.removeSelected}>remove</button>
                  <button class="pbtn" onClick={this.clearSel}>clear</button>
                </div>
              ) : null}
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
                <col class="c-sel" />
                <col class="c-name" />
                <col class="c-meta" />
                <col class="c-meta" />
                <col class="c-use" />
                <col class="c-act" />
              </colgroup>
              <thead>
                <tr>
                  <th class="sel"><span class={"ck" + (this.removable().length > 0 && this.removable().every((v) => this.selected.includes(v.name)) ? " on" : "")} onClick={this.selectAllVisible}></span></th>
                  <th>Name</th><th>Driver</th><th class="r">Size</th><th>Mounted by</th><th></th>
                </tr>
              </thead>
              <tbody>
                {vis.map((v) => (
                  <tr class={this.selected.includes(v.name) ? "sel" : ""} onClick={() => (this.detail = v)}>
                    {v.used_by.length ? <td class="sel"></td> : (
                      <td class="sel" onClick={(e: Event) => this.toggleSel(v.name, e)}><span class={"ck" + (this.selected.includes(v.name) ? " on" : "")}></span></td>
                    )}
                    <td class="rname">{v.host ? <span class="htag" title={v.host}>{v.host}</span> : null}{v.name}</td>
                    <td class="rmeta">{v.driver}</td>
                    <td class="rmeta r">{bytes(v.size)}</td>
                    <td class="use">{v.used_by.length ? <span>{v.used_by[0].service || v.used_by[0].name}{v.used_by.length > 1 ? <span class="ubmore"> +{v.used_by.length - 1}</span> : null}</span> : <span class="none">unused</span>}</td>
                    <td class="r">{!v.used_by.length ? <button class="rm" title="remove volume" onClick={(e: Event) => { e.stopPropagation(); this.del(v); }}><loom-icon name="x" size={14}></loom-icon></button> : null}</td>
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

  private renderDetail(v: VolumeInfo & { host?: string }) {
    return (
      <div class="dmodal" onClick={() => (this.detail = null)}>
        <div class="dbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt">{v.name}</span>
            <span class="grow"></span>
            <button class="dx" onClick={() => (this.detail = null)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="dfacts">
            {v.host ? <span class="st"><i class="sk">host</i><i class="sv">{v.host}</i></span> : null}
            <span class="st"><i class="sk">driver</i><i class="sv">{v.driver}</i></span>
            <span class="st"><i class="sk">size</i><i class="sv">{bytes(v.size)}</i></span>
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
            {v.used_by.length ? <span class="dnote">mounted — unmount its containers before removing</span> : null}
            <span class="grow"></span>
            {v.used_by.length ? null : <button class="pbtn danger" onClick={() => this.del(v)}>remove</button>}
          </div>
        </div>
      </div>
    );
  }
}
