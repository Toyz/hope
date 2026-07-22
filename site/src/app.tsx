// <hope-docs> — the shell. It IS hope's chrome: a top strip, the left rail (here the
// rail is hope's feature nav instead of the fleet tree), and a docked content panel.
// Hash-routed so deep links work on GitHub Pages with no server rewrites.
import { LoomElement, component, styles, css, reactive, mount } from "@toyz/loom";
import { theme } from "./theme";
import { NAV, HOME, PAGES } from "./content";
import "./doc";

function slugFromHash(): string {
  const h = (location.hash || "").replace(/^#\/?/, "").trim();
  return PAGES[h] ? h : HOME;
}

@component("hope-docs")
@styles(theme, css`
  :host { display: grid; grid-template-rows: 44px 1fr; height: 100%; background: var(--ink); overflow: hidden; }

  /* top strip */
  .top { display: flex; align-items: center; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--line);
    background: var(--panel); }
  .brand { display: flex; align-items: center; gap: 9px; }
  .brand .d { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
  .brand .nm { font: 700 14px/1 var(--mono); color: var(--hi); letter-spacing: .02em; }
  .brand .tag { font: 600 9px/1.6 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    border: 1px solid var(--line2); padding: 2px 6px; }
  .grow { flex: 1; }
  .tlink { color: var(--mid); font: 500 12px/1 var(--mono); padding: 6px 10px; }
  .tlink:hover { color: var(--hi); }
  .tcta { color: var(--upd); border: 1px solid color-mix(in srgb, var(--upd) 45%, var(--line2)); padding: 6px 12px;
    font: 600 11px/1 var(--mono); letter-spacing: .04em; }
  .tcta:hover { background: color-mix(in srgb, var(--upd) 14%, transparent); color: var(--hi); }

  /* body: rail + content */
  .body { display: grid; grid-template-columns: 232px 1fr; min-height: 0; }
  .rail { border-right: 1px solid var(--line); background: var(--panel); overflow-y: auto; padding: 14px 0 20px; display: flex; flex-direction: column; }
  .grp { padding: 0 14px; margin: 14px 0 6px; }
  .grp:first-child { margin-top: 0; }
  .eyebrow { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .rlink { display: flex; align-items: center; height: 30px; padding: 0 14px 0 16px; cursor: pointer;
    color: var(--mid); font: 500 12.5px/1 var(--mono); position: relative; }
  .rlink:hover { background: var(--raised); color: var(--hi); }
  .rlink.on { background: color-mix(in srgb, var(--upd) 15%, transparent); color: var(--hi); }
  .rlink.on::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--upd); }
  .railfoot { margin-top: auto; padding: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
  .railfoot a { color: var(--dim); font: 500 11.5px/1.8 var(--mono); }
  .railfoot a:hover { color: var(--hi); }

  .content { min-width: 0; min-height: 0; overflow-y: auto; }
`)
export class HopeDocs extends LoomElement {
  @reactive accessor slug = slugFromHash();

  @mount onMount() {
    window.addEventListener("hashchange", this.onHash);
    if (!location.hash) location.hash = "#/" + HOME;
  }
  private onHash = () => { this.slug = slugFromHash(); document.querySelector(".content")?.scrollTo(0, 0); };

  update() {
    return (
      <>
        <div class="top">
          <a class="brand" href={"#/" + HOME}>
            <span class="d"></span>
            <span class="nm">hope</span>
            <span class="tag">docs</span>
          </a>
          <span class="grow"></span>
          <a class="tlink" href="https://github.com/toyz/hope" target="_blank" rel="noreferrer">github</a>
          <a class="tcta" href="#/getting-started">run hope</a>
        </div>
        <div class="body">
          <div class="rail">
            {NAV.map((sec) => (
              <>
                <div class="grp"><span class="eyebrow">{sec.section}</span></div>
                {sec.items.map((it) => (
                  <a class={"rlink" + (this.slug === it.slug ? " on" : "")} href={"#/" + it.slug}>{it.title}</a>
                ))}
              </>
            ))}
            <div class="railfoot">
              <a href="https://github.com/toyz/hope" target="_blank" rel="noreferrer">github.com/toyz/hope</a>
              <a href="https://github.com/toyz/hope/pkgs/container/hope" target="_blank" rel="noreferrer">ghcr.io/toyz/hope</a>
            </div>
          </div>
          <div class="content"><hope-doc slug={this.slug}></hope-doc></div>
        </div>
      </>
    );
  }
}
