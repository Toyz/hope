// <hope-plugin-surface> — the surface-agnostic renderer for a plugin's UI. It
// walks a getLayout layout node (section/tabs/row/grid/leaf) and mounts the
// view-kind components (kv/table/query/tree), action buttons, and stream slots,
// calling the plugin through Plugins.call. The SAME component renders a container
// panel now and a full page later — it doesn't care which surface hosts it.
import { LoomElement, component, styles, css, reactive, prop, watch, mount, unmount } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { PromptService, type PromptField } from "../prompt";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { registerPluginIcons } from "./plugin-icon";
import { theme } from "../styles";

interface Node {
  kind: string;
  title?: string;
  ref?: string;
  size?: number;
  fill?: boolean;
  children?: Node[];
}
interface RowAction { method: string; label: string; icon?: string; danger?: boolean }
interface ViewDesc { method: string; label: string; kind: string; icon?: string; lang?: string; default?: string; row_method?: string; row_actions?: RowAction[] }
interface ActionDesc { method: string; label: string; icon?: string; fields?: PromptField[]; danger?: boolean }
interface StreamDesc { method: string; label: string; kind: string; icon?: string }
interface Schema { views?: ViewDesc[]; actions?: ActionDesc[]; streams?: StreamDesc[]; icons?: Record<string, string> }
export interface Surface { key: string; name: string; title?: string; node: Node; schema: Schema; param?: Record<string, any> }

type Cell = { loading: boolean; error?: string; data?: any };
type TableState = { page: number; sort: number; dir: 1 | -1; filter: string };
const TABLE_PAGE = 100; // rows per page — client-side windowing so big results don't blow up the DOM

@component("hope-plugin-surface")
@styles(theme, css`
  :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .sec { padding: 4px 0 10px; display: flex; flex-direction: column; min-height: 0; }
  .tabsw { display: flex; flex-direction: column; min-height: 0; }
  /* a node (or its ancestor chain to a fill leaf) grows to fill remaining height */
  .grow { flex: 1 1 0; min-height: 0; }
  .leaf.grow { display: flex; flex-direction: column; }
  .leaf.grow .gwrap { flex: 1 1 0; min-height: 0; max-height: none; }
  .sect { padding: 12px 16px 8px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; padding: 0 4px; }
  .row > * { flex: 1 1 240px; min-width: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; padding: 0 4px; }

  .tabs { display: flex; gap: 2px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .tb { padding: 8px 12px; color: var(--dim); cursor: pointer; font: 600 10.5px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tb:hover { color: var(--mid); }
  .tb.on { color: var(--hi); border-bottom-color: var(--upd); }

  .leaf { padding: 6px 16px 12px; min-width: 0; }
  .llabel { display: flex; align-items: center; gap: 10px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; margin-bottom: 8px; }
  .sbtn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; background: transparent; border: 1px solid var(--line); color: var(--dim); cursor: pointer; font: 600 9px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .sbtn:hover { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .sbtn.on { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line2)); }
  .msg { color: var(--dim); font: 12px/1.5 var(--mono); padding: 6px 0; }
  .msg.bad { color: var(--bad); }

  table.g { width: 100%; border-collapse: collapse; font: 12px/1.5 var(--mono); }
  table.g th { position: sticky; top: 0; background: var(--panel); text-align: left; padding: 7px 12px; border-bottom: 1px solid var(--line); color: var(--dim); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  table.g td { padding: 6px 12px; border-bottom: 1px solid var(--line); color: var(--mid); vertical-align: top; }
  .gwrap { max-height: 320px; overflow: auto; border: 1px solid var(--line); }
  .tblwrap { display: flex; flex-direction: column; min-height: 0; }
  .leaf.grow .tblwrap { flex: 1 1 0; }
  .leaf.grow .tblwrap .gwrap { flex: 1 1 0; max-height: none; }
  .tbar { display: flex; align-items: center; gap: 12px; padding: 6px 0 8px; }
  .tfilter { flex: 0 1 220px; padding: 5px 9px; background: var(--ink); border: 1px solid var(--line); color: var(--hi); font: 12px/1.3 var(--mono); }
  .tfilter:focus { outline: none; border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .tcount { color: var(--dim); font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .tpager { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
  .pnum { color: var(--dim); font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .pbtn { display: inline-flex; padding: 3px; background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer; }
  .pbtn:hover:not(:disabled) { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .pbtn:disabled { opacity: .35; cursor: default; }
  th.srt { cursor: pointer; user-select: none; }
  th.srt:hover { color: var(--mid); }
  .sarrow { margin-left: 4px; color: var(--upd); }

  .qrun { display: flex; justify-content: flex-end; margin: 8px 0; }

  tr.clk { cursor: pointer; }
  tr.clk:hover td { background: color-mix(in srgb, var(--upd) 8%, transparent); color: var(--hi); }
  td.rax, th.rax { text-align: right; white-space: nowrap; width: 1%; }
  .rowbtn { display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; padding: 2px 7px; background: transparent; border: 1px solid var(--line); color: var(--dim); cursor: pointer; font: 600 9px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
  .rowbtn:hover { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .rowbtn.bad:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line2)); }

  .ovl { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, var(--ink) 68%, transparent); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .rowmodal { display: flex; flex-direction: column; width: min(560px, 100%); max-height: 82vh; background: var(--panel); border: 1px solid var(--line2); box-shadow: 0 18px 50px rgba(0,0,0,.5); }
  .rmhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .rmt { color: var(--hi); font: 600 13px/1.2 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rmx { display: inline-flex; padding: 4px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .rmx:hover { color: var(--hi); }
  .rmbody { padding: 12px 16px; overflow: auto; min-height: 0; }
  .rmfoot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); }

  ul.tree { list-style: none; margin: 0; padding: 0 0 0 4px; font: 12px/1.7 var(--mono); }
  ul.tree ul { list-style: none; margin: 0; padding-left: 16px; border-left: 1px solid var(--line); }
  ul.tree li { color: var(--mid); }
  ul.tree li > .lb { color: var(--hi); }

  .streams { display: flex; gap: 26px; flex-wrap: wrap; padding: 4px 0; }
  .stream { display: inline-flex; flex-direction: column; gap: 6px; padding: 8px 0; }
  .stream .k { color: var(--dim); font: 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .08em; }
  .stream .v { color: var(--upd); font: 600 20px/1 var(--mono); font-variant-numeric: tabular-nums; }

  .spark { display: flex; align-items: center; gap: 14px; padding: 4px 0; }
  .sparksvg { width: 240px; height: 44px; overflow: visible; }
  .sfill { fill: color-mix(in srgb, var(--upd) 14%, transparent); stroke: none; }
  .sline { fill: none; stroke: var(--upd); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .sdot { fill: var(--upd); }
  .sval { color: var(--upd); font: 600 20px/1 var(--mono); font-variant-numeric: tabular-nums; }
`)
export class HopePluginSurface extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(ToastService) accessor toast!: ToastService;

  @prop accessor host = "";
  @prop accessor surface: Surface | null = null;
  @prop accessor reloadTick = 0; // bump to force a view refetch (e.g. on tab re-entry)

  @reactive accessor cells: Record<string, Cell> = {};
  @reactive accessor tabSel: Record<string, number> = {};
  @reactive accessor queryText: Record<string, string> = {};
  @reactive accessor tableState: Record<string, TableState> = {}; // per-table filter/sort/page
  @reactive accessor streamData: Record<string, any> = {};
  @reactive accessor streamHist: Record<string, number[]> = {}; // numeric history for sparklines
  @reactive accessor streamOn: Record<string, boolean> = {}; // which streams are live
  // row-detail modal: the returned detail plus the clicked row + its actions (so the
  // modal footer can offer the same row actions).
  @reactive accessor modal: { title: string; data: any; row?: Record<string, any>; actions?: RowAction[]; view?: string } | null = null;

  private views: Record<string, ViewDesc> = {};
  private actions: Record<string, ActionDesc> = {};
  private streams: Record<string, StreamDesc> = {};
  private streamAborts = new Map<string, AbortController>(); // one controller per live stream
  private curKey = ""; // the surface we last built for

  @mount onMount() { this.rebuild(); }
  @watch("surface") onSurface() { this.rebuild(); }
  @unmount onUnmount() { this.stopAll(); }

  // The host bumps nonce when this surface is shown again (tab re-entry) — refetch
  // the views so a stale/failed load self-heals, without touching live streams.
  @watch("reloadTick") onReload() {
    const s = this.surface;
    if (!s) return;
    for (const ref of this.leafRefs(s.node)) if (this.views[ref]) void this.fetch(ref);
  }

  private stopAll() {
    for (const c of this.streamAborts.values()) c.abort();
    this.streamAborts.clear();
    this.streamOn = {};
  }

  private rebuild() {
    const s = this.surface;
    const key = s ? s.key : "";
    // Only rebuild when the surface ACTUALLY changes. The host re-renders (stats
    // poll) re-set this prop with the same value; a naive rebuild would tear down +
    // re-fetch every time.
    if (s && key === this.curKey) return;
    this.curKey = key;
    this.stopAll(); // drop any live streams from the previous surface
    this.views = {};
    this.actions = {};
    this.streams = {};
    this.cells = {};
    this.streamData = {};
    this.streamHist = {};
    if (!s) return;
    registerPluginIcons(s.key, s.schema.icons); // sanitize + namespace this plugin's icons
    for (const v of s.schema.views || []) this.views[v.method] = v;
    for (const a of s.schema.actions || []) this.actions[a.method] = a;
    for (const st of s.schema.streams || []) this.streams[st.method] = st;
    // Fetch views eagerly; streams are OPT-IN (a live connection is precious —
    // one held stream can starve the dev proxy / the browser's per-host limit).
    for (const ref of this.leafRefs(s.node)) {
      if (this.views[ref]) void this.fetch(ref);
    }
  }

  // startStream opens a live subscription for one stream method (explicit user
  // action). Each frame updates the value; the per-stream AbortController tears it
  // down on stop / surface change / unmount, and hope cancels the plugin stream.
  private startStream = async (method: string) => {
    const s = this.surface;
    if (!s || this.streamAborts.has(method)) return;
    const ctrl = new AbortController();
    this.streamAborts.set(method, ctrl);
    this.streamOn = { ...this.streamOn, [method]: true };
    this.streamHist = { ...this.streamHist, [method]: [] }; // fresh history per live session
    try {
      for await (const frame of this.rpc.streamWithSignal<any>("Stream", "pluginStream", [s.key, method], ctrl.signal)) {
        if (frame?.type === "data") {
          this.streamData = { ...this.streamData, [method]: frame.data };
          const val = this.pickNumeric(frame.data);
          if (val != null) this.streamHist = { ...this.streamHist, [method]: [...(this.streamHist[method] || []), val].slice(-60) };
        } else if (frame?.type === "error") this.streamData = { ...this.streamData, [method]: { error: frame.error } };
      }
    } catch {
      /* aborted or transport closed */
    } finally {
      if (this.streamAborts.get(method) === ctrl) this.streamAborts.delete(method);
      this.streamOn = { ...this.streamOn, [method]: false };
    }
  };

  private stopStream = (method: string) => {
    this.streamAborts.get(method)?.abort();
    this.streamAborts.delete(method);
    this.streamOn = { ...this.streamOn, [method]: false };
  };

  private leafRefs(n: Node | undefined, acc: string[] = []): string[] {
    if (!n) return acc;
    if (n.kind === "leaf" && n.ref) acc.push(n.ref);
    for (const c of n.children || []) this.leafRefs(c, acc);
    return acc;
  }

  // callArgs merges the page's param (from a dynamic page) under the call's own
  // args, so a shared view/action receives the selected page's argument (e.g. the
  // table name) automatically.
  private callArgs(extra?: any): any {
    const merged = { ...(this.surface?.param || {}), ...(extra || {}) };
    return Object.keys(merged).length ? merged : undefined;
  }

  private async fetch(method: string, extra?: any) {
    const s = this.surface;
    if (!s) return;
    this.cells = { ...this.cells, [method]: { loading: true } };
    try {
      const data = await this.rpc.call<any>("Plugins", "call", [{ key: s.key, method, args: this.callArgs(extra) }]);
      this.cells = { ...this.cells, [method]: { loading: false, data } };
    } catch (e: any) {
      this.cells = { ...this.cells, [method]: { loading: false, error: e?.message ?? "call failed" } };
    }
  }

  private runAction = async (a: ActionDesc) => {
    const s = this.surface;
    if (!s) return;
    let values: any = undefined;
    if (a.fields && a.fields.length) {
      const v = await this.prompt.ask({ title: a.label, submitLabel: "Run", fields: a.fields });
      if (!v) return;
      values = v;
    }
    // Danger actions confirm before running (author flagged them destructive). The
    // field prompt, if any, comes first so the confirm is the final gate.
    if (a.danger && !(await this.confirm.ask({ title: a.label, message: `Run "${a.label}"? This is a destructive action.`, danger: true, confirmLabel: a.label }))) return;
    try {
      const res = await this.rpc.call<any>("Plugins", "call", [{ key: s.key, method: a.method, args: this.callArgs(values), audit: true, danger: !!a.danger }]);
      this.toast.ok(res && typeof res === "object" && res.message ? String(res.message) : `${a.label} ok`);
    } catch (e: any) {
      this.toast.error(`${a.label} — ${e?.message ?? "failed"}`);
    }
  };

  // ── rendering ──
  // hasFill reports whether a node or any descendant wants to fill height, so the
  // whole chain from the surface root down to a fill leaf gets `grow` (flex:1).
  private hasFill(n: Node): boolean {
    return !!n.fill || (n.children || []).some((c) => this.hasFill(c));
  }

  private renderNode(n: Node, idKey: string): any {
    const g = this.hasFill(n) ? " grow" : "";
    switch (n.kind) {
      case "section":
        return (
          <div class={"sec" + g}>
            {n.title ? <div class="sect">{n.title}</div> : null}
            {(n.children || []).map((c, i) => this.renderNode(c, idKey + "." + i))}
          </div>
        );
      case "tabs": {
        const kids = n.children || [];
        const sel = this.tabSel[idKey] ?? 0;
        return (
          <div class={"tabsw" + g}>
            <div class="tabs">
              {kids.map((c, i) => (
                <div class={"tb" + (i === sel ? " on" : "")} onClick={() => (this.tabSel = { ...this.tabSel, [idKey]: i })}>
                  {c.title || this.labelOf(c) || "tab"}
                </div>
              ))}
            </div>
            {kids[sel] ? this.renderNode(kids[sel], idKey + "." + sel) : null}
          </div>
        );
      }
      case "row":
        return <div class={"row" + g}>{(n.children || []).map((c, i) => this.renderNode(c, idKey + "." + i))}</div>;
      case "grid":
        return <div class={"grid" + g}>{(n.children || []).map((c, i) => this.renderNode(c, idKey + "." + i))}</div>;
      case "leaf":
        return this.renderLeaf(n.ref || "", !!n.fill);
      default:
        return null;
    }
  }

  // leafIcon renders a plugin-declared icon (sanitized + plugin-namespaced), or
  // nothing. Built-in names fall through to loom-icon inside hope-plugin-icon.
  private leafIcon(name?: string) {
    if (!name) return null;
    return <hope-plugin-icon plugin={this.surface?.key} name={name} size={12}></hope-plugin-icon>;
  }

  private labelOf(n: Node): string {
    const r = n.ref || "";
    return this.views[r]?.label || this.actions[r]?.label || this.streams[r]?.label || "";
  }

  private renderLeaf(ref: string, fill = false) {
    const g = fill ? " grow" : "";
    if (this.actions[ref]) {
      const a = this.actions[ref];
      return <div class="leaf"><hope-button size="sm" tone={a.danger ? "danger" : "primary"} onClick={() => this.runAction(a)}>{a.label}</hope-button></div>;
    }
    if (this.streams[ref]) {
      const st = this.streams[ref];
      const on = !!this.streamOn[ref];
      const d = this.streamData[ref];
      return (
        <div class="leaf">
          <div class="llabel">
            {st.label}
            {on
              ? <button class="sbtn on" onClick={() => this.stopStream(ref)}><loom-icon name="stop" size={11}></loom-icon>stop</button>
              : <button class="sbtn" onClick={() => this.startStream(ref)}><loom-icon name="play" size={11}></loom-icon>live</button>}
          </div>
          {on ? (d != null ? this.renderStream(d, st.kind, ref) : <div class="msg">connecting…</div>) : <div class="msg">not live — click live to stream</div>}
        </div>
      );
    }
    const v = this.views[ref];
    if (!v) return null;
    const cell = this.cells[ref];
    return (
      <div class={"leaf" + g}>
        <div class="llabel">{this.leafIcon(v.icon)}{v.label}</div>
        {v.kind === "query" ? this.renderQuery(v, cell) : cell?.loading ? <div class="msg">loading…</div> : cell?.error ? <div class="msg bad">{cell.error}</div> : this.renderView(v, cell?.data)}
      </div>
    );
  }

  private renderView(v: ViewDesc, data: any) {
    if (data == null) return <div class="msg">no data</div>;
    switch (v.kind) {
      case "kv":
        return <hope-kvlist data={this.strMap(data)}></hope-kvlist>;
      case "table":
      case "query":
        return this.renderTable(data, v);
      case "tree":
        return this.renderTree(data?.nodes || []);
      default:
        return <div class="msg">unsupported view</div>;
    }
  }

  // queryDefault fills the view's Default template with the page param, e.g.
  // "select * from {table}" -> "select * from table_00" on that table's page.
  private queryDefault(v: ViewDesc): string {
    const p = this.surface?.param || {};
    return (v.default || "").replace(/\{(\w+)\}/g, (_, k) => (p[k] != null ? String(p[k]) : ""));
  }

  private renderQuery(v: ViewDesc, cell: Cell | undefined) {
    const text = this.queryText[v.method] ?? this.queryDefault(v);
    return (
      <div>
        <hope-code lang={v.lang || "sql"} value={text} placeholder="enter a query…" onInput={(e: any) => (this.queryText = { ...this.queryText, [v.method]: e.detail })}></hope-code>
        <div class="qrun">
          <hope-button size="sm" tone="primary" icon="play" onClick={() => this.fetch(v.method, { input: this.queryText[v.method] ?? this.queryDefault(v) })}>run</hope-button>
        </div>
        {cell?.loading ? <div class="msg">running…</div> : cell?.error ? <div class="msg bad">{cell.error}</div> : cell?.data ? this.renderTable(cell.data, v) : <div class="msg">no results yet</div>}
      </div>
    );
  }

  private tableSt(key: string): TableState {
    return this.tableState[key] || { page: 0, sort: -1, dir: 1, filter: "" };
  }
  private setTable(key: string, patch: Partial<TableState>) {
    this.tableState = { ...this.tableState, [key]: { ...this.tableSt(key), ...patch } };
  }
  // cmpCells is numeric-aware: numbers sort as numbers, everything else as strings.
  private cmpCells(a: any, b: any): number {
    const na = typeof a === "number" ? a : parseFloat(a);
    const nb = typeof b === "number" ? b : parseFloat(b);
    if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na - nb;
    return this.cellStr(a).localeCompare(this.cellStr(b));
  }

  // renderTable draws {columns, rows} with client-side filter, column sort, and
  // pagination (so a 5000-row result doesn't blow up the DOM). If the view declares
  // row_method the rows are clickable (detail modal); row_actions add a trailing
  // action cell. Columns are fully dynamic — whatever the plugin returns.
  private renderTable(data: any, v?: ViewDesc) {
    const cols: string[] = data?.columns || [];
    const rows: any[][] = data?.rows || [];
    const onRow: string | undefined = v?.row_method || data?.on_row || data?.onRow;
    const acts: RowAction[] = v?.row_actions || data?.row_actions || [];
    if (!cols.length && !rows.length) return <div class="msg">empty</div>;

    const key = v?.method || "_t";
    const st = this.tableSt(key);

    // filter -> sort -> page over row INDICES (keeps the original rows intact).
    let idx = rows.map((_, i) => i);
    if (st.filter) {
      const f = st.filter.toLowerCase();
      idx = idx.filter((i) => rows[i].some((c) => this.cellStr(c).toLowerCase().includes(f)));
    }
    if (st.sort >= 0) idx.sort((a, b) => this.cmpCells(rows[a][st.sort], rows[b][st.sort]) * st.dir);

    const total = idx.length;
    const pages = Math.max(1, Math.ceil(total / TABLE_PAGE));
    const page = Math.min(st.page, pages - 1);
    const shown = idx.slice(page * TABLE_PAGE, page * TABLE_PAGE + TABLE_PAGE);
    const toolbar = rows.length > TABLE_PAGE || st.filter;

    return (
      <div class="tblwrap">
        {toolbar ? (
          <div class="tbar">
            <input class="tfilter" placeholder="filter…" value={st.filter}
              onInput={(e: any) => this.setTable(key, { filter: e.target.value, page: 0 })} />
            <span class="tcount">{total.toLocaleString()}{total !== rows.length ? ` / ${rows.length.toLocaleString()}` : ""} rows</span>
            {pages > 1 ? (
              <span class="tpager">
                <button class="pbtn" disabled={page <= 0} onClick={() => this.setTable(key, { page: page - 1 })}><loom-icon name="chevron-left" size={13}></loom-icon></button>
                <span class="pnum">{page + 1} / {pages}</span>
                <button class="pbtn" disabled={page >= pages - 1} onClick={() => this.setTable(key, { page: page + 1 })}><loom-icon name="chevron-right" size={13}></loom-icon></button>
              </span>
            ) : null}
          </div>
        ) : null}
        <div class="gwrap">
          <table class="g">
            <thead><tr>
              {cols.map((c, ci) => (
                <th class="srt" onClick={() => this.setTable(key, { sort: ci, dir: st.sort === ci ? (st.dir === 1 ? -1 : 1) as 1 | -1 : 1 })}>
                  {c}{st.sort === ci ? <span class="sarrow">{st.dir === 1 ? "↑" : "↓"}</span> : null}
                </th>
              ))}
              {acts.length ? <th class="rax"></th> : null}
            </tr></thead>
            <tbody>{shown.map((i) => {
              const r = rows[i];
              return (
                <tr class={onRow ? "clk" : ""} onClick={onRow ? () => this.openRow(onRow, cols, r, acts, v?.method) : undefined}>
                  {r.map((cell) => <td>{this.cellStr(cell)}</td>)}
                  {acts.length ? (
                    <td class="rax">{acts.map((a) => (
                      <button class={"rowbtn" + (a.danger ? " bad" : "")} onClick={(e: any) => { e.stopPropagation(); void this.runRowAction(a, cols, r, v?.method); }}>
                        {a.icon ? <hope-plugin-icon plugin={this.surface?.key} name={a.icon} size={11}></hope-plugin-icon> : null}{a.label}
                      </button>
                    ))}</td>
                  ) : null}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
    );
  }

  private rowObj(cols: string[], row: any[]): Record<string, any> {
    const obj: Record<string, any> = {};
    cols.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  }

  // Clicking a row calls the table's row_method with {row: {col: val}} and shows the
  // plugin's returned detail (kv or table) in a modal, carrying the row's actions.
  private openRow = async (method: string, cols: string[], row: any[], acts?: RowAction[], viewMethod?: string) => {
    const s = this.surface;
    if (!s) return;
    const obj = this.rowObj(cols, row);
    try {
      const detail = await this.rpc.call<any>("Plugins", "call", [{ key: s.key, method, args: this.callArgs({ row: obj }) }]);
      this.modal = { title: String(obj[cols[0]] ?? "Row"), data: detail, row: obj, actions: acts, view: viewMethod };
    } catch (e: any) {
      this.toast.error(`row — ${e?.message ?? "failed"}`);
    }
  };

  // runRowAction invokes an author's row action with {row: {col: val}}. Danger
  // actions confirm first; on success the owning table refetches (e.g. a deleted
  // row disappears) and any open row modal closes.
  private runRowAction = async (a: RowAction, cols: string[], row: any[], viewMethod?: string) => {
    const s = this.surface;
    if (!s) return;
    const obj = this.rowObj(cols, row);
    if (a.danger && !(await this.confirm.ask({ title: a.label, message: `${a.label} — ${String(obj[cols[0]] ?? "this row")}?`, danger: true }))) return;
    try {
      const res = await this.rpc.call<any>("Plugins", "call", [{ key: s.key, method: a.method, args: this.callArgs({ row: obj }), audit: true, danger: !!a.danger }]);
      this.toast.ok(res && typeof res === "object" && res.message ? String(res.message) : `${a.label} ok`);
      this.modal = null;
      if (viewMethod && this.views[viewMethod]) void this.fetch(viewMethod, this.views[viewMethod].kind === "query" ? { input: this.queryText[viewMethod] ?? "" } : undefined);
    } catch (e: any) {
      this.toast.error(`${a.label} — ${e?.message ?? "failed"}`);
    }
  };

  private renderDetail(data: any): any {
    if (data && typeof data === "object" && Array.isArray(data.columns)) return this.renderTable(data);
    return <hope-kvlist data={this.strMap(data)}></hope-kvlist>;
  }

  // pickNumeric extracts a value to plot from a stream frame: prefer y, then count,
  // then the first numeric field — so counter and series streams both spark.
  private pickNumeric(d: any): number | null {
    if (typeof d === "number") return d;
    if (d && typeof d === "object") {
      for (const k of ["y", "value", "count", "rps"]) if (typeof d[k] === "number") return d[k];
      for (const k of Object.keys(d)) if (typeof d[k] === "number") return d[k];
    }
    return null;
  }

  // renderSparkline draws a min-max-normalized area+line from the numeric history,
  // with an emphasized endpoint — the live shape of a counter/series stream.
  private renderSparkline(vals: number[], latest: any) {
    const W = 240, H = 44, pad = 3;
    if (vals.length < 2) return <div class="msg">collecting…</div>;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) hi = lo + 1;
    const x = (i: number) => pad + (i / (vals.length - 1)) * (W - 2 * pad);
    const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${pad},${H - pad} ${pts} ${(W - pad).toFixed(1)},${H - pad}`;
    const ex = x(vals.length - 1), ey = y(vals[vals.length - 1]);
    return (
      <div class="spark">
        <svg viewBox={`0 0 ${W} ${H}`} class="sparksvg">
          <polygon points={area} class="sfill"></polygon>
          <polyline points={pts} class="sline"></polyline>
          <circle cx={ex} cy={ey} r={2.5} class="sdot"></circle>
        </svg>
        <span class="sval">{this.cellStr(latest)}</span>
      </div>
    );
  }

  private renderStream(d: any, kind?: string, method?: string) {
    if (d && typeof d === "object" && d.error) return <div class="msg bad">{String(d.error)}</div>;
    if ((kind === "series" || kind === "counter") && method) {
      const hist = this.streamHist[method] || [];
      if (hist.length >= 2) return this.renderSparkline(hist, this.pickNumeric(d));
    }
    if (d && typeof d === "object") {
      return <div class="streams">{Object.keys(d).map((k) => <div class="stream"><span class="k">{k}</span><span class="v">{this.cellStr(d[k])}</span></div>)}</div>;
    }
    return <div class="stream"><span class="v">{this.cellStr(d)}</span></div>;
  }

  private renderTree(nodes: any[]): any {
    if (!nodes.length) return <div class="msg">empty</div>;
    const walk = (ns: any[]): any => (
      <ul class="tree">
        {ns.map((n) => (
          <li><span class="lb">{n.label}</span>{Array.isArray(n.children) && n.children.length ? walk(n.children) : null}</li>
        ))}
      </ul>
    );
    return walk(nodes);
  }

  private strMap(o: any): Record<string, string> {
    const out: Record<string, string> = {};
    if (o && typeof o === "object") for (const k of Object.keys(o)) out[k] = this.cellStr(o[k]);
    return out;
  }
  private cellStr(v: any): string {
    if (v == null) return "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  private closeModal = () => (this.modal = null);

  private renderModal() {
    const m = this.modal;
    if (!m) return null;
    return (
      <div class="ovl" onClick={this.closeModal}>
        <div class="rowmodal" onClick={(e: any) => e.stopPropagation()}>
          <div class="rmhead">
            <span class="rmt">{m.title}</span>
            <button class="rmx" onClick={this.closeModal}><loom-icon name="x" size={13}></loom-icon></button>
          </div>
          <div class="rmbody">{this.renderDetail(m.data)}</div>
          {m.actions && m.actions.length && m.row ? (
            <div class="rmfoot">{m.actions.map((a) => (
              <hope-button size="sm" tone={a.danger ? "danger" : "primary"} icon={a.icon}
                onClick={() => this.runModalAction(a, m)}>{a.label}</hope-button>
            ))}</div>
          ) : null}
        </div>
      </div>
    );
  }

  // runModalAction runs a row action from the modal footer (same row context).
  private runModalAction = (a: RowAction, m: { row?: Record<string, any>; view?: string }) => {
    if (!m.row) return;
    const cols = Object.keys(m.row);
    void this.runRowAction(a, cols, cols.map((c) => m.row![c]), m.view);
  };

  update() {
    const s = this.surface;
    if (!s || !s.node) return <div class="msg" style="padding:16px">no panel</div>;
    return <>{this.renderNode(s.node, "r")}{this.renderModal()}</>;
  }
}
