// <hope-registries> — the registry-credentials manager: list + add + remove.
// Reused in both the images-page quick-add modal and the dedicated /registries
// system page, so the UI + logic live in one place. hope is the fleet's registry
// authority: creds are applied to the local daemon and every connected agent, and
// (with a state db) persist encrypted on the PRIMARY hope node — never per-agent.
// Config-defined entries are read-only.
import { LoomElement, component, styles, css, reactive, prop, mount, watch, unmount } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { signalModal } from "../modal";
import type { RegistryView } from "../contracts";
import { theme } from "../styles";

// Well-known registries: a quick-pick that prefills the server and tells the
// operator exactly what to put in each field (most get this wrong — e.g. Docker
// Hub wants an access token, not the account password). Some registries have a
// per-account server (ECR, GAR): those declare `parts` we collect as fields and
// `build` into the final server, instead of making the user hand-edit a template.
type RegPart = { key: string; label: string; placeholder: string };
type KnownRegistry = {
  id: string; label: string; server: string; user: string; pass: string; note: string;
  fixedUser?: string;
  parts?: RegPart[];
  build?: (v: Record<string, string>) => string;
};
const KNOWN_REGISTRIES: KnownRegistry[] = [
  { id: "dockerhub", label: "Docker Hub", server: "docker.io", user: "your Docker Hub username", pass: "access token", note: "Create an access token at Docker Hub → Account Settings → Personal access tokens. Use the token, not your account password." },
  { id: "ghcr", label: "GitHub (GHCR)", server: "ghcr.io", user: "your GitHub username", pass: "personal access token", note: "Use a GitHub PAT with the read:packages scope as the password." },
  { id: "quay", label: "Quay", server: "quay.io", user: "quay username or robot account", pass: "token / robot password", note: "A robot account (Quay → Account → Robot Accounts) is the safest fit — its name is the username, its token the password." },
  { id: "gitlab", label: "GitLab", server: "registry.gitlab.com", user: "username or deploy-token name", pass: "personal or deploy token", note: "Use a deploy token (Settings → Repository → Deploy tokens) with the read_registry scope, or a PAT." },
  { id: "digitalocean", label: "DigitalOcean (DOCR)", server: "registry.digitalocean.com", user: "your DO API token", pass: "the same DO API token", note: "DigitalOcean uses your API token (or a read-only registry token) as BOTH the username and the password." },
  {
    id: "ecr", label: "AWS ECR (private)", server: "ACCOUNT.dkr.ecr.REGION.amazonaws.com", user: "AWS", pass: "aws ecr get-login-password output", fixedUser: "AWS",
    note: "Username is literally AWS. Password is the output of `aws ecr get-login-password` — it EXPIRES (~12h), so re-add when it rotates.",
    parts: [
      { key: "account", label: "AWS account ID", placeholder: "123456789012" },
      { key: "region", label: "Region", placeholder: "us-east-1" },
    ],
    build: (v) => `${v.account || "ACCOUNT"}.dkr.ecr.${v.region || "REGION"}.amazonaws.com`,
  },
  { id: "ecrpublic", label: "AWS ECR Public", server: "public.ecr.aws", user: "AWS", pass: "aws ecr-public get-login-password output", fixedUser: "AWS", note: "Username is AWS. Password is `aws ecr-public get-login-password --region us-east-1` — it EXPIRES (~12h), so re-add when it rotates." },
  {
    id: "gar", label: "Google Artifact Registry", server: "REGION-docker.pkg.dev", user: "_json_key", pass: "service-account JSON key", fixedUser: "_json_key",
    note: "Username is _json_key; paste the whole service-account JSON key file as the password.",
    parts: [{ key: "region", label: "Location", placeholder: "us (or europe, us-central1)" }],
    build: (v) => `${v.region || "REGION"}-docker.pkg.dev`,
  },
  {
    id: "acr", label: "Azure (ACR)", server: "REGISTRY.azurecr.io", user: "token name or service principal", pass: "token password / SP secret",
    note: "Use a repository-scoped token (ACR → Tokens) or a service principal — its name/ID is the username, its secret the password.",
    parts: [{ key: "name", label: "Registry name", placeholder: "myregistry" }],
    build: (v) => `${v.name || "REGISTRY"}.azurecr.io`,
  },
  {
    id: "ocir", label: "Oracle (OCIR)", server: "REGION.ocir.io", user: "<tenancy-namespace>/<username>", pass: "OCI auth token",
    note: "Username is `<tenancy-namespace>/<username>` (federated: add /oracleidentitycloudservice/). Password is an OCI auth token. Region is the region KEY.",
    parts: [{ key: "region", label: "Region key", placeholder: "iad, phx, fra…" }],
    build: (v) => `${v.region || "REGION"}.ocir.io`,
  },
  {
    id: "ibm", label: "IBM Cloud (ICR)", server: "REGION.icr.io", user: "iamapikey", pass: "IBM Cloud API key", fixedUser: "iamapikey",
    note: "Username is `iamapikey`; password is an IBM Cloud API key. Region is the ICR region (us, de, uk, jp, au…).",
    parts: [{ key: "region", label: "Region", placeholder: "us (→ us.icr.io)" }],
    build: (v) => `${v.region || "REGION"}.icr.io`,
  },
  {
    id: "scaleway", label: "Scaleway", server: "rg.REGION.scw.cloud", user: "nologin", pass: "Scaleway secret key", fixedUser: "nologin",
    note: "Username is literally `nologin`; password is a Scaleway secret key (API key).",
    parts: [{ key: "region", label: "Region", placeholder: "fr-par (or nl-ams, pl-waw)" }],
    build: (v) => `rg.${v.region || "REGION"}.scw.cloud`,
  },
  {
    id: "aliyun", label: "Alibaba (ACR)", server: "registry.REGION.aliyuncs.com", user: "your Alibaba Cloud account", pass: "registry password",
    note: "Username is your Alibaba Cloud account (or RAM user); password is the registry access password you set in ACR.",
    parts: [{ key: "region", label: "Region", placeholder: "cn-hangzhou, us-west-1…" }],
    build: (v) => `registry.${v.region || "REGION"}.aliyuncs.com`,
  },
];

@component("hope-registries")
@styles(theme, css`
  :host { display: block; }

  /* full-bleed table — mirrors the networks page. minmax(0,…) columns keep it
     responsive so it still fits the compact (~600px) images-page modal. */
  .rows { padding-bottom: 8px; }
  .rhead, .rrow { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1.1fr) 96px 82px 34px; align-items: center; gap: 16px; padding: 0 28px; }
  .rhead { height: 36px; border-bottom: 1px solid var(--line); }
  .rhead span { font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .rrow { height: 52px; border-bottom: 1px solid var(--line); }
  .rrow:hover { background: var(--raised); }
  .rserver { color: var(--hi); font: 13px/1 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ruser { color: var(--mid); font: 12px/1 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ruser.none { color: var(--dim); }
  .rauth { display: inline-flex; align-items: center; gap: 7px; font: 11px/1 var(--mono); color: var(--ok); }
  .rauth.no { color: var(--warn); }
  .rauth::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .rmc { display: flex; justify-content: flex-end; }
  .rempty { padding: 40px 28px; text-align: center; color: var(--dim); font: 12.5px/1.5 var(--mono); }
  .rempty b { color: var(--hi); }

  /* standalone toolbar (images-page modal, where there's no page header) */
  .rtools { display: flex; justify-content: flex-end; padding: 0 0 14px; }

  /* add-registry modal — same chrome as the app's other modals */
  .rmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: rfade .12s ease both; }
  @keyframes rfade { from { opacity: 0; } to { opacity: 1; } }
  .rbox { width: 560px; max-width: 100%; max-height: 90vh; display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--line2); border-top: 2px solid var(--upd);
    animation: rpop .14s cubic-bezier(.2, .8, .3, 1) both; }
  @keyframes rpop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
  .rmhd { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--line);
    font: 600 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--hi); }
  .rmhd loom-icon { color: var(--upd); } .rmhd .grow { flex: 1; }
  .rmx { background: transparent; border: 0; color: var(--dim); cursor: pointer; display: flex; padding: 2px; }
  .rmx:hover { color: var(--hi); }
  .rmbd { padding: 18px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
  .rfield { display: flex; flex-direction: column; gap: 6px; }
  .rfield.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .rfield label, .rfield.two > div > label { font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .rfield.two > div { display: flex; flex-direction: column; gap: 6px; }
  .rfield input { width: 100%; box-sizing: border-box; background: var(--ink); border: 1px solid var(--line); color: var(--hi); font: 12.5px/1 var(--mono); padding: 10px 11px; }
  .rfield input:focus { outline: none; border-color: var(--line2); }
  .rpreview { background: var(--ink); border: 1px dashed var(--line2); color: var(--mid); font: 12.5px/1 var(--mono); padding: 10px 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rnote { font: 11.5px/1.6 var(--mono); color: var(--dim); padding: 11px 13px; border: 1px solid var(--line); background: var(--ink); }
  .rnote.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .rmft { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
`)
export class HopeRegistries extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;

  // standalone: render an own "add registry" button (for the images-page modal,
  // which has no page header). On the /registries page the header opens the modal.
  @prop accessor standalone = false;

  @reactive accessor regs: RegistryView[] = [];
  @reactive accessor loaded = false; // first load done — drives the row skeleton
  @reactive accessor adding = false; // the add-registry modal is open
  @reactive accessor regBusy = false;
  @reactive accessor rServer = "";
  @reactive accessor rUser = "";
  @reactive accessor rPass = "";
  @reactive accessor rPreset = "";
  @reactive accessor rParts: Record<string, string> = {};

  @mount
  onMount() { void this.loadRegs(); }

  @watch("adding") private lockBody() { signalModal(this, this.adding); }
  @unmount private releaseBody() { signalModal(this, false); }

  // Open/close the add-registry modal. openAdd is public so the /registries page's
  // header button can trigger it.
  openAdd = () => {
    this.rServer = this.rUser = this.rPass = this.rPreset = "";
    this.rParts = {};
    this.adding = true;
  };
  private closeAdd = () => { this.adding = false; };

  private loadRegs = async () => {
    try {
      this.regs = (await this.rpc.call<RegistryView[]>("System", "registries", [])) || [];
    } catch (err: any) {
      this.toast.error(`load registries — ${err?.message ?? "failed"}`);
    } finally {
      this.loaded = true;
    }
  };

  private selectPreset = (id: string) => {
    this.rPreset = id;
    this.rParts = {};
    this.rUser = "";
    const k = KNOWN_REGISTRIES.find((x) => x.id === id);
    if (!k) { this.rServer = ""; return; }
    this.rServer = k.build ? k.build({}) : k.server;
    if (k.fixedUser) this.rUser = k.fixedUser;
  };

  private configuredFor(k: KnownRegistry): RegistryView | undefined {
    if (k.build) return undefined;
    return this.regs.find((r) => r.server === k.server);
  }

  private setPart = (k: KnownRegistry, key: string, val: string) => {
    this.rParts = { ...this.rParts, [key]: val.trim() };
    if (k.build) this.rServer = k.build(this.rParts);
  };

  private addReg = async () => {
    const server = this.rServer.trim();
    const user = this.rUser.trim();
    if (!server || !user || !this.rPass) {
      this.toast.error("server, username and password are required");
      return;
    }
    this.regBusy = true;
    try {
      const res = await this.rpc.call<{ ok: boolean; persisted: boolean }>("System", "addRegistry", [server, user, this.rPass]);
      this.toast.ok(res?.persisted ? `added ${server}` : `added ${server} (not persisted — no state db mounted)`);
      this.rServer = this.rUser = this.rPass = this.rPreset = "";
      this.rParts = {};
      this.adding = false;
      await this.loadRegs();
    } catch (err: any) {
      this.toast.error(`add ${server} — ${err?.message ?? "failed"}`);
    } finally {
      this.regBusy = false;
    }
  };

  private removeReg = async (r: RegistryView) => {
    const ok = await this.confirm.ask({
      title: "remove registry",
      danger: true,
      confirmLabel: "Remove",
      message: `Stop authenticating pulls from ${r.server} across the fleet.`,
      stats: [{ label: "registry", value: r.server }, ...(r.username ? [{ label: "user", value: r.username }] : [])],
    });
    if (!ok) return;
    try {
      await this.rpc.call("System", "removeRegistry", [r.server]);
      this.toast.ok(`removed ${r.server}`);
      await this.loadRegs();
    } catch (err: any) {
      this.toast.error(`remove ${r.server} — ${err?.message ?? "failed"}`);
    }
  };

  // The add-registry modal — a clean design-system dialog (preset picker + fields),
  // opened from the page header (or the standalone toolbar button).
  private renderAddModal() {
    const preset = KNOWN_REGISTRIES.find((k) => k.id === this.rPreset);
    const cfg = preset ? this.configuredFor(preset) : undefined;
    const blocked = !!cfg && !cfg.editable;
    return (
      <div class="rmodal" onClick={this.closeAdd}>
        <div class="rbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="rmhd">
            <loom-icon name="database" size={15}></loom-icon>
            <span>add registry</span>
            <span class="grow"></span>
            <button class="rmx" onClick={this.closeAdd}><loom-icon name="x" size={16}></loom-icon></button>
          </div>
          <div class="rmbd">
            <div class="rfield">
              <label>Known registries</label>
              <hope-select
                options={[
                  { value: "", label: "Custom / other…" },
                  ...KNOWN_REGISTRIES.map((k) => {
                    const c = this.configuredFor(k);
                    return { value: k.id, label: k.label + (c ? (c.editable ? " · added" : " · config") : "") };
                  }),
                ]}
                value={this.rPreset}
                placeholder="Custom / other…"
                onSelect={(e: any) => this.selectPreset(e.detail)}
              ></hope-select>
            </div>
            {preset?.parts ? (
              <>
                <div class="rfield two">
                  {preset.parts.map((p) => (
                    <div>
                      <label>{p.label}</label>
                      <input type="text" placeholder={p.placeholder} autocomplete="off" value={this.rParts[p.key] || ""} onInput={(e: any) => this.setPart(preset, p.key, e.target.value)} />
                    </div>
                  ))}
                </div>
                <div class="rfield">
                  <label>Registry server</label>
                  <div class="rpreview">{this.rServer}</div>
                </div>
              </>
            ) : (
              <div class="rfield">
                <label>Registry server</label>
                <input type="text" placeholder="registry.example.com" value={this.rServer} onInput={(e: any) => { this.rServer = e.target.value; }} />
              </div>
            )}
            <div class="rfield two">
              <div>
                <label>Username</label>
                <input type="text" placeholder={preset ? preset.user : "username"} autocomplete="off" value={this.rUser} onInput={(e: any) => (this.rUser = e.target.value)} />
              </div>
              <div>
                <label>Password / token</label>
                <input type="password" placeholder={preset ? preset.pass : "password or access token"} autocomplete="new-password" value={this.rPass} onInput={(e: any) => (this.rPass = e.target.value)} />
              </div>
            </div>
            {preset ? <div class="rnote">{preset.note}</div> : null}
            {cfg ? (
              <div class={"rnote" + (blocked ? " warn" : "")}>
                {blocked
                  ? `${cfg.server} is already configured from config (read-only) — remove it there to change it.`
                  : `${cfg.server} is already added — saving updates its stored credentials.`}
              </div>
            ) : null}
          </div>
          <div class="rmft">
            <hope-button onClick={this.closeAdd}>cancel</hope-button>
            <hope-button tone="primary" solid icon="plus" disabled={this.regBusy || blocked} onClick={this.addReg}>{this.regBusy ? "adding…" : blocked ? "read-only" : cfg ? "update registry" : "add registry"}</hope-button>
          </div>
        </div>
      </div>
    );
  }

  update() {
    return (
      <>
        {this.standalone ? (
          <div class="rtools"><hope-button icon="plus" onClick={this.openAdd}>add registry</hope-button></div>
        ) : null}
        {!this.loaded ? (
          <div class="rows">
            <div class="rhead"><span>server</span><span>username</span><span>auth</span><span>source</span><span></span></div>
            {[0, 1, 2].map(() => (
              <div class="rrow">
                <div class="rserver"><hope-skel w="200" h="12"></hope-skel></div>
                <div class="ruser"><hope-skel w="120" h="12"></hope-skel></div>
                <div><hope-skel w="70" h="12"></hope-skel></div>
                <div><hope-skel w="52" h="16"></hope-skel></div>
                <div class="rmc"></div>
              </div>
            ))}
          </div>
        ) : this.regs.length ? (
          <div class="rows">
            <div class="rhead"><span>server</span><span>username</span><span>auth</span><span>source</span><span></span></div>
            {this.regs.map((r) => (
              <div class="rrow">
                <div class="rserver" title={r.server}>{r.server}</div>
                <div class={"ruser" + (r.username ? "" : " none")}>{r.username || "no user"}</div>
                <div><span class={"rauth" + (r.has_password ? "" : " no")}>{r.has_password ? "token set" : "no password"}</span></div>
                <div><hope-chip tone={r.editable ? "ok" : ""} size="sm">{r.source}</hope-chip></div>
                <div class="rmc">{r.editable ? <hope-button size="sm" tone="danger" icon="trash" title="remove registry" onClick={() => this.removeReg(r)}></hope-button> : null}</div>
              </div>
            ))}
          </div>
        ) : (
          <div class="rempty">No registries configured. <b>Add a registry</b> to pull private images.</div>
        )}
        {this.adding ? this.renderAddModal() : null}
      </>
    );
  }
}
