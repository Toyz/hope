// <hope-plugin-widgets> — renders enabled plugins' `dashboard`-surface
// contributions as compact cards on the fleet/host dashboard. Self-contained so it
// stays out of the dashboard page's internals: it fetches Plugins.dashboard on
// mount (and on PluginsChanged), and renders nothing when there are none — so the
// host can drop it in with a single line and no gating.
import { LoomElement, component, styles, css, reactive, prop, mount, on } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { PluginsChanged } from "../events";
import { theme } from "../styles";
import "./plugin-surface"; // registers <hope-plugin-surface> + <hope-plugin-icon>
import type { Surface } from "./plugin-surface";

type Widget = Surface & { host: string; stack?: string; icon?: string };

@component("hope-plugin-widgets")
@styles(theme, css`
  :host { display: block; }
  /* Align with the dashboard's content inset (its section header uses 22px/28px). */
  .wsec { margin: 8px 0 28px; padding: 0 28px; }
  .whead { display: flex; align-items: center; gap: 8px; padding: 14px 0 12px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; }
  .wgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 360px)); gap: 14px; }
  .wcard { border: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; min-width: 0; transition: border-color .12s ease; }
  .wcard:hover { border-color: var(--line2); }
  .wtitle { display: flex; align-items: center; gap: 8px; padding: 9px 13px; border-bottom: 1px solid var(--line); color: var(--hi); font: 600 12px/1.2 var(--mono); }
  .wtitle .wsub { margin-left: auto; color: var(--dim); font: 10px/1 var(--mono); }
  /* Trim the surface's own outer padding inside the compact widget body. */
  .wbody { min-width: 0; padding: 4px 2px; }
`)
export class HopePluginWidgets extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @reactive accessor widgets: Widget[] = [];
  // When set, show only widgets whose plugin container belongs to this compose stack
  // (used on the stack page). Unset = the fleet dashboard, which shows every widget.
  @prop accessor stack = "";

  @mount onMount() { void this.load(); }
  @on(PluginsChanged) onChanged() { void this.load(); }

  private async load() {
    try {
      const w = await this.rpc.call<Widget[]>("Plugins", "dashboard", []);
      this.widgets = Array.isArray(w) ? w : [];
    } catch {
      this.widgets = [];
    }
  }

  update() {
    const shown = this.stack ? this.widgets.filter((w) => w.stack === this.stack) : this.widgets;
    if (!shown.length) return <></>;
    return (
      <div class="wsec">
        <div class="whead"><loom-icon name="plugin" size={12}></loom-icon>plugin widgets</div>
        <div class="wgrid">
          {shown.map((w) => (
            <div class="wcard">
              <div class="wtitle">
                <hope-plugin-icon plugin={w.key} name={w.icon || "plugin"} size={14}></hope-plugin-icon>
                {w.title || w.name}
                <span class="wsub">{w.name}</span>
              </div>
              <div class="wbody"><hope-plugin-surface surface={w}></hope-plugin-surface></div>
            </div>
          ))}
        </div>
      </div>
    );
  }
}
