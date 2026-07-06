// Plugin page — renders a plugin's `page`-surface contribution full-screen. The
// same <hope-plugin-surface> renderer that drives the container-inspector panel
// drives a full page here; the route's :path selects which page (and which param,
// for dynamic pages that share one layout).
import { LoomElement, component, styles, css, mount, reactive, prop, watch, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { HopeTransport } from "../transport";
import { PromptService } from "../prompt";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import "../components/plugin-surface"; // registers <hope-plugin-surface> + <hope-plugin-icon>
import type { Surface } from "../components/plugin-surface";
import { runPluginAction } from "../plugin-run";
import { theme } from "../styles";

@route("/plugin/:key/:path")
@route("/plugin/:key/:path/:arg")
@component("hope-plugin-page")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 100%; background: var(--ink); }
  /* The body owns the scroll: a filled table fills the remaining height, but a
     content-heavy page scrolls instead of squishing everything. */
  .body { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 4px 0 12px; display: flex; flex-direction: column; }
  .empty { padding: 40px 28px; color: var(--dim); font: 12.5px/1.6 var(--mono); }
`)
export class PluginPage extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;
  private get router(): LoomRouter { return app.get(LoomRouter); }

  @prop({ param: "key" }) accessor key = "";
  @prop({ param: "path" }) accessor path = "";
  @prop({ param: "arg" }) accessor arg = ""; // master-detail: the entity id for a DetailPage

  @reactive accessor surface: Surface | null = null;
  @reactive accessor error = "";
  @reactive accessor loaded = false;

  @mount onMount() {
    if (!this.auth.isAuthenticated) { this.router.navigate("/login"); return; }
    void this.load();
  }
  @watch("key") onKey() { void this.load(); }
  @watch("path") onPath() { void this.load(); }
  @watch("arg") onArg() { void this.load(); }

  private async load() {
    if (!this.key || !this.path) return;
    // Stale-while-revalidate: only show "loading…" on the FIRST load. On a page
    // change keep the current page rendered until the new one arrives, so
    // navigating between plugin pages doesn't flash empty/loading.
    if (!this.surface) this.loaded = false;
    try {
      const s = await this.rpc.call<any>("Plugins", "page", [{ key: decodeURIComponent(this.key), path: this.path, arg: this.arg || "" }]);
      this.surface = s ? { key: s.key, name: s.name, title: s.title, node: s.node, schema: s.schema, actions: s.actions, param: s.param } : null;
      this.error = this.surface ? "" : "page not found";
    } catch (e: any) {
      this.error = e?.message ?? "failed to load page";
      this.surface = null;
    } finally {
      this.loaded = true;
    }
  }

  // The page's author-declared header actions go in the phead's action slot (the
  // one header component every page uses) — not a bespoke bar inside the surface.
  private headerActions(s: Surface) {
    const acts = (s.actions || []).map((r) => (s.schema.actions || []).find((a) => a.method === r)).filter(Boolean) as NonNullable<Surface["schema"]["actions"]>;
    return acts.map((a) => (
      <button slot="actions" class={a.danger ? "bad" : ""} onClick={() => this.runAction(s, a)}>
        {a.icon ? <hope-plugin-icon plugin={s.key} name={a.icon} size={13}></hope-plugin-icon> : null}{a.label}
      </button>
    ));
  }

  private runAction(s: Surface, a: any) {
    void runPluginAction({ rpc: this.rpc, prompt: this.prompt, confirm: this.confirm, toast: this.toast }, s.key, a, undefined, s.param);
  }

  update() {
    const s = this.surface;
    return (
      <>
        <hope-phead heading={s?.title || "Plugin"} scope="plugin" meta={s ? s.name : "custom page"}>
          {s ? this.headerActions(s) : null}
        </hope-phead>
        <div class="body">
          {this.error ? <div class="empty">{this.error}</div> : !this.loaded ? <div class="empty">loading…</div> : s ? <hope-plugin-surface surface={s}></hope-plugin-surface> : null}
        </div>
      </>
    );
  }
}
