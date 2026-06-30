// Images — every local image on the daemon, cleanly: repo:tag, id, size, age,
// and whether it's in use or dangling. Sorted largest first.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { ConfirmService } from "../confirm";
import { ProcService } from "../proc";
import type { ImageInfo, PruneResult, OpFrame, FleetImagesHost } from "../contracts";
import { theme } from "../styles";

type Filter = "all" | "used" | "unused" | "dangling";

@route("/images")
@component("hope-images")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--ink); }

  .bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink); }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
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

  main { padding: 24px 24px 64px; max-width: 1120px; margin: 0 auto; }

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
  .toast { position: fixed; right: 22px; bottom: 22px; z-index: 60; background: var(--raised);
    border: 1px solid var(--line2); color: var(--hi); font: 500 12px/1.4 var(--mono); padding: 11px 15px; max-width: 420px; }
  .toast.bad { border-color: var(--bad); color: var(--bad); }

  .search { position: relative; margin-bottom: 18px; }
  .search input { width: 100%; background: var(--panel); border: 1px solid var(--line); color: var(--hi);
    font: 13px/1 var(--mono); padding: 11px 12px 11px 38px; }
  .search input::placeholder { color: var(--dim); }
  .search input:focus { outline: none; border-color: var(--line2); }
  .search .ico { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--dim); display: flex; }

  table { width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--line); }
  colgroup col.c-sel { width: 40px; }
  colgroup col.c-repo { width: 29%; }
  colgroup col.c-id { width: 12%; }
  colgroup col.c-size { width: 9%; }
  colgroup col.c-age { width: 9%; }
  colgroup col.c-use { width: 29%; }
  colgroup col.c-act { width: 7%; }
  th.sel, td.sel { padding-left: 16px; padding-right: 0; cursor: pointer; }
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
  .chip { font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 3px 7px;
    border: 1px solid var(--line2); color: var(--mid); }
  .chip.use { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .chip.dang { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .empty { padding: 40px; text-align: center; color: var(--dim); border: 1px solid var(--line); }
  .repo .htag { display: inline-flex; justify-content: center; align-items: center; min-width: 78px; box-sizing: border-box;
    margin-right: 11px; vertical-align: middle;
    font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim);
    padding: 4px 7px; border: 1px solid var(--line); border-radius: 5px; white-space: nowrap; }
`)
export class ImagesPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ProcService) accessor proc!: ProcService;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor images: (ImageInfo & { host?: string })[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor busy = false;
  @reactive accessor filter: Filter = "all";
  @reactive accessor toast = "";
  @reactive accessor toastKind = "";
  @reactive accessor detail: ImageInfo | null = null;
  @reactive accessor selected: string[] = [];
  @reactive accessor fleet: FleetImagesHost[] | null = null; // cross-host images ("all hosts")

  // "all hosts" is the same client-side view flag the dashboard uses.
  get fleetMode() {
    return localStorage.getItem("hope.fleet") === "1";
  }

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
  }

  // All hosts' images flattened into one combined, host-tagged list, so the
  // normal table + filters + search work across the whole fleet.
  private loadFleet = async () => {
    this.busy = true;
    try {
      const hosts = (await this.rpc.call<FleetImagesHost[]>("System", "fleetImages", [])) || [];
      const combined: (ImageInfo & { host?: string })[] = [];
      for (const h of hosts) {
        if (!h.online) continue;
        for (const i of h.images || []) combined.push({ ...i, tags: i.tags || [], used_by: i.used_by || [], host: h.id });
      }
      // Sort biggest-first so hosts interleave (otherwise it's all of host A
      // then all of host B) and the heavy images surface for cleanup.
      combined.sort((a, b) => b.size - a.size);
      this.images = combined;
      this.error = "";
      this.loaded = true;
    } catch (err: any) {
      this.error = err?.message ?? "Can't list images.";
    } finally {
      this.busy = false;
    }
  };

  private load = async () => {
    if (this.fleetMode) return this.loadFleet();
    this.busy = true;
    try {
      const list = await this.rpc.call<ImageInfo[]>("System", "images", []);
      // Go nil slices arrive as JSON null — normalize tags + used_by to arrays.
      this.images = (list || []).map((i) => ({ ...i, tags: i.tags || [], used_by: i.used_by || [] }));
      this.error = "";
      this.loaded = true;
    } catch (err: any) {
      this.error = err?.message ?? "Can't list images.";
    } finally {
      this.busy = false;
    }
  };

  private visible(): (ImageInfo & { host?: string })[] {
    const q = this.query.trim().toLowerCase();
    return this.images.filter((i) => {
      if (this.filter === "used" && !i.in_use) return false;
      if (this.filter === "unused" && i.in_use) return false;
      if (this.filter === "dangling" && !i.dangling) return false;
      if (q && !(i.tags.join(" ") + " " + i.id).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  private showToast(msg: string, kind = "") {
    this.toast = msg;
    this.toastKind = kind;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = ""), 3500);
  }
  private toastTimer: any = 0;

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
      if (i.host) await this.rpc.call("System", "setActiveHost", [i.host]);
      await this.rpc.call("System", "removeImage", [i.id, true]);
      this.showToast(`removed ${label}`);
      await this.load();
    } catch (err: any) {
      this.showToast(`remove ${label} — ${err?.message ?? "failed"}`, "bad");
    }
  };

  private prune = async (all: boolean) => {
    const targets = this.images.filter((i) => (all ? !i.in_use : i.dangling));
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
    await this.load();
  };

  // Consume a redeploy stream into the proc dialog (shared by the cleanup ops).
  private async pipeStream(emit: (l: string) => void, signal: AbortSignal, method: string, args: string[]): Promise<boolean> {
    let ok = true;
    for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", method, args, signal)) {
      if (f.type === "log" && f.data) emit("  " + f.data);
      else if (f.type === "done" && !f.ok) {
        ok = false;
        emit("  failed: " + (f.error ?? ""));
      }
    }
    return ok;
  }

  // ---- selection ----
  // Selection key — the same image id can exist on multiple hosts in the all
  // view, so key by host+id, not id alone.
  private imgKey = (i: ImageInfo & { host?: string }) => (i.host ? i.host + "|" : "") + i.id;
  private toggleSel = (key: string, e: Event) => {
    e.stopPropagation();
    this.selected = this.selected.includes(key) ? this.selected.filter((x) => x !== key) : [...this.selected, key];
  };
  private clearSel = () => (this.selected = []);

  // Cross-fleet prune: run the prune stream on every connected host in turn,
  // piping each host's output into the shared processing dialog.
  private pruneFleet = async (all: boolean) => {
    const ok = await this.confirm.ask({
      title: all ? "prune unused — all hosts" : "prune dangling — all hosts",
      danger: all,
      warn: !all,
      confirmLabel: "Prune",
      message: `Prune ${all ? "all unused" : "dangling"} images across every connected host.`,
    });
    if (!ok) return;
    const hosts = ((await this.rpc.call<{ id: string; connected: boolean }[]>("System", "hosts", [])) || []).filter((h) => h.connected);
    await this.proc.run(all ? "prune unused — all hosts" : "prune dangling — all hosts", async (emit, signal) => {
      let okv = true;
      for (const h of hosts) {
        emit(`> ${h.id}`);
        try {
          await this.rpc.call("System", "setActiveHost", [h.id]);
          for await (const f of this.rpc.streamWithSignal<OpFrame>("Stream", "pruneImages", [String(all)], signal)) {
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
    await this.load();
  };

  // Cross-fleet redeploy & prune: per host, redeploy containers pinning a
  // dangling image, then prune dangling — frees in-use dangling images too.
  private redeployAndPruneFleet = async () => {
    const ok = await this.confirm.ask({
      title: "redeploy & prune — all hosts",
      warn: true,
      confirmLabel: "Run",
      message: "On every connected host: redeploy each container pinning a dangling image, then prune dangling images.",
    });
    if (!ok) return;
    const hosts = ((await this.rpc.call<{ id: string; connected: boolean }[]>("System", "hosts", [])) || []).filter((h) => h.connected);
    await this.proc.run("redeploy & prune — all hosts", async (emit, signal) => {
      let okv = true;
      for (const h of hosts) {
        emit(`> ${h.id}`);
        try {
          await this.rpc.call("System", "setActiveHost", [h.id]);
          const byId = new Map<string, any>();
          for (const i of this.images.filter((i) => i.host === h.id && i.dangling && i.used_by.length)) {
            for (const u of i.used_by) byId.set(u.id, u);
          }
          for (const u of byId.values()) {
            emit("  redeploy " + (u.project ? u.project + "/" : "") + (u.service || u.name || shortId(u.id)));
            if (!(await this.pipeStream(emit, signal, "redeploy", [u.id]))) okv = false;
          }
          emit("  prune dangling");
          if (!(await this.pipeStream(emit, signal, "pruneImages", ["false"]))) okv = false;
        } catch (e: any) {
          okv = false;
          emit("  " + (e?.message ?? "failed"));
        }
      }
      emit("done");
      return okv;
    });
    await this.load();
  };

  // Only images with no containers using them are selectable for bulk removal.
  private removable = () => this.visible().filter((i) => !i.used_by.length);
  private selectAllVisible = (e: Event) => {
    e.stopPropagation();
    const keys = this.removable().map((i) => this.imgKey(i));
    const allSel = keys.length > 0 && keys.every((k) => this.selected.includes(k));
    this.selected = allSel ? this.selected.filter((k) => !keys.includes(k)) : Array.from(new Set([...this.selected, ...keys]));
  };
  private selImages(): (ImageInfo & { host?: string })[] {
    return this.images.filter((i) => this.selected.includes(this.imgKey(i)));
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
          if (i.host) await this.rpc.call("System", "setActiveHost", [i.host]);
          await this.rpc.call("System", "removeImage", [i.id, true]);
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
    await this.load();
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
    await this.load();
  };

  // One-shot cleanup: redeploy every container pinning a dangling image (moves
  // them onto current tags), then prune all dangling images — freeing the ones
  // that were stuck "in use".
  private redeployAndPrune = async () => {
    const stuck = this.images.filter((i) => i.dangling && i.used_by.length);
    const byId = new Map<string, ImageInfo["used_by"][number]>();
    for (const i of stuck) for (const u of i.used_by) byId.set(u.id, u);
    const users = [...byId.values()];
    const free = this.images.filter((i) => i.dangling).reduce((a, i) => a + i.size, 0);
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
    await this.load();
  };

  // Redeploy every container using this image so they move onto their current
  // tag — which frees the old (often untagged) image to be removed.
  private redeployUsers = async (i: ImageInfo) => {
    const users = i.used_by;
    if (!users.length) return;
    const ok = await this.confirm.ask({
      title: "redeploy & free",
      warn: true,
      confirmLabel: "Redeploy",
      message: "Redeploy each container onto its current image tag. That recreates them and frees this old image.",
      stats: [{ label: "containers", value: String(users.length) }],
    });
    if (!ok) return;
    this.detail = null;
    await this.proc.run("redeploying containers", async (emit, signal) => {
      let okv = true;
      for (const u of users) {
        emit("> " + (u.project ? u.project + "/" : "") + (u.service || u.name || shortId(u.id)));
        if (!(await this.pipeStream(emit, signal, "redeploy", [u.id]))) okv = false;
      }
      emit("done — the old image is now free; remove it from the list");
      return okv;
    });
    await this.load();
  };

  private renderDetail(i: ImageInfo & { host?: string }) {
    const title = i.tags.length ? i.tags[0] : "<untagged>";
    return (
      <div class="dmodal" onClick={() => (this.detail = null)}>
        <div class="dbox" onClick={(e: Event) => e.stopPropagation()}>
          <div class="dhead">
            <span class="dt" title={title}>{title}</span>
            <span class="grow"></span>
            <button class="dx" onClick={() => (this.detail = null)}><loom-icon name="x" size={15}></loom-icon></button>
          </div>
          <div class="dfacts">
            {i.host ? <span class="st"><i class="sk">host</i><i class="sv">{i.host}</i></span> : null}
            <span class="st"><i class="sk">size</i><i class="sv">{bytes(i.size)}</i></span>
            <span class="st"><i class="sk">age</i><i class="sv">{age(i.created)}</i></span>
            <span class="st"><i class="sk">status</i><i class="sv">{i.in_use ? "in use" : i.dangling ? "dangling" : "unused"}</i></span>
            <span class="st"><i class="sk">containers</i><i class="sv">{i.used_by.length}</i></span>
          </div>
          <div class="dbody">
            <div class="drow"><span class="dk">id</span><span class="dv mono">{shortId(i.id)}</span></div>
            <div class="drow"><span class="dk">tags</span>
              <span class="dv">{i.tags.length ? i.tags.map((t) => <span class="tagchip">{t}</span>) : <span class="dim">untagged</span>}</span>
            </div>
            <div class="drow top"><span class="dk">used by</span>
              <span class="dv">
                {i.used_by.length ? (
                  i.used_by.map((u) => (
                    <span class="ub" onClick={() => { this.detail = null; this.router.navigate(`/container/${encodeURIComponent(u.id)}`); }}>
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
          <div class="dacts">
            {i.used_by.length ? <span class="dnote">in use — redeploy frees it cleanly; remove force-deletes it from under the containers</span> : null}
            <span class="grow"></span>
            {i.used_by.length ? <button class="pbtn warn" onClick={() => this.redeployUsers(i)}>redeploy {i.used_by.length} &amp; free</button> : null}
            <button class="pbtn danger" onClick={() => { const im = i; this.detail = null; this.removeImg(im); }}>remove</button>
          </div>
        </div>
      </div>
    );
  }

  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  // Cross-fleet images overview: a section per host with its counts; "manage"
  // drills into that host's full images page (filters, prune, selection).
  update() {
    const vis = this.visible();
    const total = this.images.reduce((a, i) => a + i.size, 0);
    const danglingImgs = this.images.filter((i) => i.dangling);
    const unusedImgs = this.images.filter((i) => !i.in_use);
    const dangling = danglingImgs.length;
    const unused = unusedImgs.length;
    const danglingSize = danglingImgs.reduce((a, i) => a + i.size, 0);
    const unusedSize = unusedImgs.reduce((a, i) => a + i.size, 0);

    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> {this.fleetMode ? "all hosts" : "fleet"}</span></div>
          <div class="s act"><hope-host-switch></hope-host-switch></div>
          <div class="s nav"><span class="navlink on" onClick={() => this.router.navigate("/images")}>images</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/networks")}>networks</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/volumes")}>volumes</span></div>
          <div class="s nav"><span class="navlink" onClick={() => this.router.navigate("/agents")}>agents</span></div>
          <div class="grow"></div>
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {this.images.length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">images</i><i class="v">{this.images.length}</i></span>
              <span class="stat"><i class="k">total size</i><i class="v">{bytes(total)}</i></span>
              {unused > 0 ? <span class="stat"><i class="k">unused</i><i class="v warnv">{unused}<i class="t"> · {bytes(unusedSize)}</i></i></span> : null}
              {dangling > 0 ? <span class="stat"><i class="k">dangling</i><i class="v warnv">{dangling}<i class="t"> · {bytes(danglingSize)}</i></i></span> : null}
            </div>
          ) : null}

          {this.images.length > 0 ? (
            <div class="toolbar">
              <div class="filters">
                {(["all", "used", "unused", "dangling"] as Filter[]).map((f) => (
                  <button class={"fchip" + (this.filter === f ? " on" : "")} onClick={() => (this.filter = f)}>
                    {f}
                    <span class="fn">{f === "all" ? this.images.length : this.images.filter((i) => (f === "used" ? i.in_use : f === "unused" ? !i.in_use : i.dangling)).length}</span>
                  </button>
                ))}
              </div>
              <div class="grow"></div>
              {this.selected.length > 0 ? (
                <>
                  <span class="seln">{this.selected.length} selected</span>
                  <span class="selsz">~{bytes(this.selImages().reduce((a, i) => a + i.size, 0))}</span>
                  {!this.fleetMode && this.selImages().some((i) => i.used_by.length) ? <button class="pbtn warn" onClick={this.redeployFreeSelected}>redeploy &amp; free</button> : null}
                  <button class="pbtn danger" onClick={this.removeSelected}>remove</button>
                  <button class="pbtn" onClick={this.clearSel}>clear</button>
                </>
              ) : this.fleetMode ? (
                <>
                  {this.images.some((i) => i.dangling && i.used_by.length) ? <button class="pbtn warn" onClick={this.redeployAndPruneFleet}>redeploy &amp; prune · all</button> : null}
                  {dangling > 0 ? <button class="pbtn" onClick={() => this.pruneFleet(false)}>prune dangling · all</button> : null}
                  {unused > 0 ? <button class="pbtn danger" onClick={() => this.pruneFleet(true)}>prune unused · all</button> : null}
                </>
              ) : (
                <>
                  {this.images.some((i) => i.dangling && i.used_by.length) ? <button class="pbtn warn" onClick={this.redeployAndPrune}>redeploy &amp; prune</button> : null}
                  {dangling > 0 ? <button class="pbtn" onClick={() => this.prune(false)}>prune dangling</button> : null}
                  {unused > 0 ? <button class="pbtn danger" onClick={() => this.prune(true)}>prune unused</button> : null}
                </>
              )}
            </div>
          ) : null}

          {this.images.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Search image tags and ids…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            </div>
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
                  <th class="sel"><span class={"ck" + (this.removable().length > 0 && this.removable().every((i) => this.selected.includes(this.imgKey(i))) ? " on" : "")} onClick={this.selectAllVisible}></span></th>
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
                  <tr class={"irow" + (this.selected.includes(this.imgKey(i)) ? " sel" : "")} onClick={() => (this.detail = i)}>
                    {i.used_by.length ? (
                      <td class="sel"></td>
                    ) : (
                      <td class="sel" onClick={(e: Event) => this.toggleSel(this.imgKey(i), e)}>
                        <span class={"ck" + (this.selected.includes(this.imgKey(i)) ? " on" : "")}></span>
                      </td>
                    )}
                    <td class="repo" title={i.tags.join(", ")}>
                      {i.host ? <span class="htag" title={i.host}>{i.host}</span> : null}
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
                        <span class="chip dang">dangling</span>
                      ) : (
                        <span class="chip">unused</span>
                      )}
                    </td>
                    <td class="r">
                      <button class="rm" title={i.in_use ? "force-remove (in use)" : "remove image"} onClick={(e: Event) => { e.stopPropagation(); this.removeImg(i); }}>
                        <loom-icon name="x" size={14}></loom-icon>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : this.loaded && !this.error ? (
            <div class="empty">{this.query ? "No images match." : "No images on this daemon."}</div>
          ) : null}
        </main>
        {this.toast ? <div class={"toast " + this.toastKind}>{this.toast}</div> : null}
        {this.detail ? this.renderDetail(this.detail) : null}
      </div>
    );
  }
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

function bytes(b: number): string {
  if (!b || b <= 0) return "0";
  const gb = b / 1073741824;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 2) + " GB";
  return (b / 1048576).toFixed(0) + " MB";
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
