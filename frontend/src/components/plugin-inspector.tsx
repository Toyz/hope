// <hope-plugin-inspector> — the docked bottom panel for one plugin instance,
// opened from a plugins-page row (like the container/volume/network inspectors).
// Left column: identity (host, stack, container, image, endpoint). Right column:
// trust + a placeholder for the plugin's own rendered panel & live metrics, which
// arrive once hope dials the plugin (a later phase — it's just a container after
// all). Data comes from Plugins.list (cached) filtered to this host.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { PluginInspector } from "../plugin-inspector";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { PluginInspectorTarget } from "../events";
import { capabilities } from "../caps";
import { withHost } from "../host-url";
import type { PluginView } from "../contracts";
import { theme } from "../styles";

@component("hope-plugin-inspector")
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
  .pa.ok:hover { color: var(--upd); }
  .pa.danger:hover { color: var(--bad); }
  .pa:disabled { opacity: .4; cursor: default; }

  .body { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-columns: minmax(320px, 44%) minmax(0, 1fr); }
  .col { min-width: 0; min-height: 0; overflow-y: auto; border-right: 1px solid var(--line); }
  .col:last-child { border-right: 0; }
  .ctitle { padding: 13px 15px 9px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .ctitle.sep { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 13px; }
  .row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 12px; padding: 5px 15px; font: 12px/1.5 var(--mono); align-items: baseline; }
  .row .k { color: var(--dim); }
  .row .v { color: var(--hi); min-width: 0; word-break: break-all; font-variant-numeric: tabular-nums; }
  .row .v.dim { color: var(--dim); }
  .row .v.link { color: var(--mid); cursor: pointer; }
  .row .v.link:hover { color: var(--upd); }
  .flags { display: flex; flex-wrap: wrap; gap: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--line2);
    font: 10px/1.6 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--dim); }
  .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line2)); }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line2)); }
  .pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line2)); }

  .future { margin: 12px 15px; padding: 22px 16px; border: 1px dashed var(--line2); text-align: center; color: var(--dim); font: 12px/1.7 var(--mono); }
  .future b { color: var(--mid); font-weight: 600; }
  .empty { padding: 18px 15px; color: var(--dim); font: 12px/1.4 var(--mono); }
`)
export class HopePluginInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(PluginInspector) accessor insp!: PluginInspector;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;

  @reactive accessor host = "";
  @reactive accessor key = "";
  @reactive accessor view: PluginView | null = null;
  @reactive accessor error = "";
  @reactive accessor busy = false;
  @reactive accessor storeOn = true;

  @mount
  onMount() {
    this.host = this.insp.host;
    this.key = this.insp.key;
    void capabilities().then((c) => (this.storeOn = !!c.store_enabled));
    void this.load();
  }

  @on(PluginInspectorTarget)
  private onTarget(e: PluginInspectorTarget) {
    if (!e.key || (e.key === this.key && e.host === this.host)) return;
    this.host = e.host;
    this.key = e.key;
    this.view = null;
    this.error = "";
    void this.load();
  }

  private async load() {
    if (!this.key) return;
    try {
      const all = (await this.rpc.call<PluginView[]>("Plugins", "list", [{ host: this.host }])) || [];
      const v = all.find((p) => p.key === this.key) || null;
      this.view = v;
      this.error = v ? "" : "plugin not found on this host";
    } catch (e: any) {
      this.error = e?.message ?? "failed to load plugin";
      this.view = null;
    }
  }

  private act = async (method: "enable" | "disable" | "forget") => {
    const v = this.view;
    if (!v || this.busy) return;
    if (method === "forget") {
      const ok = await this.confirm.ask({
        title: "forget plugin",
        danger: true,
        confirmLabel: "Forget",
        message: `Forget ${v.name || v.key}? Drops its stored approval + token.`,
      });
      if (!ok) return;
    }
    this.busy = true;
    try {
      await this.rpc.call("Plugins", method, [{ key: v.key }]);
      this.toast.ok(`${method}d ${v.name || v.service || "plugin"}`);
      this.insp.onChange?.();
      if (method === "forget") this.insp.close();
      else void this.load();
    } catch (e: any) {
      this.toast.error(`${method} — ${e?.message ?? "failed"}`);
    } finally {
      this.busy = false;
    }
  };

  private gotoContainer() {
    const v = this.view;
    if (!v || !v.present || !v.container_id) return;
    this.insp.close();
    const path = v.project
      ? `/stack/${encodeURIComponent(v.project)}/${encodeURIComponent(v.container_id)}`
      : `/container/${encodeURIComponent(v.container_id)}`;
    app.get(LoomRouter).navigate(withHost(v.host, path));
  }

  update() {
    if (!this.key) return <div class="empty">Select a plugin.</div>;
    const v = this.view;
    return (
      <>
        <div class="bar">
          <div class="who">
            <loom-icon name="plugin" size={14}></loom-icon>
            <span class="nm">{v ? v.name || v.title || v.service || v.key : this.key}</span>
            {v ? <span class="sub">{v.host}</span> : null}
          </div>
          <span class="grow"></span>
          <div class="acts">
            {v && v.present && !v.enabled ? (
              <hope-tip text={this.storeOn ? "enable" : "store not mounted"} pos="bottom-end"><button class="pa ok" disabled={this.busy || !this.storeOn} onClick={() => this.act("enable")}><loom-icon name="play" size={14}></loom-icon></button></hope-tip>
            ) : null}
            {v && v.enabled ? (
              <hope-tip text="disable" pos="bottom-end"><button class="pa" disabled={this.busy} onClick={() => this.act("disable")}><loom-icon name="stop" size={14}></loom-icon></button></hope-tip>
            ) : null}
            {v && v.trusted ? (
              <hope-tip text="forget" pos="bottom-end"><button class="pa danger" disabled={this.busy} onClick={() => this.act("forget")}><loom-icon name="trash" size={14}></loom-icon></button></hope-tip>
            ) : null}
            <hope-tip text="close" pos="bottom-end"><button class="pa" onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></button></hope-tip>
          </div>
        </div>

        {this.error || !v ? (
          <div class="empty">{this.error || "loading plugin…"}</div>
        ) : (
          <div class="body">
            <div class="col">
              <div class="ctitle">identity</div>
              <div class="row"><span class="k">host</span><span class="v">{v.host}</span></div>
              <div class="row"><span class="k">stack</span>{v.project ? <span class="v link" onClick={() => this.gotoContainer()}>{v.project}{v.service ? " / " + v.service : ""}</span> : <span class="v dim">standalone</span>}</div>
              <div class="row"><span class="k">container</span>{v.present && v.container_id ? <span class="v link" onClick={() => this.gotoContainer()}>{v.container_id.slice(0, 12)}</span> : <span class="v dim">—</span>}</div>
              <div class="row"><span class="k">image</span><span class="v">{v.image || "—"}</span></div>
              <div class="row"><span class="k">endpoint</span><span class="v">{v.port ? ":" + v.port : "—"}{v.path || ""}</span></div>
              {v.replicas > 1 ? <div class="row"><span class="k">replicas</span><span class="v">{v.replicas}</span></div> : null}

              <div class="ctitle sep">trust</div>
              <div class="row"><span class="k">state</span><span class="v"><span class="flags">
                {!v.present ? <span class="pill bad">missing</span> : v.running ? <span class="pill ok">running</span> : <span class="pill warn">stopped</span>}
                {v.enabled ? <span class="pill ok">enabled</span> : v.trusted ? <span class="pill">disabled</span> : <span class="pill warn">untrusted</span>}
                {v.stale ? <span class="pill bad">changed</span> : null}
              </span></span></div>
            </div>

            <div class="col">
              <div class="ctitle">settings</div>
              <div class="future">
                {v.enabled
                  ? <span>Operator-managed <b>settings</b> the plugin declares are configured &amp; saved here.<br />Its own panel &amp; live metrics render on the <b>container</b> inspector — it's just a container.<br />(editable form arrives once hope dials the plugin.)</span>
                  : <span>Enable this plugin to configure its settings here.<br />Its panel &amp; metrics render on the <b>container</b> inspector.</span>}
              </div>
            </div>
          </div>
        )}
      </>
    );
  }
}
