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
import type { CatalogEntry, CatalogEnvField, CatalogVolume, VolumeChoice, InstallParams, NetworkInfo, VolumeInfo, StackSummary, HostView, OpFrame } from "../contracts";
import { theme } from "../styles";
import "./select"; // <hope-select>

const PLUGIN_NET = "ink-plugins"; // hope's bridge; never a user-pickable target

// Per-plugin form state.
interface InstForm {
  name: string;
  env: Record<string, string>;
  settings: Record<string, string>;
  vols: Record<string, VolumeChoice>; // keyed by mount target
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
  .head .back { display: inline-grid; place-items: center; width: 30px; height: 30px; margin-left: -6px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .head .back:hover { color: var(--hi); }
  .head .hostsel { width: 220px; }
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
  .card .cta { display: flex; align-items: center; gap: 8px; }
  .card .cta .grow { flex: 1; }

  /* ── details ("more info") view ── */
  .dhead { display: flex; align-items: center; gap: 13px; margin-bottom: 22px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
  .dicon { display: grid; place-items: center; width: 46px; height: 46px; flex: none; border: 1px solid var(--line2); background: var(--ink); }
  .dicon loom-icon { color: var(--mid); }
  .dt { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .dtrow { display: flex; align-items: center; gap: 10px; }
  .dtitle { color: var(--hi); font: 700 16px/1.2 var(--mono); }
  .dimg { color: var(--dim); font: 11px/1.3 var(--mono); overflow: hidden; text-overflow: ellipsis; }
  .dbadge { color: var(--dim); font: 8.5px/1.5 var(--mono); letter-spacing: .12em; text-transform: uppercase; border: 1px solid var(--line2); padding: 2px 7px; flex: none; }
  .dbadge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line2)); background: color-mix(in srgb, var(--ok) 9%, transparent); }
  .ddesc { color: var(--mid); font: 13px/1.85 var(--mono); margin: 0; }
  .dsec { margin-bottom: 16px; }
  .dsec > .dlbl { display: block; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; margin-bottom: 9px; }
  .dfield { padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
  .dfield:last-child { border-bottom: none; }
  .dfk { color: var(--hi); font: 12.5px/1.4 var(--mono); display: flex; align-items: center; gap: 8px; }
  .dfk .req { color: var(--bad); font: 9px/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .dfk .tag { color: var(--dim); font: 9px/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; border: 1px solid var(--line2); padding: 0 4px; }
  .dfmeta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; color: var(--dim); font: 11px/1.5 var(--mono); }
  .dfmeta code { color: var(--mid); }
  .dfhint { color: var(--dim); font: 11px/1.5 var(--mono); margin-top: 4px; }
  .dvol, .dset { display: flex; align-items: center; gap: 8px; color: var(--mid); font: 12px/1.7 var(--mono); }
  .dvol loom-icon { color: var(--dim); flex: none; }
  .dvol code, .dset code { color: var(--hi); }

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
  @reactive accessor detailId = ""; // catalog id whose "more info" detail is open (optional view)
  @reactive accessor forms: Record<string, InstForm> = {};
  @reactive accessor project = "";
  @reactive accessor placeMode: "new_stack" | "stack_net" = "new_stack";
  @reactive accessor pickNets: string[] = []; // extra networks ALL plugins join (config, not placement)
  @reactive accessor pickStack = "";

  @reactive accessor networks: NetworkInfo[] = [];
  @reactive accessor stacks: StackSummary[] = [];
  @reactive accessor volumes: VolumeInfo[] = [];
  @reactive accessor hosts: HostView[] = [];

  @on(OpenInstaller)
  private onOpen(e: OpenInstaller) {
    this.host = e.host && e.host !== "all" ? e.host : "";
    this.open = true;
    this.step = "browse";
    this.detailId = "";
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
    // Opened host-scoped (from /plugins/:host) => that host is pre-selected in onOpen.
    // Opened from the fleet "all" view => host stays empty so the picker forces a
    // "choose a fleet" selection rather than silently guessing one.
    await this.reloadHostResources();
  }

  private async reloadHostResources() {
    // Capture the fleet these resources belong to: a fast fleet switch could otherwise
    // let an earlier host's networks/stacks/volumes land last and show under the wrong one.
    const host = this.host;
    const h = host || undefined;
    try {
      const n = (await this.rpc.call<NetworkInfo[]>("System", "networks", [], undefined, false, h)) || [];
      if (this.host === host) this.networks = n;
    } catch { if (this.host === host) this.networks = []; }
    try {
      const s = (await this.rpc.call<StackSummary[]>("Stacks", "list", [], undefined, false, h)) || [];
      if (this.host === host) this.stacks = s;
    } catch { if (this.host === host) this.stacks = []; }
    try {
      const v = (await this.rpc.call<VolumeInfo[]>("System", "volumes", [], undefined, false, h)) || [];
      if (this.host === host) this.volumes = v;
    } catch { if (this.host === host) this.volumes = []; }
  }

  private setHost = (id: string) => { this.host = id; this.pickNets = []; this.pickStack = ""; void this.reloadHostResources(); };

  private connectedHosts(): HostView[] { return this.hosts.filter((h) => h.connected); }
  private hostOpts(): { value: string; label: string }[] {
    return this.connectedHosts().map((h) => ({ value: h.id, label: h.id + (h.kind === "local" ? " (local)" : "") }));
  }
  // Top-of-dialog back: config → gallery, detail → gallery.
  private goBack = () => {
    if (this.step === "config") this.step = "browse";
    else if (this.detailId) this.detailId = "";
  };
  private canBack(): boolean { return this.step === "config" || !!this.detailId; }
  private headTitle(): string {
    if (this.step === "config") return this.selected.length > 1 ? "Configure plugins" : "Configure";
    if (this.detailId) return this.entry(this.detailId)?.title || "Plugin";
    return "Install plugin";
  }

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
    this.detailId = "";
    const forms: Record<string, InstForm> = {};
    for (const id of this.selected) {
      const e = this.entry(id);
      if (!e) continue;
      const env: Record<string, string> = {};
      for (const f of e.env || []) env[f.key] = f.default ?? "";
      const settings: Record<string, string> = {};
      for (const s of e.settings || []) settings[s.key] = s.value;
      const vols: Record<string, VolumeChoice> = {};
      for (const v of e.volumes || []) if (v.type !== "bind") vols[v.target] = { existing: false, name: "" };
      forms[id] = { name: this.forms[id]?.name || e.id, env, settings, vols };
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
  private setVol = (id: string, target: string, choice: VolumeChoice) => {
    this.forms = { ...this.forms, [id]: { ...this.forms[id], vols: { ...this.forms[id].vols, [target]: choice } } };
  };
  // The select's "" option = create a new volume; any other value = reuse that existing one.
  private pickVol = (id: string, target: string, val: string) => {
    this.setVol(id, target, val ? { existing: true, name: val } : { existing: false, name: "" });
  };
  private volOpts(): { value: string; label: string }[] {
    return [{ value: "", label: "Create a new volume" }, ...this.volumes.map((v) => ({ value: v.name, label: v.name }))];
  }
  // The generated default name hope will create for a fresh volume: <instance>-<target slug>
  // (mirrors the backend's sanitizeName + slugPath so the placeholder previews the real name).
  private defVolName(id: string, target: string): string {
    const svc = (this.forms[id]?.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
    const slug = target.replace(/^\/+|\/+$/g, "").replace(/\//g, "-").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "data";
    return `${svc}-${slug}`;
  }
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
    if (!this.host) return "choose a fleet to install on";
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
    // Join an existing stack => deploy UNDER that stack's project so the plugin lands
    // inside it (merged, additive on the backend). A new stack uses the typed name.
    const project = this.placeMode === "stack_net"
      ? this.pickStack
      : this.project.trim();
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
        volumes: this.forms[id].vols,
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

  // One declared volume: pick "create new" (default, gets a generated name) or reuse an
  // existing named volume on the host.
  private volField(id: string, v: CatalogVolume) {
    const choice = this.forms[id].vols[v.target] || { existing: false, name: "" };
    return (
      <div class="field">
        <label>Storage at <code>{v.target}</code>{v.read_only ? <span class="hint"> (read-only)</span> : null}</label>
        <hope-select options={this.volOpts()} value={choice.existing ? choice.name : ""} placeholder="Create a new volume" onSelect={(ev: any) => this.pickVol(id, v.target, ev.detail)}></hope-select>
        {choice.existing
          ? <span class="hint">reuses the existing volume <code>{choice.name}</code></span>
          : <input type="text" value={choice.name} placeholder={this.defVolName(id, v.target)} onInput={(ev: any) => this.setVol(id, v.target, { existing: false, name: ev.target.value })} />}
        {v.hint ? <span class="hint">{v.hint}</span> : null}
      </div>
    );
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
                {this.hasDetail(c) ? <hope-button size="sm" icon="info" onClick={(e: any) => { e.stopPropagation(); this.detailId = c.id; }}>Details</hope-button> : null}
                <span class="grow"></span>
                <hope-button size="sm" tone="primary" icon="download" onClick={(e: any) => { e.stopPropagation(); this.installOne(c.id); }}>Install</hope-button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // hasDetail reports whether an entry carries enough beyond title+image to be worth a
  // "more info" view — so the Details affordance stays optional (bare entries omit it).
  private hasDetail(c: CatalogEntry): boolean {
    return !!(c.description || (c.env || []).length || (c.volumes || []).length || (c.settings || []).length);
  }

  // detailView renders one entry's full info: description + what it needs (env, storage,
  // default settings, endpoint). Opened from a card's Details button, closed via Back.
  private detailView() {
    const c = this.entry(this.detailId);
    if (!c) { this.detailId = ""; return this.catalogGrid(); }
    const vols = (c.volumes || []).filter((v) => v.type !== "bind");
    return (
      <div class="detail">
        <div class="dhead">
          <div class="dicon"><loom-icon name={c.icon || "plugin"} size={24}></loom-icon></div>
          <div class="dt">
            <div class="dtrow">
              <span class="dtitle">{c.title}</span>
              <span class={"dbadge" + (c.source && c.source !== "builtin" ? "" : " ok")}>{c.source && c.source !== "builtin" ? c.source : "first-party"}</span>
            </div>
            <span class="dimg" title={c.image}>{c.image}</span>
          </div>
        </div>
        {c.description ? (
          <div class="dsec">
            <span class="dlbl">Overview</span>
            <p class="ddesc">{c.description}</p>
          </div>
        ) : null}

        {(c.env || []).length ? (
          <div class="dsec">
            <span class="dlbl">Configuration</span>
            {(c.env || []).map((f) => (
              <div class="dfield">
                <div class="dfk">{f.label || f.key}
                  {f.required ? <span class="req">required</span> : null}
                  {f.kind === "secret" ? <span class="tag">secret</span> : f.kind === "select" ? <span class="tag">select</span> : null}
                </div>
                <div class="dfmeta"><code>{f.key}</code>
                  {f.default ? <span>default: {f.default}</span> : null}
                  {f.kind === "select" && (f.options || []).length ? <span>one of: {(f.options || []).map((o) => o.value).join(", ")}</span> : null}
                </div>
                {f.hint ? <div class="dfhint">{f.hint}</div> : null}
              </div>
            ))}
          </div>
        ) : null}

        {vols.length ? (
          <div class="dsec">
            <span class="dlbl">Storage</span>
            {vols.map((v) => <div class="dvol"><loom-icon name="hard-drive" size={13}></loom-icon><span>a volume at <code>{v.target}</code>{v.hint ? ` — ${v.hint}` : ""}</span></div>)}
          </div>
        ) : null}

        {(c.settings || []).length ? (
          <div class="dsec">
            <span class="dlbl">Default settings</span>
            {(c.settings || []).map((s) => <div class="dset"><code>{s.key}</code> = {s.value}</div>)}
          </div>
        ) : null}

        <div class="dsec">
          <span class="dlbl">Endpoint</span>
          <div class="dset">:{c.port || 8080}{c.path || "/__hope"}</div>
        </div>
      </div>
    );
  }

  private configView() {
    // Placement is host-scoped — the stack/network lists come from the chosen fleet.
    // Force that choice first so you can't pick a stack with no fleet (or the wrong
    // one), which is also why the install button stays disabled until a host is set.
    if (!this.host) {
      return (
        <div class="sec">
          <span class="lbl">fleet</span>
          <span class="hint">Choose a fleet (top-right) to pick where the plugin installs — its stacks and networks load from that host.</span>
        </div>
      );
    }
    return (
      <>
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
              {(e.volumes || []).filter((v) => v.type !== "bind").map((v) => this.volField(id, v))}
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
            {this.canBack() ? <button class="back" title="back to catalog" onClick={this.goBack}><loom-icon name="chevron-left" size={17}></loom-icon></button> : null}
            <span class="t">{this.headTitle()}</span>
            <span class="grow"></span>
            <hope-select class="hostsel" options={this.hostOpts()} value={this.host} placeholder="choose a fleet…" onSelect={(e: any) => this.setHost(e.detail)}></hope-select>
            <button class="x" onClick={this.close}><loom-icon name="x" size={16}></loom-icon></button>
          </div>

          {this.step === "browse" && !this.detailId ? (
            <div class="tools">
              <hope-search placeholder="Search the catalog…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
              <span class="grow"></span>
              <hope-button size="sm" icon="rotate" spin={this.refreshing} disabled={this.busy} onClick={() => void withRefresh(() => this.refresh())}>Refresh</hope-button>
            </div>
          ) : null}

          <div class="body">
            {!this.loaded ? <div class="empty">loading catalog…</div>
              : this.error ? <div class="empty">{this.error}</div>
              : this.step !== "browse" ? this.configView()
              : this.detailId ? this.detailView()
              : this.catalogGrid()}
          </div>

          <div class="foot">
            <span class="note">{!this.host ? "Choose a fleet to install on" : ""}</span>
            <span class="grow"></span>
            {this.step === "config" ? (
              <hope-button size="sm" tone="primary" icon="download" disabled={!this.host} onClick={this.doInstall}>Install {this.selected.length > 1 ? this.selected.length + " plugins" : ""}</hope-button>
            ) : this.detailId ? (
              <hope-button size="sm" tone="primary" icon="download" disabled={!this.host} onClick={() => this.installOne(this.detailId)}>Install</hope-button>
            ) : (
              <>
                {this.host ? <span class="note">{this.selected.length ? `${this.selected.length} selected` : "Select plugins, or Install one directly"}</span> : null}
                <hope-button size="sm" tone="primary" icon="chevron-right" disabled={!this.selected.length || !this.host} onClick={this.goConfig}>Configure {this.selected.length || ""}</hope-button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
}
