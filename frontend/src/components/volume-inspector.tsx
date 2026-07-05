// <hope-volume-inspector> — the docked bottom panel for a volume, opened from a
// volumes-page row (like the container/image inspectors, not a modal). Two
// columns: identity + what mounts it, and mountpoint + driver options + labels.
// There's no single-volume RPC, so it finds the volume in the host's volume list.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { VolumeInspector } from "../volume-inspector";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { ProcService } from "../proc";
import { VolumeInspectorTarget } from "../events";
import { withHost } from "../host-url";
import { UNGROUPED } from "../const";
import { bytes } from "../format";
import type { VolumeInfo, ResourceUser } from "../contracts";
import { theme } from "../styles";

@component("hope-volume-inspector")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }

  .bar { display: flex; align-items: stretch; height: 38px; flex: none; border-bottom: 1px solid var(--line); }
  .who { display: flex; align-items: center; gap: 9px; padding: 0 15px; border-right: 1px solid var(--line); min-width: 0; }
  .who loom-icon { color: var(--dim); flex: none; }
  .who .nm { font: 700 12.5px/1 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who .sub { color: var(--dim); font: 500 10px/1 var(--mono); flex: none; }
  .grow { flex: 1; }
  .acts { display: flex; align-items: stretch; border-left: 1px solid var(--line); }
  .pa { display: inline-grid; place-items: center; width: 40px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .pa:hover { color: var(--hi); background: var(--raised); }
  .pa.danger:hover { color: var(--bad); }
  .pa:disabled { opacity: .4; cursor: default; }

  .body { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-columns: minmax(320px, 40%) minmax(0, 1fr); }
  .col { min-width: 0; min-height: 0; overflow-y: auto; border-right: 1px solid var(--line); }
  .col:last-child { border-right: 0; }
  .ctitle { padding: 13px 15px 9px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .ctitle.sep { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 13px; }
  .row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 5px 15px; font: 12px/1.5 var(--mono); align-items: baseline; }
  .row .k { color: var(--dim); }
  .row .v { color: var(--hi); min-width: 0; word-break: break-all; }
  .row .v.dim { color: var(--dim); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--line2); font: 10px/1.6 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--dim); }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line2)); } .pill.ok::before { background: var(--ok); }
  .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .ubs { display: flex; flex-wrap: wrap; gap: 7px; padding: 2px 15px 14px; }
  .ub { display: inline-flex; align-items: baseline; padding: 5px 9px; background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer; font: 11.5px/1 var(--mono); }
  .ub:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ub .p { color: var(--dim); }
  .kv { padding: 2px 15px 14px; }
  .empty { padding: 18px 15px; color: var(--dim); font: 12px/1.4 var(--mono); }
`)
export class HopeVolumeInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(VolumeInspector) accessor insp!: VolumeInspector;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(ProcService) accessor proc!: ProcService;

  @reactive accessor host = "";
  @reactive accessor name = "";
  @reactive accessor vol: VolumeInfo | null = null;
  @reactive accessor error = "";
  @reactive accessor busy = false;

  @mount
  onMount() { this.host = this.insp.host; this.name = this.insp.name; this.load(); }

  @on(VolumeInspectorTarget)
  private onTarget(e: VolumeInspectorTarget) {
    if (!e.name || (e.name === this.name && e.host === this.host)) return;
    this.host = e.host; this.name = e.name; this.vol = null; this.error = "";
    this.load();
  }

  private async load() {
    if (!this.name) return;
    try {
      const list = await this.rpc.callOn<VolumeInfo[]>(this.host, "System", "volumes", []);
      const v = (list || []).find((x) => x.name === this.name);
      if (!v) { this.error = "volume not found on this host"; this.vol = null; return; }
      this.vol = { ...v, used_by: v.used_by || [] };
      this.error = "";
    } catch (e: any) {
      this.error = e?.message ?? "failed to load volume";
      this.vol = null;
    }
  }

  private gotoContainer(u: ResourceUser) {
    this.insp.close();
    app.get(LoomRouter).navigate(withHost(this.host, `/stack/${encodeURIComponent(u.project || UNGROUPED)}/${encodeURIComponent(u.id)}`));
  }

  private removeVol = async () => {
    const v = this.vol;
    if (!v || this.busy) return;
    const ok = await this.confirm.ask({
      title: "remove volume",
      danger: true,
      confirmLabel: "Remove",
      message: `Remove volume "${v.name}"? Its data is deleted.`,
      stats: [{ label: "volume", value: v.name }, ...(this.host ? [{ label: "host", value: this.host }] : []), { label: "frees", value: bytes(v.size) }],
    });
    if (!ok) return;
    this.busy = true;
    try {
      await this.rpc.callOn(this.host, "System", "removeVolume", [v.name]);
      this.toast.ok(`removed ${v.name}`);
      this.insp.onChange?.();
      this.insp.close();
    } catch (e: any) {
      this.toast.error(`remove — ${e?.message ?? "failed"}`);
    } finally {
      this.busy = false;
    }
  };

  update() {
    if (!this.name) return <div class="empty">Select a volume.</div>;
    const v = this.vol;
    const inUse = !!v && v.used_by.length > 0;
    return (
      <>
        <div class="bar">
          <div class="who">
            <loom-icon name="database" size={14}></loom-icon>
            <span class="nm">{this.name}</span>
            {v ? <span class="sub">{v.driver}</span> : null}
          </div>
          <span class="grow"></span>
          <div class="acts">
            <hope-tip text={inUse ? "unmount its containers first" : "remove volume"} pos="bottom-end"><button class="pa danger" disabled={this.busy || inUse} onClick={this.removeVol}><loom-icon name="trash" size={14}></loom-icon></button></hope-tip>
            <hope-tip text="close" pos="bottom-end"><button class="pa" onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></button></hope-tip>
          </div>
        </div>

        {this.error || !v ? (
          <div class="empty">{this.error || "loading volume…"}</div>
        ) : (
          <div class="body">
            <div class="col">
              <div class="ctitle">identity</div>
              <div class="row"><span class="k">driver</span><span class="v">{v.driver}</span></div>
              {v.scope ? <div class="row"><span class="k">scope</span><span class="v">{v.scope}</span></div> : null}
              <div class="row"><span class="k">size</span><span class="v">{v.size >= 0 ? bytes(v.size) : "—"}</span></div>
              <div class="row"><span class="k">created</span><span class="v">{v.created_at ? v.created_at.replace("T", " ").replace(/\..*/, "") + " UTC" : "—"}</span></div>
              <div class="row"><span class="k">status</span><span class="v">{inUse ? <span class="pill ok">mounted</span> : <span class="pill">unused</span>}</span></div>
              <div class="ctitle sep">mounted by &middot; {v.used_by.length}</div>
              {v.used_by.length ? (
                <div class="ubs">{v.used_by.map((u) => <button class="ub" onClick={() => this.gotoContainer(u)}>{u.project ? <span class="p">{u.project} / </span> : null}{u.service || u.name}</button>)}</div>
              ) : <div class="empty">nothing mounts it — safe to remove</div>}
            </div>

            <div class="col">
              <div class="ctitle">mountpoint</div>
              <div class="row" style="grid-template-columns:1fr"><span class="v">{v.mountpoint || "—"}</span></div>
              {v.options && Object.keys(v.options).length ? (<><div class="ctitle sep">driver options</div><div class="kv"><hope-kvlist data={v.options}></hope-kvlist></div></>) : null}
              {v.labels && Object.keys(v.labels).length ? (<><div class="ctitle sep">labels</div><div class="kv"><hope-kvlist data={v.labels}></hope-kvlist></div></>) : null}
            </div>
          </div>
        )}
      </>
    );
  }
}
