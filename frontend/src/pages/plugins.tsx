// Plugins — the resource page for the container-plugin system. hope discovers
// containers across the fleet that declare a JSON-RPC endpoint (labels
// hope.plugin.*) and lists them here; each is INERT until the operator enables it.
// Enabling mints a per-plugin bearer token and records a trust fingerprint (stored
// encrypted). Discovery + trust only; rendering an enabled plugin's own views/
// actions happens in the container inspector.
//
// Instances are deduplicated by STABLE identity (host + compose project/service),
// so a redeploy keeps its trust, two of the same image in different stacks stay
// distinct, and replicas collapse to one entry.
import { LoomElement, component, styles, css, mount, reactive, prop, watch, on, app, bus } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { HopeTransport } from "../transport";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { PluginsChanged, OpenInstaller, Refreshing, withRefresh } from "../events";
import { PluginInspector } from "../plugin-inspector";
import "../components/plugin-installer"; // registers <hope-plugin-installer>
import { capabilities } from "../caps";
import { withHost } from "../host-url";
import type { PluginView } from "../contracts";
import { theme } from "../styles";

@route("/plugins") // fleet-wide system view
@route("/plugins/:host") // per-host resource view
@route("/plugins/:host/:key") // deep-linked docked inspector
@component("hope-plugins")
@styles(theme, css`
  :host { display: block; min-height: 100%; background: var(--ink); }

  .vtools { display: flex; align-items: center; gap: 10px; padding: 12px 28px; border-bottom: 1px solid var(--line); }
  .vtools .grow { flex: 1; }
  .vtools hope-search { flex: 0 0 300px; max-width: 42%; }

  .rows { padding-bottom: 24px; }
  /* Fixed tracks (no 'auto') so every row + the header share identical columns —
     each .prow is its own grid, and an auto track would size per-row and shift. */
  .rhead, .prow { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr) 232px 150px; align-items: center; gap: 18px; padding: 0 28px; }
  .rhead { height: 36px; border-bottom: 1px solid var(--line); }
  .rhead span { font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .prow { height: 52px; border-bottom: 1px solid var(--line); position: relative; cursor: pointer; }
  .prow:hover { background: var(--raised); }
  .prow.off { opacity: .58; }
  .prow.on { background: color-mix(in srgb, var(--upd) 12%, transparent); }
  .prow.on::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--upd); }
  /* the selected-row tint washes out a neutral button's var(--line) border —
     lift the border token inside the action cell (custom props reach the
     button's shadow DOM) so the disable button stays outlined when selected. */
  .prow.on .pacts { --line: var(--line2); }

  .pname { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .pname > loom-icon { color: var(--dim); flex: none; }
  .hostchip { font: 9.5px/1.6 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--upd);
    border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line2)); padding: 2px 6px; flex: none; }
  .pn { min-width: 0; }
  .pn .nm { display: block; color: var(--hi); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pn .sub { display: block; font: 11px/1.5 var(--mono); color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pstack { min-width: 0; }
  .pstack .svc { color: var(--mid); font: 12.5px/1.4 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
  .pstack .svc .proj { color: var(--dim); }
  .pstack .clink { cursor: pointer; }
  .pstack .clink:hover, .pstack .clink:hover .proj { color: var(--upd); }

  .status { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; overflow: hidden; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--line2);
    font: 10px/1.6 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--dim); }
  .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line2)); }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line2)); }
  .pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line2)); }
  .pill.flat::before { display: none; }

  .pacts { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }

  .empty { padding: 40px 28px; text-align: center; color: var(--dim); font: 12.5px/1.6 var(--mono); }
  .empty code { color: var(--mid); }
  .note { margin: 12px 28px 0; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line2));
    color: var(--warn); font: 12px/1.6 var(--mono); }
  .note code { color: var(--hi); }
`)
export class PluginsPage extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(PluginInspector) accessor insp!: PluginInspector;
  private get router(): LoomRouter { return app.get(LoomRouter); }

  // Set on the per-host resource route (/plugins/:host). Empty / "all" => fleet.
  @prop({ param: "host" }) accessor host = "";
  // Trailing :key opens the docked inspector for that plugin identity (deep-link).
  @prop({ param: "key" }) accessor routeKey = "";

  @reactive accessor plugins: PluginView[] = [];
  @reactive accessor query = "";
  @reactive accessor loaded = false;
  @reactive accessor busy = false;
  @reactive accessor error = "";
  @reactive accessor storeOn = true; // enabling needs the state store mounted to persist approval + token

  private get scoped(): boolean { return !!this.host && this.host !== "all"; }

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) { this.router.navigate("/login"); return; }
    void capabilities().then((c) => (this.storeOn = !!c.store_enabled));
    void this.load();
    this.syncInsp();
  }

  @watch("routeKey") private onKeyParam() { this.syncInsp(); }

  // A marketplace install just landed (or trust changed) — refresh the list.
  @on(PluginsChanged) private onPluginsChanged() { void this.load(true); }

  // Spin the refresh action off the shared Refreshing bus (ref-counted, min-beat),
  // not the raw `busy` flag — the resource-page pattern, so it never looks stuck.
  @reactive accessor refreshing = false;
  private refreshRC = 0;
  @on(Refreshing) private onRefreshing(e: Refreshing) {
    this.refreshRC = Math.max(0, this.refreshRC + (e.active ? 1 : -1));
    this.refreshing = this.refreshRC > 0;
  }

  private openInstaller = () => bus.emit(new OpenInstaller(this.host));

  // Drive the docked inspector from the :key route param (deep-linkable).
  private syncInsp() {
    if (this.routeKey) {
      this.insp.onChange = () => this.load(true);
      this.insp.apply(this.host, decodeURIComponent(this.routeKey));
    } else if (this.insp.isOpen) {
      this.insp.apply("", "");
    }
  }

  private async load(refresh = false) {
    this.busy = true;
    try {
      this.plugins = (await this.rpc.call<PluginView[]>("Plugins", "list", [{ refresh, host: this.host }])) || [];
      this.error = "";
    } catch (e: any) {
      this.error = e?.message ?? "failed to load plugins";
    } finally {
      this.loaded = true;
      this.busy = false;
    }
  }

  private visible(): PluginView[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.plugins;
    return this.plugins.filter((p) => (p.name + " " + p.title + " " + p.image + " " + p.project + " " + p.service + " " + p.host).toLowerCase().includes(q));
  }

  private enable = async (p: PluginView) => {
    try {
      await this.rpc.call("Plugins", "enable", [{ key: p.key }]);
      this.toast.ok(`enabled ${p.name || p.title}`);
      void this.load(true);
      bus.emit(new PluginsChanged());
    } catch (e: any) {
      this.toast.error(`enable — ${e?.message ?? "failed"}`);
    }
  };

  private disable = async (p: PluginView) => {
    try {
      await this.rpc.call("Plugins", "disable", [{ key: p.key }]);
      this.toast.ok(`disabled ${p.name || p.title}`);
      void this.load(true);
      bus.emit(new PluginsChanged());
    } catch (e: any) {
      this.toast.error(`disable — ${e?.message ?? "failed"}`);
    }
  };

  // Deep-link to the plugin's underlying container — it's just a container, so
  // reuse the stack/container view every other page links to.
  private openContainer = (p: PluginView) => {
    if (!p.present || !p.container_id) return;
    const path = p.project
      ? `/stack/${encodeURIComponent(p.project)}/${encodeURIComponent(p.container_id)}`
      : `/container/${encodeURIComponent(p.container_id)}`;
    this.router.navigate(withHost(p.host, path));
  };

  private forget = async (p: PluginView) => {
    const ok = await this.confirm.ask({
      title: "forget plugin",
      danger: true,
      confirmLabel: "Forget",
      message: `Forget ${p.name || p.key}? This drops its stored approval and token. It'll reappear as untrusted if the container is still around.`,
    });
    if (!ok) return;
    try {
      await this.rpc.call("Plugins", "forget", [{ key: p.key }]);
      this.toast.ok(`forgot ${p.name || p.key}`);
      void this.load(true);
      bus.emit(new PluginsChanged());
    } catch (e: any) {
      this.toast.error(`forget — ${e?.message ?? "failed"}`);
    }
  };

  private row(p: PluginView) {
    const open = this.routeKey && decodeURIComponent(this.routeKey) === p.key;
    return (
      <div class={"prow" + (p.enabled ? "" : " off") + (open ? " on" : "")} onClick={() => this.insp.select(p.host, p.key, () => this.load(true))}>
        <div class="pname">
          <loom-icon name="plugin" size={16}></loom-icon>
          {!this.scoped ? <span class="hostchip">{p.host}</span> : null}
          <div class="pn">
            <span class="nm" title={p.name || p.title}>{p.name || p.title || p.service || p.container_id.slice(0, 12)}</span>
            <span class="sub">{p.container_id ? p.container_id.slice(0, 12) : "—"}{p.port ? " :" + p.port : ""}{p.replicas > 1 ? ` · ${p.replicas} replicas` : ""}</span>
          </div>
        </div>
        <div class="pstack">
          {p.present ? (
            <span class="svc clink" onClick={(e: Event) => { e.stopPropagation(); this.openContainer(p); }}>
              {p.project ? <span class="proj">{p.project} / </span> : null}{p.service || p.container_id.slice(0, 12)}
            </span>
          ) : (
            <span class="pill flat">gone</span>
          )}
        </div>
        <div class="status">
          {!p.present ? <span class="pill bad">missing</span> : p.running ? <span class="pill ok">running</span> : <span class="pill warn">stopped</span>}
          {p.enabled ? <span class="pill ok">enabled</span> : p.trusted ? <span class="pill">disabled</span> : <span class="pill warn">untrusted</span>}
          {p.stale ? <span class="pill bad flat">changed</span> : null}
        </div>
        <div class="pacts" onClick={(e: Event) => e.stopPropagation()}>
          {p.present && !p.enabled ? <hope-button size="sm" tone="primary" icon="play" disabled={!this.storeOn} onClick={() => this.enable(p)}>enable</hope-button> : null}
          {p.enabled ? <hope-button size="sm" icon="stop" onClick={() => this.disable(p)}>disable</hope-button> : null}
          {p.trusted ? <hope-tip text="forget · drop approval + token" pos="top-end"><hope-button size="sm" tone="danger" icon="trash" onClick={() => this.forget(p)}></hope-button></hope-tip> : null}
        </div>
      </div>
    );
  }

  update() {
    const discovered = this.plugins.filter((p) => p.present).length;
    const enabled = this.plugins.filter((p) => p.enabled).length;
    const vis = this.visible();
    return (
      <div>
        <hope-phead
          heading="Plugins"
          scope={this.scoped ? this.host : "fleet"}
          meta={this.scoped ? "plugin containers on this host" : "container-declared endpoints across the fleet"}
        >
          <hope-button slot="actions" tone="primary" icon="download" disabled={!this.storeOn} onClick={this.openInstaller}>Install</hope-button>
          <hope-button slot="actions" icon="rotate" spin={this.refreshing} disabled={this.busy} onClick={() => void withRefresh(() => this.load(true))}></hope-button>
          <div class="vstats">
            <hope-stat label="discovered" value={String(discovered)}></hope-stat>
            <hope-stat label="enabled" value={String(enabled)} tone={enabled > 0 ? "ok" : undefined}></hope-stat>
          </div>
        </hope-phead>

        {this.error ? <div class="empty">{this.error}</div> : null}
        {!this.storeOn ? <div class="note">Enabling is disabled: the state store isn't mounted, so approvals + tokens can't persist. Set <code>[store]</code> path (a mounted volume) to enable plugins.</div> : null}

        {this.plugins.length > 0 ? (
          <div class="vtools">
            <span class="grow"></span>
            <hope-search placeholder="Search plugins…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
          </div>
        ) : null}

        {!this.loaded ? (
          <div class="empty">scanning the fleet…</div>
        ) : this.plugins.length === 0 ? (
          <div class="empty">
            No plugins discovered. Label a container <code>hope.plugin=true</code> + <code>hope.plugin.port=&lt;port&gt;</code>{" "}
            to expose a hope plugin endpoint (see docs/plugin-protocol.md), then refresh.
          </div>
        ) : vis.length === 0 ? (
          <div class="empty">No plugins match <b>{this.query}</b>.</div>
        ) : (
          <div class="rows">
            <div class="rhead"><span>plugin</span><span>image</span><span>status</span><span></span></div>
            {vis.map((p) => this.row(p))}
          </div>
        )}
        <hope-plugin-installer></hope-plugin-installer>
      </div>
    );
  }
}
