// <hope-plugin-installer> — the marketplace install wizard. Opened from the plugins
// page (OpenInstaller event), it browses the catalog (built-in + remote repos), lets
// the operator pick one or several plugins, name the stack, set each plugin's env +
// setting overrides + placement (join networks or a new plugin stack), then streams the
// server-side install (Stream/installPlugin) into the shared processing dialog. hope
// pulls the image, deploys the container(s) wired so it can reach them, and auto-enables.
import { LoomElement, component, styles, css, reactive, on, bus } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { ProcService } from "../proc";
import { ToastService } from "../toast";
import { OpenInstaller, PluginsChanged, Refreshing, withRefresh } from "../events";
import type { CatalogEntry, CatalogEnvField, InstallParams, NetworkInfo, StackSummary, HostView, OpFrame } from "../contracts";
import { theme } from "../styles";
import "./select"; // <hope-select>

const PLUGIN_NET = "ink-plugins"; // hope's bridge; never a user-pickable target

// Per-plugin form state.
interface InstForm {
  name: string;
  env: Record<string, string>;
  settings: Record<string, string>;
}

@component("hope-plugin-installer")
@styles(theme, css`
  :host { display: contents; }
  .overlay { position: fixed; inset: 0; z-index: 60; display: none; }
  .overlay.open { display: block; }
  .scrim { position: absolute; inset: 0; background: color-mix(in srgb, var(--ink) 78%, transparent); }
  .modal { position: absolute; inset: 4% 6%; background: var(--panel); border: 1px solid var(--line2); display: flex; flex-direction: column; min-height: 0; box-shadow: 0 24px 80px rgba(0,0,0,.5); }
  .head { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); flex: none; }
  .head .t { color: var(--hi); font: 700 14px/1 var(--mono); }
  .head .sub { display: inline-flex; align-items: center; gap: 5px; color: var(--dim); font: 11px/1 var(--mono); }
  .head .grow { flex: 1; }
  .x { display: inline-grid; place-items: center; width: 32px; height: 32px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .x:hover { color: var(--hi); }
  .tools { display: flex; align-items: center; gap: 10px; padding: 10px 20px; border-bottom: 1px solid var(--line); flex: none; }
  .tools .grow { flex: 1; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px; }
  .foot { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--line); flex: none; }
  .foot .grow { flex: 1; }
  .foot .note { color: var(--dim); font: 11.5px/1.5 var(--mono); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--line); background: var(--ink); padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; cursor: pointer; transition: border-color .12s ease, background .12s ease; }
  .card:hover { border-color: color-mix(in srgb, var(--upd) 35%, var(--line2)); }
  .card.sel { border-color: color-mix(in srgb, var(--upd) 55%, var(--line2)); background: color-mix(in srgb, var(--upd) 6%, var(--ink)); }
  .card .ch { display: flex; align-items: center; gap: 10px; }
  .card .ch loom-icon { color: var(--mid); flex: none; }
  .ck { display: inline-block; width: 15px; height: 15px; flex: none; border: 1px solid var(--line2); vertical-align: middle; position: relative; }
  .ck.on { background: var(--upd); border-color: var(--upd); box-shadow: inset 0 0 0 3px var(--panel); }
  .card .nm { color: var(--hi); font: 600 13px/1.2 var(--mono); overflow: hidden; text-overflow: ellipsis; }
  .card .src { margin-left: auto; color: var(--dim); font: 9px/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; border: 1px solid var(--line2); padding: 1px 5px; flex: none; }
  .card .desc { color: var(--mid); font: 11.5px/1.55 var(--mono); flex: 1; }
  .card .img { color: var(--dim); font: 10.5px/1.4 var(--mono); overflow: hidden; text-overflow: ellipsis; }
  .card .cta { display: flex; gap: 8px; }

  .sec { margin-bottom: 18px; }
  .sec > .lbl { color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; margin-bottom: 10px; display: block; }
  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .field > label { color: var(--mid); font: 12px/1.3 var(--mono); }
  .field > label .req { color: var(--bad); }
  .field .hint { color: var(--dim); font: 10.5px/1.4 var(--mono); }
  input[type=text], input[type=password], input[type=number] { height: 36px; background: var(--ink); border: 1px solid var(--line); color: var(--hi); padding: 0 10px; font: 12.5px/1 var(--mono); }
  input:focus { outline: none; border-color: color-mix(in srgb, var(--upd) 55%, var(--line2)); }
  .toggle { display: inline-flex; align-items: center; gap: 8px; color: var(--mid); font: 12px/1 var(--mono); cursor: pointer; }
  .radio { display: flex; gap: 16px; margin-bottom: 12px; }
  .radio label { display: inline-flex; align-items: center; gap: 7px; color: var(--mid); font: 12px/1 var(--mono); cursor: pointer; }
  .nets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .nchip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 7px 4px 10px; border: 1px solid color-mix(in srgb, var(--upd) 50%, var(--line2)); color: var(--upd); background: color-mix(in srgb, var(--upd) 8%, transparent); font: 11.5px/1 var(--mono); cursor: pointer; }
  .nchip loom-icon { color: var(--dim); }
  .nchip:hover { border-color: color-mix(in srgb, var(--bad) 45%, var(--line2)); color: var(--bad); }
  .nchip:hover loom-icon { color: var(--bad); }
  .pcfg { border: 1px solid var(--line); padding: 14px; margin-bottom: 14px; }
  .pcfg > .h { color: var(--hi); font: 600 12.5px/1 var(--mono); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .vol { color: var(--dim); font: 11px/1.5 var(--mono); }
  .vol code { color: var(--mid); }
  .empty { color: var(--dim); font: 12.5px/1.6 var(--mono); text-align: center; padding: 36px; }
`)
export class HopePluginInstaller extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(ToastService) accessor toast!: ToastService;

  @reactive accessor open = false;
  @reactive accessor host = "";
  @reactive accessor catalog: CatalogEntry[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor busy = false;
  // Spin the refresh button off the shared Refreshing bus (ref-counted, min-beat) —
  // NOT a raw loading flag, which looks stuck. Matches the resource pages.
  @reactive accessor refreshing = false;
  private refreshRC = 0;
  @on(Refreshing) private onRefreshing(e: Refreshing) {
    this.refreshRC = Math.max(0, this.refreshRC + (e.active ? 1 : -1));
    this.refreshing = this.refreshRC > 0;
  }

  @reactive accessor step: "browse" | "config" = "browse";
  @reactive accessor selected: string[] = []; // catalog ids
  @reactive accessor forms: Record<string, InstForm> = {};
  @reactive accessor project = "";
  @reactive accessor placeMode: "new_stack" | "stack_net" = "new_stack";
  @reactive accessor pickNets: string[] = []; // extra networks ALL plugins join (config, not placement)
  @reactive accessor pickStack = "";

  @reactive accessor networks: NetworkInfo[] = [];
  @reactive accessor stacks: StackSummary[] = [];
  @reactive accessor hosts: HostView[] = [];

  @on(OpenInstaller)
  private onOpen(e: OpenInstaller) {
    this.host = e.host && e.host !== "all" ? e.host : "";
    this.open = true;
    this.step = "browse";
    this.selected = [];
    this.forms = {};
    this.project = "";
    this.pickNets = [];
    this.placeMode = "new_stack";
    void this.loadCatalog(e.preselect);
    void this.loadResources();
  }

  private async loadCatalog(preselect = "") {
    this.loaded = false;
    try {
      this.catalog = (await this.rpc.call<CatalogEntry[]>("Plugins", "catalog", [])) || [];
      this.error = "";
      if (preselect && this.catalog.some((c) => c.id === preselect)) this.installOne(preselect);
    } catch (e: any) {
      this.error = e?.message ?? "failed to load catalog";
    } finally {
      this.loaded = true;
    }
  }

  private async loadResources() {
    try {
      this.hosts = (await this.rpc.call<HostView[]>("System", "hosts", [])) || [];
    } catch { this.hosts = []; }
    // Install must name a host; default to the opened host, else the active/first connected.
    if (!this.host) {
      const connected = this.hosts.filter((h) => h.connected);
      this.host = (connected.find((h) => h.active) || connected[0])?.id || "";
    }
    await this.reloadHostResources();
  }

  private async reloadHostResources() {
    const h = this.host || undefined;
    try {
      this.networks = (await this.rpc.call<NetworkInfo[]>("System", "networks", [], undefined, false, h)) || [];
    } catch { this.networks = []; }
    try {
      this.stacks = (await this.rpc.call<StackSummary[]>("Stacks", "list", [], undefined, false, h)) || [];
    } catch { this.stacks = []; }
  }

  private setHost = (id: string) => { this.host = id; this.pickNets = []; void this.reloadHostResources(); };

  private refresh = async () => {
    this.busy = true;
    try {
      this.catalog = (await this.rpc.call<CatalogEntry[]>("Plugins", "refreshCatalog", [])) || [];
      this.toast.ok("catalog refreshed");
    } catch (e: any) {
      this.toast.error(`refresh — ${e?.message ?? "failed"}`);
    } finally {
      this.busy = false;
    }
  };

  private entry(id: string): CatalogEntry | undefined { return this.catalog.find((c) => c.id === id); }

  private toggleSelect = (id: string) => {
    this.selected = this.selected.includes(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id];
  };

  // "Install" on a card -> just that plugin, straight to config.
  private installOne = (id: string) => {
    this.selected = [id];
    this.goConfig();
  };

  private goConfig = () => {
    if (!this.selected.length) return;
    const forms: Record<string, InstForm> = {};
    for (const id of this.selected) {
      const e = this.entry(id);
      if (!e) continue;
      const env: Record<string, string> = {};
      for (const f of e.env || []) env[f.key] = f.default ?? "";
      const settings: Record<string, string> = {};
      for (const s of e.settings || []) settings[s.key] = s.value;
      forms[id] = { name: this.forms[id]?.name || e.id, env, settings };
    }
    this.forms = forms;
    // Multiple plugins => a shared new stack; a single plugin defaults its own name.
    if (this.selected.length > 1) this.placeMode = "new_stack";
    if (!this.project) this.project = this.selected.length === 1 ? forms[this.selected[0]].name : "plugins";
    this.step = "config";
  };

  private setName = (id: string, v: string) => { this.forms = { ...this.forms, [id]: { ...this.forms[id], name: v } }; };
  private setEnv = (id: string, key: string, v: string) => {
    this.forms = { ...this.forms, [id]: { ...this.forms[id], env: { ...this.forms[id].env, [key]: v } } };
  };
  private setSetting = (id: string, key: string, v: string) => {
    this.forms = { ...this.forms, [id]: { ...this.forms[id], settings: { ...this.forms[id].settings, [key]: v } } };
  };
  private toggleNet = (name: string) => {
    this.pickNets = this.pickNets.includes(name) ? this.pickNets.filter((n) => n !== name) : [...this.pickNets, name];
  };

  // The docker networks that belong to a compose stack (its <project>_* nets, e.g.
  // <project>_default) — what a plugin joins to reach that stack's containers.
  private stackNets(project: string): string[] {
    const pfx = project + "_";
    const nets = this.networks.filter((n) => n.name === project || n.name.startsWith(pfx)).map((n) => n.name);
    return nets.length ? nets : [project + "_default"];
  }

  private setStack = (project: string) => {
    this.pickStack = project;
    this.pickNets = this.stackNets(project);
  };

  private close = () => { this.open = false; };

  // User-attachable networks: exclude hope's own bridge and docker's defaults
  // (bridge/host/none) — none of which is a useful plugin attach target.
  private pickableNets(): NetworkInfo[] {
    const skip = new Set([PLUGIN_NET, "bridge", "host", "none"]);
    return this.networks.filter((n) => !skip.has(n.name));
  }

  // Options for the "add a network" searchable dropdown — attachable nets not yet
  // picked (the dropdown's own search handles hundreds of networks).
  private availNets(): { value: string; label: string }[] {
    return this.pickableNets().filter((n) => !this.pickNets.includes(n.name)).map((n) => ({ value: n.name, label: n.name }));
  }

  private addNet = (name: string) => {
    if (name && !this.pickNets.includes(name)) this.pickNets = [...this.pickNets, name];
  };

  // Validate required + select env before install.
  private validate(): string {
    if (!this.host) return "pick a target host";
    if (this.placeMode === "new_stack" && !this.project.trim()) return "a stack name is required";
    if (this.placeMode === "stack_net" && !this.pickStack) return "pick a stack to join";
    for (const id of this.selected) {
      const e = this.entry(id); const f = this.forms[id];
      if (!e || !f) continue;
      if (!f.name.trim()) return `${e.title}: an instance name is required`;
      for (const fld of e.env || []) {
        const v = (f.env[fld.key] ?? "").trim();
        if (fld.required && !v && !fld.default) return `${e.title}: ${fld.label} is required`;
        if (fld.kind === "select" && v && !(fld.options || []).some((o) => o.value === v)) return `${e.title}: ${fld.label} is invalid`;
      }
    }
    return "";
  }

  private doInstall = async () => {
    const bad = this.validate();
    if (bad) { this.toast.error(bad); return; }
    // The plugin(s) always deploy as their OWN stack (project); "join a stack" means
    // attach to that stack's network, not merge into it. Networks all plugins get =
    // the joined stack's nets (if any) + the extra picked ones.
    const project = this.placeMode === "new_stack"
      ? this.project.trim()
      : (this.selected.length === 1 ? this.forms[this.selected[0]].name.trim() : (this.project.trim() || "plugins"));
    const stackNets = this.placeMode === "stack_net" && this.pickStack ? this.stackNets(this.pickStack) : [];
    const networks = Array.from(new Set([...stackNets, ...this.pickNets]));
    const params: InstallParams = {
      host: this.host,
      project,
      placement: { mode: this.placeMode, networks },
      plugins: this.selected.map((id) => ({
        catalog_id: id,
        name: this.forms[id].name.trim(),
        env: this.forms[id].env,
        settings: this.forms[id].settings,
      })),
    };
    let ok = false;
    await this.proc.run("install " + project, async (emit, signal) => {
      for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "installPlugin", [JSON.stringify(params)], signal, this.host)) {
        if (f.type === "log" && f.data) emit(f.data);
        else if (f.type === "done" && !f.ok) { emit("failed: " + (f.error ?? "")); return false; }
      }
      ok = true;
      return true;
    });
    if (ok) {
      this.toast.ok("installed " + project);
      bus.emit(new PluginsChanged());
      this.close();
    }
  };

  // ── render helpers ──
  private envInput(id: string, f: CatalogEnvField) {
    const val = this.forms[id].env[f.key] ?? "";
    if (f.kind === "select") {
      return <hope-select options={f.options || []} value={val} placeholder={f.placeholder || "select…"} onSelect={(e: any) => this.setEnv(id, f.key, e.detail)}></hope-select>;
    }
    if (f.kind === "toggle") {
      return <label class="toggle"><input type="checkbox" checked={val === "true"} onChange={(e: any) => this.setEnv(id, f.key, e.target.checked ? "true" : "false")} />{f.label}</label>;
    }
    const type = f.kind === "secret" ? "password" : f.kind === "number" ? "number" : "text";
    return <input type={type} value={val} placeholder={f.placeholder || ""} onInput={(e: any) => this.setEnv(id, f.key, e.target.value)} />;
  }

  private catalogGrid() {
    const q = this.query.trim().toLowerCase();
    const items = q ? this.catalog.filter((c) => (c.id + " " + c.title + " " + (c.description || "") + " " + c.image).toLowerCase().includes(q)) : this.catalog;
    if (!items.length) return <div class="empty">{this.catalog.length ? "No plugins match your search." : "No installable plugins. Add a catalog repo in [plugins.catalog], or check the built-ins."}</div>;
    return (
      <div class="grid">
        {items.map((c) => {
          const on = this.selected.includes(c.id);
          return (
            <div class={"card" + (on ? " sel" : "")} onClick={() => this.toggleSelect(c.id)}>
              <div class="ch">
                <span class={"ck" + (on ? " on" : "")}></span>
                <loom-icon name={c.icon || "plugin"} size={16}></loom-icon>
                <span class="nm" title={c.title}>{c.title}</span>
                {c.source && c.source !== "builtin" ? <span class="src">{c.source}</span> : null}
              </div>
              <div class="desc">{c.description || "—"}</div>
              <div class="img" title={c.image}>{c.image}</div>
              <div class="cta">
                <hope-button size="sm" tone="primary" icon="download" onClick={(e: any) => { e.stopPropagation(); this.installOne(c.id); }}>Install</hope-button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  private configView() {
    const hostOpts = this.hosts.filter((h) => h.connected).map((h) => ({ value: h.id, label: h.id + (h.kind === "local" ? " (local)" : "") }));
    return (
      <>
        <div class="sec">
          <span class="lbl">target host</span>
          <div class="field">
            <hope-select options={hostOpts} value={this.host} placeholder="pick a host…" onSelect={(e: any) => this.setHost(e.detail)}></hope-select>
            <span class="hint">Where the plugin container is deployed. A remote host needs a hope agent (or a published port) so hope can reach the plugin.</span>
          </div>
        </div>
        <div class="sec">
          <span class="lbl">stack</span>
          <div class="radio">
            <label><input type="radio" checked={this.placeMode === "new_stack"} onChange={() => (this.placeMode = "new_stack")} /> New plugin stack</label>
            <label><input type="radio" checked={this.placeMode === "stack_net"} onChange={() => (this.placeMode = "stack_net")} /> Join a stack</label>
          </div>
          {this.placeMode === "stack_net" ? (
            <div class="field">
              <label>Existing stack</label>
              <hope-select options={this.stacks.map((s) => ({ value: s.project, label: s.project }))} value={this.pickStack} placeholder="pick a stack…" onSelect={(e: any) => this.setStack(e.detail)}></hope-select>
              <span class="hint">The plugin(s) join this stack's network{this.pickStack ? ` (${this.stackNets(this.pickStack).join(", ")})` : ""} so they can reach its containers.</span>
            </div>
          ) : (
            <div class="field">
              <label>Stack name</label>
              <input type="text" value={this.project} placeholder="plugins" onInput={(e: any) => (this.project = e.target.value)} />
              <span class="hint">A new stack for the plugin(s).</span>
            </div>
          )}
        </div>

        <div class="sec">
          <span class="lbl">networks</span>
          <div class="field">
            <hope-select options={this.availNets()} value="" placeholder="add a network…" onSelect={(e: any) => this.addNet(e.detail)}></hope-select>
            {this.pickNets.length ? (
              <div class="nets">
                {this.pickNets.map((n) => (
                  <span class="nchip on" onClick={() => this.toggleNet(n)} title="remove">{n}<loom-icon name="x" size={10}></loom-icon></span>
                ))}
              </div>
            ) : null}
            <span class="hint">Extra networks every plugin joins (hope's {PLUGIN_NET} is always added) — e.g. a database stack's network so the plugin can reach it.</span>
          </div>
        </div>

        {this.selected.map((id) => {
          const e = this.entry(id); const f = this.forms[id];
          if (!e || !f) return null;
          return (
            <div class="pcfg">
              <div class="h"><loom-icon name={e.icon || "plugin"} size={15}></loom-icon>{e.title}</div>
              <div class="field">
                <label>Instance name</label>
                <input type="text" value={f.name} onInput={(ev: any) => this.setName(id, ev.target.value)} />
              </div>
              {(e.env || []).map((fld) => (
                <div class="field">
                  <label>{fld.label}{fld.required ? <span class="req"> *</span> : null}</label>
                  {this.envInput(id, fld)}
                  {fld.hint ? <span class="hint">{fld.hint}</span> : null}
                </div>
              ))}
              {(e.settings || []).length ? (
                <>
                  {(e.settings || []).map((s) => (
                    <div class="field">
                      <label>{s.key} <span class="hint">(setting)</span></label>
                      <input type="text" value={f.settings[s.key] ?? s.value} onInput={(ev: any) => this.setSetting(id, s.key, ev.target.value)} />
                    </div>
                  ))}
                </>
              ) : null}
              {(e.volumes || []).length ? (
                <div class="vol">{(e.volumes || []).map((v) => <div>hope will {v.type === "bind" ? "bind" : "create a volume"} at <code>{v.target}</code>{v.hint ? ` — ${v.hint}` : ""}</div>)}</div>
              ) : null}
            </div>
          );
        })}
      </>
    );
  }

  update() {
    // Always render the tree (gated by .overlay.open) so every reactive change
    // re-renders reliably — an empty/absent render can leave loom without a stable root.
    return (
      <div class={"overlay" + (this.open ? " open" : "")}>
        <div class="scrim" onClick={this.close}></div>
        <div class="modal">
          <div class="head">
            <span class="t">Install plugin</span>
            <span class="sub">{this.host ? <><loom-icon name="server" size={11}></loom-icon>{this.host}</> : "fleet"}</span>
            <span class="grow"></span>
            <button class="x" onClick={this.close}><loom-icon name="x" size={16}></loom-icon></button>
          </div>

          {this.step === "browse" ? (
            <div class="tools">
              <hope-search placeholder="Search the catalog…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
              <span class="grow"></span>
              <hope-button size="sm" icon="rotate" spin={this.refreshing} disabled={this.busy} onClick={() => void withRefresh(() => this.refresh())}>Refresh</hope-button>
            </div>
          ) : null}

          <div class="body">
            {!this.loaded ? <div class="empty">loading catalog…</div>
              : this.error ? <div class="empty">{this.error}</div>
              : this.step === "browse" ? this.catalogGrid()
              : this.configView()}
          </div>

          <div class="foot">
            {this.step === "config" ? <hope-button size="sm" icon="chevron-left" onClick={() => (this.step = "browse")}>Back</hope-button> : null}
            <span class="grow"></span>
            {this.step === "browse" ? (
              <>
                <span class="note">{this.selected.length ? `${this.selected.length} selected` : "Select plugins, or Install one directly"}</span>
                <hope-button size="sm" tone="primary" icon="chevron-right" disabled={!this.selected.length} onClick={this.goConfig}>Configure {this.selected.length || ""}</hope-button>
              </>
            ) : (
              <hope-button size="sm" tone="primary" icon="download" onClick={this.doInstall}>Install {this.selected.length > 1 ? this.selected.length + " plugins" : ""}</hope-button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
