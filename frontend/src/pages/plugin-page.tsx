// Plugin page — renders a plugin's `page`-surface contribution full-screen. The
// same <hope-plugin-surface> renderer that drives the container-inspector panel
// drives a full page here; the route's :path selects which page (and which param,
// for dynamic pages that share one layout).
import { LoomElement, component, styles, css, mount, reactive, prop, watch, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { HopeTransport } from "../transport";
import type { Surface } from "../components/plugin-surface";
import { theme } from "../styles";

@route("/plugin/:key/:path")
@component("hope-plugin-page")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 100%; background: var(--ink); }
  .body { flex: 1 1 0; min-height: 0; padding: 4px 0 12px; display: flex; flex-direction: column; }
  .empty { padding: 40px 28px; color: var(--dim); font: 12.5px/1.6 var(--mono); }
`)
export class PluginPage extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  private get router(): LoomRouter { return app.get(LoomRouter); }

  @prop({ param: "key" }) accessor key = "";
  @prop({ param: "path" }) accessor path = "";

  @reactive accessor surface: Surface | null = null;
  @reactive accessor error = "";
  @reactive accessor loaded = false;

  @mount onMount() {
    if (!this.auth.isAuthenticated) { this.router.navigate("/login"); return; }
    void this.load();
  }
  @watch("key") onKey() { void this.load(); }
  @watch("path") onPath() { void this.load(); }

  private async load() {
    if (!this.key || !this.path) return;
    this.loaded = false;
    try {
      const s = await this.rpc.call<any>("Plugins", "page", [{ key: decodeURIComponent(this.key), path: this.path }]);
      this.surface = s ? { key: s.key, name: s.name, title: s.title, node: s.node, schema: s.schema, param: s.param } : null;
      this.error = this.surface ? "" : "page not found";
    } catch (e: any) {
      this.error = e?.message ?? "failed to load page";
      this.surface = null;
    } finally {
      this.loaded = true;
    }
  }

  update() {
    const s = this.surface;
    return (
      <>
        <hope-phead heading={s?.title || "Plugin"} scope="plugin" meta={s ? s.name : "custom page"}></hope-phead>
        <div class="body">
          {this.error ? <div class="empty">{this.error}</div> : !this.loaded ? <div class="empty">loading…</div> : s ? <hope-plugin-surface surface={s}></hope-plugin-surface> : null}
        </div>
      </>
    );
  }
}
