// <hope-plugin-inspector> — the docked bottom panel for one plugin instance,
// opened from a plugins-page row (like the container/volume/network inspectors).
// Left column: identity (host, stack, container, image, endpoint). Right column:
// trust + a placeholder for the plugin's own rendered panel & live metrics, which
// arrive once hope dials the plugin (a later phase — it's just a container after
// all). Data comes from Plugins.list (cached) filtered to this host.
import { LoomElement, component, styles, css, reactive, mount, on, app, bus } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { consumeOpStream } from "../stream-op";
import { PluginInspector } from "../plugin-inspector";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { ProcService } from "../proc";
import { PromptService, type PromptField } from "../prompt";
import { PluginInspectorTarget, PluginsChanged } from "../events";
import { capabilities } from "../caps";
import { withHost } from "../host-url";
import type { PluginView, PluginConfig, OpFrame, PluginMetric, AuditEntry, PluginStatus } from "../contracts";
import { ago } from "../format";
import { theme } from "../styles";
import { scopeLabel, SCOPE_ORDER } from "../scope-labels";

function orderedScopes(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const s of l ?? []) seen.add(s);
  const known = SCOPE_ORDER.filter((s) => seen.has(s));
  const extra = [...seen].filter((s) => !SCOPE_ORDER.includes(s)); // future scopes, appended
  return [...known, ...extra];
}

// A plugin's operator-managed setting descriptor (subset of hope.schema.settings).
interface PluginSetting {
  key: string;
  label: string;
  kind?: "text" | "textarea" | "select" | "toggle" | "number" | "secret";
  default?: string;
  hint?: string;
  options?: { label: string; value: string }[];
}
interface PluginManifest {
  schema: { settings?: PluginSetting[] };
  layout: unknown;
  settings: Record<string, string> | null;
}

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
  .row { display: grid; grid-template-columns: 136px minmax(0, 1fr); gap: 14px; padding: 6px 16px; font: 12px/1.5 var(--mono); align-items: baseline; }
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
  .ctitle { display: flex; align-items: center; justify-content: space-between; }
  .ctitle .edit { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; background: transparent; border: 1px solid var(--line); color: var(--dim); cursor: pointer; font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .ctitle .edit:hover { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  /* permission grant toggle — hope's standard switch */
  .tog { display: inline-flex; width: 34px; height: 18px; border: 1px solid var(--line2); background: var(--ink); position: relative; flex: none; cursor: pointer; transition: background .12s, border-color .12s; }
  .tog::after { content: ""; position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; background: var(--dim); transition: transform .12s, background .12s; }
  .tog.on { border-color: var(--upd); background: color-mix(in srgb, var(--upd) 22%, var(--ink)); }
  .tog.on::after { transform: translateX(16px); background: var(--upd); }
  .tog.busy { opacity: .5; pointer-events: none; }
  .retry { margin-left: 6px; padding: 2px 7px; background: transparent; border: 1px solid var(--line2); color: var(--mid); cursor: pointer; font: 11px/1.4 var(--mono); }
  .retry:hover { color: var(--upd); }
  /* advisory self-status — plugin-reported health, colored by level (hope owns liveness) */
  .advis { display: flex; align-items: baseline; gap: 10px; margin: 6px 16px 2px; padding: 8px 12px;
    border: 1px solid var(--line2); border-left-width: 3px; font: 11.5px/1.5 var(--mono); }
  .advis .al { color: var(--hi); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; flex: none; }
  .advis .ad { color: var(--mid); min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .advis .age { color: var(--dim); font-variant-numeric: tabular-nums; flex: none; }
  .advis.ok { border-left-color: var(--ok); } .advis.ok .al { color: var(--ok); }
  .advis.info { border-left-color: var(--upd); } .advis.info .al { color: var(--upd); }
  .advis.warn { border-left-color: var(--warn); } .advis.warn .al { color: var(--warn); }
  .advis.error { border-left-color: var(--bad); } .advis.error .al { color: var(--bad); }
  /* operations — metrics tiles + audit trail */
  .mets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin: 4px 0 2px; background: var(--line); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .met { display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; background: var(--panel); min-width: 0; }
  .met .mv { color: var(--hi); font: 600 14px/1 var(--mono); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .met.bad .mv { color: var(--bad); }
  .met .mk { color: var(--dim); font: 9px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .audit { display: flex; flex-direction: column; }
  .ae { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto auto; align-items: baseline; gap: 10px;
    padding: 7px 16px; font: 11.5px/1.4 var(--mono); border-bottom: 1px solid var(--line); }
  .ae .am { color: var(--mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ae .aa { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ae.bad .am { color: var(--bad); }
  .ae.danger .am::before { content: "! "; color: var(--warn); }
  .ae .at, .ae .ag { color: var(--dim); font-variant-numeric: tabular-nums; }
  .ae .ag { min-width: 40px; text-align: right; }
`)
export class HopePluginInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(PluginInspector) accessor insp!: PluginInspector;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ProcService) accessor proc!: ProcService;

  @reactive accessor host = "";
  @reactive accessor key = "";
  @reactive accessor view: PluginView | null = null;
  @reactive accessor error = "";
  @reactive accessor busy = false;
  @reactive accessor storeOn = true;

  // Settings (fetched from the manifest once the plugin is enabled + reachable).
  @reactive accessor settings: PluginSetting[] = [];
  @reactive accessor settingVals: Record<string, string> = {};
  @reactive accessor manifestErr = "";
  @reactive accessor manifestBusy = false;

  // Configuration (env) — only for a hope-INSTALLED plugin (has a catalog id + stored
  // spec). Editing env recreates the container; empty for hand-labeled plugins.
  @reactive accessor config: PluginConfig | null = null;

  // Operations — in-memory metrics + the durable audit trail (both already recorded by
  // hope; this surfaces them). Fetched alongside the manifest for an enabled plugin.
  @reactive accessor metric: PluginMetric | null = null;
  @reactive accessor audit: AuditEntry[] = [];
  @reactive accessor status: PluginStatus | null = null; // plugin's advisory self-reported health
  @reactive accessor opsBusy = false;

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
    const host = this.host, key = this.key;
    this.settings = [];
    this.settingVals = {};
    this.config = null;
    this.manifestErr = "";
    this.metric = null;
    this.audit = [];
    this.status = null;
    try {
      const all = (await this.rpc.call<PluginView[]>("Plugins", "list", [{ host }])) || [];
      if (host !== this.host || key !== this.key) return; // switched plugin mid-flight
      const v = all.find((p) => p.key === key) || null;
      this.view = v;
      this.error = v ? "" : "plugin not found on this host";
      if (v?.enabled) { void this.loadManifest(); void this.loadConfig(); void this.loadOps(); }
    } catch (e: any) {
      if (host !== this.host || key !== this.key) return;
      this.error = e?.message ?? "failed to load plugin";
      this.view = null;
    }
  }

  // Fetch the env schema + current values for a hope-installed plugin. Empty (fields
  // = []) for a hand-labeled plugin, which hides the Configuration section.
  private async loadConfig() {
    const key = this.key;
    try {
      const cfg = await this.rpc.call<PluginConfig>("Plugins", "config", [{ key }]);
      if (key === this.key) this.config = cfg;
    } catch { if (key === this.key) this.config = null; }
  }

  // Fetch this plugin's observability: in-memory metrics (returned for all plugins,
  // filtered to this key) + its audit trail. Non-fatal — no store just means no audit.
  private async loadOps() {
    const key = this.key;
    this.opsBusy = true;
    try {
      const [metrics, audit, status] = await Promise.all([
        this.rpc.call<PluginMetric[]>("Plugins", "metrics", []),
        this.rpc.call<AuditEntry[]>("Plugins", "audit", [{ key, limit: 50 }]),
        this.rpc.call<PluginStatus>("Plugins", "status", [{ key }]),
      ]);
      if (key !== this.key) return;
      this.metric = (metrics || []).find((m) => m.key === key) || null;
      this.audit = audit || [];
      this.status = status && status.level ? status : null;
    } catch {
      if (key === this.key) { this.metric = null; this.audit = []; this.status = null; }
    } finally {
      if (key === this.key) this.opsBusy = false;
    }
  }

  // Edit env via the shared prompt form, then stream a recreate (Stream/reconfigurePlugin).
  private editConfig = async () => {
    const cfg = this.config;
    if (!cfg?.fields?.length) return;
    const fields: PromptField[] = cfg.fields.map((f) => ({
      key: f.key,
      label: f.label || f.key,
      type: f.kind === "select" ? "select" : f.kind === "toggle" ? "toggle" : "text",
      value: f.kind === "secret" ? "" : (cfg.values[f.key] ?? f.default ?? ""),
      hint: f.kind === "secret" ? "leave blank to keep the current value" : f.hint,
      options: f.options,
      optional: true,
    }));
    const v = await this.prompt.ask({ title: "plugin configuration", icon: "edit", submitLabel: "Save + recreate", fields });
    if (!v) return;
    let ok = false;
    await this.proc.run("reconfigure " + (this.view?.service || this.key), async (emit, signal) => {
      if (!(await consumeOpStream(this.rpc.streamWithSignal<OpFrame>("Stream", "reconfigurePlugin", [this.key, JSON.stringify(v)], signal, this.host), emit))) return false;
      ok = true;
      return true;
    });
    if (ok) {
      this.toast.ok("reconfigured");
      bus.emit(new PluginsChanged());
      void this.load();
    }
  };

  // Dial the enabled plugin for its settings schema + current values. Reachability
  // failures are non-fatal — the identity/trust view still renders.
  private async loadManifest() {
    const key = this.key;
    this.manifestBusy = true;
    try {
      const m = await this.rpc.call<PluginManifest>("Plugins", "manifest", [{ key }]);
      if (key !== this.key) return; // switched plugin while dialing (this call is slow) — don't show A's settings under B
      this.settings = m?.schema?.settings || [];
      this.settingVals = m?.settings || {};
      this.manifestErr = "";
    } catch (e: any) {
      if (key === this.key) this.manifestErr = e?.message ?? "couldn't reach the plugin";
    } finally {
      if (key === this.key) this.manifestBusy = false;
    }
  }

  // Edit settings via the shared prompt form, then persist + push through hope.
  private editSettings = async () => {
    if (!this.settings.length) return;
    const fields: PromptField[] = this.settings.map((s) => ({
      key: s.key,
      label: s.label || s.key,
      type: s.kind === "textarea" ? "textarea" : s.kind === "select" ? "select" : s.kind === "toggle" ? "toggle" : "text",
      value: this.settingVals[s.key] ?? s.default ?? "",
      hint: s.hint,
      options: s.options,
      optional: true,
    }));
    const v = await this.prompt.ask({ title: "plugin settings", icon: "edit", submitLabel: "Save", fields });
    if (!v) return;
    try {
      await this.rpc.call("Plugins", "setSettings", [{ key: this.key, values: v }]);
      this.toast.ok("saved settings");
      void this.loadManifest();
    } catch (e: any) {
      this.toast.error(`save — ${e?.message ?? "failed"}`);
    }
  };

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
      bus.emit(new PluginsChanged());
      if (method === "forget") this.insp.close();
      else void this.load();
    } catch (e: any) {
      this.toast.error(`${method} — ${e?.message ?? "failed"}`);
    } finally {
      this.busy = false;
    }
  };

  // Allow (grant) or deny/revoke a reverse-capability scope. Deny doubles as revoke.
  private decideScope = async (scope: string, allow: boolean) => {
    const v = this.view;
    if (!v || this.busy) return;
    this.busy = true;
    try {
      await this.rpc.call("Plugins", allow ? "grant" : "deny", [{ key: v.key, scope }]);
      this.toast.ok(`${allow ? "granted" : "revoked"} ${scopeLabel(scope)}`);
      bus.emit(new PluginsChanged());
      await this.load();
    } catch (e: any) {
      this.toast.error(`${allow ? "grant" : "revoke"} — ${e?.message ?? "failed"}`);
    } finally {
      this.busy = false;
    }
  };

  // Display value for a setting row — secrets are masked, never revealed.
  private settingDisplay(s: PluginSetting): string {
    const val = this.settingVals[s.key] ?? s.default ?? "";
    if (s.kind === "secret") return val ? "••••••" : "—";
    return val || "—";
  }

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
              <button class="pa ok" tip={{ text: this.storeOn ? "enable" : "store not mounted", pos: "bottom-end" }} disabled={this.busy || !this.storeOn} onClick={() => this.act("enable")}><loom-icon name="play" size={14}></loom-icon></button>
            ) : null}
            {v && v.enabled ? (
              <button class="pa" tip={{ text: "disable", pos: "bottom-end" }} disabled={this.busy} onClick={() => this.act("disable")}><loom-icon name="stop" size={14}></loom-icon></button>
            ) : null}
            {v && v.trusted ? (
              <button class="pa danger" tip={{ text: "forget", pos: "bottom-end" }} disabled={this.busy} onClick={() => this.act("forget")}><loom-icon name="trash" size={14}></loom-icon></button>
            ) : null}
            <button class="pa" tip={{ text: "close", pos: "bottom-end" }} onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></button>
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
                {v.enabled ? (this.manifestBusy && !this.settings.length ? <span class="pill">dialing</span> : this.manifestErr ? <span class="pill bad">unreachable</span> : <span class="pill ok">reachable</span>) : null}
              </span></span></div>

              {(() => {
                const scopes = orderedScopes(v.grants, v.pending, v.denied);
                if (!v.trusted || scopes.length === 0) return null;
                return (
                  <>
                    <div class="ctitle sep">permissions</div>
                    {scopes.map((sc) => {
                      const on = (v.grants ?? []).includes(sc);
                      return (
                        <div class="row">
                          <span class="k">{scopeLabel(sc)}</span>
                          <span class="v"><span class={"tog" + (on ? " on" : "") + (this.busy ? " busy" : "")} title={on ? "granted — click to revoke" : "click to allow"} onClick={() => this.decideScope(sc, !on)}></span></span>
                        </div>
                      );
                    })}
                  </>
                );
              })()}
            </div>

            <div class="col">
              <div class="ctitle">
                settings
                {v.enabled && this.settings.length ? <button class="edit" onClick={this.editSettings}><loom-icon name="edit" size={12}></loom-icon>edit</button> : null}
              </div>
              {!v.enabled ? (
                <div class="future"><span>Enable this plugin to configure its settings &amp; see its operations here.<br />Its rendered panel appears on the <b>container</b> inspector — it's just a container.</span></div>
              ) : this.manifestBusy && !this.settings.length ? (
                <div class="empty">dialing the plugin…</div>
              ) : this.manifestErr ? (
                <div class="empty">couldn't reach the plugin — {this.manifestErr} <button class="retry" onClick={() => this.loadManifest()}>retry</button></div>
              ) : !this.settings.length ? (
                <div class="future"><span>This plugin exposes no settings.<br />Its rendered panel appears on the <b>container</b> inspector.</span></div>
              ) : (
                <>
                  {this.settings.map((s) => (
                    <div class="row"><span class="k">{s.label || s.key}</span><span class="v">{this.settingDisplay(s)}</span></div>
                  ))}
                </>
              )}

              {v.enabled && this.config && this.config.fields?.length ? (
                <>
                  <div class="ctitle sep">
                    configuration
                    <button class="edit" onClick={this.editConfig}><loom-icon name="edit" size={12}></loom-icon>edit</button>
                  </div>
                  {this.config.fields.map((f) => (
                    <div class="row">
                      <span class="k">{f.label || f.key}</span>
                      <span class="v">{f.kind === "secret" ? "••••••" : (this.config!.values[f.key] || f.default || "—")}</span>
                    </div>
                  ))}
                </>
              ) : null}

              {v.enabled ? (
                <>
                  <div class="ctitle sep">operations</div>
                  {this.status ? (
                    <div class={"advis " + this.status.level}>
                      <span class="al">{this.status.status || this.status.level}</span>
                      {this.status.detail ? <span class="ad">{this.status.detail}</span> : <span class="ad"></span>}
                      <span class="age">{this.status.at_ms ? ago(new Date(this.status.at_ms).toISOString()) : ""}</span>
                    </div>
                  ) : null}
                  {this.opsBusy && !this.metric && !this.audit.length ? (
                    <div class="empty">loading…</div>
                  ) : (
                    <>
                      <div class="mets">
                        <div class="met"><span class="mv">{this.metric?.calls ?? 0}</span><span class="mk">calls</span></div>
                        <div class={"met" + (this.metric?.errors ? " bad" : "")}><span class="mv">{this.metric?.errors ?? 0}</span><span class="mk">errors</span></div>
                        <div class="met"><span class="mv">{this.metric?.calls ? Math.round(this.metric.avg_ms) + "ms" : "—"}</span><span class="mk">avg</span></div>
                        <div class="met"><span class="mv">{this.metric?.last_at_ms ? ago(new Date(this.metric.last_at_ms).toISOString()) : "—"}</span><span class="mk">last call</span></div>
                      </div>
                      {this.audit.length ? (
                        <div class="audit">
                          {this.audit.map((a) => (
                            <div class={"ae" + (a.ok ? "" : " bad") + (a.danger ? " danger" : "")} title={a.err || undefined}>
                              <span class="am">{a.method}</span>
                              <span class="aa">{a.actor || "—"}</span>
                              <span class="at">{a.ms}ms</span>
                              <span class="ag">{ago(a.time)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div class="empty">No audited actions yet — mutations a plugin runs through hope appear here.</div>
                      )}
                    </>
                  )}
                </>
              ) : null}
            </div>
          </div>
        )}
      </>
    );
  }
}
