// <hope-footer> — the site footer: a quiet shill line plus links to the source
// and (when enabled) the in-app API explorer. Rendered once by the app shell
// under the routed page.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";
import { theme } from "../styles";
import { capabilities } from "../caps";

const REPO = "https://github.com/toyz/hope";

@component("hope-footer")
@styles(theme, css`
  :host { display: block; }
  /* Fixed 48px height so pages can size to calc(100vh - 48px) and the footer
     doesn't force a scrollbar when content fits. */
  .ft { display: flex; align-items: center; gap: 16px; height: 48px; box-sizing: border-box; padding: 0 24px;
    border-top: 1px solid var(--line); background: var(--ink); overflow: hidden; }
  .brand { display: flex; align-items: center; gap: 8px; font: 700 12px/1 var(--mono); letter-spacing: .04em; color: var(--hi); }
  .brand .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--upd); }
  .tag { font: 11.5px/1.5 var(--mono); color: var(--dim); }
  .grow { flex: 1; }
  .lnk { display: inline-flex; align-items: center; gap: 6px; font: 600 11px/1 var(--mono); letter-spacing: .1em;
    text-transform: uppercase; color: var(--dim); cursor: pointer; text-decoration: none; }
  .lnk:hover { color: var(--hi); }
  @media (max-width: 600px) { .grow { flex-basis: 100%; height: 0; } }
`)
export class HopeFooter extends LoomElement {
  @reactive accessor apiOn = false;
  private get router(): LoomRouter { return app.get(LoomRouter); }

  @mount
  onMount() { capabilities().then((c) => (this.apiOn = !!c.api_enabled)); }

  update() {
    return (
      <div class="ft">
        <span class="brand"><span class="dot"></span>hope</span>
        <span class="tag">open-source, self-hostable Docker cluster manager</span>
        <span class="grow"></span>
        {this.apiOn ? <span class="lnk" onClick={() => this.router.navigate("/api-docs")}><loom-icon name="terminal" size={13}></loom-icon> API</span> : null}
        <a class="lnk" href={REPO} target="_blank" rel="noreferrer"><loom-icon name="link" size={13}></loom-icon> GitHub</a>
      </div>
    );
  }
}
