// <hope-image-inspector> — the docked bottom panel for an image, opened from an
// images-page row (like the container inspector, not a modal). Three columns:
// identity (id / digest / source / size), the layer breakdown (docker history
// with per-layer size bars — where the weight is), and used-by / also-pulled
// across the fleet. Build steps can leak secrets (ARG/ENV/RUN --token=…), so they
// are masked until the operator arms reveal. Actions: redeploy-&-free, remove.
import { LoomElement, component, styles, css, reactive, mount, unmount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { consumeOpStream } from "../stream-op";
import { ImageInspector } from "../image-inspector";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { ProcService } from "../proc";
import { ImageInspectorTarget, withRefresh } from "../events";
import { redactCmd } from "../redact";
import { withHost } from "../host-url";
import { UNGROUPED } from "../const";
import { bytes, shortId, ageUnix as age } from "../format";
import type { ImageInfo, ImageLayer, ImageUser, OpFrame } from "../contracts";
import { theme } from "../styles";

@component("hope-image-inspector")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }

  .bar { display: flex; align-items: stretch; height: 38px; flex: none; border-bottom: 1px solid var(--line); }
  .who { display: flex; align-items: center; gap: 9px; padding: 0 15px; border-right: 1px solid var(--line); min-width: 0; }
  .who loom-icon { color: var(--dim); flex: none; }
  .who .nm { font: 700 12.5px/1 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who .sub { color: var(--dim); font: 500 10px/1 var(--mono); flex: none; }
  .grow { flex: 1; }
  .acts { display: flex; align-items: stretch; border-left: 1px solid var(--line); }
  .pa { display: inline-flex; align-items: center; gap: 6px; padding: 0 13px; background: transparent; border: 0; color: var(--dim); cursor: pointer; font: 500 11px/1 var(--mono); letter-spacing: .04em; }
  .pa:hover { color: var(--hi); background: var(--raised); }
  .pa.iconly { padding: 0; width: 40px; justify-content: center; }
  .pa.caution { color: var(--warn); }
  .pa.caution.armed { color: var(--bad); }
  .pa.warn:hover { color: var(--warn); }
  .pa.danger:hover { color: var(--bad); }
  .pa:disabled { opacity: .4; cursor: default; }

  .body { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-columns: minmax(320px, 34%) minmax(0, 1fr); }
  .col { min-width: 0; min-height: 0; overflow-y: auto; border-right: 1px solid var(--line); }
  .col:last-child { border-right: 0; }
  .ctitle { display: flex; align-items: center; gap: 8px; padding: 13px 15px 9px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .ctitle.sep { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 13px; }
  .ubs { display: flex; flex-wrap: wrap; gap: 7px; padding: 2px 15px 14px; }
  .ctitle .grow { flex: 1; }
  .cbtn { background: transparent; border: 0; color: var(--dim); cursor: pointer; font: 600 9px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .cbtn:hover { color: var(--hi); }
  .cbtn.armed { color: var(--warn); }

  .row { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 12px; padding: 5px 15px; font: 12px/1.5 var(--mono); align-items: baseline; }
  .row .k { color: var(--dim); }
  .row .v { color: var(--hi); min-width: 0; word-break: break-all; }
  .row .v.dim { color: var(--dim); }
  .tag { display: inline-block; color: var(--hi); border: 1px solid var(--line2); padding: 2px 7px; margin: 0 5px 5px 0; font-size: 11.5px; }
  .digest { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 4px 8px; border: 1px solid var(--line); background: transparent; color: var(--mid); cursor: pointer; font: 11.5px/1 var(--mono); }
  .digest:hover { color: var(--hi); border-color: var(--line2); }
  .ub { display: inline-flex; align-items: baseline; gap: 0; padding: 5px 9px; background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer; font: 11.5px/1 var(--mono); }
  .ub:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ub .p { color: var(--dim); }

  /* layers — heaviest first (spot the fat layer), badge maps back to the build step */
  .lyhead { display: grid; grid-template-columns: 72px minmax(0, 1fr) 44px; gap: 12px; padding: 4px 15px 7px; border-bottom: 1px solid var(--line); }
  .lyhead span { font: 600 8.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .lyhead .r { text-align: right; }
  .lyrow { display: grid; grid-template-columns: 72px minmax(0, 1fr) 44px; gap: 12px; align-items: baseline; padding: 6px 15px; font: 11.5px/1.5 var(--mono); border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); cursor: pointer; }
  .lyrow:hover { background: var(--raised); }
  .lyrow.on { background: color-mix(in srgb, var(--upd) 10%, transparent); }
  .lyrow.meta { color: var(--dim); }
  /* click-to-expand layer details drawer */
  .lyexp { padding: 8px 15px 12px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); background: color-mix(in srgb, var(--upd) 5%, transparent); }
  .lyexp .lek { font: 600 8.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
  .lyexp .lecmd { margin: 0 0 10px; padding: 8px 10px; background: var(--ink); border: 1px solid var(--line); color: var(--hi); font: 11.5px/1.6 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
  .lyexp .lefacts { display: flex; flex-wrap: wrap; gap: 8px 22px; }
  .lyexp .lefacts span { display: inline-flex; align-items: baseline; gap: 7px; font: 12px/1.5 var(--mono); color: var(--hi); }
  .lyexp .lefacts i { font-style: normal; font: 600 9px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .lysz { color: var(--mid); font-variant-numeric: tabular-nums; text-align: right; }
  .lysz.heavy { color: var(--hi); font-weight: 600; }
  .lycmd { color: var(--mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .lycmdtip { min-width: 0; overflow: hidden; } /* keep the clipped command ellipsizing inside the tooltip wrapper */
  .lycmdtip .lycmd { display: block; width: 100%; }
  .lyrow.meta .lycmd { color: var(--dim); }
  .lybadge { text-align: right; color: var(--dim); font: 600 10px/1.5 var(--mono); font-variant-numeric: tabular-nums; }
  .empty { padding: 18px 15px; color: var(--dim); font: 12px/1.4 var(--mono); }
`)
export class HopeImageInspector extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(ImageInspector) accessor insp!: ImageInspector;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(ProcService) accessor proc!: ProcService;

  @reactive accessor host = "";
  @reactive accessor ref = "";
  @reactive accessor info: ImageInfo | null = null;
  @reactive accessor layers: ImageLayer[] | null = null;
  @reactive accessor error = "";
  @reactive accessor reveal = false;   // unmask secrets in build steps
  @reactive accessor showMeta = false;  // include 0-byte metadata layers
  @reactive accessor laySort: "step" | "size" = "step"; // layer order: build step | heaviest first
  @reactive accessor busy = false;
  @reactive accessor openLayer = ""; // expanded layer (by step key), for the details drawer

  @mount
  onMount() { this.host = this.insp.host; this.ref = this.insp.ref; this.load(); }

  @unmount
  onUnmount() {}

  @on(ImageInspectorTarget)
  private onTarget(e: ImageInspectorTarget) {
    if (!e.ref || (e.ref === this.ref && e.host === this.host)) return;
    this.host = e.host; this.ref = e.ref;
    this.info = null; this.layers = null; this.error = ""; this.reveal = false; this.showMeta = false; this.openLayer = "";
    this.load();
  }

  private async load() {
    if (!this.ref) return;
    const host = this.host, ref = this.ref;
    try {
      const info = await this.rpc.callOn<ImageInfo>(host, "System", "image", [ref]);
      if (host !== this.host || ref !== this.ref) return; // switched image mid-flight
      this.info = info; this.error = "";
      try {
        const layers = await this.rpc.callOn<ImageLayer[]>(host, "System", "imageHistory", [info.id]);
        if (host === this.host && ref === this.ref) this.layers = layers;
      } catch { if (host === this.host && ref === this.ref) this.layers = []; }
    } catch (e: any) {
      if (host !== this.host || ref !== this.ref) return;
      this.error = e?.message ?? "image not found on this host";
      this.info = null;
    }
  }

  private copyDigest(d: string) { navigator.clipboard?.writeText(d).catch(() => {}); this.toast.ok("digest copied"); }
  // Open the container in the NEW docked flow (/stack/:host/:project/:id), never
  // the deprecated standalone container page.
  private gotoContainer(u: ImageUser) {
    this.insp.close();
    const project = u.project || UNGROUPED;
    app.get(LoomRouter).navigate(withHost(this.host, `/stack/${encodeURIComponent(project)}/${encodeURIComponent(u.id)}`));
  }

  private removeImage = async () => {
    const i = this.info;
    if (!i || this.busy) return;
    const label = i.tags[0] || shortId(i.id);
    const ok = await this.confirm.ask({
      title: "remove image",
      danger: true,
      confirmLabel: "Remove",
      message: i.used_by.length ? `${label} is used by ${i.used_by.length} container(s) — it'll be force-removed from under them.` : `Remove ${label}.`,
    });
    if (!ok) return;
    this.busy = true;
    try {
      await withRefresh(async () => { await this.rpc.callOn(this.host, "System", "removeImage", [i.id, true]); });
      this.toast.ok(`removed ${label}`);
      this.insp.onChange?.();
      this.insp.close();
    } catch (e: any) {
      this.toast.error(`remove — ${e?.message ?? "failed"}`);
    } finally {
      this.busy = false;
    }
  };

  private redeployUsers = async () => {
    const i = this.info;
    if (!i || this.busy || !i.used_by.length) return;
    this.busy = true;
    try {
      await this.proc.run(`redeploy ${i.used_by.length} & free`, async (emit, signal) => {
        let ok = true;
        for (const u of i.used_by) {
          emit(`redeploying ${u.service || u.name || shortId(u.id)}…`);
          if (!(await consumeOpStream(this.rpc.streamWithSignal<OpFrame>("Stream", "redeploy", [u.id], signal, this.host), emit))) ok = false;
        }
        emit("done");
        return ok;
      });
      this.insp.onChange?.();
      this.load();
    } catch (e: any) {
      this.toast.error(`redeploy — ${e?.message ?? "failed"}`);
    } finally {
      this.busy = false;
    }
  };

  private renderLayers() {
    if (this.layers === null) return <div class="col"><div class="ctitle">layers</div><div class="empty">loading&hellip;</div></div>;
    if (!this.layers.length) return <div class="col"><div class="ctitle">layers</div><div class="empty">no layer history</div></div>;
    // Tag each layer with its build-step number, then show heaviest first so the
    // weight is obvious; the badge maps back to where it sits in the Dockerfile.
    const n = this.layers.length;
    const withIdx = this.layers.map((l, idx) => ({ l, step: n - idx })); // history is newest-first → step counts up from the base
    const shown = this.showMeta ? withIdx : withIdx.filter((x) => !x.l.empty);
    const list = shown.slice().sort((a, b) => (this.laySort === "size" ? b.l.size - a.l.size : a.step - b.step));
    const hidden = withIdx.length - withIdx.filter((x) => !x.l.empty).length;
    const total = this.layers.reduce((a, l) => a + l.size, 0);
    const max = Math.max(1, ...this.layers.map((l) => l.size));
    return (
      <div class="col">
        <div class="ctitle">
          layers &middot; {this.layers.length} &middot; {bytes(total)}
          <span class="grow"></span>
          <button class="cbtn" onClick={() => (this.laySort = this.laySort === "step" ? "size" : "step")}>sort: {this.laySort === "step" ? "layer" : "size"}</button>
          {hidden > 0 ? <button class="cbtn" onClick={() => (this.showMeta = !this.showMeta)}>{this.showMeta ? "hide meta" : `+${hidden} meta`}</button> : null}
        </div>
        <div class="lyhead"><span>size</span><span>build step</span><span class="r">layer</span></div>
        {list.map(({ l, step }) => {
          const cmd = cleanLayer(l.created_by) || (l.empty ? "(metadata)" : "");
          const text = this.reveal ? cmd : redactCmd(cmd);
          const heavy = l.size >= max * 0.5 && l.size > 0;
          const key = String(step);
          const open = this.openLayer === key;
          return (
            <>
              <div class={"lyrow" + (l.empty ? " meta" : "") + (open ? " on" : "")} onClick={() => (this.openLayer = open ? "" : key)}>
                <span class={"lysz" + (heavy ? " heavy" : "")}>{l.size ? bytes(l.size) : "—"}</span>
                <hope-tip class="lycmdtip" text={text} pos="top"><span class="lycmd">{text}</span></hope-tip>
                <span class="lybadge">{l.empty ? "meta" : "L" + step}</span>
              </div>
              {open ? (
                <div class="lyexp">
                  <div class="lek">command</div>
                  <pre class="lecmd">{text || "(none)"}</pre>
                  <div class="lefacts">
                    <span><i>size</i>{l.size ? bytes(l.size) : "0 B"}</span>
                    {l.created ? <span><i>created</i>{age(l.created)}</span> : null}
                    <span><i>layer</i>{l.empty ? "metadata (0 B)" : "L" + step}</span>
                    {l.comment ? <span><i>comment</i>{l.comment}</span> : null}
                    {l.id ? <span><i>id</i><code>{shortId(l.id)}</code></span> : null}
                  </div>
                </div>
              ) : null}
            </>
          );
        })}
      </div>
    );
  }

  update() {
    if (!this.ref) return <div class="empty">Select an image.</div>;
    const i = this.info;
    const title = i ? (i.tags.length ? i.tags[0].split(":")[0] : "<untagged>") : "image";
    const tagPart = i && i.tags.length && i.tags[0].includes(":") ? ":" + i.tags[0].split(":").slice(1).join(":") : "";
    return (
      <>
        <div class="bar">
          <div class="who">
            <loom-icon name="box" size={14}></loom-icon>
            <span class="nm">{title}</span>
            <span class="sub">{tagPart}{i ? ` · ${shortId(i.id)}` : ""}</span>
          </div>
          <span class="grow"></span>
          <div class="acts">
            <hope-tip text={this.reveal ? "hide secrets" : "reveal secrets (build steps)"} pos="bottom-end">
              <button class={"pa iconly caution" + (this.reveal ? " armed" : "")} onClick={() => (this.reveal = !this.reveal)}><loom-icon name={this.reveal ? "x" : "alert"} size={14}></loom-icon></button>
            </hope-tip>
            {i && i.used_by.length ? <hope-tip text="redeploy &amp; free" pos="bottom-end"><button class="pa iconly warn" disabled={this.busy} onClick={this.redeployUsers}><loom-icon name="redeploy" size={14}></loom-icon></button></hope-tip> : null}
            <hope-tip text="remove image" pos="bottom-end"><button class="pa iconly danger" disabled={this.busy} onClick={this.removeImage}><loom-icon name="trash" size={14}></loom-icon></button></hope-tip>
            <hope-tip text="close" pos="bottom-end"><button class="pa iconly" onClick={() => this.insp.close()}><loom-icon name="x" size={15}></loom-icon></button></hope-tip>
          </div>
        </div>

        {this.error || !i ? (
          <div class="empty">{this.error || "loading image…"}</div>
        ) : (
          <div class="body">
            <div class="col">
              <div class="ctitle">identity</div>
              <div class="row"><span class="k">id</span><span class="v">{shortId(i.id)}</span></div>
              <div class="row"><span class="k">size</span><span class="v">{bytes(i.size)}</span></div>
              <div class="row"><span class="k">age</span><span class="v">{age(i.created)}</span></div>
              <div class="row"><span class="k">status</span><span class="v">{i.in_use ? "in use" : i.dangling ? "dangling" : "unused"}</span></div>
              <div class="row"><span class="k">source</span>{i.registry ? <span class="v">{i.registry}</span> : <span class="v dim">local only</span>}</div>
              <div class="row"><span class="k">tags</span><span class="v">{i.tags.length ? i.tags.map((t) => <span class="tag">{t}</span>) : <span class="dim">untagged</span>}</span></div>
              {i.digests && i.digests.length ? (
                <div class="row"><span class="k">digest</span><span class="v">{i.digests.map((d) => { const at = d.lastIndexOf("@"); const sha = at > 0 ? d.slice(at + 1) : d; return <hope-tip text={d} pos="top-end"><button class="digest" onClick={() => this.copyDigest(d)}>{shortSha(sha)}<loom-icon name="copy" size={11}></loom-icon></button></hope-tip>; })}</span></div>
              ) : null}
              <div class="ctitle sep">used by &middot; {i.used_by.length}</div>
              {i.used_by.length ? (
                <div class="ubs">{i.used_by.map((u) => <button class="ub" onClick={() => this.gotoContainer(u)}>{u.project ? <span class="p">{u.project} / </span> : null}{u.service || u.name || shortId(u.id)}</button>)}</div>
              ) : <div class="empty">nothing uses it — safe to remove</div>}
            </div>

            {this.renderLayers()}
          </div>
        )}
      </>
    );
  }
}

// cleanLayer normalizes a docker-history created_by line into a readable step.
function cleanLayer(s: string): string {
  if (!s) return "";
  let c = s.replace(/^\|\d+\s+/, ""); // buildkit ARG-count prefix
  c = c.replace(/\s+#\s*buildkit\s*$/, ""); // buildkit marker suffix
  c = c.replace(/^(?:RUN\s+)?\/bin\/sh\s+-c\s+#\(nop\)\s*/, ""); // metadata op → "ENV …", "CMD …"
  c = c.replace(/^(?:RUN\s+)?\/bin\/sh\s+-c\s+/, "RUN "); // real RUN (classic + buildkit "RUN /bin/sh -c")
  return c.trim();
}

function shortSha(sha: string): string {
  const m = /^sha256:([0-9a-f]{12})/.exec(sha);
  return m ? `sha256:${m[1]}` : sha;
}

