// Images — every local image on the daemon, cleanly: repo:tag, id, size, age,
// and whether it's in use or dangling. Sorted largest first.
import { component, styles, css, reactive, watch, unmount, prop, mount, query, on } from "@toyz/loom";
import type { HopeRegistries } from "../components/registries";
import { signalModal } from "../modal";
import { inject } from "@toyz/loom/di";
import { route } from "@toyz/loom/router";
import { rpc } from "@toyz/loom-rpc";
import type { ApiState } from "@toyz/loom/query";
import { ResourcePage } from "./resource-page";
import { HopeTransport } from "../transport";
import { ImageInspector } from "../image-inspector";
import { ImageInspectorTarget } from "../events";
import { System } from "../contracts";
import type { ImageInfo, OpFrame, FleetImagesHost } from "../contracts";
import { bytes, shortId } from "../format";
import { theme } from "../styles";

type Filter = "all" | "used" | "unused" | "dangling";

@route("/images/:host")
@route("/images/:host/:id")
@component("hope-images")
@styles(theme, css`
  :host { display: block; min-height: 100%; background: var(--ink); }

  /* ── signature: disk composition instrument ── */
  .disk { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 26px; align-items: center; padding: 20px 28px 18px; border-bottom: 1px solid var(--line); }
  .diskmain { min-width: 0; }
  .disktotal { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .disktotal .big { font: 600 26px/1 var(--mono); letter-spacing: .01em; color: var(--hi); }
  .disktotal .lbl { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .meter { display: flex; height: 8px; width: 100%; background: var(--line); overflow: hidden; }
  .meter i { display: block; height: 100%; }
  .meter .inuse { background: var(--upd); } .meter .unused { background: var(--faint); } .meter .dangling { background: var(--warn); }
  .legend { display: flex; gap: 22px; margin-top: 12px; flex-wrap: wrap; }
  .lg { display: flex; align-items: center; gap: 8px; font: 11.5px/1 var(--mono); color: var(--mid); }
  .lg .sw { width: 9px; height: 9px; flex: none; }
  .lg .sw.inuse { background: var(--upd); } .lg .sw.unused { background: var(--faint); } .lg .sw.dangling { background: var(--warn); }
  .lg b { color: var(--hi); font-weight: 600; } .lg .sz { color: var(--dim); }
  .reclaim { display: flex; flex-direction: column; gap: 7px; padding-left: 26px; border-left: 1px solid var(--line); text-align: right; }
  .reclaim .k { font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .reclaim .v { font: 600 22px/1 var(--mono); color: var(--warn); }
  .reclaim .sub { font: 11px/1 var(--mono); color: var(--dim); }

  /* ── filter + search ── */
  .vtools { display: flex; align-items: center; gap: 10px; padding: 12px 28px; border-bottom: 1px solid var(--line); }
  .vtools .grow { flex: 1; }
  .seg { display: flex; }
  .seg button { height: 28px; padding: 0 12px; background: transparent; border: 1px solid var(--line); border-right: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
  .seg button:last-child { border-right: 1px solid var(--line); }
  .seg button .n { color: var(--faint); font-variant-numeric: tabular-nums; }
  .seg button:hover { color: var(--mid); }
  .seg button.on { color: var(--hi); background: var(--raised); border-color: var(--line2); }
  .seg button.on .n { color: var(--mid); }
  .vtools hope-search { flex: 0 0 300px; max-width: 42%; }

  /* ── image rows (disk instrument) ── */
  .rows { padding-bottom: 24px; }
  .rhead, .irow { display: grid; grid-template-columns: minmax(0, 1.7fr) 128px 92px 64px minmax(0, 1fr) 34px; align-items: center; gap: 18px; padding: 0 28px; }
  .rhead { height: 36px; border-bottom: 1px solid var(--line); }
  .rhead span { font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .irow { height: 52px; border-bottom: 1px solid var(--line); cursor: pointer; position: relative; }
  .irow:hover { background: var(--raised); }
  .irow.on { background: color-mix(in srgb, var(--upd) 12%, transparent); }
  .irow.on::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--upd); }
  .repo { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .repo .hostchip { font: 9.5px/1.6 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--upd);
    border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line2)); padding: 2px 6px; flex: none; }
  .repo .tag { color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo .tag .untag { color: var(--dim); }
  .repo .more { color: var(--dim); font-size: 11px; flex: none; }
  .sizebar { display: flex; align-items: center; }
  .sizebar .track { flex: 1; height: 4px; background: var(--line); overflow: hidden; }
  .sizebar .track i { display: block; height: 100%; background: var(--mid); }
  .sizebar.big .track i { background: var(--upd); }
  .size { color: var(--mid); font-variant-numeric: tabular-nums; text-align: right; }
  .age { color: var(--dim); font-variant-numeric: tabular-nums; }
  .usedby { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .usedby .svc { color: var(--mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usedby .svc .proj { color: var(--dim); }
  .usedby .svc .extra { color: var(--dim); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--line2);
    font: 10px/1.6 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--dim); }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line2)); }
  .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .rmc { text-align: right; }
  .rm { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; background: transparent;
    border: 1px solid transparent; color: var(--dim); cursor: pointer; opacity: 0; }
  .irow:hover .rm { opacity: 1; }
  .rm:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--line2)); }

  /* image detail modal */
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

  /* registries manager modal — hosts the shared <hope-registries> component */
  .regsheet { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); animation: fade .12s ease both; }
  .regsheetbox { width: 720px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); border-top: 2px solid var(--upd); }
  .regsheethd { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line);
    font: 600 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--hi); }
  .regsheethd loom-icon { color: var(--upd); }
  .regsheethd .grow { flex: 1; }
  .regsheetx { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .regsheetx:hover { color: var(--hi); }
  .regsheetbd { padding: 8px 0 16px; overflow-y: auto; max-height: 78vh; }
`)
export class ImagesPage extends ResourcePage<ImageInfo> {
  // Streams (prune/redeploy) + cross-host ops target hosts explicitly.
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(ImageInspector) accessor imageInsp!: ImageInspector;

  @rpc(System, "images", { eager: false }) accessor singleQ!: ApiState<ImageInfo[]>;
  @rpc(System, "fleetImages", { eager: false }) accessor fleetQ!: ApiState<FleetImagesHost[]>;

  @reactive accessor filter: Filter = "all";
  // Optional trailing id: /images/:host/:id opens the docked image inspector for
  // that image (deep-linkable, and how a container's image field jumps here).
  @prop({ param: "id" }) accessor routeImage = "";

  // Fleet mode opens the inspector in place (no URL id), so mirror the docked
  // target off the bus to highlight the open row. Cleared when it closes.
  @reactive accessor inspHost = "";
  @reactive accessor inspRef = "";
  @on(ImageInspectorTarget) private onInspOpen(e: ImageInspectorTarget) {
    this.inspHost = e.ref ? e.host : "";
    this.inspRef = e.ref;
  }

  // Overrides ResourcePage.onMount — replicate its auth-check + refresh, then open
  // the deep-linked image. (A bare @mount here would shadow the base and skip the
  // initial data fetch.)
  @mount
  private onImageMount() {
    if (!this.auth.isAuthenticated) { this.router.navigate("/login"); return; }
    this.refresh();
    this.syncImage();
  }

  @watch("routeImage")
  private onImageParam() { this.syncImage(); }

  // Drive the docked image inspector from the URL's id segment. apply() only sets
  // state + fires the bus event (no navigation), so it can't loop with select().
  private syncImage() {
    if (this.routeImage) {
      this.imageInsp.onChange = () => this.refresh();
      this.imageInsp.apply(this.hostCtx.token, decodeURIComponent(this.routeImage));
    } else if (this.imageInsp.isOpen) {
      this.imageInsp.apply("", "");
    }
  }

  // Registries manager (modal). hope is the fleet's registry-auth authority:
  // creds added here apply to the local daemon and every connected agent, and
  // persist (encrypted) when a state db is mounted. Config-defined registries
  // are read-only.
  @reactive accessor showRegs = false;
  @query("hope-registries") accessor regEl!: HopeRegistries;

  @watch("showRegs") private lockRegs() { signalModal(this, this.showRegs); }
  @unmount private releaseRegs() { signalModal(this, false); }

  // The shared <hope-registries> component self-loads and owns add/remove, so the
  // page just toggles the modal shell.
  private openRegs = () => { this.showRegs = true; };
  private closeRegs = () => { this.showRegs = false; };

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

  // Cross-fleet images overview: a section per host with its counts; "manage"
  // drills into that host's full images page (filters, prune, selection).
  update() {
    const vis = this.visible();
    const items = this.items();
    // Disjoint disk buckets for the composition meter (priority: in use > dangling > unused).
    let inUseSz = 0, unusedSz = 0, dangSz = 0, inUseN = 0, unusedN = 0, dangN = 0;
    for (const i of items) {
      if (i.in_use) { inUseSz += i.size; inUseN++; }
      else if (i.dangling) { dangSz += i.size; dangN++; }
      else { unusedSz += i.size; unusedN++; }
    }
    const total = inUseSz + unusedSz + dangSz;
    const reclaim = unusedSz + dangSz;
    const dangling = items.filter((i) => i.dangling).length;
    const unusedAll = items.filter((i) => !i.in_use).length;
    const maxSize = Math.max(1, ...vis.map((i) => i.size));
    const pct = (n: number) => (total ? (n / total) * 100 : 0);
    const fcount = (f: Filter) => (f === "all" ? items.length : items.filter((i) => (f === "used" ? i.in_use : f === "unused" ? !i.in_use : i.dangling)).length);
    const fleet = this.fleetMode;
    const sel = this.selected.length;
    const busy = this.loading();
    const first = busy && items.length === 0; // first load, nothing to show yet
    // The open image's ref can be a sha id (row click) or a tag (a container's
    // image field jumped here) — match either so the active row highlights.
    const openRef = this.routeImage ? decodeURIComponent(this.routeImage) : "";

    return (
      <div>
        <hope-phead heading="Images" scope={fleet ? "fleet" : this.hostCtx.token || "local"} meta={first ? "docker images" : fleet ? "aggregated across the fleet" : `${items.length} image${items.length === 1 ? "" : "s"} on this daemon`}>
          <hope-button slot="actions" icon="plus" onClick={this.openRegs}>registries</hope-button>
          {sel > 0 ? (
            <>
              {!fleet && this.selImages().some((i) => i.used_by.length) ? <hope-button slot="actions" onClick={this.redeployFreeSelected}>redeploy &amp; free</hope-button> : null}
              <hope-button slot="actions" tone="danger" onClick={this.removeSelected}>remove {sel}</hope-button>
              <hope-button slot="actions" onClick={this.clearSel}>clear</hope-button>
            </>
          ) : fleet ? (
            <>
              {items.some((i) => i.dangling && i.used_by.length) ? <hope-button slot="actions" onClick={this.redeployAndPruneFleet}>redeploy &amp; prune</hope-button> : null}
              {dangling > 0 ? <hope-button slot="actions" onClick={() => this.pruneFleet(false)}>prune dangling</hope-button> : null}
              {unusedAll > 0 ? <hope-button slot="actions" tone="danger" onClick={() => this.pruneFleet(true)}>prune unused</hope-button> : null}
            </>
          ) : (
            <>
              {items.some((i) => i.dangling && i.used_by.length) ? <hope-button slot="actions" onClick={this.redeployAndPrune}>redeploy &amp; prune</hope-button> : null}
              {dangling > 0 ? <hope-button slot="actions" onClick={() => this.prune(false)}>prune dangling</hope-button> : null}
              {unusedAll > 0 ? <hope-button slot="actions" tone="danger" onClick={() => this.prune(true)}>prune unused</hope-button> : null}
            </>
          )}
          <hope-button slot="actions" icon="rotate" spin={this.refreshing} disabled={busy} onClick={this.userRefresh}></hope-button>

          {first ? (
            <div class="disk"><div class="diskmain"><div class="disktotal"><hope-skel w="90" h="26"></hope-skel><hope-skel w="150" h="10"></hope-skel></div><hope-skel h="8"></hope-skel><div class="legend"><hope-skel w="120" h="11"></hope-skel><hope-skel w="120" h="11"></hope-skel><hope-skel w="120" h="11"></hope-skel></div></div></div>
          ) : (
            <div class="disk">
              <div class="diskmain">
                <div class="disktotal"><span class="big num">{bytes(total)}</span><span class="lbl">on disk &middot; {items.length} images</span></div>
                <div class="meter">
                  <i class="inuse" style={`width:${pct(inUseSz)}%`}></i>
                  <i class="unused" style={`width:${pct(unusedSz)}%`}></i>
                  <i class="dangling" style={`width:${pct(dangSz)}%`}></i>
                </div>
                <div class="legend">
                  <span class="lg"><span class="sw inuse"></span>in use <b>{inUseN}</b> <span class="sz">&middot; {bytes(inUseSz)}</span></span>
                  <span class="lg"><span class="sw unused"></span>unused <b>{unusedN}</b> <span class="sz">&middot; {bytes(unusedSz)}</span></span>
                  <span class="lg"><span class="sw dangling"></span>dangling <b>{dangN}</b> <span class="sz">&middot; {bytes(dangSz)}</span></span>
                </div>
              </div>
              <div class="reclaim">
                <span class="k">reclaimable</span>
                <span class="v num">{bytes(reclaim)}</span>
                <span class="sub">prune unused + dangling</span>
              </div>
            </div>
          )}
        </hope-phead>

        {this.err() ? <div class="empty">{this.err()}</div> : null}

        {items.length > 0 ? (
          <div class="vtools">
            <div class="seg">
              {(["all", "used", "unused", "dangling"] as Filter[]).map((f) => (
                <button class={this.filter === f ? "on" : ""} onClick={() => (this.filter = f)}>{f === "used" ? "in use" : f}<span class="n">{fcount(f)}</span></button>
              ))}
            </div>
            <span class="grow"></span>
            <hope-search placeholder="Search tags and ids…" text={this.query} onSearch={(e: any) => (this.query = e.detail)}></hope-search>
          </div>
        ) : null}

        {first ? (
          <div class="rows">
            <div class="rhead"><span>repository</span><span>size</span><span></span><span>age</span><span>used by</span><span></span></div>
            {[0, 1, 2, 3, 4].map(() => (
              <div class="irow" style="cursor:default">
                <div class="repo"><hope-skel w="200" h="12"></hope-skel></div>
                <div class="sizebar"><span class="track"></span></div>
                <div class="size"><hope-skel w="56" h="12"></hope-skel></div>
                <div class="age"><hope-skel w="30" h="12"></hope-skel></div>
                <div class="usedby"><hope-skel w="120" h="12"></hope-skel></div>
                <div class="rmc"></div>
              </div>
            ))}
          </div>
        ) : vis.length > 0 ? (
          <div class="rows">
            <div class="rhead"><span>repository</span><span>size</span><span></span><span>age</span><span>used by</span><span></span></div>
            {vis.map((i) => {
              const big = i.size >= maxSize * 0.66;
              return (
                <div class={"irow" + ((openRef && (openRef === i.id || shortId(i.id) === openRef || i.tags.includes(openRef))) || (fleet && this.inspRef === i.id && this.inspHost === (i.host || "")) ? " on" : "")} onClick={() => this.imageInsp.select(i.host || this.hostCtx.token, i.id, () => this.refresh())}>
                  <div class="repo">
                    {i.host ? <span class="hostchip">{i.host}</span> : null}
                    <span class="tag" title={i.tags.join(", ")}>{i.tags.length ? i.tags[0] : <span class="untag">&lt;untagged&gt;</span>}</span>
                    {i.tags.length > 1 ? <span class="more">+{i.tags.length - 1}</span> : null}
                  </div>
                  <div class={"sizebar" + (big ? " big" : "")}><span class="track"><i style={`width:${Math.max(2, (i.size / maxSize) * 100)}%`}></i></span></div>
                  <div class="size num">{bytes(i.size)}</div>
                  <div class="age num">{age(i.created)}</div>
                  <div class="usedby">
                    {i.used_by.length ? (
                      <span class="svc">{i.used_by[0].project ? <span class="proj">{i.used_by[0].project} / </span> : null}{i.used_by[0].service || i.used_by[0].name || shortId(i.used_by[0].id)}{i.used_by.length > 1 ? <span class="extra"> +{i.used_by.length - 1}</span> : null}</span>
                    ) : i.dangling ? <span class="pill warn">dangling</span> : <span class="pill">unused</span>}
                  </div>
                  <div class="rmc">{i.in_use ? null : <button class="rm" title="remove image" onClick={(e: Event) => { e.stopPropagation(); this.removeImg(i); }}><loom-icon name="x" size={14}></loom-icon></button>}</div>
                </div>
              );
            })}
          </div>
        ) : !this.loading() && !this.err() ? (
          <div class="empty">{this.query ? <span>No images match <b>{this.query}</b>.</span> : items.length === 0 ? "No images on this daemon." : this.filter === "used" ? "No images in use." : this.filter === "unused" ? "No unused images — every image backs a container." : this.filter === "dangling" ? "No dangling images — nothing to prune." : "No images on this daemon."}</div>
        ) : null}
        {this.showRegs ? (
          <div class="regsheet" onClick={this.closeRegs}>
            <div class="regsheetbox" onClick={(e: Event) => e.stopPropagation()}>
              <div class="regsheethd">
                <loom-icon name="database" size={15}></loom-icon>
                <span>registries</span>
                <span class="grow"></span>
                <hope-button size="sm" icon="plus" onClick={() => this.regEl?.openAdd()}>add registry</hope-button>
                <button class="regsheetx" onClick={this.closeRegs}><loom-icon name="x" size={16}></loom-icon></button>
              </div>
              <div class="regsheetbd"><hope-registries></hope-registries></div>
            </div>
          </div>
        ) : null}
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
