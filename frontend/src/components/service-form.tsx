// <hope-service-form> — the editable fields of one service (or a one-off
// container): image, ports, env, volumes, networks, and an advanced drawer.
// Reused by the one-off deploy tab and by every row of the stack builder/editor.
//
// It is UNCONTROLLED: it seeds its internal state once from the `initial` prop
// (re-seeding only when `seed` changes, so a parent that reloads data can force
// it), owns its state thereafter, and hands the parent a ContainerSpec on demand
// via getSpec(). That avoids a per-keystroke round-trip through the parent.
import { LoomElement, component, styles, css, reactive, mount, watch } from "@toyz/loom";
import { theme } from "../styles";
import type { ContainerSpec, TunnelRoute, PortMap, MountSpec, Option, HealthSpec } from "../contracts";

interface PortRow { host: string; container: string; proto: string; }
interface EnvRow { k: string; v: string; }
interface VolRow { source: string; target: string; ro: boolean; }
interface NetRow { name: string; aliases: string[]; }
interface TunRow { connector: string; sub: string; domain: string; hostname: string; port: string; path: string; }

export type ConnectorOpt = Option;

@component("hope-service-form")
@styles(theme, css`
  :host { display: block; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
  .f { display: flex; flex-direction: column; gap: 6px; }
  .f.wide { grid-column: 1 / -1; }
  label { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  input { width: 100%; height: 38px; box-sizing: border-box; background: var(--ink); border: 1px solid var(--line);
    color: var(--hi); font: 13px/1 var(--mono); padding: 0 11px; }
  input::placeholder { color: var(--dim); }
  input:focus { outline: none; border-color: var(--line2); }
  hope-select { display: block; height: 38px; }
  .sec { margin-top: 16px; }
  .sec > .lab { display: flex; align-items: center; gap: 8px; font: 600 9.5px/1 var(--mono); letter-spacing: .16em;
    text-transform: uppercase; color: var(--dim); margin-bottom: 8px; }
  .sec > .lab .grow { flex: 1; }
  .rows { display: flex; flex-direction: column; gap: 7px; }
  .row { display: flex; align-items: center; gap: 7px; }
  .row input { flex: 1; }
  .row .p-host { flex: 0 0 120px; }
  .row .p-proto { flex: 0 0 84px; }
  .hostpair { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
  .hostpair input { flex: 1; min-width: 80px; }
  .hostpair hope-select { flex: 1; min-width: 0; }
  .hostpair .dot { color: var(--dim); font: 600 14px/1 var(--mono); }
  .row .v-ro { flex: 0 0 auto; }
  .lab .grow { flex: 1; }
  .lab .hint { font: 500 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: none; color: var(--dim); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 9px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; padding: 7px 11px; border: 1px solid var(--line2);
    color: var(--hi); font: 12px/1 var(--mono); background: var(--ink); }
  .chip loom-icon { color: var(--upd); }
  .chip .x { cursor: pointer; color: var(--dim); display: flex; margin-left: 1px; }
  .chip .x:hover { color: var(--bad); }
  .netlist { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .netitem { border: 1px solid var(--line2); background: var(--ink); }
  .nethead { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--line); }
  .nethead loom-icon { color: var(--upd); }
  .nethead .nn { font: 600 12.5px/1 var(--mono); color: var(--hi); }
  .nethead .grow { flex: 1; }
  .nethead .x { cursor: pointer; color: var(--dim); display: flex; }
  .nethead .x:hover { color: var(--bad); }
  .aliasrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 9px 11px; }
  .atag { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid var(--line);
    color: var(--mid); font: 11.5px/1 var(--mono); background: var(--panel); }
  .atag .x { cursor: pointer; color: var(--dim); display: flex; }
  .atag .x:hover { color: var(--bad); }
  .aliasrow .ain { flex: 1; min-width: 150px; height: 32px; }
  .netadd { display: flex; flex-direction: column; gap: 8px; }
  .netadd .newnet { display: flex; align-items: center; gap: 7px; }
  .netadd .newnet input { flex: 1; }
  .tog { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; user-select: none; }
  .tog .sw { width: 32px; height: 17px; border: 1px solid var(--line2); background: var(--ink); position: relative; flex: none; }
  .tog .sw::after { content: ""; position: absolute; top: 1px; left: 1px; width: 13px; height: 13px; background: var(--dim); transition: transform .12s, background .12s; }
  .tog.on .sw { border-color: var(--upd); background: color-mix(in srgb, var(--upd) 22%, var(--ink)); }
  .tog.on .sw::after { transform: translateX(15px); background: var(--upd); }
  .tog .tl { font: 12px/1 var(--mono); color: var(--mid); }
  .drawer { display: flex; align-items: center; gap: 7px; margin-top: 16px; cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
  .drawer:hover { color: var(--hi); }
  .drawer loom-icon { transition: transform .12s; }
  .drawer.open loom-icon { transform: rotate(90deg); }
  .adv { border-left: 1px solid var(--line); padding-left: 14px; margin: 12px 0 4px; }
  .note { font: 11px/1.5 var(--mono); color: var(--dim); }
`)
export class HopeServiceForm extends LoomElement {
  @reactive accessor initial: ContainerSpec = { image: "" };
  @reactive accessor seed = 0;
  @reactive accessor networks: string[] = []; // available network names
  @reactive accessor volumes: string[] = []; // available volume names
  @reactive accessor connectors: ConnectorOpt[] = []; // tunnel connectors (empty = hide tunnels)
  @reactive accessor zones: string[] = []; // Cloudflare domains for the subdomain|domain picker
  @reactive accessor showName = true; // one-off container hides the service name

  @reactive accessor name = "";
  @reactive accessor image = "";
  @reactive accessor restart = "";
  @reactive accessor ports: PortRow[] = [];
  @reactive accessor envs: EnvRow[] = [];
  @reactive accessor vols: VolRow[] = [];
  @reactive accessor netRows: NetRow[] = [];
  @reactive accessor tuns: TunRow[] = [];
  @reactive accessor command = "";
  @reactive accessor entrypoint = "";
  @reactive accessor user = "";
  @reactive accessor workingDir = "";
  @reactive accessor capAdd = "";
  @reactive accessor privileged = false;
  @reactive accessor labels: EnvRow[] = [];
  // healthcheck (compose healthcheck: block). hcTest is the shell command; empty = none.
  @reactive accessor hcTest = "";
  @reactive accessor hcInterval = "";
  @reactive accessor hcTimeout = "";
  @reactive accessor hcRetries = "";
  @reactive accessor hcStart = "";
  @reactive accessor advOpen = false;

  @mount
  onMount() { this.reseed(); }

  // Reseed whenever the parent hands us a new spec object (import, edit-load,
  // add/remove restructure) — the property can arrive after @mount, so watching
  // it (not just @mount/seed) is what actually populates the fields.
  @watch("initial")
  onInitial() { this.reseed(); }

  @watch("seed")
  onSeed() { this.reseed(); }

  private reseed() {
    const s = this.initial || ({ image: "" } as ContainerSpec);
    this.name = s.name || "";
    this.image = s.image || "";
    this.restart = s.restart || "";
    this.ports = (s.ports || []).map((p) => ({ host: p.host || "", container: p.container || "", proto: p.protocol || "tcp" }));
    this.envs = Object.entries(s.env || {}).map(([k, v]) => ({ k, v }));
    this.vols = (s.mounts || []).map((m) => ({ source: m.source || "", target: m.target || "", ro: !!m.read_only }));
    this.netRows = (s.networks || []).map((n) => ({ name: n, aliases: [...((s.aliases && s.aliases[n]) || [])] }));
    this.tuns = (s.tunnels || []).map((t) => { const { sub, domain } = this.splitHost(t.hostname || ""); return { connector: t.connector || "", sub, domain, hostname: t.hostname || "", port: t.port || "", path: t.path || "" }; });
    this.command = (s.command || []).join(" ");
    this.entrypoint = (s.entrypoint || []).join(" ");
    this.user = s.user || "";
    this.workingDir = s.working_dir || "";
    this.capAdd = (s.cap_add || []).join(", ");
    this.privileged = !!s.privileged;
    this.labels = Object.entries(s.labels || {}).map(([k, v]) => ({ k, v }));
    const t = s.health?.test || [];
    // Strip the compose CMD/CMD-SHELL prefix for editing; NONE = disabled.
    this.hcTest = t[0] === "NONE" ? "" : t[0] === "CMD-SHELL" || t[0] === "CMD" ? t.slice(1).join(" ") : t.join(" ");
    this.hcInterval = s.health?.interval || "";
    this.hcTimeout = s.health?.timeout || "";
    this.hcRetries = s.health?.retries != null ? String(s.health.retries) : "";
    this.hcStart = s.health?.start_period || "";
  }

  /** getSpec assembles the current fields into a ContainerSpec. */
  getSpec(): ContainerSpec {
    const spec: ContainerSpec = { image: this.image.trim() };
    if (this.showName && this.name.trim()) spec.name = this.name.trim();
    if (this.restart) spec.restart = this.restart;
    const ports: PortMap[] = [];
    for (const p of this.ports) {
      if (!p.container.trim()) continue;
      const pm: PortMap = { container: p.container.trim() };
      if (p.host.trim()) pm.host = p.host.trim();
      if (p.proto && p.proto !== "tcp") pm.protocol = p.proto;
      ports.push(pm);
    }
    if (ports.length) spec.ports = ports;
    const env: Record<string, string> = {};
    for (const e of this.envs) if (e.k.trim()) env[e.k.trim()] = e.v;
    if (Object.keys(env).length) spec.env = env;
    const mounts: MountSpec[] = [];
    for (const v of this.vols) {
      if (!v.target.trim()) continue;
      const src = v.source.trim();
      const type = src && (src.startsWith("/") || src.startsWith("./") || src.startsWith("~")) ? "bind" : "volume";
      mounts.push({ type, source: src, target: v.target.trim(), read_only: v.ro });
    }
    if (mounts.length) spec.mounts = mounts;
    if (this.netRows.length) {
      spec.networks = this.netRows.map((r) => r.name);
      const al: Record<string, string[]> = {};
      for (const r of this.netRows) {
        const clean = r.aliases.map((a) => a.trim()).filter(Boolean);
        if (clean.length) al[r.name] = clean;
      }
      if (Object.keys(al).length) spec.aliases = al;
    }
    if (this.command.trim()) spec.command = this.command.trim().split(/\s+/);
    if (this.entrypoint.trim()) spec.entrypoint = this.entrypoint.trim().split(/\s+/);
    if (this.user.trim()) spec.user = this.user.trim();
    if (this.workingDir.trim()) spec.working_dir = this.workingDir.trim();
    if (this.privileged) spec.privileged = true;
    const caps = this.capAdd.split(",").map((c) => c.trim()).filter(Boolean);
    if (caps.length) spec.cap_add = caps;
    const hcCmd = this.hcTest.trim();
    if (hcCmd) {
      const health: HealthSpec = { test: ["CMD-SHELL", hcCmd] };
      if (this.hcInterval.trim()) health.interval = this.hcInterval.trim();
      if (this.hcTimeout.trim()) health.timeout = this.hcTimeout.trim();
      if (this.hcStart.trim()) health.start_period = this.hcStart.trim();
      const r = parseInt(this.hcRetries, 10);
      if (!isNaN(r) && r > 0) health.retries = r;
      spec.health = health;
    }
    const labels: Record<string, string> = {};
    for (const l of this.labels) if (l.k.trim()) labels[l.k.trim()] = l.v;
    if (Object.keys(labels).length) spec.labels = labels;
    const tunnels: TunnelRoute[] = [];
    for (const t of this.tuns) {
      const host = this.tunHost(t);
      if (!host || !t.port.trim() || !t.connector) continue;
      tunnels.push({ connector: t.connector, hostname: host, port: t.port.trim(), path: t.path.trim() });
    }
    if (tunnels.length) spec.tunnels = tunnels;
    return spec;
  }

  // ── row mutators (immutable so reactivity fires) ──
  private up<T>(arr: T[], i: number, patch: Partial<T>): T[] {
    const next = arr.slice();
    next[i] = { ...next[i], ...patch };
    return next;
  }
  private del<T>(arr: T[], i: number): T[] { return arr.filter((_, j) => j !== i); }

  // splitHost breaks a hostname into subdomain + a known zone (domain). Falls
  // back to (sub="", domain="") for a free-text host when no zone matches.
  private splitHost(host: string): { sub: string; domain: string } {
    for (const z of this.zones) {
      if (host === z) return { sub: "", domain: z };
      if (host.endsWith("." + z)) return { sub: host.slice(0, -(z.length + 1)), domain: z };
    }
    return { sub: "", domain: "" };
  }
  // tunHost composes a route's hostname: subdomain|domain when zones exist (blank
  // sub = root domain), else the free-text hostname field.
  private tunHost(t: TunRow): string {
    if (this.zones.length) {
      if (!t.domain) return "";
      return (t.sub.trim() ? `${t.sub.trim()}.${t.domain}` : t.domain).toLowerCase();
    }
    return t.hostname.trim().toLowerCase();
  }

  private addNet = (name: string) => {
    const n = name.trim();
    if (n && !this.netRows.some((r) => r.name === n)) this.netRows = [...this.netRows, { name: n, aliases: [] }];
  };
  private addAlias = (i: number, alias: string) => {
    const a = alias.trim();
    if (!a) return;
    const row = this.netRows[i];
    if (row.aliases.includes(a)) return;
    this.netRows = this.up(this.netRows, i, { aliases: [...row.aliases, a] });
  };
  private delAlias = (i: number, j: number) => {
    this.netRows = this.up(this.netRows, i, { aliases: this.netRows[i].aliases.filter((_, k) => k !== j) });
  };

  update() {
    const availNets = this.networks.filter((n) => !this.netRows.some((r) => r.name === n)).map((n) => ({ value: n, label: n }));
    return (
      <div>
        <div class="grid">
          {this.showName ? (
            <div class="f">
              <label>service name</label>
              <input type="text" placeholder="web" value={this.name} onInput={(e: any) => (this.name = e.target.value)} />
            </div>
          ) : null}
          <div class={"f" + (this.showName ? "" : " wide")}>
            <label>image</label>
            <input type="text" placeholder="nginx:latest" value={this.image} onInput={(e: any) => (this.image = e.target.value)} />
          </div>
          <div class="f">
            <label>restart policy</label>
            <hope-select
              options={[
                { value: "", label: "no" },
                { value: "unless-stopped", label: "unless-stopped" },
                { value: "always", label: "always" },
                { value: "on-failure", label: "on-failure" },
              ]}
              value={this.restart}
              placeholder="no"
              onSelect={(e: any) => (this.restart = e.detail)}
            ></hope-select>
          </div>
        </div>

        <div class="sec">
          <div class="lab"><span>ports</span></div>
          <div class="rows">
            {this.ports.map((p, i) => (
              <div class="row">
                <input class="p-host" type="text" placeholder="host" value={p.host} onInput={(e: any) => (this.ports = this.up(this.ports, i, { host: e.target.value }))} />
                <input type="text" placeholder="container" value={p.container} onInput={(e: any) => (this.ports = this.up(this.ports, i, { container: e.target.value }))} />
                <div class="p-proto">
                  <hope-select options={[{ value: "tcp", label: "tcp" }, { value: "udp", label: "udp" }]} value={p.proto} onSelect={(e: any) => (this.ports = this.up(this.ports, i, { proto: e.detail }))}></hope-select>
                </div>
                <hope-button icon="x" size="sm" onClick={() => (this.ports = this.del(this.ports, i))}></hope-button>
              </div>
            ))}
          </div>
          <hope-button icon="plus" size="sm" onClick={() => (this.ports = [...this.ports, { host: "", container: "", proto: "tcp" }])}>port</hope-button>
        </div>

        <div class="sec">
          <div class="lab"><span>environment</span></div>
          <hope-kv-editor value={rowsToText(this.envs)} addLabel="variable" onChange={(e: any) => (this.envs = textToRows(e.detail))}></hope-kv-editor>
        </div>

        <div class="sec">
          <div class="lab"><span>volumes</span></div>
          <div class="rows">
            {this.vols.map((v, i) => (
              <div class="row">
                <input type="text" placeholder="volume name or /host/path" value={v.source} onInput={(e: any) => (this.vols = this.up(this.vols, i, { source: e.target.value }))} />
                <input type="text" placeholder="/container/path" value={v.target} onInput={(e: any) => (this.vols = this.up(this.vols, i, { target: e.target.value }))} />
                <span class={"tog v-ro" + (v.ro ? " on" : "")} title="read-only" onClick={() => (this.vols = this.up(this.vols, i, { ro: !v.ro }))}><span class="sw"></span><span class="tl">ro</span></span>
                <hope-button icon="x" size="sm" onClick={() => (this.vols = this.del(this.vols, i))}></hope-button>
              </div>
            ))}
          </div>
          <hope-button icon="plus" size="sm" onClick={() => (this.vols = [...this.vols, { source: "", target: "", ro: false }])}>volume</hope-button>
        </div>

        <div class="sec">
          <div class="lab"><span>networks</span><span class="grow"></span><span class="hint">attach one or more, alias per network</span></div>
          {this.netRows.length ? (
            <div class="netlist">
              {this.netRows.map((r, i) => (
                <div class="netitem">
                  <div class="nethead">
                    <loom-icon name="link" size={13}></loom-icon>
                    <span class="nn">{r.name}</span>
                    <span class="grow"></span>
                    <span class="x" title="detach" onClick={() => (this.netRows = this.del(this.netRows, i))}><loom-icon name="x" size={13}></loom-icon></span>
                  </div>
                  <div class="aliasrow">
                    {r.aliases.map((a, j) => (
                      <span class="atag">{a}<span class="x" onClick={() => this.delAlias(i, j)}><loom-icon name="x" size={11}></loom-icon></span></span>
                    ))}
                    <input class="ain" type="text" placeholder="+ alias (dns name)" onKeyDown={(e: any) => { if (e.key === "Enter") { this.addAlias(i, e.target.value); e.target.value = ""; } }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div class="note">none attached — the default bridge is used</div>
          )}
          <div class="netadd">
            {availNets.length ? (
              <hope-select options={availNets} value="" placeholder="attach an existing network…" onSelect={(e: any) => this.addNet(e.detail)}></hope-select>
            ) : null}
            <div class="newnet">
              <input type="text" placeholder="new network name" onKeyDown={(e: any) => { if (e.key === "Enter") { this.addNet(e.target.value); e.target.value = ""; } }} />
              <hope-button icon="plus" size="sm" onClick={(e: any) => { const inp = (e.currentTarget as HTMLElement).previousElementSibling as HTMLInputElement; this.addNet(inp.value); inp.value = ""; }}>attach</hope-button>
            </div>
          </div>
        </div>

        {this.connectors.length ? (
          <div class="sec">
            <div class="lab"><span>expose via tunnel</span><span class="grow"></span><span class="hint">public route — no published port needed</span></div>
            <div class="rows">
              {this.tuns.map((t, i) => (
                <div class="row">
                  <hope-select options={this.connectors} value={t.connector} placeholder="connector" onSelect={(e: any) => (this.tuns = this.up(this.tuns, i, { connector: e.detail }))}></hope-select>
                  {this.zones.length ? (
                    <div class="hostpair">
                      <input type="text" placeholder="subdomain (blank = root)" value={t.sub} onInput={(e: any) => (this.tuns = this.up(this.tuns, i, { sub: e.target.value }))} />
                      <span class="dot">.</span>
                      <hope-select options={this.zones.map((z) => ({ value: z, label: z }))} value={t.domain} placeholder="domain" onSelect={(e: any) => (this.tuns = this.up(this.tuns, i, { domain: e.detail }))}></hope-select>
                    </div>
                  ) : (
                    <input type="text" placeholder="app.example.com" value={t.hostname} onInput={(e: any) => (this.tuns = this.up(this.tuns, i, { hostname: e.target.value }))} />
                  )}
                  <input class="p-host" type="text" placeholder="container port" value={t.port} onInput={(e: any) => (this.tuns = this.up(this.tuns, i, { port: e.target.value }))} />
                  <input class="p-proto" type="text" placeholder="/path" value={t.path} onInput={(e: any) => (this.tuns = this.up(this.tuns, i, { path: e.target.value }))} />
                  <hope-button icon="x" size="sm" onClick={() => (this.tuns = this.del(this.tuns, i))}></hope-button>
                </div>
              ))}
            </div>
            <hope-button icon="plus" size="sm" onClick={() => (this.tuns = [...this.tuns, { connector: this.connectors[0]?.value || "", sub: "", domain: this.zones[0] || "", hostname: "", port: this.ports[0]?.container || "", path: "" }])}>route</hope-button>
          </div>
        ) : null}

        <div class={"drawer" + (this.advOpen ? " open" : "")} onClick={() => (this.advOpen = !this.advOpen)}>
          <loom-icon name="chevron-right" size={13}></loom-icon> advanced
        </div>
        {this.advOpen ? (
          <div class="adv">
            <div class="grid">
              <div class="f wide"><label>command</label><input type="text" placeholder="redis-server --appendonly yes" value={this.command} onInput={(e: any) => (this.command = e.target.value)} /></div>
              <div class="f wide"><label>entrypoint</label><input type="text" placeholder="(override image entrypoint)" value={this.entrypoint} onInput={(e: any) => (this.entrypoint = e.target.value)} /></div>
              <div class="f"><label>user</label><input type="text" placeholder="1000:1000" value={this.user} onInput={(e: any) => (this.user = e.target.value)} /></div>
              <div class="f"><label>working dir</label><input type="text" placeholder="/app" value={this.workingDir} onInput={(e: any) => (this.workingDir = e.target.value)} /></div>
              <div class="f"><label>cap_add</label><input type="text" placeholder="NET_ADMIN, SYS_TIME" value={this.capAdd} onInput={(e: any) => (this.capAdd = e.target.value)} /></div>
              <div class="f"><label>privileged</label><span class={"tog" + (this.privileged ? " on" : "")} onClick={() => (this.privileged = !this.privileged)}><span class="sw"></span><span class="tl">{this.privileged ? "on" : "off"}</span></span></div>
            </div>
            <div class="sec">
              <div class="lab"><span>healthcheck</span></div>
              <div class="grid">
                <div class="f wide"><label>test command</label><input type="text" placeholder="curl -fsS http://localhost:8080/health || exit 1" value={this.hcTest} onInput={(e: any) => (this.hcTest = e.target.value)} /></div>
                <div class="f"><label>interval</label><input type="text" placeholder="30s" value={this.hcInterval} onInput={(e: any) => (this.hcInterval = e.target.value)} /></div>
                <div class="f"><label>timeout</label><input type="text" placeholder="5s" value={this.hcTimeout} onInput={(e: any) => (this.hcTimeout = e.target.value)} /></div>
                <div class="f"><label>retries</label><input type="text" placeholder="3" value={this.hcRetries} onInput={(e: any) => (this.hcRetries = e.target.value)} /></div>
                <div class="f"><label>start period</label><input type="text" placeholder="10s" value={this.hcStart} onInput={(e: any) => (this.hcStart = e.target.value)} /></div>
              </div>
            </div>
            <div class="sec">
              <div class="lab"><span>labels</span></div>
              <hope-kv-editor value={rowsToText(this.labels)} addLabel="label" onChange={(e: any) => (this.labels = textToRows(e.detail))}></hope-kv-editor>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
}

// Bridge the EnvRow[] state to <hope-kv-editor>'s KEY=VALUE string (env + labels).
function rowsToText(rows: { k: string; v: string }[]): string {
  return rows.filter((r) => r.k.trim()).map((r) => `${r.k.trim()}=${r.v}`).join("\n");
}
function textToRows(s: string): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [];
  for (const line of (s || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) out.push({ k: t, v: "" });
    else out.push({ k: t.slice(0, i).trim(), v: t.slice(i + 1) });
  }
  return out;
}
