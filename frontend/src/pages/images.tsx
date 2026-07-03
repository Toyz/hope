// Images — every local image on the daemon, cleanly: repo:tag, id, size, age,
// and whether it's in use or dangling. Sorted largest first.
import { component, styles, css, reactive, watch, unmount } from "@toyz/loom";
import { signalModal } from "../modal";
import { inject } from "@toyz/loom/di";
import { route } from "@toyz/loom/router";
import { rpc } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { appBar } from "../app-bar";
import { ResourcePage } from "./resource-page";
import { HopeTransport } from "../transport";
import { ImageDetailService } from "../components/image-detail";
import { System } from "../contracts";
import type { ImageInfo, OpFrame, FleetImagesHost, RegistryView } from "../contracts";
import { bytes, shortId } from "../format";

type Filter = "all" | "used" | "unused" | "dangling";

// Well-known registries: a quick-pick that prefills the server and tells the
// operator exactly what to put in each field (most get this wrong — e.g. Docker
// Hub wants an access token, not the account password). Some registries have a
// per-account server (ECR, GAR): those declare `parts` we collect as fields and
// `build` into the final server, instead of making the user hand-edit a template.
type RegPart = { key: string; label: string; placeholder: string };
type KnownRegistry = {
  id: string; label: string; server: string; user: string; pass: string; note: string;
  fixedUser?: string; // a literal username the registry requires (AWS, _json_key, nologin…) — prefilled
  parts?: RegPart[]; // per-account server parts collected as fields
  build?: (v: Record<string, string>) => string; // compose the server from those parts
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

@route("/images")
@component("hope-images")
@styles(css`
  :host { display: block; min-height: calc(100vh - 48px); background: var(--ink); }

  .bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink); }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { display: flex; align-items: center; gap: 5px; color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .back:hover { color: var(--hi); }
  .bar .crumb { font: 600 13px/1 var(--mono); letter-spacing: .04em; }
  .bar .grow { flex: 1; }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }
  .bar .nav .navlink { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); cursor: pointer; }
  .bar .nav .navlink:hover { color: var(--hi); }
  .bar .nav .navlink.on { color: var(--hi); }

  main { padding: 28px 40px 96px; max-width: 1340px; margin: 0 auto; }

  .summary { display: flex; align-items: center; border: 1px solid var(--line); margin-bottom: 20px; }
  .summary .stat { display: flex; flex-direction: column; gap: 5px; padding: 11px 16px; border-right: 1px solid var(--line); }
  .summary .k { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .summary .v { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .summary .v.warnv { color: var(--warn); }
  .summary .v .t { color: var(--dim); font-weight: 400; }

  /* cross-fleet images overview */
  .fimg { margin-bottom: 14px; }
  .fimg .fhead { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); padding: 12px 16px; }
  .fimg .fhead .grow { flex: 1; }
  .fimg .hdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .fimg .hdot.local { background: var(--upd); }
  .fimg .hdot.agent { background: var(--ok); }
  .fimg .hname { font: 600 13px/1 var(--mono); letter-spacing: .04em; color: var(--hi); }
  .fimg .fstats { display: flex; align-items: center; gap: 0; }
  .fimg .fstats .stat { display: flex; flex-direction: column; gap: 5px; padding: 2px 16px; border-left: 1px solid var(--line); }
  .fimg .fstats .stat:first-child { border-left: 0; padding-left: 8px; }
  .fimg .fstats .k { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .fimg .fstats .v { font: 600 14px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .fimg .fstats .v.warnv { color: var(--warn); }
  .fimg .fstats .v .t { color: var(--dim); font-weight: 400; }
  .fimg .foff { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--bad); }

  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .toolbar .grow { flex: 1; }
  .filters { display: flex; gap: 2px; }
  .fchip { display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; background: transparent;
    border: 1px solid var(--line); color: var(--dim); cursor: pointer;
    font: 500 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .fchip:hover { color: var(--hi); border-color: var(--line2); }
  .fchip.on { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .fchip .fn { color: var(--dim); font-variant-numeric: tabular-nums; }
  .fchip.on .fn { color: var(--mid); }
  .pbtn { padding: 8px 13px; background: transparent; border: 1px solid var(--line); color: var(--mid);
    font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; cursor: pointer;
    white-space: nowrap; flex-shrink: 0; transition: color .1s, border-color .1s, background .1s; }
  .pbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .pbtn.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .pbtn.warn:hover { color: #06080d; background: var(--warn); border-color: var(--warn); }
  .pbtn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .pbtn.danger:hover { color: #fff; background: var(--bad); border-color: var(--bad); }
  .rm { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; background: transparent;
    border: 1px solid transparent; color: var(--dim); cursor: pointer; }
  .rm:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); background: var(--raised); }

  table { width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--line); }
  colgroup col.c-sel { width: 40px; }
  colgroup col.c-repo { width: 29%; }
  colgroup col.c-id { width: 12%; }
  colgroup col.c-size { width: 9%; }
  colgroup col.c-age { width: 9%; }
  colgroup col.c-use { width: 29%; }
  colgroup col.c-act { width: 7%; }
  th.sel, td.sel { padding-left: 16px; padding-right: 0; cursor: pointer; }
  /* box widgets overflow their narrow column; clip so no stray ellipsis mark shows */
  th:has(.ck), td:has(.ck), td:has(.rm) { text-overflow: clip; }
  td.sel:hover .ck { border-color: var(--mid); }
  .ck { display: inline-block; width: 15px; height: 15px; border: 1px solid var(--line2); cursor: pointer; vertical-align: middle; }
  .ck:hover { border-color: var(--mid); }
  .toolbar .seln { font: 600 12px/1 var(--mono); color: var(--upd); }
  .toolbar .selsz { font: 12px/1 var(--mono); color: var(--dim); margin-right: 4px; }
  .ck.on { background: var(--upd); border-color: var(--upd);
    -webkit-mask: none; box-shadow: inset 0 0 0 3px var(--panel); }
  tr.irow.sel td { background: color-mix(in srgb, var(--upd) 8%, transparent); }

  .selbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; padding: 11px 14px;
    border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line)); background: color-mix(in srgb, var(--upd) 7%, var(--panel)); }
  .selbar .seln { font: 600 12px/1 var(--mono); color: var(--upd); }
  .selbar .selsz { font: 12px/1 var(--mono); color: var(--dim); }
  .selbar .grow { flex: 1; }
  thead th { font: 600 10px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); }
  th.r, td.r { text-align: right; }
  tbody td { padding: 0 14px; height: 44px; border-bottom: 1px solid var(--line); font: 12.5px/1.3 var(--mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--raised); }
  td.repo { color: var(--hi); }
  td.repo .untag { color: var(--dim); }
  td.repo .extra { color: var(--dim); margin-left: 7px; font-size: 11px; }
  td.id, td.size, td.age { color: var(--mid); font-variant-numeric: tabular-nums; }
  tr.irow { cursor: pointer; }
  td.usedby { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--mid); }
  .ucount { color: var(--mid); }
  .ub { display: inline-block; font: 12px/1 var(--mono); color: var(--mid); border: 1px solid var(--line); padding: 5px 8px; margin: 0 6px 6px 0; cursor: pointer; }
  .ub:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ub .ubp { color: var(--dim); }
  .ubmore { color: var(--dim); }

  /* image detail modal */
  .dmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  .dbox { width: 600px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); }
  .dhead { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line); }
  .dhead .dt { font: 600 14px/1.2 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dhead .grow { flex: 1; }
  .dx { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .dx:hover { color: var(--hi); }
  .dfacts { display: flex; border-bottom: 1px solid var(--line); }
  .dfacts .st { display: flex; flex-direction: column; gap: 5px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .dfacts .sk { font: 600 9px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .dfacts .sv { font: 600 14px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  .dbody { padding: 6px 18px 12px; }
  .drow { display: flex; gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .drow:last-child { border-bottom: 0; }
  .drow.top { align-items: flex-start; }
  .dk { flex: 0 0 84px; font: 600 10px/1.8 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .dv { flex: 1; min-width: 0; font: 12.5px/1.6 var(--mono); color: var(--hi); display: flex; flex-wrap: wrap; align-items: center; }
  .dv.mono { font-family: var(--mono); }
  .dv .dim { color: var(--dim); }
  .tagchip { font: 12px/1 var(--mono); color: var(--hi); border: 1px solid var(--line); padding: 5px 8px; margin: 0 6px 6px 0; }
  .dacts { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .dacts .grow { flex: 1; }
  .dnote { font: 11px/1.4 var(--mono); color: var(--warn); max-width: 360px; }
  .empty { padding: 40px; text-align: center; color: var(--dim); border: 1px solid var(--line); }

  /* registries manager modal */
  .rbox { width: 620px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); }
  .rsub { padding: 10px 18px; border-bottom: 1px solid var(--line); font: 11px/1.5 var(--mono); color: var(--dim); }
  .rlist { max-height: 40vh; overflow-y: auto; }
  .rrow { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
  .rrow:last-child { border-bottom: 0; }
  .rrow .rmain { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .rrow .rserver { font: 600 13px/1 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rrow .rmeta { font: 11px/1 var(--mono); color: var(--dim); }
  .rrow .rmeta .nopw { color: var(--warn); }
  .rempty { padding: 26px 18px; text-align: center; color: var(--dim); font: 12px/1.5 var(--mono); border-bottom: 1px solid var(--line); }
  .rform { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 16px 18px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .rform .rf { display: flex; flex-direction: column; gap: 5px; }
  .rform .rf.full { grid-column: 1 / -1; }
  .rform label { font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .rform input { background: var(--ink); border: 1px solid var(--line); color: var(--hi); font: 12.5px/1 var(--mono); padding: 10px 11px; }
  .rform input:focus { outline: none; border-color: var(--line2); }
  .rform .rf.act { grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 12px; }
  .rform .rf.act .grow { flex: 1; }
  .rform hope-select { display: block; }
  .rform .rserverpreview { background: var(--ink); border: 1px dashed var(--line2); color: var(--mid);
    font: 12.5px/1 var(--mono); padding: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rform .rnote { font: 11.5px/1.6 var(--mono); color: var(--dim); padding: 10px 12px; border: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 40%, transparent); }
  .rform .rnote.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
    background: color-mix(in srgb, var(--warn) 7%, transparent); }
`)
export class ImagesPage extends ResourcePage<ImageInfo> {
  // Streams (prune/redeploy) + cross-host ops target hosts explicitly.
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(ImageDetailService) accessor imageDetail!: ImageDetailService;

  @rpc(System, "images", { eager: false }) accessor singleQ!: ApiState<ImageInfo[]>;
  @rpc(System, "fleetImages", { eager: false }) accessor fleetQ!: ApiState<FleetImagesHost[]>;

  @reactive accessor filter: Filter = "all";

  // Registries manager (modal). hope is the fleet's registry-auth authority:
  // creds added here apply to the local daemon and every connected agent, and
  // persist (encrypted) when a state db is mounted. Config-defined registries
  // are read-only.
  @reactive accessor showRegs = false;

  @watch("showRegs") private lockRegs() { signalModal(this, this.showRegs); }
  @unmount private releaseRegs() { signalModal(this, false); }
  @reactive accessor regs: RegistryView[] = [];
  @reactive accessor regBusy = false;
  @reactive accessor rServer = "";
  @reactive accessor rUser = "";
  @reactive accessor rPass = "";
  @reactive accessor rPreset = ""; // selected known-registry id (quick-pick)
  @reactive accessor rParts: Record<string, string> = {}; // per-account server parts (ECR/GAR)

  private openRegs = async () => {
    this.showRegs = true;
    await this.loadRegs();
  };
  private closeRegs = () => {
    this.showRegs = false;
    this.rServer = this.rUser = this.rPass = this.rPreset = "";
    this.rParts = {};
  };

  // Pick a known registry from the dropdown: prefill the server + fixed username
  // and switch the field hints. Empty id = custom (clears the prefilled server).
  private selectPreset = (id: string) => {
    this.rPreset = id;
    this.rParts = {};
    this.rUser = ""; // don't carry a previous preset's fixed username (e.g. _json_key) over
    const k = KNOWN_REGISTRIES.find((x) => x.id === id);
    if (!k) {
      this.rServer = "";
      return;
    }
    this.rServer = k.build ? k.build({}) : k.server;
    if (k.fixedUser) this.rUser = k.fixedUser;
  };

  // The already-configured registry matching a known preset's server (if any),
  // so the picker can flag it and we can block re-adding a read-only config one.
  private configuredFor(k: KnownRegistry): RegistryView | undefined {
    if (k.build) return undefined; // per-account server (ECR/GAR) — can't pre-match
    return this.regs.find((r) => r.server === k.server);
  }

  // Update a per-account server part (ECR/GAR) and recompute the server from it.
  private setPart = (k: KnownRegistry, key: string, val: string) => {
    this.rParts = { ...this.rParts, [key]: val.trim() };
    if (k.build) this.rServer = k.build(this.rParts);
  };
  private loadRegs = async () => {
    try {
      this.regs = (await this.rpc.call<RegistryView[]>("System", "registries", [])) || [];
    } catch (err: any) {
      this.toast.error(`load registries — ${err?.message ?? "failed"}`);
    }
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

  // Selection key — the same image id can exist on multiple hosts in the all
  // view, so key by host+id, not id alone.
  protected key = (i: ImageInfo & { host?: string }) => (i.host ? i.host + "|" : "") + i.id;

  protected refresh() {
    void (this.fleetMode ? this.fleetQ : this.singleQ).refetch();
  }
  protected loading() {
    return this.fleetMode ? this.fleetQ.loading : this.singleQ.loading;
  }
  private err() {
    return (this.fleetMode ? this.fleetQ.error : this.singleQ.error)?.message ?? "";
  }

  // Active-host list or, in fleet mode, every host's images flattened + tagged
  // (biggest-first so hosts interleave and heavy images surface).
  protected items(): (ImageInfo & { host?: string })[] {
    if (this.fleetMode) {
      const out: (ImageInfo & { host?: string })[] = [];
      for (const h of this.fleetQ.data || []) {
        if (!h.online) continue;
        for (const i of h.images || []) out.push({ ...i, tags: i.tags || [], used_by: i.used_by || [], host: h.id });
      }
      out.sort((a, b) => b.size - a.size);
      return out;
    }
    return (this.singleQ.data || []).map((i) => ({ ...i, tags: i.tags || [], used_by: i.used_by || [] }));
  }

  protected visible(): (ImageInfo & { host?: string })[] {
    const q = this.query.trim().toLowerCase();
    return this.items().filter((i) => {
      if (this.filter === "used" && !i.in_use) return false;
      if (this.filter === "unused" && i.in_use) return false;
      if (this.filter === "dangling" && !i.dangling) return false;
      if (q && !(i.tags.join(" ") + " " + i.id).toLowerCase().includes(q)) return false;
      return true;
    });
  }


  private removeImg = async (i: ImageInfo & { host?: string }) => {
    const label = i.tags[0] || shortId(i.id);
    const ok = await this.confirm.ask({
      title: "remove image",
      danger: true,
      confirmLabel: "Remove",
      message: i.in_use ? `${label} is referenced by a container — it'll be force-removed.` : `Remove ${label}.`,
      stats: [
        { label: "image", value: label },
        ...(i.host ? [{ label: "host", value: i.host }] : []),
        { label: "frees", value: bytes(i.size) },
      ],
    });
    if (!ok) return;
    try {
      // In the all-hosts view the row belongs to a specific host — target it.
      await this.rpc.callOn(i.host || "", "System", "removeImage", [i.id, true]);
      this.toast.ok(`removed ${label}`);
      this.refresh();
    } catch (err: any) {
      this.toast.error(`remove ${label} — ${err?.message ?? "failed"}`);
    }
  };

  private prune = async (all: boolean) => {
    const targets = this.items().filter((i) => (all ? !i.in_use : i.dangling));
    const est = targets.reduce((a, i) => a + i.size, 0);
    const ok = await this.confirm.ask({
      title: all ? "prune unused images" : "prune dangling images",
      danger: true,
      confirmLabel: "Prune",
      message: all
        ? "Remove every image no container is using. They'll need re-pulling to use again."
        : "Remove all dangling (untagged) images.",
      stats: [
        { label: all ? "unused" : "dangling", value: String(targets.length) },
        { label: "reclaims up to", value: "~" + bytes(est) },
      ],
    });
    if (!ok) return;
    await this.proc.run(all ? "pruning unused images" : "pruning dangling images", async (emit, signal) => {
      let okv = true;
      for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "pruneImages", [String(all)], signal)) {
        if (f.type === "log" && f.data) emit(f.data);
        else if (f.type === "done") okv = f.ok;
      }
      return okv;
    });
    this.refresh();
  };

  // Consume a redeploy stream into the proc dialog (shared by the cleanup ops).
  private async pipeStream(emit: (l: string) => void, signal: AbortSignal, method: string, args: string[], host?: string): Promise<boolean> {
    let ok = true;
    for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", method, args, signal, host)) {
      if (f.type === "log" && f.data) emit("  " + f.data);
      else if (f.type === "done" && !f.ok) {
        ok = false;
        emit("  failed: " + (f.error ?? ""));
      }
    }
    return ok;
  }


  // Cross-fleet prune: run the prune stream on every connected host in turn,
  // piping each host's output into the shared processing dialog.
  private pruneFleet = async (all: boolean) => {
    // Estimate reclaimable space per host from the combined fleet image list.
    const targets = this.items().filter((i) => (all ? !i.in_use : i.dangling));
    const byHost = new Map<string, { n: number; size: number }>();
    for (const i of targets) {
      const h = (i as ImageInfo & { host?: string }).host || "local";
      const e = byHost.get(h) || { n: 0, size: 0 };
      e.n++;
      e.size += i.size;
      byHost.set(h, e);
    }
    const stats = [...byHost.entries()].map(([h, e]) => ({ label: h, value: `${e.n} · ~${bytes(e.size)}` }));
    const total = targets.reduce((a, i) => a + i.size, 0);
    if (byHost.size > 1) stats.push({ label: "total", value: `${targets.length} · ~${bytes(total)}` });
    const ok = await this.confirm.ask({
      title: all ? "prune unused — all hosts" : "prune dangling — all hosts",
      danger: all,
      warn: !all,
      confirmLabel: "Prune",
      message: `Prune ${all ? "all unused" : "dangling"} images across every connected host.`,
      stats,
    });
    if (!ok) return;
    const hosts = ((await this.rpc.call<{ id: string; connected: boolean }[]>("System", "hosts", [])) || []).filter((h) => h.connected);
    await this.proc.run(all ? "prune unused — all hosts" : "prune dangling — all hosts", async (emit, signal) => {
      let okv = true;
      for (const h of hosts) {
        emit(`> ${h.id}`);
        try {
          for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "pruneImages", [String(all)], signal, h.id)) {
            if (f.type === "log" && f.data) emit("  " + f.data);
            else if (f.type === "done" && !f.ok) { okv = false; emit("  failed: " + (f.error ?? "")); }
          }
        } catch (e: any) {
          okv = false;
          emit("  " + (e?.message ?? "failed"));
        }
      }
      emit("done");
      return okv;
    });
    this.refresh();
  };

  // Cross-fleet redeploy & prune: per host, redeploy containers pinning a
  // dangling image, then prune dangling — frees in-use dangling images too.
  private redeployAndPruneFleet = async () => {
    // Estimate per host from the dangling images in the combined fleet list.
    const targets = this.items().filter((i) => i.dangling);
    const byHost = new Map<string, { n: number; size: number }>();
    for (const i of targets) {
      const h = (i as ImageInfo & { host?: string }).host || "local";
      const e = byHost.get(h) || { n: 0, size: 0 };
      e.n++;
      e.size += i.size;
      byHost.set(h, e);
    }
    const stats = [...byHost.entries()].map(([h, e]) => ({ label: h, value: `${e.n} · ~${bytes(e.size)}` }));
    const total = targets.reduce((a, i) => a + i.size, 0);
    if (byHost.size > 1) stats.push({ label: "total", value: `${targets.length} · ~${bytes(total)}` });
    const ok = await this.confirm.ask({
      title: "redeploy & prune — all hosts",
      warn: true,
      confirmLabel: "Run",
      message: "On every connected host: redeploy each container pinning a dangling image, then prune dangling images.",
      stats,
    });
    if (!ok) return;
    const hosts = ((await this.rpc.call<{ id: string; connected: boolean }[]>("System", "hosts", [])) || []).filter((h) => h.connected);
    await this.proc.run("redeploy & prune — all hosts", async (emit, signal) => {
      let okv = true;
      for (const h of hosts) {
        emit(`> ${h.id}`);
        try {
          const byId = new Map<string, any>();
          for (const i of this.items().filter((i) => i.host === h.id && i.dangling && i.used_by.length)) {
            for (const u of i.used_by) byId.set(u.id, u);
          }
          for (const u of byId.values()) {
            emit("  redeploy " + (u.project ? u.project + "/" : "") + (u.service || u.name || shortId(u.id)));
            if (!(await this.pipeStream(emit, signal, "redeploy", [u.id], h.id))) okv = false;
          }
          emit("  prune dangling");
          if (!(await this.pipeStream(emit, signal, "pruneImages", ["false"], h.id))) okv = false;
        } catch (e: any) {
          okv = false;
          emit("  " + (e?.message ?? "failed"));
        }
      }
      emit("done");
      return okv;
    });
    this.refresh();
  };

  private selImages(): (ImageInfo & { host?: string })[] {
    return this.items().filter((i) => this.selected.includes(this.key(i)));
  }

  private removeSelected = async () => {
    const imgs = this.selImages();
    if (!imgs.length) return;
    const free = imgs.reduce((a, i) => a + i.size, 0);
    const ok = await this.confirm.ask({
      title: "remove selected",
      danger: true,
      confirmLabel: "Remove",
      message: "Force-remove the selected images. In-use ones are deleted from under their containers.",
      stats: [
        { label: "images", value: String(imgs.length) },
        { label: "frees up to", value: "~" + bytes(free) },
      ],
    });
    if (!ok) return;
    await this.proc.run("removing selected images", async (emit) => {
      let okv = true;
      for (const i of imgs) {
        const label = (i.host ? i.host + " / " : "") + (i.tags[0] || shortId(i.id));
        try {
          await this.rpc.callOn(i.host || "", "System", "removeImage", [i.id, true]);
          emit("removed " + label);
        } catch (err: any) {
          emit("skip " + label + " — " + (err?.message ?? "failed"));
          okv = false;
        }
      }
      emit("done");
      return okv;
    });
    this.selected = [];
    this.refresh();
  };

  private redeployFreeSelected = async () => {
    const imgs = this.selImages();
    const users = [...new Map(imgs.flatMap((i) => i.used_by).map((u) => [u.id, u])).values()];
    if (!users.length) {
      this.removeSelected();
      return;
    }
    const ok = await this.confirm.ask({
      title: "redeploy & free selected",
      warn: true,
      confirmLabel: "Run",
      message: "Redeploy the containers using the selected images onto their current tags, then remove the freed images.",
      stats: [
        { label: "redeploys", value: String(users.length) },
        { label: "images", value: String(imgs.length) },
      ],
    });
    if (!ok) return;
    await this.proc.run("redeploy & free selected", async (emit, signal) => {
      let okv = true;
      for (const u of users) {
        emit("> redeploy " + (u.project ? u.project + "/" : "") + (u.service || u.name || shortId(u.id)));
        if (!(await this.pipeStream(emit, signal, "redeploy", [u.id]))) okv = false;
      }
      for (const i of imgs) {
        const label = i.tags[0] || shortId(i.id);
        try {
          await this.rpc.call("System", "removeImage", [i.id, false]);
          emit("removed " + label);
        } catch (err: any) {
          emit("skip " + label + " — " + (err?.message ?? "still referenced"));
        }
      }
      emit("done");
      return okv;
    });
    this.selected = [];
    this.refresh();
  };

  // One-shot cleanup: redeploy every container pinning a dangling image (moves
  // them onto current tags), then prune all dangling images — freeing the ones
  // that were stuck "in use".
  private redeployAndPrune = async () => {
    const stuck = this.items().filter((i) => i.dangling && i.used_by.length);
    const byId = new Map<string, ImageInfo["used_by"][number]>();
    for (const i of stuck) for (const u of i.used_by) byId.set(u.id, u);
    const users = [...byId.values()];
    const free = this.items().filter((i) => i.dangling).reduce((a, i) => a + i.size, 0);
    const ok = await this.confirm.ask({
      title: "redeploy & prune",
      warn: true,
      confirmLabel: "Run",
      message: "Redeploy every container pinning a dangling image, then prune all dangling images.",
      stats: [
        { label: "redeploys", value: String(users.length) },
        { label: "frees up to", value: "~" + bytes(free) },
      ],
    });
    if (!ok) return;
    await this.proc.run("redeploy & prune", async (emit, signal) => {
      let okv = true;
      for (const u of users) {
        emit("> redeploy " + (u.project ? u.project + "/" : "") + (u.service || u.name || shortId(u.id)));
        if (!(await this.pipeStream(emit, signal, "redeploy", [u.id]))) okv = false;
      }
      emit("> prune dangling");
      if (!(await this.pipeStream(emit, signal, "pruneImages", ["false"]))) okv = false;
      emit("done");
      return okv;
    });
    this.refresh();
  };

  private renderRegForm() {
    const preset = KNOWN_REGISTRIES.find((k) => k.id === this.rPreset);
    const cfg = preset ? this.configuredFor(preset) : undefined;
    const blocked = !!cfg && !cfg.editable; // config-sourced -> read-only, can't shadow it
    return (
      <div class="rform">
        <div class="rf full">
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
            {preset.parts.map((p) => (
              <div class="rf">
                <label>{p.label}</label>
                <input type="text" placeholder={p.placeholder} autocomplete="off" value={this.rParts[p.key] || ""} onInput={(e: any) => this.setPart(preset, p.key, e.target.value)} />
              </div>
            ))}
            <div class="rf full">
              <label>Registry server</label>
              <div class="rserverpreview">{this.rServer}</div>
            </div>
          </>
        ) : (
          <div class="rf full">
            <label>Registry server</label>
            <input type="text" placeholder="registry.example.com" value={this.rServer} onInput={(e: any) => { this.rServer = e.target.value; }} />
          </div>
        )}
        <div class="rf">
          <label>Username</label>
          <input type="text" placeholder={preset ? preset.user : "username"} autocomplete="off" value={this.rUser} onInput={(e: any) => (this.rUser = e.target.value)} />
        </div>
        <div class="rf">
          <label>Password / token</label>
          <input type="password" placeholder={preset ? preset.pass : "password or access token"} autocomplete="new-password" value={this.rPass} onInput={(e: any) => (this.rPass = e.target.value)} />
        </div>
        {preset ? <div class="rf full"><div class="rnote">{preset.note}</div></div> : null}
        {cfg ? (
          <div class="rf full">
            <div class={"rnote" + (blocked ? " warn" : "")}>
              {blocked
                ? `${cfg.server} is already configured from config (read-only) — remove it there to change it.`
                : `${cfg.server} is already added — saving updates its stored credentials.`}
            </div>
          </div>
        ) : null}
        <div class="rf act">
          <span class="grow"></span>
          <button class="pbtn" disabled={this.regBusy || blocked} onClick={this.addReg}>{this.regBusy ? "adding…" : blocked ? "read-only" : cfg ? "update registry" : "add registry"}</button>
        </div>
      </div>
    );
  }

  private renderRegs() {
    return (
      <div class="dmodal" onClick={this.closeRegs}>
        <div class="rbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt">registries</span>
            <span class="grow"></span>
            <button class="dx" onClick={this.closeRegs}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="rsub">Credentials for private image pulls. hope authenticates these on the local daemon and every connected agent. Config-defined entries are read-only.</div>
          <div class="rlist">
            {this.regs.length ? (
              this.regs.map((r) => (
                <div class="rrow">
                  <div class="rmain">
                    <span class="rserver" title={r.server}>{r.server}</span>
                    <span class="rmeta">
                      {r.username || <span class="dim">no user</span>}
                      {r.has_password ? null : <span class="nopw"> · no password</span>}
                    </span>
                  </div>
                  <hope-chip tone={r.editable ? "ok" : ""} size="sm">{r.source}</hope-chip>
                  {r.editable ? (
                    <button class="rm" title="remove registry" onClick={() => this.removeReg(r)}><loom-icon name="x" size={14}></loom-icon></button>
                  ) : null}
                </div>
              ))
            ) : (
              <div class="rempty">No registries configured. Add one below to pull private images.</div>
            )}
          </div>
          {this.renderRegForm()}
        </div>
      </div>
    );
  }

  // Cross-fleet images overview: a section per host with its counts; "manage"
  // drills into that host's full images page (filters, prune, selection).
  update() {
    const vis = this.visible();
    const total = this.items().reduce((a, i) => a + i.size, 0);
    const danglingImgs = this.items().filter((i) => i.dangling);
    const unusedImgs = this.items().filter((i) => !i.in_use);
    const dangling = danglingImgs.length;
    const unused = unusedImgs.length;
    const danglingSize = danglingImgs.reduce((a, i) => a + i.size, 0);
    const unusedSize = unusedImgs.reduce((a, i) => a + i.size, 0);

    return (
      <div>
        {appBar("images", [
          <div class="s act"><button style="display:inline-flex;align-items:center;gap:6px" onClick={this.openRegs}><loom-icon name="plus" size={12}></loom-icon> registries</button></div>,
        ], { onRefresh: () => this.refresh(), refreshing: this.loading() })}

        <main>
          {this.err() ? <div class="empty">{this.err()}</div> : null}

          {this.items().length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">images</i><i class="v">{this.items().length}</i></span>
              <span class="stat"><i class="k">total size</i><i class="v">{bytes(total)}</i></span>
              {unused > 0 ? <span class="stat"><i class="k">unused</i><i class="v warnv">{unused}<i class="t"> · {bytes(unusedSize)}</i></i></span> : null}
              {dangling > 0 ? <span class="stat"><i class="k">dangling</i><i class="v warnv">{dangling}<i class="t"> · {bytes(danglingSize)}</i></i></span> : null}
            </div>
          ) : null}

          {this.items().length > 0 ? (
            <div class="toolbar">
              <div class="filters">
                {(["all", "used", "unused", "dangling"] as Filter[]).map((f) => (
                  <button class={"fchip" + (this.filter === f ? " on" : "")} onClick={() => (this.filter = f)}>
                    {f}
                    <span class="fn">{f === "all" ? this.items().length : this.items().filter((i) => (f === "used" ? i.in_use : f === "unused" ? !i.in_use : i.dangling)).length}</span>
                  </button>
                ))}
              </div>
              <div class="grow"></div>
              {this.selected.length > 0 ? (
                <>
                  <span class="seln">{this.selected.length} selected</span>
                  <span class="selsz">~{bytes(this.selImages().reduce((a, i) => a + i.size, 0))}</span>
                  {!this.fleetMode && this.selImages().some((i) => i.used_by.length) ? <hope-button tone="warn" onClick={this.redeployFreeSelected}>redeploy &amp; free</hope-button> : null}
                  <hope-button tone="danger" onClick={this.removeSelected}>remove</hope-button>
                  <hope-button onClick={this.clearSel}>clear</hope-button>
                </>
              ) : this.fleetMode ? (
                <>
                  {this.items().some((i) => i.dangling && i.used_by.length) ? <hope-button tone="warn" onClick={this.redeployAndPruneFleet}>redeploy &amp; prune · all</hope-button> : null}
                  {dangling > 0 ? <hope-button onClick={() => this.pruneFleet(false)}>prune dangling · all</hope-button> : null}
                  {unused > 0 ? <hope-button tone="danger" onClick={() => this.pruneFleet(true)}>prune unused · all</hope-button> : null}
                </>
              ) : (
                <>
                  {this.items().some((i) => i.dangling && i.used_by.length) ? <hope-button tone="warn" onClick={this.redeployAndPrune}>redeploy &amp; prune</hope-button> : null}
                  {dangling > 0 ? <hope-button onClick={() => this.prune(false)}>prune dangling</hope-button> : null}
                  {unused > 0 ? <hope-button tone="danger" onClick={() => this.prune(true)}>prune unused</hope-button> : null}
                </>
              )}
            </div>
          ) : null}

          {this.items().length > 0 ? (
            <hope-search placeholder="Search image tags and ids…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
          ) : null}

          {vis.length > 0 ? (
            <table>
              <colgroup>
                <col class="c-sel" />
                <col class="c-repo" />
                <col class="c-id" />
                <col class="c-size" />
                <col class="c-age" />
                <col class="c-use" />
                <col class="c-act" />
              </colgroup>
              <thead>
                <tr>
                  <th class="sel"><span class={"ck" + (this.removable().length > 0 && this.removable().every((i) => this.selected.includes(this.key(i))) ? " on" : "")} onClick={this.selectAllVisible}></span></th>
                  <th>Repository</th>
                  <th>Image ID</th>
                  <th class="r">Size</th>
                  <th>Age</th>
                  <th>Used by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {vis.map((i) => (
                  <tr class={"irow" + (this.selected.includes(this.key(i)) ? " sel" : "")} onClick={() => this.imageDetail.open({ host: i.host, ref: i.id, onChange: () => this.refresh() })}>
                    {i.used_by.length ? (
                      <td class="sel"></td>
                    ) : (
                      <td class="sel" onClick={(e: Event) => this.toggleSel(this.key(i), e)}>
                        <span class={"ck" + (this.selected.includes(this.key(i)) ? " on" : "")}></span>
                      </td>
                    )}
                    <td class="repo" title={i.tags.join(", ")}>
                      {i.host ? <hope-chip host={true} title={i.host}>{i.host}</hope-chip> : null}
                      {i.tags.length ? i.tags[0] : <span class="untag">&lt;untagged&gt;</span>}
                      {i.tags.length > 1 ? <span class="extra">+{i.tags.length - 1}</span> : null}
                    </td>
                    <td class="id">{shortId(i.id)}</td>
                    <td class="size r">{bytes(i.size)}</td>
                    <td class="age">{age(i.created)}</td>
                    <td class="usedby">
                      {i.used_by.length ? (
                        <span class="ucount">
                          {i.used_by[0].service || i.used_by[0].name || shortId(i.used_by[0].id)}
                          {i.used_by.length > 1 ? <span class="ubmore"> +{i.used_by.length - 1}</span> : null}
                        </span>
                      ) : i.dangling ? (
                        <hope-chip tone="warn" size="sm">dangling</hope-chip>
                      ) : (
                        <hope-chip size="sm">unused</hope-chip>
                      )}
                    </td>
                    <td class="r">
                      {i.in_use ? null : (
                      <button class="rm" title="remove image" onClick={(e: Event) => { e.stopPropagation(); this.removeImg(i); }}>
                        <loom-icon name="x" size={14}></loom-icon>
                      </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : !this.loading() && !this.err() ? (
            <div class="empty">{this.query ? "No images match." : "No images on this daemon."}</div>
          ) : null}
        </main>
        {this.showRegs ? this.renderRegs() : null}
      </div>
    );
  }
}

function age(unix: number): string {
  if (!unix) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  const d = Math.floor(s / 86400);
  if (d >= 1) return d >= 365 ? `${Math.floor(d / 365)}y` : d >= 30 ? `${Math.floor(d / 30)}mo` : `${d}d`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.floor(s / 60)}m`;
}
