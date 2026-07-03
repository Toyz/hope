// <hope-chip> — the one small square label used everywhere: host tags, health
// words, "shared"/"dangling"/"unused" markers, issue counts. One definition, so
// they all share the terminal look (flat, square, hairline border, uppercase
// mono) and only differ by state + size.
//
//   <hope-chip tone="ok">healthy</hope-chip>
//   <hope-chip tone="warn" size="sm">3 issues</hope-chip>
//   <hope-chip host>{hostId}</hope-chip>   // fixed-width host label
//
// tone: "" (neutral/dim) | ok | warn | bad | upd. size: "md" (default) | "sm".
// host: fixed min-width + trailing gap, for the host label that precedes a name.
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-chip")
@styles(theme, css`
  :host { display: inline-flex; vertical-align: middle; }
  :host([host]) { margin-right: 10px; }
  .c { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
    font-family: var(--mono); font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
    color: var(--dim); border: 1px solid var(--line); white-space: nowrap; }
  .c.md { font-size: 10px; line-height: 1; padding: 4px 8px; }
  .c.sm { font-size: 9px; line-height: 1; padding: 3px 6px; }
  .c.host { min-width: 88px; }
  .c.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .c.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .c.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
  .c.upd { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 40%, var(--line)); }
`)
export class HopeChip extends LoomElement {
  @prop accessor tone = "";
  @prop accessor size = "md";

  update() {
    const host = this.hasAttribute("host") ? " host" : "";
    const cls = "c " + (this.size === "sm" ? "sm" : "md") + host + (this.tone ? " " + this.tone : "");
    return (
      <span class={cls}><slot></slot></span>
    );
  }
}
