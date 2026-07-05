// Volumes page: every Docker volume on the active host (or fleet) with the
// containers mounting it. @rpc queries (SWR — no blank on refetch), @mutate
// create, cross-host removal via callOn. Shared list mechanics in ResourcePage.
import { component, styles, css, reactive, prop, mount, watch } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route } from "@toyz/loom/router";
import { rpc, mutate } from "@toyz/loom-rpc";
import type { RpcMutator } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { ResourcePage } from "./resource-page";
import { HopeTransport } from "../transport";
import { VolumeInspector } from "../volume-inspector";
import { System, Deploy } from "../contracts";
import type { VolumeInfo, FleetVolumesHost } from "../contracts";
import { bytes } from "../format";
import { theme } from "../styles";

type Filter = "all" | "mounted" | "unused";

@route("/volumes/:host")
@route("/volumes/:host/:id")
@component("hope-volumes")
@styles(theme, css`
  :host { display: block; min-height: 100%; background: var(--ink); }

  /* storage composition instrument */
  .disk { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 26px; align-items: center; padding: 20px 28px 18px; border-bottom: 1px solid var(--line); }
  .diskmain { min-width: 0; }
  .disktotal { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .disktotal .big { font: 600 26px/1 var(--mono); color: var(--hi); }
  .disktotal .lbl { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .meter { display: flex; height: 8px; width: 100%; background: var(--line); overflow: hidden; }
  .meter i { display: block; height: 100%; }
  .meter .inuse { background: var(--upd); } .meter .unused { background: var(--faint); }
  .legend { display: flex; gap: 22px; margin-top: 12px; flex-wrap: wrap; }
  .lg { display: flex; align-items: center; gap: 8px; font: 11.5px/1 var(--mono); color: var(--mid); }
  .lg .sw { width: 9px; height: 9px; flex: none; }
  .lg .sw.inuse { background: var(--upd); } .lg .sw.unused { background: var(--faint); }
  .lg b { color: var(--hi); font-weight: 600; } .lg .sz { color: var(--dim); }
  .reclaim { display: flex; flex-direction: column; gap: 7px; padding-left: 26px; border-left: 1px solid var(--line); text-align: right; }
  .reclaim .k { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .reclaim .v { font: 600 22px/1 var(--mono); color: var(--warn); }
  .reclaim .sub { font: 11px/1 var(--mono); color: var(--dim); }

  .vtools { display: flex; align-items: center; gap: 10px; padding: 12px 28px; border-bottom: 1px solid var(--line); }
  .vtools .grow { flex: 1; }
  .seg { display: flex; }
  .seg button { height: 28px; padding: 0 12px; background: transparent; border: 1px solid var(--line); border-right: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
  .seg button:last-child { border-right: 1px solid var(--line); }
  .seg button .n { color: var(--faint); font-variant-numeric: tabular-nums; }
  .seg button:hover { color: var(--mid); }
  .seg button.on { color: var(--hi); background: var(--raised); border-color: var(--line2); }
  .seg button.on .n { color: var(--mid); }
  .vtools hope-search { flex: 0 0 300px; max-width: 42%; }

  .rows { padding-bottom: 24px; }
  .rhead, .vrow { display: grid; grid-template-columns: minmax(0, 1.8fr) 128px 92px 96px minmax(0, 1fr) 34px; align-items: center; gap: 18px; padding: 0 28px; }
  .rhead { height: 36px; border-bottom: 1px solid var(--line); }
  .rhead span { font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .vrow { height: 52px; border-bottom: 1px solid var(--line); cursor: pointer; position: relative; }
  .vrow:hover { background: var(--raised); }
  .vrow.on { background: color-mix(in srgb, var(--upd) 12%, transparent); }
  .vrow.on::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--upd); }
  .vname { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .vname .hostchip { font: 9.5px/1.6 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--upd);
    border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line2)); padding: 2px 6px; flex: none; }
  .vname .nm { color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sizebar { display: flex; align-items: center; }
  .sizebar .track { flex: 1; height: 4px; background: var(--line); overflow: hidden; }
  .sizebar .track i { display: block; height: 100%; background: var(--mid); }
  .sizebar.big .track i { background: var(--upd); }
  .size { color: var(--mid); font-variant-numeric: tabular-nums; text-align: right; }
  .driver { color: var(--dim); }
  .mountedby { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .mountedby .svc { color: var(--mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mountedby .svc .proj { color: var(--dim); } .mountedby .svc .extra { color: var(--dim); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--line2);
    font: 10px/1.6 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--dim); }
  .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .rmc { text-align: right; }
  .rm { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; background: transparent;
    border: 1px solid transparent; color: var(--dim); cursor: pointer; opacity: 0; }
  .vrow:hover .rm { opacity: 1; }
  .rm:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line2)); }
  .empty { padding: 40px 28px; text-align: center; color: var(--dim); font: 12.5px/1.5 var(--mono); }
`)
export class VolumesPage extends ResourcePage<VolumeInfo> {
  @inject(HopeTransport) accessor rpc!: HopeTransport; // cross-host removal (per-item host)
  @inject(VolumeInspector) accessor volInsp!: VolumeInspector;

  @rpc(System, "volumes", { eager: false }) accessor singleQ!: ApiState<VolumeInfo[]>;
  @rpc(System, "fleetVolumes", { eager: false }) accessor fleetQ!: ApiState<FleetVolumesHost[]>;
  @mutate(Deploy, "createVolume") accessor mkVol!: RpcMutator<[string, string, string, string], VolumeInfo>;

  @reactive accessor filter: Filter = "all";
  @prop({ param: "id" }) accessor routeVol = "";

  @mount
  private onVolMount() {
    if (!this.auth.isAuthenticated) { this.router.navigate("/login"); return; }
    this.refresh();
    this.syncVol();
  }
  @watch("routeVol") private onVolParam() { this.syncVol(); }
  private syncVol() {
    if (this.routeVol) {
      this.volInsp.onChange = () => this.refresh();
      this.volInsp.apply(this.hostCtx.token, decodeURIComponent(this.routeVol));
    } else if (this.volInsp.isOpen) {
      this.volInsp.apply("", "");
    }
  }

  protected key = (v: VolumeInfo & { host?: string }) => v.name; // unique per host

  protected refresh() {
    void (this.fleetMode ? this.fleetQ : this.singleQ).refetch();
  }
  protected loading() {
    return this.fleetMode ? this.fleetQ.loading : this.singleQ.loading;
  }
  private err() {
    return (this.fleetMode ? this.fleetQ.error : this.singleQ.error)?.message ?? "";
  }

  protected items(): (VolumeInfo & { host?: string })[] {
    let out: (VolumeInfo & { host?: string })[];
    if (this.fleetMode) {
      out = [];
      for (const h of this.fleetQ.data || []) {
        if (!h.online) continue;
        for (const v of h.volumes || []) out.push({ ...v, used_by: v.used_by || [], host: h.id });
      }
    } else {
      out = (this.singleQ.data || []).map((v) => ({ ...v, used_by: v.used_by || [] }));
    }
    return out.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  }

  private createVol = async () => {
    const v = await this.prompt.ask({
      title: "create volume",
      icon: "copy",
      submitLabel: "Create",
      fields: [
        { key: "name", label: "name", placeholder: "my-data" },
        { key: "driver", label: "driver", type: "select", value: "local", options: [{ value: "local", label: "local" }] },
        {
          key: "options", label: "driver options", type: "kv", optional: true, addLabel: "option",
          placeholder: "type=nfs\no=addr=10.0.0.5,rw\ndevice=:/exports/data",
          hint: "local driver: type=nfs|cifs|tmpfs + o=… + device=… for network/tmpfs volumes",
        },
        { key: "labels", label: "labels", type: "kv", optional: true, addLabel: "label", placeholder: "team=platform" },
      ],
    });
    if (!v) return;
    try {
      await this.mkVol.call(v.name.trim(), v.driver || "local", v.options || "", v.labels || "");
      this.toast.ok("created volume " + v.name.trim());
      this.refresh();
    } catch (err: any) {
      this.toast.error("create failed: " + (err?.message ?? "error"));
    }
  };

  private removeSelected = async () => {
    const vols = this.items().filter((v) => this.selected.includes(v.name));
    if (!vols.length) return;
    const free = vols.reduce((a, v) => a + v.size, 0);
    const ok = await this.confirm.ask({
      title: "remove volumes",
      danger: true,
      confirmLabel: `Remove ${vols.length}`,
      message: `Remove ${vols.length} unused volume(s)? Their data is deleted.`,
      stats: [
        { label: "volumes", value: String(vols.length) },
        { label: "frees", value: bytes(free) },
      ],
    });
    if (!ok) return;
    await this.proc.run("removing selected volumes", async (emit) => {
      let okv = true;
      for (const v of vols) {
        const label = (v.host ? v.host + " / " : "") + v.name;
        try {
          await this.rpc.callOn(v.host || "", "System", "removeVolume", [v.name]);
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


  private del = async (v: VolumeInfo & { host?: string }) => {
    const inUse = v.used_by.length > 0;
    const ok = await this.confirm.ask({
      title: "remove volume",
      danger: true,
      confirmLabel: "Remove",
      message: inUse
        ? `"${v.name}" is mounted by ${v.used_by.length} container(s) — force-removing deletes its data.`
        : `Remove volume "${v.name}"? Its data is deleted.`,
      stats: [
        { label: "volume", value: v.name },
        ...(v.host ? [{ label: "host", value: v.host }] : []),
        { label: "frees", value: bytes(v.size) },
        { label: "mounted by", value: String(v.used_by.length) },
      ],
    });
    if (!ok) return;
    this.detail = null;
    const label = (v.host ? v.host + " / " : "") + v.name;
    await this.proc.run(`remove ${v.name}`, async (emit) => {
      try {
        emit("deleting volume " + label + "…");
        await this.rpc.callOn(v.host || "", "System", "removeVolume", [v.name]);
        emit("removed " + label);
        return true;
      } catch (err: any) {
        emit("failed: " + (err?.message ?? "error"));
        return false;
      }
    });
    this.refresh();
  };

  protected visible() {
    const q = this.query.trim().toLowerCase();
    return this.items().filter((v) => {
      if (this.filter === "mounted" && !v.used_by.length) return false;
      if (this.filter === "unused" && v.used_by.length) return false;
      if (q && !(v.name + " " + v.driver).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  update() {
    const items = this.items();
    const vis = this.visible();
    let inUseSz = 0, unusedSz = 0, mounted = 0, unusedN = 0;
    for (const v of items) {
      const sz = v.size > 0 ? v.size : 0;
      if (v.used_by.length) { inUseSz += sz; mounted++; }
      else { unusedSz += sz; unusedN++; }
    }
    const total = inUseSz + unusedSz;
    const maxSize = Math.max(1, ...vis.map((v) => (v.size > 0 ? v.size : 0)));
    const pct = (n: number) => (total ? (n / total) * 100 : 0);
    const fleet = this.fleetMode;
    const openRef = this.routeVol ? decodeURIComponent(this.routeVol) : "";
    const error = this.err();
    const busy = this.loading();
    const sel = this.selected.length;
    const first = busy && items.length === 0; // first load, nothing to show yet
    return (
      <div>
        <hope-phead heading="Volumes" scope={fleet ? "fleet" : this.hostCtx.token || "local"} meta={first ? "docker volumes" : fleet ? "aggregated across the fleet" : `${items.length} volume${items.length === 1 ? "" : "s"} on this daemon`}>
          <hope-button slot="actions" icon="plus" disabled={busy} onClick={this.createVol}>create</hope-button>
          {sel > 0 ? (
            <>
              <hope-button slot="actions" tone="danger" onClick={this.removeSelected}>remove {sel}</hope-button>
              <hope-button slot="actions" onClick={this.clearSel}>clear</hope-button>
            </>
          ) : null}
          <hope-button slot="actions" icon="rotate" spin={this.refreshing} disabled={busy} onClick={this.userRefresh}></hope-button>

          {first ? (
            <div class="disk"><div class="diskmain"><div class="disktotal"><hope-skel w="52" h="26"></hope-skel><hope-skel w="150" h="10"></hope-skel></div><hope-skel h="8"></hope-skel><div class="legend"><hope-skel w="90" h="11"></hope-skel><hope-skel w="80" h="11"></hope-skel></div></div></div>
          ) : items.length > 0 ? (
            <div class="disk">
              <div class="diskmain">
                <div class="disktotal"><span class="big num">{bytes(total)}</span><span class="lbl">in {items.length} volumes</span></div>
                <div class="meter"><i class="inuse" style={`width:${pct(inUseSz)}%`}></i><i class="unused" style={`width:${pct(unusedSz)}%`}></i></div>
                <div class="legend">
                  <span class="lg"><span class="sw inuse"></span>mounted <b>{mounted}</b> <span class="sz">&middot; {bytes(inUseSz)}</span></span>
                  <span class="lg"><span class="sw unused"></span>unused <b>{unusedN}</b> <span class="sz">&middot; {bytes(unusedSz)}</span></span>
                </div>
              </div>
              <div class="reclaim"><span class="k">reclaimable</span><span class="v num">{bytes(unusedSz)}</span><span class="sub">remove unused</span></div>
            </div>
          ) : null}
        </hope-phead>

        {error ? <div class="empty">{error}</div> : null}

        {items.length > 0 ? (
          <div class="vtools">
            <div class="seg">
              {(["all", "mounted", "unused"] as Filter[]).map((f) => (
                <button class={this.filter === f ? "on" : ""} onClick={() => (this.filter = f)}>{f}<span class="n">{f === "all" ? items.length : f === "mounted" ? mounted : unusedN}</span></button>
              ))}
            </div>
            <span class="grow"></span>
            <hope-search placeholder="Search volumes…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
          </div>
        ) : null}

        {first ? (
          <div class="rows">
            <div class="rhead"><span>name</span><span>size</span><span></span><span>driver</span><span>mounted by</span><span></span></div>
            {[0, 1, 2, 3, 4].map(() => (
              <div class="vrow" style="cursor:default">
                <div class="vname"><hope-skel w="180" h="12"></hope-skel></div>
                <div class="sizebar"><span class="track"></span></div>
                <div class="size"><hope-skel w="50" h="12"></hope-skel></div>
                <div class="driver"><hope-skel w="46" h="12"></hope-skel></div>
                <div class="mountedby"><hope-skel w="120" h="12"></hope-skel></div>
                <div class="rmc"></div>
              </div>
            ))}
          </div>
        ) : vis.length > 0 ? (
          <div class="rows">
            <div class="rhead"><span>name</span><span>size</span><span></span><span>driver</span><span>mounted by</span><span></span></div>
            {vis.map((v) => {
              const sz = v.size > 0 ? v.size : 0;
              const big = sz >= maxSize * 0.66 && sz > 0;
              return (
                <div class={"vrow" + (openRef === v.name ? " on" : "")} onClick={() => this.volInsp.select(v.host || this.hostCtx.token, v.name, () => this.refresh())}>
                  <div class="vname">{v.host ? <span class="hostchip">{v.host}</span> : null}<span class="nm" title={v.name}>{v.name}</span></div>
                  <div class={"sizebar" + (big ? " big" : "")}><span class="track"><i style={`width:${sz ? Math.max(2, (sz / maxSize) * 100) : 0}%`}></i></span></div>
                  <div class="size num">{v.size >= 0 ? bytes(v.size) : "—"}</div>
                  <div class="driver">{v.driver}</div>
                  <div class="mountedby">{v.used_by.length ? <span class="svc">{v.used_by[0].project ? <span class="proj">{v.used_by[0].project} / </span> : null}{v.used_by[0].service || v.used_by[0].name}{v.used_by.length > 1 ? <span class="extra"> +{v.used_by.length - 1}</span> : null}</span> : <span class="pill">unused</span>}</div>
                  <div class="rmc">{v.used_by.length ? null : <button class="rm" title="remove volume" onClick={(e: Event) => { e.stopPropagation(); this.del(v); }}><loom-icon name="x" size={14}></loom-icon></button>}</div>
                </div>
              );
            })}
          </div>
        ) : items.length === 0 && !error && !busy ? (
          <div class="empty">No volumes.</div>
        ) : !first && !error ? (
          <div class="empty">{this.query ? <span>No volumes match <b>{this.query}</b>.</span> : this.filter === "mounted" ? "No mounted volumes — nothing is using a volume right now." : this.filter === "unused" ? "No unused volumes — every volume is mounted." : "No volumes."}</div>
        ) : null}
      </div>
    );
  }
}
