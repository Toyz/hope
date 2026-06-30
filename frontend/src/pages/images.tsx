// Images — every local image on the daemon, cleanly: repo:tag, id, size, age,
// and whether it's in use or dangling. Sorted largest first.
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { ImageInfo } from "../contracts";
import { theme } from "../styles";

@route("/images")
@component("hope-images")
@styles(css`
  ${theme}
  :host { display: block; min-height: 100vh; background: var(--ink); }

  .bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink); }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .bar .back:hover { color: var(--hi); }
  .bar .crumb { font: 600 13px/1 var(--mono); letter-spacing: .04em; }
  .bar .grow { flex: 1; }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 24px 24px 64px; max-width: 1120px; margin: 0 auto; }

  .summary { display: flex; align-items: center; border: 1px solid var(--line); margin-bottom: 20px; }
  .summary .stat { display: flex; flex-direction: column; gap: 5px; padding: 11px 16px; border-right: 1px solid var(--line); }
  .summary .k { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
  .summary .v { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .summary .v.warnv { color: var(--warn); }

  .search { position: relative; margin-bottom: 18px; }
  .search input { width: 100%; background: var(--panel); border: 1px solid var(--line); color: var(--hi);
    font: 13px/1 var(--mono); padding: 11px 12px 11px 38px; }
  .search input::placeholder { color: var(--dim); }
  .search input:focus { outline: none; border-color: var(--line2); }
  .search .ico { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--dim); display: flex; }

  table { width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--line); }
  colgroup col.c-repo { width: 46%; }
  colgroup col.c-id { width: 16%; }
  colgroup col.c-size { width: 12%; }
  colgroup col.c-age { width: 14%; }
  colgroup col.c-use { width: 12%; }
  thead th { font: 600 10px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); }
  th.r, td.r { text-align: right; }
  tbody td { padding: 0 14px; height: 44px; border-bottom: 1px solid var(--line); font: 12.5px/1.3 var(--mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--raised); }
  td.repo { color: var(--hi); }
  td.repo .untag { color: var(--dim); }
  td.repo .extra { color: var(--dim); margin-left: 7px; font-size: 11px; }
  td.id, td.size, td.age { color: var(--mid); font-variant-numeric: tabular-nums; }
  .chip { font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 3px 7px;
    border: 1px solid var(--line2); color: var(--mid); }
  .chip.use { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .chip.dang { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .empty { padding: 40px; text-align: center; color: var(--dim); border: 1px solid var(--line); }
`)
export class ImagesPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor images: ImageInfo[] = [];
  @reactive accessor loaded = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor busy = false;

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
  }

  private load = async () => {
    this.busy = true;
    try {
      const list = await this.rpc.call<ImageInfo[]>("System", "images", []);
      // Go sends a nil tag slice as JSON null for dangling images — normalize.
      this.images = (list || []).map((i) => ({ ...i, tags: i.tags || [] }));
      this.error = "";
      this.loaded = true;
    } catch (err: any) {
      this.error = err?.message ?? "Can't list images.";
    } finally {
      this.busy = false;
    }
  };

  private visible(): ImageInfo[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.images;
    return this.images.filter((i) => (i.tags.join(" ") + " " + i.id).toLowerCase().includes(q));
  }

  private logout = () => {
    this.auth.clear();
    this.router.navigate("/login");
  };

  update() {
    const vis = this.visible();
    const total = this.images.reduce((a, i) => a + i.size, 0);
    const dangling = this.images.filter((i) => i.dangling).length;
    const unused = this.images.filter((i) => !i.in_use).length;

    return (
      <div>
        <div class="bar">
          <div class="s"><span class="back" onClick={() => this.router.navigate("/")}><loom-icon name="chevron-left" size={13}></loom-icon> fleet</span></div>
          <div class="s"><span class="crumb">images</span></div>
          <div class="grow"></div>
          <div class="s act"><button disabled={this.busy} onClick={this.load}>{this.busy ? "…" : "refresh"}</button></div>
          <div class="s act"><button onClick={this.logout}>exit</button></div>
        </div>

        <main>
          {this.error ? <div class="empty">{this.error}</div> : null}

          {this.images.length > 0 ? (
            <div class="summary">
              <span class="stat"><i class="k">images</i><i class="v">{this.images.length}</i></span>
              <span class="stat"><i class="k">total size</i><i class="v">{bytes(total)}</i></span>
              {unused > 0 ? <span class="stat"><i class="k">unused</i><i class="v warnv">{unused}</i></span> : null}
              {dangling > 0 ? <span class="stat"><i class="k">dangling</i><i class="v warnv">{dangling}</i></span> : null}
            </div>
          ) : null}

          {this.images.length > 0 ? (
            <div class="search">
              <span class="ico"><loom-icon name="search" size={15}></loom-icon></span>
              <input type="text" placeholder="Search image tags and ids…" value={this.query} onInput={(e: any) => (this.query = e.target.value)} />
            </div>
          ) : null}

          {vis.length > 0 ? (
            <table>
              <colgroup>
                <col class="c-repo" />
                <col class="c-id" />
                <col class="c-size" />
                <col class="c-age" />
                <col class="c-use" />
              </colgroup>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Image ID</th>
                  <th class="r">Size</th>
                  <th>Age</th>
                  <th>Usage</th>
                </tr>
              </thead>
              <tbody>
                {vis.map((i) => (
                  <tr>
                    <td class="repo" title={i.tags.join(", ")}>
                      {i.tags.length ? i.tags[0] : <span class="untag">&lt;untagged&gt;</span>}
                      {i.tags.length > 1 ? <span class="extra">+{i.tags.length - 1}</span> : null}
                    </td>
                    <td class="id">{shortId(i.id)}</td>
                    <td class="size r">{bytes(i.size)}</td>
                    <td class="age">{age(i.created)}</td>
                    <td>
                      {i.in_use ? <span class="chip use">in use</span> : i.dangling ? <span class="chip dang">dangling</span> : <span class="chip">unused</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : this.loaded && !this.error ? (
            <div class="empty">{this.query ? "No images match." : "No images on this daemon."}</div>
          ) : null}
        </main>
      </div>
    );
  }
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

function bytes(b: number): string {
  if (!b || b <= 0) return "0";
  const gb = b / 1073741824;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 2) + " GB";
  return (b / 1048576).toFixed(0) + " MB";
}

function age(unix: number): string {
  if (!unix) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  const d = Math.floor(s / 86400);
  if (d >= 1) return d >= 365 ? `${Math.floor(d / 365)}y` : d >= 30 ? `${Math.floor(d / 30)}mo` : `${d}d`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.floor(s / 60)}m`;
}
