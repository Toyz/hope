// Deploy — build and ship containers and stacks through hope, no YAML required.
// Two modes: a one-off Container, and a visual Stack builder (add/remove service
// rows, declare networks + volumes, optionally expose ports via a Cloudflare
// tunnel). The same page is the stack editor: /deploy?edit=<project> seeds the
// builder from the stack's stored spec (or reconstructs it from live containers).
import { LoomElement, component, styles, css, reactive, mount, unmount, on, query, queryAll, app } from "@toyz/loom";
import { clipboard } from "@toyz/loom/element";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { consumeOpStream } from "../stream-op";
import { AuthStore } from "../auth-store";
import { ProcService } from "../proc";
import { PromptService } from "../prompt";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import type { ContainerSpec, StackSpec, NetworkSpec, VolumeSpec, OpFrame, OpResult, ImportResult, ExportResult, NetworkInfo, VolumeInfo, ConnectorView, TunnelView, ZoneView, HostView } from "../contracts";
import type { ConnectorOpt } from "../components/service-form";
import { DeployIntent } from "../deploy-intent";
import { HostContext } from "../host-context";
import { withHost } from "../host-url";
import { patchAt as patch } from "../util";
import { HostChanged } from "../events";
import { theme } from "../styles";
import "../components/service-form";

interface Row { key: number; initial: ContainerSpec; }
interface ResDecl { name: string; driver: string; }

// A contextless Dockerfile build (no files uploaded) can't resolve COPY/ADD from a
// local path — flag those so the user isn't surprised by a build that fails on the
// daemon. COPY --from=<stage> (multi-stage) and ADD <url> need no context, so skip them.
function dockerfileWarnings(df: string): string[] {
  const bad = df.split("\n").some((raw) => {
    const line = raw.trim();
    const m = /^(COPY|ADD)\s+(.+)$/i.exec(line);
    if (!m) return false;
    if (/--from=/i.test(m[2])) return false; // multi-stage: source is another build stage
    if (/^ADD\s+https?:\/\//i.test(line)) return false; // ADD from a URL
    return true;
  });
  return bad
    ? ["COPY/ADD from a local path won't work — no build context is uploaded. Use a stack with a build context, or a git-based image."]
    : [];
}

@route("/deploy/:host")
@component("hope-deploy")
@styles(theme, css`
  :host { display: block; min-height: 100%; background: var(--ink); }
  .wrap { padding: 16px 28px 130px; }

  /* deploy-target dropdown, lives in the phead actions slot */
  .htarget { display: flex; align-items: center; gap: 8px; }
  .htarget .lbl { font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .htarget hope-select { display: block; height: 30px; min-width: 150px; }

  /* two-pane: form + sticky summary rail */
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 34px; align-items: start; }
  @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } .side { display: none; } }
  .side { position: sticky; top: 20px; display: flex; flex-direction: column; gap: 14px; }

  /* summary card */
  .sum { border: 1px solid var(--line); background: var(--panel); }
  .sum .sh { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line);
    font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .sum .sh loom-icon { color: var(--upd); }
  .sum .sb { padding: 6px 0; }
  .srow { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 12px; padding: 6px 14px; font: 12px/1.5 var(--mono); }
  .srow .k { color: var(--dim); }
  .srow .v { color: var(--hi); min-width: 0; word-break: break-word; }
  .srow .v.empty { color: var(--faint); }
  .ssvc { padding: 9px 14px; border-top: 1px solid var(--line); }
  .ssvc .n { display: flex; align-items: center; gap: 7px; font: 600 12px/1.4 var(--mono); color: var(--hi); }
  .ssvc .n loom-icon { color: var(--dim); flex: none; }
  .ssvc .img { margin: 3px 0 0 20px; font: 11px/1.5 var(--mono); color: var(--upd); word-break: break-all; }
  .ssvc .tags { margin: 5px 0 0 20px; display: flex; flex-wrap: wrap; gap: 5px; }
  .stag { padding: 1px 7px; border: 1px solid var(--line2); font: 9.5px/1.6 var(--mono); letter-spacing: .04em;
    text-transform: uppercase; color: var(--dim); }
  .sempty { padding: 16px 14px; font: 11.5px/1.6 var(--mono); color: var(--faint); text-align: center; }
  /* readiness pill */
  .ready { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font: 11.5px/1.4 var(--mono); }
  .ready::before { content: ""; width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .ready.ok { color: var(--ok); } .ready.ok::before { background: var(--ok); }
  .ready.no { color: var(--warn); } .ready.no::before { background: var(--warn); }

  /* sticky action footer, spans the form column */
  .footbar { position: sticky; bottom: 0; z-index: 15; display: flex; align-items: center; gap: 10px;
    margin-top: 26px; padding: 14px 0; border-top: 1px solid var(--line2);
    background: linear-gradient(to top, var(--ink) 72%, transparent); }
  .footbar .hint { font: 11.5px/1.4 var(--mono); color: var(--warn); }
  .footbar .grow { flex: 1; }
  .tabs { display: flex; gap: 2px; margin-bottom: 22px; }
  .tab { padding: 9px 16px; background: transparent; border: 1px solid var(--line); color: var(--dim); cursor: pointer;
    font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .tab:hover { color: var(--hi); border-color: var(--line2); }
  .tab.on { color: var(--hi); border-color: var(--line2); background: var(--raised); }

  /* section cards use <hope-panel>; body content below is slotted (light DOM) */

  .f { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  label { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  input, textarea { width: 100%; box-sizing: border-box; background: var(--ink); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1.5 var(--mono); }
  input { height: 38px; line-height: 1; padding: 0 12px; }
  textarea { padding: 10px 12px; resize: vertical; min-height: 150px; }
  input::placeholder, textarea::placeholder { color: var(--dim); }
  input:focus, textarea:focus { outline: none; border-color: var(--line2); }
  hope-select { display: block; height: 38px; }

  /* each service is a collapsible <hope-panel>; the form is its slotted body */
  .resrow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .resrow input { flex: 1; }
  .resrow .drv { flex: 0 0 150px; }

  .foot { display: flex; align-items: center; gap: 10px; margin-top: 22px; }
  .foot .grow { flex: 1; }

  .filerow { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .filerow .or { font: 11.5px/1 var(--mono); color: var(--dim); }
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
  @reactive accessor dfMode = false; // container tab: build from a Dockerfile instead of an image
  @reactive accessor dockerfile = "";

  @reactive accessor host = "";
  @reactive accessor hostList: HostView[] = [];
  @reactive accessor connectors: ConnectorOpt[] = [];
  @reactive accessor zones: string[] = [];
  @reactive accessor existingNets: string[] = [];
  @reactive accessor existingVols: string[] = [];
  @reactive accessor importText = "";
  @reactive accessor importEnv = "";
  @reactive accessor warnings: string[] = [];
  @reactive accessor editing = "";
  private keyc = 1;

  // Live element refs (loom @query resolves against the shadow root).
  @queryAll("hope-service-form") accessor serviceForms!: any;
  @query("#composefile") accessor composeFileInput!: HTMLInputElement | null;

  private get router(): LoomRouter { return app.get(LoomRouter); }

  @mount
  async onMount() {
    if (!this.auth.isAuthenticated) { this.router.navigate("/login"); return; }
    const editProject = this.intent.take() || new URLSearchParams(location.search).get("edit");
    // Render the builder immediately with one empty row (new deploy) so it doesn't
    // pop in after the async host/resource loads resolve.
    if (!editProject && this.rows.length === 0) this.rows = [{ key: this.keyc++, initial: { image: "" } }];
    // Resolve the target host FIRST (sets the transport's target in the fleet view)
    // so the host-scoped loads below all hit the right host.
    await this.loadHost();
    await Promise.all([this.loadConnectors(), this.loadResources()]);
    if (editProject) await this.loadEdit(editProject);
  }

  @unmount
  onUnmount() {
    this.hostCtx.clearTarget(); // don't leak the deploy target to the next page
  }

  private async loadHost() {
    try {
      this.hostList = (await this.rpc.call<HostView[]>("System", "hosts", [])) || [];
    } catch { this.hostList = []; }
    if (!this.inFleet()) {
      this.host = this.hostCtx.token; // pinned by /deploy/:host — transport uses it
      return;
    }
    // Fleet view: no host in the URL, so deploy picks a target and sets it as the
    // transport's ambient target (no per-call threading). Keep the current choice
    // if still connected, else default to the first connected host.
    const ids = this.hostList.filter((h) => h.connected).map((h) => h.id);
    if (!this.host || !ids.includes(this.host)) this.host = ids[0] || this.hostCtx.defaultHost();
    this.hostCtx.setTarget(this.host);
  }

  private inFleet(): boolean {
    return this.hostCtx.fleet;
  }

  // Fleet host selector changed — retarget the transport and refresh the pickers.
  private pickTarget = async (id: string) => {
    if (!id || id === this.host) return;
    this.host = id;
    this.hostCtx.setTarget(id);
    await Promise.all([this.loadConnectors(), this.loadResources()]);
  };

  // Active host switched elsewhere — refresh the host-scoped pickers in place.
  @on(HostChanged)
  onHostChanged() {
    if (!this.auth.isAuthenticated) return;
    this.loadHost();
    this.loadConnectors();
    this.loadResources();
  }

  // A deploy needs one target. Off the fleet view the URL pins it; on the fleet
  // view loadHost + the selector set it (this.host) and point the transport there.
  // Guard against an empty target (no connected hosts) so we never deploy nowhere.
  private ensureTargetHost(): boolean {
    if (this.host) return true;
    this.toast.error("no target host — connect a host first");
    return false;
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
    return (this.serviceForms || []).map((el: any) => el.getSpec() as ContainerSpec);
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
    if (!this.ensureTargetHost()) return;
    let success = false;
    await this.proc.run((this.editing ? "apply " : "deploy ") + spec.name, async (emit, signal) => {
      if (!(await consumeOpStream(this.rpc.streamWithSignal<OpFrame>("Stream", "applyStack", [JSON.stringify(spec)], signal), emit))) return false;
      await this.applyRoutes(spec, emit);
      success = true;
      return true;
    });
    // Only leave for the stack page once the deploy actually succeeded — a failed
    // pull (rate limit, bad image) leaves you on the builder with the log.
    if (success) this.router.navigate(withHost(this.host || this.hostCtx.token, "/stack/" + encodeURIComponent(spec.name)));
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
      const dok = await consumeOpStream(this.rpc.streamWithSignal<OpFrame>("Stream", "destroyStack", [project, "true"], signal), emit);
      success = dok;
      return dok;
    });
    if (success) { this.toast.ok("deleted " + project); this.router.navigate(withHost(this.host || this.hostCtx.token, "/")); }
  };

  private deployContainer = async () => {
    const form = this.serviceForms?.[0] as any;
    const spec: ContainerSpec = form ? form.getSpec() : { image: "" };
    if (this.dfMode) {
      if (!this.dockerfile.trim()) { this.toast.error("paste a Dockerfile"); return; }
      if (dockerfileWarnings(this.dockerfile).length) { this.toast.error("remove COPY/ADD from local paths — no build context is uploaded"); return; }
      spec.dockerfile = this.dockerfile; // backend builds this into a local image, then runs it
    } else if (!spec.image) {
      this.toast.error("image is required"); return;
    }
    if (!spec.name) { this.toast.error("container name is required"); return; }
    if (!this.ensureTargetHost()) return;
    let success = false;
    await this.proc.run("deploy " + spec.name, async (emit, signal) => {
      const ok = await consumeOpStream(this.rpc.streamWithSignal<OpFrame>("Stream", "deployContainer", [JSON.stringify(spec)], signal), emit);
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
      this.toast.ok("imported " + (res.spec.services?.length || 0) + " service(s)");
    } catch (e: any) {
      this.toast.error("import failed: " + (e?.message || "error"));
    }
  };

  // Export renders the deployed stack (stored spec, or reconstructed from live)
  // to compose YAML. Only offered while editing an existing stack.
  @clipboard("write") private copyCompose(content: string) { return content; }

  private doExport = async () => {
    const project = this.editing || this.project.trim();
    if (!project) { this.toast.error("stack name is required to export"); return; }
    try {
      const res = await this.rpc.call<ExportResult>("Deploy", "exportCompose", [project]);
      this.copyCompose(res.content);
      this.toast.ok("compose copied to clipboard");
    } catch (e: any) {
      this.toast.error("export failed: " + (e?.message || "error"));
    }
  };

  update() {
    const stack = this.tab === "stack";
    const connected = this.hostList.filter((h) => h.connected);
    const hostOpts = connected.map((h) => ({ value: h.id, label: h.kind === "local" ? "local" : h.id + " · agent" }));
    const target = this.host || this.hostCtx.token || "local";
    return (
      <div>
        <hope-phead
          heading={this.editing ? "Edit stack" : "Deploy"}
          scope={target}
          meta={this.editing ? this.editing : stack ? "compose services into a managed stack" : "run a one-off container"}
        >
          {connected.length > 1 ? (
            <div slot="actions" class="htarget">
              <span class="lbl">deploy to</span>
              <hope-select options={hostOpts} value={this.host || target} onSelect={(e: any) => this.pickTarget(e.detail)}></hope-select>
            </div>
          ) : null}
        </hope-phead>
        <div class="wrap">
          {this.editing ? null : (
            <div class="tabs">
              <button class={"tab" + (stack ? " on" : "")} onClick={() => (this.tab = "stack")}>Stack</button>
              <button class={"tab" + (!stack ? " on" : "")} onClick={() => (this.tab = "container")}>Container</button>
            </div>
          )}
          <div class="grid">
            <div class="formcol" {...{ onFocusout: () => this.syncPreview() }}>
              {stack ? this.renderStack() : this.renderContainer()}
              {this.renderFoot(stack)}
            </div>
            <aside class="side">{this.renderSummary(stack)}</aside>
          </div>
        </div>
      </div>
    );
  }

  // The stack's at-a-glance model, derived from synced state (rows[].initial is
  // refreshed on focusout via syncPreview, so it tracks edits without racing keystrokes).
  private stackSummary() {
    const svcs = this.rows.map((r) => r.initial || { image: "" });
    const nets = this.netDecls.map((n) => n.name.trim()).filter(Boolean);
    const vols = this.volDecls.map((v) => v.name.trim()).filter(Boolean);
    let reason = "";
    if (!this.project.trim()) reason = "name the stack";
    else if (!svcs.some((s) => s.image)) reason = "add a service image";
    else if (svcs.some((s) => s.image && !s.name)) reason = "every service needs a name";
    return { svcs, nets, vols, ready: !reason, reason };
  }

  // Re-read the service forms into rows[].initial so the summary reflects the latest
  // typed values. Fires on focusout (a field lost focus) — never mid-keystroke, so it
  // can't steal focus or reset a cursor.
  private syncPreview() { this.syncRows(); }

  private renderSummary(stack: boolean) {
    if (!stack) {
      return (
        <div class="sum">
          <div class="sh"><loom-icon name="box" size={12}></loom-icon>container</div>
          <div class="sb">
            <div class="srow"><span class="k">target</span><span class="v">{this.host || this.hostCtx.token || "local"}</span></div>
            <div class="srow"><span class="k">source</span>{this.dfMode ? <span class={"v" + (this.dockerfile.trim() ? "" : " empty")}>{this.dockerfile.trim() ? "Dockerfile build" : "empty Dockerfile"}</span> : <span class={"v" + (this.oneoff.image ? "" : " empty")}>{this.oneoff.image || "not set"}</span>}</div>
          </div>
        </div>
      );
    }
    const m = this.stackSummary();
    const named = m.svcs.filter((s) => s.image);
    return (
      <>
        <div class="sum">
          <div class="sh"><loom-icon name="box" size={12}></loom-icon>stack</div>
          <div class="sb">
            <div class="srow"><span class="k">target</span><span class="v">{this.host || this.hostCtx.token || "local"}</span></div>
            <div class="srow"><span class="k">name</span><span class={"v" + (this.project.trim() ? "" : " empty")}>{this.project.trim() || "unnamed"}</span></div>
            <div class="srow"><span class="k">services</span><span class="v">{named.length || "—"}</span></div>
          </div>
          {named.length === 0 ? (
            <div class="sempty">no services yet — add an image to begin</div>
          ) : (
            named.map((s) => {
              const ports = (s.ports || []).length;
              const env = Object.keys(s.env || {}).length;
              const mounts = (s.mounts || []).length;
              const netc = (s.networks || []).length;
              return (
                <div class="ssvc">
                  <div class="n"><loom-icon name="box" size={12}></loom-icon>{s.name || "service"}</div>
                  <div class="img">{s.image}</div>
                  {ports || env || mounts || netc ? (
                    <div class="tags">
                      {ports ? <span class="stag">{ports} port{ports > 1 ? "s" : ""}</span> : null}
                      {env ? <span class="stag">{env} env</span> : null}
                      {mounts ? <span class="stag">{mounts} vol{mounts > 1 ? "s" : ""}</span> : null}
                      {netc ? <span class="stag">{netc} net{netc > 1 ? "s" : ""}</span> : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          {m.nets.length || m.vols.length ? (
            <>
              {m.nets.length ? <div class="srow" style="border-top:1px solid var(--line);padding-top:9px"><span class="k">networks</span><span class="v">{m.nets.join(", ")}</span></div> : null}
              {m.vols.length ? <div class="srow"><span class="k">volumes</span><span class="v">{m.vols.join(", ")}</span></div> : null}
            </>
          ) : null}
        </div>
        <div class={"ready " + (m.ready ? "ok" : "no")}>{m.ready ? "ready to deploy" : m.reason}</div>
      </>
    );
  }

  private renderFoot(stack: boolean) {
    const m = stack ? this.stackSummary() : null;
    return (
      <div class="footbar">
        {stack && this.editing ? <hope-button icon="copy" size="sm" onClick={this.doExport}>Copy compose</hope-button> : null}
        {stack && this.editing ? <hope-button tone="danger" icon="trash" size="sm" onClick={this.deleteStack}>Delete</hope-button> : null}
        {m && !m.ready ? <span class="hint">{m.reason}</span> : null}
        <span class="grow"></span>
        <hope-button onClick={() => this.router.navigate(withHost(this.host || this.hostCtx.token, "/"))}>Cancel</hope-button>
        {stack ? (
          <hope-button tone="primary" solid={true} icon="rocket" onClick={this.deployStack}>{this.editing ? "Apply changes" : "Deploy stack"}</hope-button>
        ) : (
          <hope-button tone="primary" solid={true} icon="rocket" onClick={this.deployContainer}>Deploy container</hope-button>
        )}
      </div>
    );
  }

  private renderContainer() {
    return (
      <hope-panel label="One-off container" icon="box">
        <p class="sub">Create a single container on the active host. For a grouped, editable app, use the Stack tab.</p>
        <div class="tabs" style="margin-bottom:16px">
          <button class={"tab" + (!this.dfMode ? " on" : "")} onClick={() => (this.dfMode = false)}>Use an image</button>
          <button class={"tab" + (this.dfMode ? " on" : "")} onClick={() => (this.dfMode = true)}>Build a Dockerfile</button>
        </div>
        {this.dfMode ? (
          <>
            <div class="f">
              <label>Dockerfile</label>
              <hope-code lang="dockerfile" style="--code-min-h:180px" placeholder={"FROM alpine:3\nRUN apk add --no-cache curl\nCMD [\"sleep\", \"infinity\"]"} value={this.dockerfile} onInput={(e: any) => (this.dockerfile = e.detail)}></hope-code>
            </div>
            {dockerfileWarnings(this.dockerfile).length ? (
              <div class="warns">{dockerfileWarnings(this.dockerfile).map((w) => <div class="w">{w}</div>)}</div>
            ) : null}
            <p class="sub">hope builds the Dockerfile text alone — no build context, so COPY/ADD from local paths won't resolve. Set the name, ports, and env below; the image field is ignored.</p>
          </>
        ) : null}
        <hope-service-form initial={this.oneoff} seed={this.oneoffSeed} networks={this.existingNets} volumes={this.existingVols} showName={true} connectors={[]}></hope-service-form>
      </hope-panel>
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
          <hope-panel label="import a compose file" icon="download" collapsible={true} collapsed={true} style="margin-bottom:18px">
            <div class="filerow">
              <input id="composefile" type="file" accept=".yml,.yaml,text/yaml,text/plain" style="display:none" onChange={this.onFile} />
              <hope-button size="sm" icon="download" onClick={() => this.composeFileInput?.click()}>Choose a compose file</hope-button>
              <span class="or">or paste it below</span>
            </div>
            <div class="f"><label>compose.yml</label><hope-code lang="yaml" style="--code-min-h:150px" placeholder={"services:\n  web:\n    image: nginx\n    ports:\n      - \"8080:80\""} value={this.importText} onInput={(e: any) => (this.importText = e.detail)}></hope-code></div>
            <div class="f"><label>.env (optional, for ${"{VAR}"})</label><textarea style="min-height:90px" placeholder="TAG=1.25" value={this.importEnv} onInput={(e: any) => (this.importEnv = e.target.value)}></textarea></div>
            <hope-button tone="primary" icon="box" onClick={this.doImport}>Parse into builder</hope-button>
          </hope-panel>
        )}

        {this.warnings.length ? (
          <div class="warns">{this.warnings.map((w) => <div class="w">{w}</div>)}</div>
        ) : null}

        {this.rows.map((r) => (
          <hope-panel label={r.initial.name || "service"} icon="box" collapsible={true} style="margin-top:14px">
            {this.rows.length > 1 ? <hope-button slot="actions" icon="x" size="sm" title="remove service" onClick={(e: any) => { e.stopPropagation(); this.removeService(r.key); }}></hope-button> : null}
            <hope-service-form initial={r.initial} seed={this.seed} networks={availNets} volumes={availVols} connectors={this.connectors} zones={this.zones} showName={true}></hope-service-form>
          </hope-panel>
        ))}
        <hope-button icon="plus" size="sm" onClick={this.addService}>add service</hope-button>

        <hope-panel label="stack networks" icon="link" style="margin-top:22px">
          {this.netDecls.map((n, i) => (
            <div class="resrow">
              <input type="text" placeholder="network name" value={n.name} onInput={(e: any) => (this.netDecls = patch(this.netDecls, i, { name: e.target.value }))} />
              <div class="drv"><hope-select options={[{ value: "", label: "bridge" }, { value: "overlay", label: "overlay" }, { value: "macvlan", label: "macvlan" }]} value={n.driver} onSelect={(e: any) => (this.netDecls = patch(this.netDecls, i, { driver: e.detail }))}></hope-select></div>
              <hope-button icon="x" size="sm" onClick={() => (this.netDecls = this.netDecls.filter((_, j) => j !== i))}></hope-button>
            </div>
          ))}
          <hope-button icon="plus" size="sm" onClick={() => (this.netDecls = [...this.netDecls, { name: "", driver: "" }])}>network</hope-button>
        </hope-panel>

        <hope-panel label="stack volumes" icon="copy" style="margin-top:14px">
          {this.volDecls.map((v, i) => (
            <div class="resrow">
              <input type="text" placeholder="volume name" value={v.name} onInput={(e: any) => (this.volDecls = patch(this.volDecls, i, { name: e.target.value }))} />
              <div class="drv"><hope-select options={[{ value: "", label: "local" }]} value={v.driver} placeholder="local" onSelect={(e: any) => (this.volDecls = patch(this.volDecls, i, { driver: e.detail }))}></hope-select></div>
              <hope-button icon="x" size="sm" onClick={() => (this.volDecls = this.volDecls.filter((_, j) => j !== i))}></hope-button>
            </div>
          ))}
          <hope-button icon="plus" size="sm" onClick={() => (this.volDecls = [...this.volDecls, { name: "", driver: "" }])}>volume</hope-button>
        </hope-panel>
      </div>
    );
  }
}

