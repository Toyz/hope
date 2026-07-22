// <hope-plugin-widgets> — renders enabled plugins' surface contributions as compact
// cards. Two modes, one component:
//   - no props        -> `dashboard`-surface widgets (fleet/host dashboard).
//   - stack + host set -> `stack`-surface widgets matched to that stack's containers
//                         (the stack page), via Plugins.stackWidgets.
// Self-contained: it fetches on mount / when the target changes / on PluginsChanged,
// and renders nothing when there are none — drop it in with one line, no gating.
import { LoomElement, component, styles, css, reactive, prop, mount, watch, on } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { capabilities } from "../caps";
import { PluginsChanged } from "../events";
import { theme } from "../styles";
import "./plugin-surface"; // registers <hope-plugin-surface> + <hope-plugin-icon>
import type { Surface } from "./plugin-surface";

type Widget = Surface & { host?: string; stack?: string; icon?: string };

@component("hope-plugin-widgets")
@styles(theme, css`
  :host { display: block; }
  /* Align with the dashboard's content inset (its section header uses 22px/28px). */
  .wsec { margin: 8px 0 28px; padding: 0 28px; }
  .whead { display: flex; align-items: center; gap: 8px; padding: 14px 0 12px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; }
  /* align-items:start so each widget is its own content height instead of stretching to the
     tallest card in the row (which left big empty space under short widgets). */
  .wgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 360px)); gap: 14px; align-items: start; }
  .wcard { border: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; min-width: 0; transition: border-color .12s ease; }
  .wcard:hover { border-color: var(--line2); }
  .wcard.deg { border-color: color-mix(in srgb, var(--warn) 40%, var(--line2)); }
  /* unreachable tag — plugin down, widget rendered from last-good cache */
  .wtitle .wdeg { color: var(--warn); font: 9.5px/1.6 var(--mono); letter-spacing: .04em; text-transform: uppercase;
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line2)); padding: 1px 6px; }
  /* Two rows so the title breathes: name on top, its meta (plugin · host · stack)
     on a tidy line below instead of everything crammed onto one row. */
  .wtitle { display: flex; flex-direction: column; gap: 6px; padding: 10px 13px; border-bottom: 1px solid var(--line); }
  .wtitle .wt { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--hi); font: 600 12.5px/1.2 var(--mono); }
  .wtitle .wt .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wtitle .wmeta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
  .wtitle .wsub { color: var(--dim); font: 10px/1 var(--mono); }
  /* host tag in the fleet ("all") view so a widget's origin host is obvious */
  .wtitle .whost { color: var(--upd); font: 9.5px/1.6 var(--mono); letter-spacing: .04em; text-transform: uppercase;
    border: 1px solid color-mix(in srgb, var(--upd) 40%, var(--line2)); padding: 1px 6px; }
  /* stack the widget belongs to (when it's part of one) */
  .wtitle .wstack { color: var(--dim); font: 9.5px/1.6 var(--mono); letter-spacing: .04em;
    border: 1px solid var(--line2); padding: 1px 6px; }
  /* Trim the surface's own outer padding inside the compact widget body. */
  .wbody { min-width: 0; padding: 4px 2px; }
`)
export class HopePluginWidgets extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @reactive accessor widgets: Widget[] = [];
  // Set both to render this stack's `stack`-surface widgets (the stack page). Unset =
  // the fleet dashboard's `dashboard`-surface widgets.
  @prop accessor stack = "";
  @prop accessor host = "";

  private pluginsOn = false;
  private lastKey = ""; // the (mode/host/project) we last fetched — dedupes redundant loads

  @mount async onMount() {
    // Never call the plugin surfaces when the plugin system is off — a whole class of
    // stacks (every stack, when no plugins are enabled) otherwise fires a pointless
    // request. capabilities() is cached, so this is one shared lookup.
    this.pluginsOn = !!(await capabilities()).plugins_enabled;
    void this.load();
  }
  @watch("stack") onStack() { void this.load(); }
  @watch("host") onHost() { void this.load(); }
  @on(PluginsChanged) onChanged() { this.lastKey = ""; void this.load(); }

  private async load() {
    if (!this.pluginsOn) { this.widgets = []; return; }
    // Stack mode needs BOTH host and project to match against the stack's containers. The
    // two props hydrate separately, so a half-set state (host still blank) would POST a
    // bad request the backend rejects 400 ("host and project are required") — and the two
    // watchers firing per navigation made it a burst. Wait for both, and skip a repeat of
    // the same target (two watchers = one real change).
    if (this.stack && !this.host) return;
    const key = this.stack ? `s:${this.host}/${this.stack}` : "d";
    if (key === this.lastKey) return;
    this.lastKey = key;
    try {
      // Stack mode is backend-filtered by the stack's containers; dashboard mode fetches
      // the whole fleet's widgets (host-independent — update() scopes them client-side).
      const w = this.stack
        ? await this.rpc.call<Widget[]>("Plugins", "stackWidgets", [{ host: this.host, project: this.stack }])
        : await this.rpc.call<Widget[]>("Plugins", "dashboard", []);
      this.widgets = Array.isArray(w) ? w : [];
    } catch {
      this.widgets = [];
    }
  }

  update() {
    // Stack mode is backend-filtered already. Dashboard mode fetches the whole fleet's
    // widgets, so scope to this host when one is selected (a host with no plugins shows
    // nothing); an empty host is the fleet "all" view, which shows every host's widgets.
    const shown = this.stack || !this.host
      ? this.widgets
      : this.widgets.filter((w) => w.host === this.host);
    if (!shown.length) return <></>;
    return (
      <div class="wsec">
        <div class="whead"><loom-icon name="plugin" size={12}></loom-icon>plugin widgets</div>
        <div class="wgrid">
          {shown.map((w) => (
            <div class={"wcard" + (w.degraded ? " deg" : "")}>
              <div class="wtitle">
                <div class="wt">
                  <hope-plugin-icon plugin={w.key} name={w.icon || "plugin"} size={14}></hope-plugin-icon>
                  <span class="nm">{w.title || w.name}</span>
                </div>
                <div class="wmeta">
                  <span class="wsub">{w.name}</span>
                  {!this.host && w.host ? <span class="whost">{w.host}</span> : null}
                  {w.stack ? <span class="wstack">{w.stack}</span> : null}
                  {w.degraded ? <span class="wdeg" tip={`plugin unreachable (${w.degraded}) — last-known panel`}>unreachable</span> : null}
                </div>
              </div>
              <div class="wbody"><hope-plugin-surface surface={w}></hope-plugin-surface></div>
            </div>
          ))}
        </div>
      </div>
    );
  }
}
