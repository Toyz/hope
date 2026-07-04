// <hope-image-detail> — the image-detail modal, reusable from anywhere a
// container's image is shown (not just the Images page). Opened via
// ImageDetailService.open({ host, ref }): it fetches the image on that host
// (System.image, by id/tag/digest), shows where it came from (registry + repo
// digest) plus size/age/status/used-by, and offers remove / redeploy-and-free.
import { LoomElement, styles, css, reactive, watch, unmount, app } from "@toyz/loom";
import { clipboard } from "@toyz/loom/element";
import { signalModal } from "../modal";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { theme } from "../styles";
import { HopeTransport } from "../transport";
import { HostContext } from "../host-context";
import { withHost } from "../host-url";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { ProcService } from "../proc";
import type { ImageInfo, ImageLayer, OpFrame } from "../contracts";
import { bytes, shortId } from "../format";
import { redactCmd } from "../redact";
import type { ImageDetailOpts } from "./image-detail";

@styles(theme, css`
  :host { display: contents; }
  .dmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .dbox { width: 620px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); }
  .dhead { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line); }
  .dhead .dt { font: 600 14px/1.2 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dhead .grow { flex: 1; }
  .dx { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .dx:hover { color: var(--hi); }
  .dfacts { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .dfacts .st { display: flex; flex-direction: column; gap: 5px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .dfacts .sk { font: 600 9px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .dfacts .sv { font: 600 14px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  .dbody { padding: 6px 18px 12px; }
  .drow { display: flex; gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .drow:last-child { border-bottom: 0; }
  .drow.top { align-items: flex-start; }
  .dk { flex: 0 0 84px; font: 600 10px/1.8 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .dv { flex: 1; min-width: 0; font: 12.5px/1.6 var(--mono); color: var(--hi); display: flex; flex-wrap: wrap; align-items: center; }
  .dv.brk { word-break: break-all; display: block; }
  .dv .dim { color: var(--dim); }
  .reg { display: inline-flex; align-items: center; gap: 7px; }
  .reg .rico { color: var(--dim); display: inline-flex; }
  .tagchip { font: 12px/1 var(--mono); color: var(--hi); border: 1px solid var(--line); padding: 5px 8px; margin: 0 6px 6px 0; }
  .digest { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; margin: 0 0 6px; padding: 6px 9px;
    background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer;
    font: 11.5px/1 var(--mono); text-align: left; }
  .digest:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .digest .dgrepo { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .digest .dgsha { color: var(--hi); flex: none; }
  .digest:hover .dgrepo { color: var(--mid); }
  .digest loom-icon { color: var(--dim); flex: none; }
  .digest:hover loom-icon { color: var(--hi); }
  .ub { display: inline-block; font: 12px/1 var(--mono); color: var(--mid); border: 1px solid var(--line); padding: 5px 8px; margin: 0 6px 6px 0; cursor: pointer; }
  .ub:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ub .ubp { color: var(--dim); }
  .dacts { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .dacts .grow { flex: 1; }
  .dnote { font: 11px/1.4 var(--mono); color: var(--warn); max-width: 360px; }
  .pbtn { padding: 8px 13px; background: transparent; border: 1px solid var(--line); color: var(--mid);
    font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; cursor: pointer; white-space: nowrap; }
  .pbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .pbtn.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .pbtn.warn:hover { color: #06080d; background: var(--warn); border-color: var(--warn); }
  .pbtn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .pbtn.danger:hover { color: #fff; background: var(--bad); border-color: var(--bad); }
  .dstate { padding: 30px 18px; text-align: center; color: var(--dim); font: 12.5px/1.5 var(--mono); }
  .dstate.err { color: var(--bad); }

  /* build history / layers */
  .lyloading { padding: 12px 18px; border-top: 1px solid var(--line); font: 11.5px/1 var(--mono); color: var(--dim); }
  .layers { border-top: 1px solid var(--line); }
  .lyhead { display: flex; align-items: center; gap: 10px; padding: 11px 18px 9px; }
  .lyhead .lyt { font: 600 10px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .lyhead .lyn { font: 12px/1 var(--mono); color: var(--mid); font-variant-numeric: tabular-nums; }
  .lyhead .grow { flex: 1; }
  .lybtn { background: transparent; border: 1px solid var(--line); color: var(--dim); cursor: pointer;
    font: 500 10px/1 var(--mono); letter-spacing: .06em; padding: 5px 9px; }
  .lybtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .lybtn.armed { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .lybtn.armed:hover { color: #06080d; background: var(--warn); border-color: var(--warn); }
  .lylist { max-height: 34vh; overflow: auto; border-top: 1px solid var(--line); }
  .lyrow { display: grid; grid-template-columns: 72px 74px 1fr; align-items: center; gap: 12px;
    padding: 9px 18px; border-bottom: 1px solid var(--line); }
  .lyrow:last-child { border-bottom: 0; }
  .lyrow.meta { opacity: .62; }
  .lyrow .lysz { font: 600 12px/1 var(--mono); color: var(--hi); text-align: right; font-variant-numeric: tabular-nums; }
  .lyrow.meta .lysz { color: var(--dim); }
  .lyrow .lybar { height: 5px; background: var(--line); overflow: hidden; }
  .lyrow .lybar i { display: block; height: 100%; background: var(--upd); }
  .lyrow.meta .lybar { visibility: hidden; }
  .lyrow .lycmd { font: 12px/1.5 var(--mono); color: var(--mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`)
export default class ImageDetailModal extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(ProcService) accessor proc!: ProcService;

  @reactive accessor open = false;
  @reactive accessor loading = false;
  @reactive accessor info: ImageInfo | null = null;
  @reactive accessor host = "";
  @reactive accessor error = "";
  @reactive accessor layers: ImageLayer[] | null = null;
  @reactive accessor showMeta = false; // include 0-byte metadata layers
  @reactive accessor revealLayers = false; // unmask secrets in build steps
  private onChange?: () => void;

  @watch("open") private lockBody() { signalModal(this, this.open); }
  @unmount private releaseBody() { signalModal(this, false); }

  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  // Called by ImageDetailService.open — fetch the image on its host and show.
  async show(o: ImageDetailOpts) {
    this.host = o.host || "";
    this.onChange = o.onChange;
    this.open = true;
    this.info = null;
    this.layers = null;
    this.error = "";
    this.loading = true;
    try {
      this.info = await this.rpc.callOn<ImageInfo>(this.host, "System", "image", [o.ref]);
    } catch (e: any) {
      this.error = e?.message ?? "failed to load image";
    } finally {
      this.loading = false;
    }
    // Layers load in the background — the header/detail shouldn't wait on them.
    if (this.info) {
      try {
        this.layers = await this.rpc.callOn<ImageLayer[]>(this.host, "System", "imageHistory", [this.info.id]);
      } catch {
        this.layers = [];
      }
    }
  }

  private close = () => {
    this.open = false;
    this.info = null;
    this.layers = null;
    this.error = "";
  };

  private refetch = async () => {
    if (!this.info) return;
    try {
      this.info = await this.rpc.callOn<ImageInfo>(this.host, "System", "image", [this.info.id]);
    } catch {
      this.close(); // image is gone (removed) — nothing left to show
    }
  };

  // loom's declarative clipboard: the return value is what gets copied.
  @clipboard("write")
  private copyDigest(d: string) {
    this.toast.ok("digest copied");
    return d;
  }

  private gotoContainer = (id: string) => {
    const host = this.host || this.hostCtx.token;
    this.close();
    this.router.navigate(withHost(host, `/container/${encodeURIComponent(id)}`));
  };

  private removeImage = async () => {
    const i = this.info;
    if (!i) return;
    const label = i.tags[0] || shortId(i.id);
    const ok = await this.confirm.ask({
      title: "remove image",
      danger: true,
      confirmLabel: "Remove",
      message: i.in_use ? `${label} is referenced by a container — it'll be force-removed.` : `Remove ${label}.`,
      stats: [
        { label: "image", value: label },
        ...(this.host ? [{ label: "host", value: this.host }] : []),
        { label: "frees", value: bytes(i.size) },
      ],
    });
    if (!ok) return;
    try {
      await this.rpc.callOn(this.host, "System", "removeImage", [i.id, true]);
      this.toast.ok(`removed ${label}`);
      this.onChange?.();
      this.close();
    } catch (err: any) {
      this.toast.error(`remove ${label} — ${err?.message ?? "failed"}`);
    }
  };

  // Redeploy every container using this image onto its current tag, freeing the
  // old (often untagged) image so it can be removed cleanly.
  private redeployUsers = async () => {
    const i = this.info;
    if (!i || !i.used_by.length) return;
    const ok = await this.confirm.ask({
      title: "redeploy & free",
      warn: true,
      confirmLabel: "Redeploy",
      message: "Redeploy each container onto its current image tag. That recreates them and frees this old image.",
      stats: [{ label: "containers", value: String(i.used_by.length) }],
    });
    if (!ok) return;
    const users = i.used_by;
    const host = this.host;
    await this.proc.run("redeploying containers", async (emit, signal) => {
      let okv = true;
      for (const u of users) {
        emit("> " + (u.project ? u.project + "/" : "") + (u.service || u.name || shortId(u.id)));
        for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "redeploy", [u.id], signal, host)) {
          if (f.type === "log" && f.data) emit("  " + f.data);
          else if (f.type === "done" && !f.ok) { okv = false; emit("  failed: " + (f.error ?? "")); }
        }
      }
      emit("done — the old image is now free; remove it from the list");
      return okv;
    });
    this.onChange?.();
    await this.refetch();
  };

  // Build history — how the image was assembled, layer by layer, with per-layer
  // size bars (biggest layers are where the weight is). Metadata-only layers are
  // hidden behind a toggle; build steps mask secrets unless revealed.
  private renderLayers() {
    if (this.layers === null) return <div class="lyloading">loading layers…</div>;
    if (!this.layers.length) return null;
    const shown = this.showMeta ? this.layers : this.layers.filter((l) => !l.empty);
    const hidden = this.layers.length - shown.length;
    const max = Math.max(1, ...this.layers.map((l) => l.size));
    const total = this.layers.reduce((a, l) => a + l.size, 0);
    return (
      <div class="layers">
        <div class="lyhead">
          <span class="lyt">layers</span>
          <span class="lyn">{this.layers.length} · {bytes(total)}</span>
          <span class="grow"></span>
          {this.layers.some((l) => l.empty) ? (
            <button class="lybtn" onClick={() => (this.showMeta = !this.showMeta)}>{this.showMeta ? "hide metadata" : `show metadata (${hidden})`}</button>
          ) : null}
          <button class={"lybtn" + (this.revealLayers ? " armed" : "")} onClick={() => (this.revealLayers = !this.revealLayers)}>{this.revealLayers ? "hide secrets" : "reveal secrets"}</button>
        </div>
        <div class="lylist">
          {shown.map((l) => {
            const cmd = cleanLayer(l.created_by);
            return (
              <div class={"lyrow" + (l.empty ? " meta" : "")}>
                <span class="lysz">{l.size ? bytes(l.size) : "—"}</span>
                <span class="lybar"><i style={`width:${l.size ? Math.max(2, (l.size / max) * 100) : 0}%`}></i></span>
                <span class="lycmd" title={this.revealLayers ? cmd : redactCmd(cmd)}>{this.revealLayers ? cmd : redactCmd(cmd)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  update() {
    if (!this.open) return <div></div>;
    const i = this.info;
    const title = i ? (i.tags.length ? i.tags[0] : "<untagged>") : "image";
    return (
      <div class="dmodal" onClick={this.close}>
        <div class="dbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt" title={title}>{title}</span>
            <span class="grow"></span>
            <button class="dx" onClick={this.close}><loom-icon name="x" size={15}></loom-icon></button>
          </div>

          {this.loading ? (
            <div class="dstate">loading image…</div>
          ) : this.error || !i ? (
            <div class="dstate err">{this.error || "image not found on this host"}</div>
          ) : (
            <>
              <div class="dfacts">
                {this.host ? <span class="st"><i class="sk">host</i><i class="sv">{this.host}</i></span> : null}
                <span class="st"><i class="sk">size</i><i class="sv">{bytes(i.size)}</i></span>
                <span class="st"><i class="sk">age</i><i class="sv">{age(i.created)}</i></span>
                <span class="st"><i class="sk">status</i><i class="sv">{i.in_use ? "in use" : i.dangling ? "dangling" : "unused"}</i></span>
                <span class="st"><i class="sk">containers</i><i class="sv">{i.used_by.length}</i></span>
              </div>
              <div class="dbody">
                <div class="drow"><span class="dk">source</span>
                  <span class="dv">
                    {i.registry ? (
                      <span class="reg"><span class="rico"><loom-icon name="box" size={13}></loom-icon></span>{i.registry}</span>
                    ) : (
                      <span class="dim">local only — no registry</span>
                    )}
                  </span>
                </div>
                <div class="drow"><span class="dk">id</span><span class="dv mono">{shortId(i.id)}</span></div>
                <div class="drow"><span class="dk">tags</span>
                  <span class="dv">{i.tags.length ? i.tags.map((t) => <span class="tagchip">{t}</span>) : <span class="dim">untagged</span>}</span>
                </div>
                {i.digests && i.digests.length ? (
                  <div class="drow top"><span class="dk">digest</span>
                    <span class="dv brk">
                      {i.digests.map((d) => {
                        const at = d.lastIndexOf("@");
                        const repo = at > 0 ? d.slice(0, at) : "";
                        const sha = at > 0 ? d.slice(at + 1) : d;
                        return (
                          <button class="digest" title={`${d}\nclick to copy`} onClick={() => this.copyDigest(d)}>
                            {repo ? <span class="dgrepo">{repo}</span> : null}
                            <span class="dgsha">{shortSha(sha)}</span>
                            <loom-icon name="copy" size={11}></loom-icon>
                          </button>
                        );
                      })}
                    </span>
                  </div>
                ) : null}
                <div class="drow top"><span class="dk">used by</span>
                  <span class="dv">
                    {i.used_by.length ? (
                      i.used_by.map((u) => (
                        <span class="ub" onClick={() => this.gotoContainer(u.id)}>
                          {u.project ? <span class="ubp">{u.project} / </span> : null}
                          {u.service || u.name || shortId(u.id)}
                        </span>
                      ))
                    ) : (
                      <span class="dim">nothing — safe to remove</span>
                    )}
                  </span>
                </div>
              </div>
              {this.renderLayers()}
              <div class="dacts">
                {i.used_by.length ? <span class="dnote">in use — redeploy frees it cleanly; remove force-deletes it from under the containers</span> : null}
                <span class="grow"></span>
                {i.used_by.length ? <button class="pbtn warn" onClick={this.redeployUsers}>redeploy {i.used_by.length} &amp; free</button> : null}
                <button class="pbtn danger" onClick={this.removeImage}>remove</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
}

// cleanLayer turns a raw history CreatedBy into something that reads like the
// Dockerfile line that produced it: buildkit/legacy shells and the "#(nop)"
// metadata marker are stripped, and a bare shell command is shown as RUN.
function cleanLayer(s: string): string {
  if (!s) return "";
  let c = s.replace(/^\|\d+\s+/, ""); // buildkit ARG count prefix
  c = c.replace(/^\/bin\/sh\s+-c\s+#\(nop\)\s*/, ""); // metadata op → "ENV ...", "CMD ..."
  if (/^\/bin\/sh\s+-c\s+/.test(c)) c = "RUN " + c.replace(/^\/bin\/sh\s+-c\s+/, ""); // real RUN
  return c.trim();
}

// shortSha trims a digest hash to sha256:<first 12 hex> for a readable chip; the
// full value is still copied and shown on hover.
function shortSha(sha: string): string {
  const m = /^sha256:([0-9a-f]{12})/.exec(sha);
  return m ? `sha256:${m[1]}` : sha;
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
