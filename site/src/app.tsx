// <hope-docs> — the shell, matched to hope's real explorer chrome: a 46px top strip
// spanning the full width, a fixed-width rail below it (here the rail is feature nav
// instead of the fleet tree), and a scrolling content pane. Hash-routed so deep links
// work on GitHub Pages without server rewrites.
import {
    LoomElement,
    app,
    component,
    css,
    on,
    query,
    reactive,
    styles,
} from "@toyz/loom";
import { api, type ApiState } from "@toyz/loom/query";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { HOME, NAV } from "./docs/nav";
import { searchDocs } from "./docs/search-registry";
import { docStyles } from "./docs/styles/doc-page";
import { theme } from "./theme";

function slugFromPath(path: string): string {
  return path === "/" ? HOME : path.replace(/^\//, "");
}
function titleOf(slug: string): string {
  for (const s of NAV)
    for (const it of s.items) if (it.slug === slug) return it.title;
  return slug;
}
function sectionOf(slug: string): string {
  return (
    NAV.find((section) => section.items.some((item) => item.slug === slug))
      ?.section ?? "docs"
  );
}
function sectionEntry(slug: string): string {
  return (
    NAV.find((section) => section.items.some((item) => item.slug === slug))
      ?.items[0]?.slug ?? HOME
  );
}

interface PluginRelease {
  version: string;
}

interface GitHubTagRef {
  ref: string;
}

const pluginTagPattern = /^refs\/tags\/plugin\/v(\d+)\.(\d+)\.(\d+)$/;

async function latestPluginRelease(): Promise<PluginRelease> {
  const response = await fetch(
    "https://api.github.com/repos/Toyz/hope/git/matching-refs/tags/plugin/v",
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`GitHub tags request failed (${response.status})`);
  }

  const releases = ((await response.json()) as GitHubTagRef[])
    .map(({ ref }) => {
      const match = pluginTagPattern.exec(ref);
      return match
        ? {
            version: `v${match[1]}.${match[2]}.${match[3]}`,
            parts: match.slice(1).map(Number),
          }
        : null;
    })
    .filter(
      (release): release is { version: string; parts: number[] } =>
        release !== null,
    )
    .sort((left, right) => {
      for (let index = 0; index < 3; index++) {
        const difference = right.parts[index] - left.parts[index];
        if (difference) return difference;
      }
      return 0;
    });

  if (!releases[0]) throw new Error("No plugin SDK release tags found");
  return { version: releases[0].version };
}

@component("hope-docs")
@styles(
  theme,
  css`
    :host {
      display: grid;
      height: 100vh;
      overflow: hidden;
      background: var(--ink);
      grid-template-columns: 264px minmax(0, 1fr);
      grid-template-rows: 46px minmax(0, 1fr);
    }

    /* top strip — spans both columns, exactly hope's topbar */
    .top {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 14px;
      height: 100%;
      padding: 0 14px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    .navtoggle {
      display: none;
      place-items: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid var(--line2);
      background: transparent;
      color: var(--mid);
      cursor: pointer;
    }
    .brand {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .brand loom-link::part(anchor) {
      display: flex;
      align-items: baseline;
      gap: 8px;
      text-decoration: none;
    }
    .brand b {
      font: 700 14px/1 var(--mono);
      letter-spacing: 0.02em;
      color: var(--hi);
    }
    .brand .v {
      color: var(--dim);
      font: 500 10px/1 var(--mono);
      letter-spacing: 0.1em;
    }
    .crumb {
      display: flex;
      align-items: center;
      gap: 8px;
      font: 500 12px/1 var(--mono);
    }
    .crumb .c {
      color: var(--dim);
      cursor: pointer;
    }
    .crumb .c:hover {
      color: var(--hi);
    }
    .crumb .c.cur {
      color: var(--hi);
      cursor: default;
    }
    .crumb .sep {
      color: var(--line2);
    }
    .sbox {
      position: relative;
      margin-left: auto;
      width: min(340px, 32vw);
    }
    .search {
      display: flex;
      align-items: center;
      gap: 9px;
      height: 30px;
      padding: 0 10px;
      background: var(--ink);
      border: 1px solid var(--line2);
    }
    .search:focus-within {
      border-color: var(--dim);
    }
    .sin {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: 0;
      outline: none;
      color: var(--hi);
      font: 400 12px/1 var(--mono);
    }
    .sin::placeholder {
      color: var(--dim);
    }
    .search .k {
      border: 1px solid var(--line2);
      padding: 1px 5px;
      font: 500 10px/1 var(--mono);
      color: var(--dim);
    }
    .sres {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      left: 0;
      z-index: 50;
      max-height: 62vh;
      overflow-y: auto;
      background: var(--panel);
      border: 1px solid var(--line2);
    }
    .rail,
    .main,
    .sres {
      scrollbar-width: thin;
      scrollbar-color: var(--line2) var(--ink);
    }
    .rail::-webkit-scrollbar,
    .main::-webkit-scrollbar,
    .sres::-webkit-scrollbar {
      width: 9px;
      height: 9px;
    }
    .rail::-webkit-scrollbar-track,
    .main::-webkit-scrollbar-track,
    .sres::-webkit-scrollbar-track {
      background: var(--ink);
      border-left: 1px solid var(--line);
    }
    .rail::-webkit-scrollbar-thumb,
    .main::-webkit-scrollbar-thumb,
    .sres::-webkit-scrollbar-thumb {
      min-height: 32px;
      background: var(--line2);
      border: 2px solid var(--ink);
    }
    .rail::-webkit-scrollbar-thumb:hover,
    .main::-webkit-scrollbar-thumb:hover,
    .sres::-webkit-scrollbar-thumb:hover {
      background: var(--dim);
    }
    .rail::-webkit-scrollbar-corner,
    .main::-webkit-scrollbar-corner,
    .sres::-webkit-scrollbar-corner {
      background: var(--ink);
    }
    .sr {
      padding: 9px 12px;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
    }
    .sr:last-child {
      border-bottom: 0;
    }
    .sr:hover {
      background: var(--raised);
    }
    .srh {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .srt {
      color: var(--hi);
      font: 600 12px/1.2 var(--mono);
    }
    .srsec {
      color: var(--dim);
      font: 9px/1 var(--mono);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      flex: none;
    }
    .srsnip {
      color: var(--dim);
      font: 11px/1.4 var(--mono);
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sempty {
      padding: 14px;
      color: var(--dim);
      font: 12px/1 var(--mono);
      text-align: center;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 11px;
      border: 1px solid var(--line2);
      background: transparent;
      color: var(--mid);
      cursor: pointer;
      font: 600 10.5px/1 var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .btn:hover {
      color: var(--hi);
      border-color: var(--dim);
    }
    .btn.cta {
      color: var(--upd);
      border-color: color-mix(in srgb, var(--upd) 45%, var(--line2));
    }
    .btn.cta:hover {
      color: var(--hi);
      background: color-mix(in srgb, var(--upd) 14%, transparent);
    }

    /* rail — exactly hope's rail metrics */
    .rail {
      grid-row: 2;
      grid-column: 1;
      min-height: 0;
      overflow-y: auto;
      background: var(--panel);
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
      padding: 12px 0 8px;
    }
    .grp {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      margin: 0 0 6px;
    }
    .grp.mt {
      margin-top: 16px;
    }
    .eyebrow {
      font: 600 9.5px/1 var(--mono);
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--dim);
    }
    .scope {
      color: var(--faint);
      font: 600 9px/1 var(--mono);
      letter-spacing: 0.05em;
      text-transform: none;
    }
    .scope.release {
      color: var(--upd);
    }
    .rlink {
      display: flex;
      align-items: center;
      gap: 9px;
      height: 26px;
      padding: 0 12px 0 14px;
      cursor: pointer;
      color: var(--mid);
      font: 500 12.5px/1 var(--mono);
      position: relative;
    }
    .rlink loom-link::part(anchor) {
      display: flex;
      align-items: center;
      width: 100%;
      height: 100%;
      color: inherit;
      text-decoration: none;
    }
    .rlink.nested {
      height: 24px;
      padding-left: 26px;
      color: var(--dim);
      font-size: 11.5px;
    }
    .rlink.nested::after {
      content: "";
      position: absolute;
      left: 15px;
      top: 0;
      bottom: 0;
      border-left: 1px solid var(--line);
    }
    .rlink.nested.on::after {
      border-color: color-mix(in srgb, var(--upd) 42%, var(--line));
    }
    .rlink:hover {
      background: var(--raised);
      color: var(--hi);
    }
    .rlink.on {
      background: color-mix(in srgb, var(--upd) 15%, transparent);
      color: var(--hi);
    }
    .rlink.on::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--upd);
    }
    .foot {
      margin-top: auto;
      border-top: 1px solid var(--line);
      padding: 12px 14px 4px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .foot a {
      color: var(--dim);
      font: 500 11px/1.6 var(--mono);
    }
    .foot a:hover {
      color: var(--hi);
    }

    .main {
      grid-row: 2;
      grid-column: 2;
      min-width: 0;
      min-height: 0;
      overflow-y: auto;
    }
    .main loom-outlet {
      display: block;
      min-height: 100%;
    }
    .backdrop {
      display: none;
    }

    @media (max-width: 720px) {
      :host {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: 46px minmax(0, 1fr);
      }
      .top {
        grid-column: 1;
        gap: 9px;
        padding: 0 10px;
      }
      .navtoggle {
        display: grid;
        flex: none;
      }
      .crumb,
      .top > .btn,
      .top > loom-link {
        display: none;
      }
      .brand .v {
        display: none;
      }
      .sbox {
        width: auto;
        flex: 1;
        min-width: 0;
      }
      .search {
        width: 100%;
      }
      .rail {
        position: fixed;
        z-index: 80;
        top: 46px;
        left: 0;
        bottom: 0;
        width: 264px;
        transform: translateX(-100%);
        transition: transform 0.16s ease;
      }
      .rail.open {
        transform: translateX(0);
      }
      .backdrop {
        display: block;
        position: fixed;
        z-index: 70;
        inset: 46px 0 0;
        background: var(--scrim);
      }
      .main {
        grid-row: 2;
        grid-column: 1;
      }
    }
  `,
)
export class HopeDocs extends LoomElement {
  @reactive accessor slug = slugFromPath(location.hash.slice(1) || "/");
  @reactive accessor q = ""; // docs search query
  @reactive accessor navOpen = false;
  @query(".sin") accessor sin!: HTMLInputElement | null;
  @api<PluginRelease>({
    fn: latestPluginRelease,
    staleTime: 60 * 60 * 1000,
    retry: 2,
  })
  accessor pluginRelease!: ApiState<PluginRelease>;

  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @on(RouteChanged)
  private onRouteChanged(event: RouteChanged) {
    this.slug = slugFromPath(event.path);
    this.q = "";
    this.navOpen = false;
    this.shadowRoot?.querySelector(".main")?.scrollTo(0, 0);
  }

  // "/" focuses the search from anywhere; Escape clears it.
  @on(window, "keydown")
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing =
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        (t as any).isContentEditable);
    if (e.key === "/" && !typing) {
      e.preventDefault();
      this.sin?.focus();
    } else if (e.key === "Escape" && this.q) {
      this.q = "";
      this.sin?.blur();
    }
  }
  private pick(slug: string) {
    this.q = "";
    void this.router.navigate("/" + slug);
  }

  update() {
    return (
      <>
        <div class="top">
          <button
            class="navtoggle"
            aria-label="Open navigation"
            onClick={() => (this.navOpen = !this.navOpen)}
          >
            <loom-icon name="menu" size={14}></loom-icon>
          </button>
          <div class="brand">
            <loom-link to="/">
              <b>hope</b>
              <span class="v">docs</span>
            </loom-link>
          </div>
          <div class="crumb">
            <span
              class="c"
              onClick={() => void this.router.navigate("/overview")}
            >
              docs
            </span>
            <span class="sep">/</span>
            <span
              class="c"
              onClick={() =>
                void this.router.navigate("/" + sectionEntry(this.slug))
              }
            >
              {sectionOf(this.slug)}
            </span>
            <span class="sep">/</span>
            <span class="c cur">{titleOf(this.slug)}</span>
          </div>
          <div class="sbox">
            <div class="search">
              <loom-icon name="search" size={13}></loom-icon>
              <input
                class="sin"
                type="text"
                placeholder="Search the docs…"
                value={this.q}
                onInput={(e: any) => (this.q = e.target.value)}
              />
              {this.q ? null : <span class="k">/</span>}
            </div>
            {this.q ? (
              <div class="sres">
                {searchDocs(this.q).length ? (
                  searchDocs(this.q).map((r) => (
                    <div
                      class="sr"
                      onClick={() => this.pick(r.to.replace(/^\//, ""))}
                    >
                      <div class="srh">
                        <span class="srt">{r.title}</span>
                        <span class="srsec">{r.section}</span>
                      </div>
                      <div class="srsnip">{r.summary}</div>
                    </div>
                  ))
                ) : (
                  <div class="sempty">no matches</div>
                )}
              </div>
            ) : null}
          </div>
          <a
            class="btn"
            href="https://github.com/toyz/hope"
            target="_blank"
            rel="noreferrer"
          >
            <loom-icon name="link" size={12}></loom-icon>github
          </a>
          <loom-link
            to="/getting-started"
            styles={[] as CSSStyleSheet[]}
            class="btn cta"
          >
            <loom-icon name="rocket" size={12}></loom-icon>run hope
          </loom-link>
        </div>

        <div class={"rail" + (this.navOpen ? " open" : "")}>
          {NAV.map((sec, i) => (
            <>
              <div class={"grp" + (i > 0 ? " mt" : "")}>
                <span class="eyebrow">{sec.section}</span>
                {sec.section === "plugins" ? (
                  <span class="scope release">
                    sdk{" "}
                    {this.pluginRelease.data?.version ??
                      (this.pluginRelease.loading ? "..." : "latest")}
                  </span>
                ) : (
                  <span class="scope">{sec.items.length}</span>
                )}
              </div>
              {sec.items.map((it) => (
                <div
                  class={
                    "rlink" +
                    (it.depth ? " nested" : "") +
                    (this.slug === it.slug ? " on" : "")
                  }
                >
                  <loom-link to={"/" + it.slug}>{it.title}</loom-link>
                </div>
              ))}
            </>
          ))}
          <div class="foot">
            <a
              href="https://github.com/toyz/hope"
              target="_blank"
              rel="noreferrer"
            >
              github.com/toyz/hope
            </a>
            <a
              href="https://github.com/toyz/hope/pkgs/container/hope"
              target="_blank"
              rel="noreferrer"
            >
              ghcr.io/toyz/hope
            </a>
          </div>
        </div>
        {this.navOpen ? (
          <div class="backdrop" onClick={() => (this.navOpen = false)}></div>
        ) : null}

        <div class="main">
          <loom-outlet styles={[theme, docStyles]}></loom-outlet>
        </div>
      </>
    );
  }
}
