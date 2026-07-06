// <hope-plugin-widgets> — renders enabled plugins' `dashboard`-surface
// contributions as compact cards on the fleet/host dashboard. Self-contained so it
// stays out of the dashboard page's internals: it fetches Plugins.dashboard on
// mount (and on PluginsChanged), and renders nothing when there are none — so the
// host can drop it in with a single line and no gating.
import { LoomElement, component, styles, css, reactive, mount, on } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { PluginsChanged } from "../events";
import { theme } from "../styles";
import "./plugin-surface"; // registers <hope-plugin-surface> + <hope-plugin-icon>
import type { Surface } from "./plugin-surface";

type Widget = Surface & { host: string; icon?: string };

@component("hope-plugin-widgets")
@styles(theme, css`
  :host { display: contents; }
  .wsec { margin-bottom: 34px; }
  .whead { display: flex; align-items: center; gap: 8px; padding: 0 0 12px; color: var(--dim); font: 600 10px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; }
  .wgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .wcard { border: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; min-width: 0; }
  .wtitle { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); color: var(--hi); font: 600 12px/1.2 var(--mono); }
  .wtitle .wsub { margin-left: auto; color: var(--dim); font: 10px/1 var(--mono); }
  .wbody { min-width: 0; }
`)
export class HopePluginWidgets extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @reactive accessor widgets: Widget[] = [];

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
    if (!this.widgets.length) return <></>;
    return (
      <div class="wsec">
        <div class="whead"><loom-icon name="plug" size={12}></loom-icon>plugin widgets</div>
        <div class="wgrid">
          {this.widgets.map((w) => (
            <div class="wcard">
              <div class="wtitle">
                <hope-plugin-icon plugin={w.key} name={w.icon || "plug"} size={14}></hope-plugin-icon>
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
