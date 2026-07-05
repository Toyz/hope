// <hope-plugin-icon> — renders an icon named by a plugin, resolved against THAT
// plugin's own icon map (never loom's global registry, so plugins can't collide or
// shadow hope's built-ins). Plugin SVG is untrusted → sanitized before it touches
// the DOM (see sanitize-svg). Unknown names fall back to a built-in <loom-icon>, so
// a plugin can reference either its own icon or one of hope's.
//
// Cloned from @toyz/loom's loom-icon (which trusts its static registry); the
// difference is the per-plugin namespace + sanitization.
import { LoomElement, component, styles, css, prop, watch } from "@toyz/loom";
import { sanitizeSvgInner } from "../sanitize-svg";

// pluginKey -> (iconName -> sanitized inner SVG). Populated as surfaces/manifests
// load; keyed by the stable plugin identity so two plugins' "database" icons stay
// distinct.
const registry = new Map<string, Map<string, string>>();

/** Register a plugin's icon map (sanitizing each). Safe to call repeatedly. */
export function registerPluginIcons(pluginKey: string, icons?: Record<string, string>) {
  if (!pluginKey || !icons) return;
  let m = registry.get(pluginKey);
  if (!m) { m = new Map(); registry.set(pluginKey, m); }
  for (const [name, markup] of Object.entries(icons)) {
    if (!m.has(name)) m.set(name, sanitizeSvgInner(markup));
  }
}

function resolve(pluginKey: string, name: string): string | null {
  return registry.get(pluginKey)?.get(name) ?? null;
}

@component("hope-plugin-icon", { shadow: false })
@styles(css`
  hope-plugin-icon { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; line-height: 0; width: var(--_s); height: var(--_s); }
  hope-plugin-icon svg { width: 100%; height: 100%; fill: none; stroke: var(--_c, currentColor); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
`)
export class HopePluginIcon extends LoomElement {
  @prop accessor plugin = "";
  @prop accessor name = "";
  @prop accessor size = 16;
  @prop accessor color = "currentColor";

  @watch("size") @watch("color") syncVars() {
    this.style.setProperty("--_s", `${this.size}px`);
    this.style.setProperty("--_c", this.color);
  }

  update() {
    this.style.setProperty("--_s", `${this.size}px`);
    this.style.setProperty("--_c", this.color);
    const inner = resolve(this.plugin, this.name);
    if (inner) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = inner; // already sanitized on register
      return svg;
    }
    // Not a plugin icon → fall back to a hope built-in by the same name.
    return (<loom-icon name={this.name} size={this.size} color={this.color}></loom-icon>) as any;
  }
}
