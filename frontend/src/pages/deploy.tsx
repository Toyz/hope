// Deploy — build and ship containers and stacks through hope, no YAML required.
// Two modes: a one-off Container, and a visual Stack builder (add/remove service
// rows, declare networks + volumes, optionally expose ports via a Cloudflare
// tunnel). The same page is the stack editor: /deploy?edit=<project> seeds the
// builder from the stack's stored spec (or reconstructs it from live containers).
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ProcService } from "../proc";
import { PromptService } from "../prompt";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import type { ContainerSpec, StackSpec, NetworkSpec, VolumeSpec, OpFrame, OpResult, ImportResult, ExportResult, NetworkInfo, VolumeInfo, ConnectorView, TunnelView, ZoneView, HostView } from "../contracts";
import type { ConnectorOpt } from "../components/service-form";
import { theme } from "../styles";
import { DeployIntent } from "../deploy-intent";
import { HostContext } from "../host-context";
import { HostChanged } from "../events";
import { appBar } from "../app-bar";
import "../components/service-form";

interface Row { key: number; initial: ContainerSpec; }
interface ResDecl { name: string; driver: string; }

@route("/deploy")
@component("hope-deploy")
@styles(css`
  ${theme}
  :host { display: block; min-height: calc(100vh - 48px); background: var(--ink); }
  .bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink); }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { display: flex; align-items: center; gap: 5px; color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .back:hover { color: var(--hi); }
  .bar .grow { flex: 1; }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 24px 24px 80px; max-width: 900px; margin: 0 auto; }
  .tabs { display: flex; gap: 2px; margin-bottom: 22px; }
  .tab { padding: 9px 16px; background: transparent; border: 1px solid var(--line); color: var(--dim); cursor: pointer;
    font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .tab:hover { color: var(--hi); border-color: var(--line2); }
  .tab.on { color: var(--hi); border-color: var(--line2); background: var(--raised); }

  .panel { border: 1px solid var(--line); background: var(--panel); }
  .phead { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .phead .t { font: 600 12px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--hi); }
  .phead .grow { flex: 1; }
  .pbody { padding: 18px; }

  .f { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  label { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  input, textarea { width: 100%; box-sizing: border-box; background: var(--ink); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1.5 var(--mono); }
  input { height: 38px; line-height: 1; padding: 0 12px; }
  textarea { padding: 10px 12px; resize: vertical; min-height: 150px; }
  input::placeholder, textarea::placeholder { color: var(--dim); }
  input:focus, textarea:focus { outline: none; border-color: var(--line2); }
  hope-select { display: block; height: 38px; }

  .svc { border: 1px solid var(--line); margin-bottom: 14px; }
  .svc .sh { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .svc .sh .n { font: 600 12px/1 var(--mono); color: var(--hi); }
  .svc .sh .grow { flex: 1; }
  .svc .sb { padding: 16px 14px; }
  .xbtn { display: inline-grid; place-items: center; width: 28px; height: 28px; background: transparent;
    border: 1px solid transparent; color: var(--dim); cursor: pointer; }
  .xbtn:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); }

  .resrow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .resrow input { flex: 1; }
  .resrow .drv { flex: 0 0 150px; }

  .add { display: inline-flex; align-items: center; gap: 7px; background: transparent; border: 1px dashed var(--line2);
    color: var(--dim); cursor: pointer; font: 600 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; padding: 9px 13px; }
  .add:hover { color: var(--hi); border-color: var(--mid); }

  .foot { display: flex; align-items: center; gap: 10px; margin-top: 22px; }
  .foot .grow { flex: 1; }
  .go { font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: #06080d;
    background: var(--upd); border: 1px solid var(--upd); padding: 12px 20px; cursor: pointer; }
  .go:hover { background: color-mix(in srgb, var(--upd) 88%, #fff); }
  .ghost { font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--mid);
    background: transparent; border: 1px solid var(--line); padding: 12px 18px; cursor: pointer; }
  .ghost:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .danger { font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--bad);
    background: transparent; border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--line)); padding: 12px 18px; cursor: pointer; }
  .danger:hover { color: #fff; background: var(--bad); border-color: var(--bad); }

  .imp { border: 1px solid var(--line); margin-bottom: 18px; }
  .imp .ih { display: flex; align-items: center; gap: 8px; padding: 11px 14px; cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
  .imp .ih:hover { color: var(--hi); }
  .imp .ih loom-icon { transition: transform .12s; }
  .imp.open .ih loom-icon { transform: rotate(90deg); }
  .imp .ib { padding: 0 14px 14px; }
  .imp .filerow { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .imp .filerow .or { font: 11.5px/1 var(--mono); color: var(--dim); }
  .ghost.sm, .go.sm { display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; }
  .warns { margin: 10px 0 0; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line));
    background: color-mix(in srgb, var(--warn) 7%, transparent); }
  .warns .w { font: 11.5px/1.5 var(--mono); color: var(--warn); }
  .sub { font: 11.5px/1.5 var(--mono); color: var(--dim); margin: 0 0 16px; }
`)
export class DeployPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ProcService) accessor proc!: ProcService;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(DeployIntent) accessor intent!: DeployIntent;
  @inject(HostContext) accessor hostCtx!: HostContext;

  @reactive accessor tab: "container" | "stack" = "stack";
  @reactive accessor project = "";
  @reactive accessor rows: Row[] = [];
  @reactive accessor netDecls: ResDecl[] = [];
  @reactive accessor volDecls: ResDecl[] = [];
  @reactive accessor seed = 0;
  @reactive accessor oneoff: ContainerSpec = { image: "" };
  @reactive accessor oneoffSeed = 0;

  @reactive accessor host = "";
  @reactive accessor hostList: HostView[] = [];
  @reactive accessor connectors: ConnectorOpt[] = [];
  @reactive accessor zones: string[] = [];
  @reactive accessor existingNets: string[] = [];
  @reactive accessor existingVols: string[] = [];
  @reactive accessor importOpen = false;
  @reactive accessor importText = "";
  @reactive accessor importEnv = "";
  @reactive accessor warnings: string[] = [];
  @reactive accessor editing = "";
  private keyc = 1;

  private get router(): LoomRouter { return app.get(LoomRouter); }

  @mount
  async onMount() {
    if (!this.auth.isAuthenticated) { this.router.navigate("/login"); return; }
    const editProject = this.intent.take() || new URLSearchParams(location.search).get("edit");
    // Render the builder immediately with one empty row (new deploy) so it doesn't
    // pop in after the async host/resource loads resolve.
    if (!editProject && this.rows.length === 0) this.rows = [{ key: this.keyc++, initial: { image: "" } }];
    await Promise.all([this.loadHost(), this.loadConnectors(), this.loadResources()]);
    if (editProject) await this.loadEdit(editProject);
  }

  private async loadHost() {
    try {
      this.hostList = (await this.rpc.call<HostView[]>("System", "hosts", [])) || [];
      this.host = this.hostList.find((h) => h.active)?.id || "";
    } catch { this.host = ""; }
  }

  private inFleet(): boolean {
    return this.hostCtx.fleet;
  }

  // Active host switched elsewhere — refresh the host-scoped pickers in place.
  @on(HostChanged)
  onHostChanged() {
    if (!this.auth.isAuthenticated) return;
    this.loadHost();
    this.loadConnectors();
    this.loadResources();
  }

  // In "all hosts" fleet mode there is no single active host, so a deploy must
  // choose one. Prompt for it, switch the server's active host to it (deploy
  // routes through the active host), and refresh the host-scoped pickers. Returns
  // false if cancelled. Outside fleet mode the current active host is used as-is.
  private async ensureTargetHost(): Promise<boolean> {
    if (!this.inFleet()) return true;
    const picked = await this.prompt.ask({
      title: "deploy target",
      icon: "box",
      submitLabel: "Continue",
      message: "You're viewing all hosts. Pick the host to deploy to.",
      fields: [{ key: "host", label: "host", type: "select", value: this.host || (this.hostList[0]?.id ?? ""), options: this.hostList.map((h) => ({ value: h.id, label: h.id + (h.kind === "local" ? "" : " · agent") })) }],
    });
    if (!picked) return false;
    const id = picked.host;
    try {
      await this.rpc.call("System", "setActiveHost", [id]);
      this.host = id;
      await Promise.all([this.loadConnectors(), this.loadResources()]);
      return true;
    } catch (e: any) {
      this.toast.error("could not switch host: " + (e?.message || "error"));
      return false;
    }
  }


  private async loadConnectors() {
    try {
      const [cons, zones] = await Promise.all([
        this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
        this.rpc.call<ZoneView[]>("Tunnels", "zones", []).catch(() => []),
      ]);
      this.connectors = (cons || []).map((c) => ({ value: c.id, label: c.title || c.name }));
      this.zones = (zones || []).map((z) => z.name);
    } catch { this.connectors = []; this.zones = []; } // tunnels disabled -> section stays hidden
  }

  private async loadResources() {
    try {
      const [nets, vols] = await Promise.all([
        this.rpc.call<NetworkInfo[]>("System", "networks", []),
        this.rpc.call<VolumeInfo[]>("System", "volumes", []),
      ]);
      this.existingNets = (nets || []).map((n) => n.name).filter((n) => n !== "host" && n !== "none");
      this.existingVols = (vols || []).map((v) => v.name);
    } catch { /* leave empty */ }
  }

  private async loadEdit(project: string) {
    try {
      const spec = await this.rpc.call<StackSpec>("Deploy", "editSpec", [project]);
      await this.hydrateTunnels(spec);
      this.seedFromSpec(spec);
      this.editing = project;
      this.tab = "stack";
    } catch (e: any) {
      this.toast.error("could not load stack: " + (e?.message || "error"));
      this.rows = [{ key: this.keyc++, initial: { image: "" } }];
    }
  }

  // Live tunnel routes aren't stored on the container (they live in Cloudflare),
  // so an adopted/edited spec has none. Pull the project's routes and attach them
  // to the matching services so the builder shows what's actually exposed.
  private async hydrateTunnels(spec: StackSpec) {
    try {
      const [routes, cons] = await Promise.all([
        this.rpc.call<TunnelView[]>("Tunnels", "tunnels", []),
        this.rpc.call<ConnectorView[]>("Tunnels", "connectors", []),
      ]);
      const idByName = new Map((cons || []).map((c) => [c.name, c.id]));
      for (const svc of spec.services || []) {
        const svcRoutes = (routes || []).filter((r) => r.project === spec.name && r.svc_name === svc.name);
        if (svcRoutes.length) {
          svc.tunnels = svcRoutes.map((r) => ({ connector: idByName.get(r.connector) || "", hostname: r.hostname, port: r.port, path: r.path || "" }));
        }
      }
    } catch { /* tunnels disabled — nothing to hydrate */ }
  }

  private seedFromSpec(spec: StackSpec) {
    this.project = spec.name || "";
    this.rows = (spec.services || []).map((s) => ({ key: this.keyc++, initial: s }));
    if (this.rows.length === 0) this.rows = [{ key: this.keyc++, initial: { image: "" } }];
    this.netDecls = (spec.networks || []).filter((n) => !n.external).map((n) => ({ name: n.name, driver: n.driver || "" }));
    this.volDecls = (spec.volumes || []).filter((v) => !v.external).map((v) => ({ name: v.name, driver: v.driver || "" }));
    this.seed++;
  }

  // Read every service-form's current spec back (before a structural change or on submit).
  private collectServices(): ContainerSpec[] {
    const forms = this.shadowRoot?.querySelectorAll("hope-service-form");
    return Array.from(forms || []).map((el: any) => el.getSpec() as ContainerSpec);
  }

  private syncRows() {
    const specs = this.collectServices();
    this.rows = this.rows.map((r, i) => (specs[i] ? { ...r, initial: specs[i] } : r));
  }

  private addService = () => {
    this.syncRows();
    this.rows = [...this.rows, { key: this.keyc++, initial: { image: "" } }];
    this.seed++;
  };
  private removeService = (key: number) => {
    this.syncRows();
    this.rows = this.rows.filter((r) => r.key !== key);
    this.seed++;
  };

  private availNets(): string[] {
    const s = new Set<string>(this.existingNets);
    for (const n of this.netDecls) if (n.name.trim()) s.add(n.name.trim());
    return [...s].sort();
  }
  private availVols(): string[] {
    const s = new Set<string>(this.existingVols);
    for (const v of this.volDecls) if (v.name.trim()) s.add(v.name.trim());
    return [...s].sort();
  }

  // ── stack spec assembly ──
  private buildStackSpec(): StackSpec {
    const services = this.collectServices();
    const networks: NetworkSpec[] = this.netDecls.filter((n) => n.name.trim()).map((n) => ({ name: n.name.trim(), driver: n.driver || undefined }));
    const volumes: VolumeSpec[] = this.volDecls.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), driver: v.driver || undefined }));
    return { name: this.project.trim(), services, networks, volumes };
  }

  private validStack(spec: StackSpec): string | null {
    if (!spec.name) return "stack name is required";
    if (spec.services.length === 0) return "add at least one service";
    const seen = new Set<string>();
    for (const s of spec.services) {
      if (!s.image) return "every service needs an image";
      if (!s.name) return "every service needs a name";
      if (seen.has(s.name)) return "duplicate service name: " + s.name;
      seen.add(s.name);
    }
    return null;
  }

  private deployStack = async () => {
    const spec = this.buildStackSpec();
    const bad = this.validStack(spec);
    if (bad) { this.toast.error(bad); return; }
    if (!(await this.ensureTargetHost())) return;
    let success = false;
    await this.proc.run((this.editing ? "apply " : "deploy ") + spec.name, async (emit, signal) => {
      let ok = true;
      for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "applyStack", [JSON.stringify(spec)], signal)) {
        if (f.type === "log" && f.data) emit(f.data);
        else if (f.type === "done" && !f.ok) { ok = false; emit("failed: " + (f.error ?? "")); }
      }
      if (!ok) return false;
      await this.applyRoutes(spec, emit);
      success = true;
      return true;
    });
    // Only leave for the stack page once the deploy actually succeeded — a failed
    // pull (rate limit, bad image) leaves you on the builder with the log.
    if (success) this.router.navigate("/stack/" + encodeURIComponent(spec.name));
  };

  // After the containers are up, wire any declared tunnel routes through the
  // existing Tunnels RPC (skipped when a service declares none).
  private async applyRoutes(spec: StackSpec, emit: (l: string) => void) {
    for (const svc of spec.services) {
      for (const t of svc.tunnels || []) {
        emit("route " + t.hostname + " -> " + (svc.name || ""));
        try {
          const res = await this.rpc.call<OpResult>("Tunnels", "addTunnel", [t.hostname, t.port, t.connector, spec.name, svc.name || "", "", t.path || ""]);
          if (res && res.ok === false) emit("route failed: " + (res.error || "error"));
          else emit("route live -> https://" + t.hostname);
        } catch (e: any) {
          emit("route failed: " + (e?.message || "error"));
        }
      }
    }
  }

  // Delete a stack: tear down its tunnel routes first (removeTunnel drops the
  // ingress rule and deletes the DNS record only when no other route uses that
  // hostname), then destroy the containers and prune the managed net/vol.
  private deleteStack = async () => {
    const project = this.editing || this.project.trim();
    if (!project) return;
    const routes: { hostname: string; path: string }[] = [];
    for (const svc of this.collectServices()) {
      for (const t of svc.tunnels || []) routes.push({ hostname: t.hostname, path: t.path || "" });
    }
    const ok = await this.confirm.ask({
      title: "delete stack",
      danger: true,
      confirmLabel: "Delete stack",
      message: `Delete "${project}" — remove every container${routes.length ? `, tear down ${routes.length} tunnel route(s),` : ""} and prune the networks/volumes hope created for it? This cannot be undone.`,
    });
    if (!ok) return;
    let success = false;
    await this.proc.run("delete " + project, async (emit, signal) => {
      for (const r of routes) {
        emit("remove route " + r.hostname + (r.path || ""));
        try {
          await this.rpc.call<OpResult>("Tunnels", "removeTunnel", [r.hostname, r.path]);
        } catch (e: any) {
          emit("route teardown failed: " + (e?.message || "error"));
        }
      }
      let dok = true;
      for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "destroyStack", [project, "true"], signal)) {
        if (f.type === "log" && f.data) emit(f.data);
        else if (f.type === "done" && !f.ok) { dok = false; emit("failed: " + (f.error ?? "")); }
      }
      success = dok;
      return dok;
    });
    if (success) { this.toast.ok("deleted " + project); this.router.navigate("/"); }
  };

  private deployContainer = async () => {
    const form = this.shadowRoot?.querySelector("hope-service-form") as any;
    const spec: ContainerSpec = form ? form.getSpec() : { image: "" };
    if (!spec.image) { this.toast.error("image is required"); return; }
    if (!spec.name) { this.toast.error("container name is required"); return; }
    if (!(await this.ensureTargetHost())) return;
    let success = false;
    await this.proc.run("deploy " + spec.name, async (emit, signal) => {
      let ok = true;
      for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "deployContainer", [JSON.stringify(spec)], signal)) {
        if (f.type === "log" && f.data) emit(f.data);
        else if (f.type === "done" && !f.ok) { ok = false; emit("failed: " + (f.error ?? "")); }
      }
      success = ok;
      return ok;
    });
    if (success) this.toast.ok("deployed " + spec.name);
  };

  // Upload path: read the chosen compose file into the box and parse it straight
  // away, so a file drop fills the builder in one step.
  private onFile = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      this.importText = await file.text();
      e.target.value = "";
      if (!this.project.trim()) this.project = file.name.replace(/\.(ya?ml)$/i, "");
      await this.doImport();
    } catch (err: any) {
      this.toast.error("could not read file: " + (err?.message || "error"));
    }
  };

  private doImport = async () => {
    if (!this.importText.trim()) { this.toast.error("choose or paste a compose file first"); return; }
    try {
      const res = await this.rpc.call<ImportResult>("Deploy", "importCompose", [this.project || "stack", this.importText, this.importEnv]);
      this.seedFromSpec(res.spec);
      this.warnings = (res.warnings || []).map((w) => (w.service ? w.service + ": " : "") + w.message);
      this.importOpen = false;
      this.toast.ok("imported " + (res.spec.services?.length || 0) + " service(s)");
    } catch (e: any) {
      this.toast.error("import failed: " + (e?.message || "error"));
    }
  };

  // Export renders the deployed stack (stored spec, or reconstructed from live)
  // to compose YAML. Only offered while editing an existing stack.
  private doExport = async () => {
    const project = this.editing || this.project.trim();
    if (!project) { this.toast.error("stack name is required to export"); return; }
    try {
      const res = await this.rpc.call<ExportResult>("Deploy", "exportCompose", [project]);
      await navigator.clipboard.writeText(res.content);
      this.toast.ok("compose copied to clipboard");
    } catch (e: any) {
      this.toast.error("export failed: " + (e?.message || "error"));
    }
  };

  update() {
    return (
      <div>
        {appBar("deploy")}
        <main>
          {this.editing ? null : (
            <div class="tabs">
              <button class={"tab" + (this.tab === "stack" ? " on" : "")} onClick={() => (this.tab = "stack")}>Stack</button>
              <button class={"tab" + (this.tab === "container" ? " on" : "")} onClick={() => (this.tab = "container")}>Container</button>
            </div>
          )}
          {this.tab === "stack" ? this.renderStack() : this.renderContainer()}
        </main>
      </div>
    );
  }

  private renderContainer() {
    return (
      <div class="panel">
        <div class="phead"><span class="t">One-off container</span></div>
        <div class="pbody">
          <p class="sub">Create a single container on the active host. For a grouped, editable app, use the Stack tab.</p>
          <hope-service-form initial={this.oneoff} seed={this.oneoffSeed} networks={this.existingNets} volumes={this.existingVols} showName={true} connectors={[]}></hope-service-form>
          <div class="foot">
            <span class="grow"></span>
            <button class="go" onClick={this.deployContainer}>Deploy container</button>
          </div>
        </div>
      </div>
    );
  }

  private renderStack() {
    const availNets = this.availNets();
    const availVols = this.availVols();
    return (
      <div>
        <div class="f">
          <label>stack name</label>
          <input type="text" placeholder="my-app" value={this.project} disabled={!!this.editing} onInput={(e: any) => (this.project = e.target.value)} />
        </div>

        {this.editing ? null : (
          <div class={"imp" + (this.importOpen ? " open" : "")}>
            <div class="ih" onClick={() => (this.importOpen = !this.importOpen)}>
              <loom-icon name="chevron-right" size={13}></loom-icon> import a compose file
            </div>
            {this.importOpen ? (
              <div class="ib">
                <div class="filerow">
                  <input id="composefile" type="file" accept=".yml,.yaml,text/yaml,text/plain" style="display:none" onChange={this.onFile} />
                  <button class="ghost sm" onClick={() => (this.shadowRoot?.querySelector("#composefile") as HTMLInputElement)?.click()}><loom-icon name="download" size={13}></loom-icon> Choose a compose file</button>
                  <span class="or">or paste it below</span>
                </div>
                <div class="f"><label>compose.yml</label><textarea placeholder={"services:\n  web:\n    image: nginx\n    ports:\n      - \"8080:80\""} value={this.importText} onInput={(e: any) => (this.importText = e.target.value)}></textarea></div>
                <div class="f"><label>.env (optional, for ${"{VAR}"})</label><textarea style="min-height:90px" placeholder="TAG=1.25" value={this.importEnv} onInput={(e: any) => (this.importEnv = e.target.value)}></textarea></div>
                <button class="go sm" onClick={this.doImport}><loom-icon name="box" size={13}></loom-icon> Parse into builder</button>
              </div>
            ) : null}
          </div>
        )}

        {this.warnings.length ? (
          <div class="warns">{this.warnings.map((w) => <div class="w">{w}</div>)}</div>
        ) : null}

        {this.rows.map((r) => (
          <div class="svc">
            <div class="sh">
              <span class="n">{r.initial.name || "service"}</span>
              <span class="grow"></span>
              {this.rows.length > 1 ? <button class="xbtn" title="remove service" onClick={() => this.removeService(r.key)}><loom-icon name="x" size={14}></loom-icon></button> : null}
            </div>
            <div class="sb">
              <hope-service-form initial={r.initial} seed={this.seed} networks={availNets} volumes={availVols} connectors={this.connectors} zones={this.zones} showName={true}></hope-service-form>
            </div>
          </div>
        ))}
        <button class="add" onClick={this.addService}><loom-icon name="plus" size={12}></loom-icon> add service</button>

        <div class="panel" style="margin-top:22px">
          <div class="phead"><span class="t">stack networks</span></div>
          <div class="pbody">
            {this.netDecls.map((n, i) => (
              <div class="resrow">
                <input type="text" placeholder="network name" value={n.name} onInput={(e: any) => (this.netDecls = patch(this.netDecls, i, { name: e.target.value }))} />
                <div class="drv"><hope-select options={[{ value: "", label: "bridge" }, { value: "overlay", label: "overlay" }, { value: "macvlan", label: "macvlan" }]} value={n.driver} onSelect={(e: any) => (this.netDecls = patch(this.netDecls, i, { driver: e.detail }))}></hope-select></div>
                <button class="xbtn" onClick={() => (this.netDecls = this.netDecls.filter((_, j) => j !== i))}><loom-icon name="x" size={14}></loom-icon></button>
              </div>
            ))}
            <button class="add" onClick={() => (this.netDecls = [...this.netDecls, { name: "", driver: "" }])}><loom-icon name="plus" size={12}></loom-icon> network</button>
          </div>
        </div>

        <div class="panel" style="margin-top:14px">
          <div class="phead"><span class="t">stack volumes</span></div>
          <div class="pbody">
            {this.volDecls.map((v, i) => (
              <div class="resrow">
                <input type="text" placeholder="volume name" value={v.name} onInput={(e: any) => (this.volDecls = patch(this.volDecls, i, { name: e.target.value }))} />
                <div class="drv"><hope-select options={[{ value: "", label: "local" }]} value={v.driver} placeholder="local" onSelect={(e: any) => (this.volDecls = patch(this.volDecls, i, { driver: e.detail }))}></hope-select></div>
                <button class="xbtn" onClick={() => (this.volDecls = this.volDecls.filter((_, j) => j !== i))}><loom-icon name="x" size={14}></loom-icon></button>
              </div>
            ))}
            <button class="add" onClick={() => (this.volDecls = [...this.volDecls, { name: "", driver: "" }])}><loom-icon name="plus" size={12}></loom-icon> volume</button>
          </div>
        </div>

        <div class="foot">
          {this.editing ? <button class="ghost" onClick={this.doExport}>Copy as compose</button> : null}
          {this.editing ? <button class="danger" onClick={this.deleteStack}>Delete stack</button> : null}
          <span class="grow"></span>
          <button class="ghost" onClick={() => this.router.navigate("/dashboard")}>Cancel</button>
          <button class="go" onClick={this.deployStack}>{this.editing ? "Apply changes" : "Deploy stack"}</button>
        </div>
      </div>
    );
  }
}

function patch<T>(arr: T[], i: number, p: Partial<T>): T[] {
  const next = arr.slice();
  next[i] = { ...next[i], ...p };
  return next;
}
