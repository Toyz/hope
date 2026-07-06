// <hope-plugin-surface> — the surface-agnostic renderer for a plugin's UI. It
// walks a getLayout layout node (section/tabs/row/grid/leaf) and mounts the
// view-kind components (kv/table/query/tree), action buttons, and stream slots,
// calling the plugin through Plugins.call. The SAME component renders a container
// panel now and a full page later — it doesn't care which surface hosts it.
import { LoomElement, component, styles, css, reactive, prop, watch, mount, unmount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { PromptService, type PromptField } from "../prompt";
import { ConfirmService } from "../confirm";
import { ToastService } from "../toast";
import { registerPluginIcons } from "./plugin-icon";
import { runPluginAction } from "../plugin-run";
import { theme } from "../styles";

interface Node {
  kind: string;
  title?: string;
  ref?: string;
  size?: number;
  fill?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  children?: Node[];
}
interface RowAction { method: string; label: string; icon?: string; danger?: boolean; fields?: PromptField[] }
interface Facet { key: string; label: string; options: { label: string; value: string }[] }
interface ViewDesc { method: string; label: string; kind: string; icon?: string; lang?: string; default?: string; row_method?: string; row_detail_button?: boolean; row_actions?: RowAction[]; page_size?: number; edit_method?: string; edit_columns?: string[]; server?: boolean; refresh?: boolean; refresh_interval?: number; facets?: Facet[] }
interface ActionDesc { method: string; label: string; icon?: string; fields?: PromptField[]; danger?: boolean }
interface StreamDesc { method: string; label: string; kind: string; icon?: string }
interface Schema { views?: ViewDesc[]; actions?: ActionDesc[]; streams?: StreamDesc[]; icons?: Record<string, string> }
export interface Surface { key: string; name: string; title?: string; node: Node; schema: Schema; actions?: string[]; breadcrumbs?: { label: string; to?: string }[]; param?: Record<string, any> }

type Cell = { loading: boolean; error?: string; data?: any };
type TableState = { page: number; sort: number; dir: 1 | -1; filter: string };
const TABLE_PAGE = 100; // default rows per page when a view doesn't declare page_size

@component("hope-plugin-surface")
@styles(theme, css`
  :host { display: block; }
  /* Stacked sections must keep their natural height — flex-shrink would compress
     them below their content and overlap the next section. Plain block flow stacks
     them; the plugin page owns the scroll. */
  .sec { padding: 4px 0 10px; }
  .tabsw { display: flex; flex-direction: column; }
  /* "fill" no longer means flex-grow (that fights a scrolling page). A filled table
     just gets a tall internal scroll (see .leaf.grow .gwrap); the page scrolls
     between sections. .grow/.leaf.grow are markers used by those selectors. */
  .sect { display: flex; align-items: center; gap: 10px; padding: 12px 16px 8px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .sect.clp { cursor: pointer; user-select: none; }
  .sect.clp:hover { color: var(--mid); }
  .sbtn.rfr { padding: 2px 5px; }
  .ptext { margin: 0; padding: 12px 16px; max-height: 62vh; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--ink); border: 1px solid var(--line); color: var(--mid); font: 12px/1.55 var(--mono); }
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

  /* separate (not collapse): with border-collapse a sticky th's border doesn't move
     with it, so scrolled rows bleed through the header seam. Borders via box-shadow
     so they travel with the sticky header. */
  table.g { width: 100%; border-collapse: separate; border-spacing: 0; font: 12px/1.5 var(--mono); }
  table.g th { position: sticky; top: 0; z-index: 2; background: var(--panel); text-align: left; padding: 7px 12px; box-shadow: inset 0 -1px 0 var(--line); color: var(--dim); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  table.g td { padding: 6px 12px; border-bottom: 1px solid var(--line); color: var(--mid); vertical-align: top; }

  /* rich cell types */
  .pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font: 600 10px/1.6 var(--mono); letter-spacing: .04em; background: color-mix(in srgb, var(--mid) 15%, transparent); color: var(--hi); }
  .pill.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
  .pill.warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .pill.bad { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
  .pill.info, .pill.upd { background: color-mix(in srgb, var(--upd) 18%, transparent); color: var(--upd); }
  .clink { color: var(--upd); cursor: pointer; text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--upd) 40%, transparent); }
  .clink:hover { color: var(--hi); border-bottom-color: var(--hi); }
  .ctime { color: var(--mid); }
  .cnum { font-variant-numeric: tabular-nums; color: var(--hi); }
  .ccode { font: 11.5px/1.5 var(--mono); background: var(--ink); padding: 1px 5px; color: var(--upd); }
  .cprog { display: inline-block; width: 90px; height: 8px; background: var(--line2); border-radius: 999px; overflow: hidden; vertical-align: middle; }
  .cprog i { display: block; height: 100%; background: var(--upd); }
  .gwrap { max-height: 320px; overflow: auto; border: 1px solid var(--line); }
  .tblwrap { display: flex; flex-direction: column; min-height: 0; }
  /* A filled table gets a tall internal scroll (not flex-grow) so it stays usable
     without collapsing siblings; the page scrolls between sections. */
  .leaf.grow .gwrap, .leaf.grow .tblwrap .gwrap { max-height: 62vh; }
  .tbar { display: flex; align-items: center; gap: 12px; padding: 6px 0 8px; }
  .tfilter { flex: 0 1 220px; padding: 5px 9px; background: var(--ink); border: 1px solid var(--line); color: var(--hi); font: 12px/1.3 var(--mono); }
  .tfilter:focus { outline: none; border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .tcount { color: var(--dim); font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .tfacet { padding: 5px 8px; background: var(--ink); border: 1px solid var(--line); color: var(--mid); font: 11px/1.2 var(--mono); cursor: pointer; }
  .tfacet:hover { border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .tfacet:focus { outline: none; border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .tpager { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
  .pnum { color: var(--dim); font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .pbtn { display: inline-flex; padding: 3px; background: transparent; border: 1px solid var(--line); color: var(--mid); cursor: pointer; }
  .pbtn:hover:not(:disabled) { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); }
  .pbtn:disabled { opacity: .35; cursor: default; }
  th.srt { cursor: pointer; user-select: none; }
  th.srt:hover { color: var(--mid); }
  .sarrow { margin-left: 4px; color: var(--upd); vertical-align: middle; }
  .sarrow.off { visibility: hidden; } /* reserve the space so sorting doesn't shift column widths */

  .stats2 { display: flex; flex-wrap: wrap; gap: 26px; padding: 4px 0; }
  .statb { display: flex; flex-direction: column; gap: 5px; padding: 4px 0 4px 0; border-left: 2px solid transparent; padding-left: 0; }
  .statb.ok { border-left-color: var(--ok); padding-left: 12px; } .statb.warn { border-left-color: var(--warn); padding-left: 12px; }
  .statb.bad { border-left-color: var(--bad); padding-left: 12px; } .statb.info { border-left-color: var(--upd); padding-left: 12px; }
  .stlabel { display: flex; align-items: center; gap: 6px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .stval { color: var(--hi); font: 600 26px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .stunit { color: var(--dim); font-size: 13px; }
  .stsub { color: var(--dim); font: 11px/1.3 var(--mono); }

  .qrun { display: flex; justify-content: flex-end; margin: 8px 0; }

  td.ecell { cursor: text; }
  td.ecell:hover { background: color-mix(in srgb, var(--upd) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--upd) 35%, transparent); }
  td.editing { padding: 0; }
  .cellin { width: 100%; box-sizing: border-box; padding: 6px 12px; background: var(--ink); border: 1px solid var(--upd); color: var(--hi); font: 12px/1.5 var(--mono); }
  .cellin:focus { outline: none; }
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

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; padding: 4px 0; }
  .pcard { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .pcard.lk { cursor: pointer; transition: border-color .12s ease, background .12s ease; }
  .pcard.lk:hover { border-color: color-mix(in srgb, var(--upd) 45%, var(--line2)); background: color-mix(in srgb, var(--upd) 5%, var(--panel)); }
  .pcard.ok { border-left: 2px solid var(--ok); } .pcard.warn { border-left: 2px solid var(--warn); }
  .pcard.bad { border-left: 2px solid var(--bad); } .pcard.info { border-left: 2px solid var(--upd); }
  .pchead { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .pctitle { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .pct { color: var(--hi); font: 600 13px/1.2 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pcsub { color: var(--dim); font: 10.5px/1.2 var(--mono); }
  .pcfields { display: flex; flex-direction: column; gap: 5px; }
  .pcf { display: flex; justify-content: space-between; gap: 12px; font: 11.5px/1.4 var(--mono); }
  .pcfl { color: var(--dim); } .pcfv { color: var(--mid); text-align: right; min-width: 0; }

  .chart { padding: 6px 0; }
  /* An explicit height reserves real space; an inline SVG with height:auto or only
     aspect-ratio collapses to ~0 in a flex column and the next section overlaps it.
     preserveAspectRatio (default) scales the viewBox content to fit. */
  .chartsvg { display: block; width: 100%; max-width: 560px; height: 240px; }
  .cgrid { stroke: var(--line); stroke-width: 1; }
  .cyl { fill: var(--dim); font: 9px/1 var(--mono); text-anchor: end; }
  .cxl { fill: var(--dim); font: 9px/1 var(--mono); text-anchor: middle; }
  .clegend { display: flex; gap: 16px; flex-wrap: wrap; padding: 6px 0 0 40px; }
  .cleg { display: inline-flex; align-items: center; gap: 6px; color: var(--mid); font: 10px/1 var(--mono); }
  .cleg i { width: 10px; height: 10px; display: inline-block; }
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
  @reactive accessor secOpen: Record<string, boolean> = {}; // collapsible section open state
  @reactive accessor queryText: Record<string, string> = {};
  @reactive accessor tableState: Record<string, TableState> = {}; // per-table filter/sort/page
  @reactive accessor facetSel: Record<string, string> = {}; // "method|facetKey" -> selected value ("" = all)
  private intervalTimers = new Map<string, any>(); // per-view auto-refresh timers
  @reactive accessor streamData: Record<string, any> = {};
  @reactive accessor streamHist: Record<string, number[]> = {}; // numeric history for sparklines
  @reactive accessor streamOn: Record<string, boolean> = {}; // which streams are live
  // row-detail modal: the returned detail plus the clicked row + its actions (so the
  // modal footer can offer the same row actions).
  @reactive accessor modal: { title: string; data: any; row?: Record<string, any>; actions?: RowAction[]; view?: string } | null = null;
  @reactive accessor editCell: { key: string; row: number; col: number } | null = null; // inline-edit target

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
    for (const ref of this.leafRefs(s.node)) {
      if (!this.views[ref]) continue;
      if (this.views[ref].server) this.serverFetch(ref);
      else void this.fetch(ref);
    }
  }

  private stopAll() {
    for (const c of this.streamAborts.values()) c.abort();
    this.streamAborts.clear();
    for (const t of this.debFetch.values()) clearTimeout(t); // cancel pending filter debounces
    this.debFetch.clear();
    for (const t of this.intervalTimers.values()) clearInterval(t); // stop auto-refresh timers
    this.intervalTimers.clear();
    this.streamOn = {};
  }

  private rebuild() {
    const s = this.surface;
    // Identity must include the PAGE (title + param + node), not just the plugin
    // key — every page of one plugin shares the key, so keying on it alone skipped
    // the rebuild when navigating between pages, leaving a new page's unique views
    // unfetched ("no data"). The host's stats-poll re-sets the same content, so this
    // composite stays stable across those and only changes on a real page change.
    const key = s ? `${s.key}|${s.title || ""}|${JSON.stringify(s.param || {})}|${JSON.stringify(s.node)}` : "";
    if (s && key === this.curKey) return;
    this.curKey = key;
    this.stopAll(); // drop any live streams from the previous surface
    this.views = {};
    this.actions = {};
    this.streams = {};
    this.cells = {};
    this.streamData = {};
    this.streamHist = {};
    this.filterDraft = {};
    if (!s) return;
    registerPluginIcons(s.key, s.schema.icons); // sanitize + namespace this plugin's icons
    for (const v of s.schema.views || []) this.views[v.method] = v;
    for (const a of s.schema.actions || []) this.actions[a.method] = a;
    for (const st of s.schema.streams || []) this.streams[st.method] = st;
    // Fetch views eagerly; streams are OPT-IN (a live connection is precious —
    // one held stream can starve the dev proxy / the browser's per-host limit).
    // Server tables get their first page via the query protocol.
    for (const ref of this.leafRefs(s.node)) {
      const v = this.views[ref];
      if (!v) continue;
      if (v.server) this.serverFetch(ref);
      else void this.fetch(ref);
      // Auto-refresh timer for views that declare an interval (min 2s guard).
      if (v.refresh_interval && v.refresh_interval > 0 && !this.intervalTimers.has(ref)) {
        const ms = Math.max(2, v.refresh_interval) * 1000;
        this.intervalTimers.set(ref, setInterval(() => this.refetchView(ref), ms));
      }
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
    const gen = this.curKey; // stable surface identity — survives the host's poll re-renders
    // Keep the prior data while refetching (stale-while-revalidate) so a filter/page
    // change on a server table doesn't blank the table and flash "loading…".
    this.cells = { ...this.cells, [method]: { ...(this.cells[method] || {}), loading: true } };
    try {
      const data = await this.rpc.call<any>("Plugins", "call", [{ key: s.key, method, args: this.callArgs(extra) }]);
      if (this.curKey !== gen) return; // the surface actually changed (page nav) — drop the stale write
      this.cells = { ...this.cells, [method]: { loading: false, data } };
    } catch (e: any) {
      if (this.curKey !== gen) return;
      this.cells = { ...this.cells, [method]: { ...(this.cells[method] || {}), loading: false, error: e?.message ?? "call failed" } };
    }
  }

  private deps() { return { rpc: this.rpc, prompt: this.prompt, confirm: this.confirm, toast: this.toast }; }

  private runAction = async (a: ActionDesc) => {
    const s = this.surface;
    if (!s) return;
    await runPluginAction(this.deps(), s.key, a, undefined, this.surface?.param);
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
      case "section": {
        const kids = n.children || [];
        // A titled section holding a single leaf already labels it — suppress the
        // leaf's own (duplicate) label. If that leaf is refreshable, put its refresh
        // button next to the section title (not floating in the leaf).
        const soleLeaf = !!n.title && kids.length === 1 && kids[0].kind === "leaf";
        const soleView = soleLeaf ? this.views[kids[0].ref || ""] : undefined;
        const collapsible = !!n.title && !!n.collapsible;
        const open = collapsible ? (this.secOpen[idKey] ?? !n.collapsed) : true;
        return (
          <div class={"sec" + g}>
            {n.title ? (
              <div class={"sect" + (collapsible ? " clp" : "")} onClick={collapsible ? () => (this.secOpen = { ...this.secOpen, [idKey]: !open }) : undefined}>
                {collapsible ? <loom-icon name={open ? "chevron-down" : "chevron-right"} size={12}></loom-icon> : null}
                {n.title}{soleView?.refresh ? this.refreshBtn(kids[0].ref || "") : null}
              </div>
            ) : null}
            {open ? kids.map((c, i) => (soleLeaf ? this.renderLeaf(c.ref || "", !!c.fill, true) : this.renderNode(c, idKey + "." + i))) : null}
          </div>
        );
      }
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

  private renderLeaf(ref: string, fill = false, hideLabel = false) {
    const g = fill ? " grow" : "";
    if (this.actions[ref]) {
      const a = this.actions[ref];
      return <div class="leaf"><hope-button size="sm" tone={a.danger ? "danger" : "primary"} onClick={() => { void this.runAction(a); }}>{a.label}</hope-button></div>;
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
    // Show data whenever we have it (even mid-refetch) so a filter/page change never
    // blanks the view; "loading…" only before the first result.
    const body = v.kind === "query"
      ? this.renderQuery(v, cell)
      : cell?.data != null
        ? this.renderView(v, cell.data)
        : cell?.loading
          ? <div class="msg">loading…</div>
          : cell?.error
            ? <div class="msg bad">{cell.error}</div>
            : <div class="msg">no data</div>;
    // Label row carries an optional refresh button inline. When the label is hidden
    // (sole leaf of a titled section) the section renders the refresh next to its
    // title instead, so it isn't shown here.
    return (
      <div class={"leaf" + g}>
        {hideLabel ? null : <div class="llabel">{this.leafIcon(v.icon)}{v.label}{v.refresh ? this.refreshBtn(ref) : null}</div>}
        {body}
      </div>
    );
  }

  private refreshBtn(ref: string) {
    return <button class="sbtn rfr" title="refresh" onClick={(e: any) => { e.stopPropagation(); this.refetchView(ref); }}><loom-icon name="rotate" size={11}></loom-icon></button>;
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
      case "chart":
        return this.renderChart(data);
      case "cards":
        return this.renderCards(data);
      case "stat":
        return this.renderStat(data);
      case "text":
        return <pre class="ptext">{typeof data === "string" ? data : this.cellStr(data?.text)}</pre>;
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
          <hope-button size="sm" tone="primary" icon="play" onClick={() => { void this.fetch(v.method, { input: this.queryText[v.method] ?? this.queryDefault(v) }); }}>run</hope-button>
        </div>
        {cell?.loading ? <div class="msg">running…</div> : cell?.error ? <div class="msg bad">{cell.error}</div> : cell?.data ? this.renderTable(cell.data, v) : <div class="msg">no results yet</div>}
      </div>
    );
  }

  private tableSt(key: string): TableState {
    return this.tableState[key] || { page: 0, sort: -1, dir: 1, filter: "" };
  }

  private debFetch = new Map<string, any>(); // per-view filter debounce timers
  private filterDraft: Record<string, string> = {}; // server-table filter text (non-reactive: typing must not re-render/lose focus)

  // serverFetch re-calls a server-driven table with the current query state ({_q}):
  // page, page_size, the sorted column NAME (resolved from the last columns), and
  // the filter. The plugin returns just that page + a total.
  private serverFetch(method: string) {
    const v = this.views[method];
    if (!v?.server) return;
    const st = this.tableSt(method);
    const size = v.page_size && v.page_size > 0 ? v.page_size : TABLE_PAGE;
    const cols: string[] | undefined = this.cells[method]?.data?.columns;
    const sort = st.sort >= 0 && cols ? { column: cols[st.sort], dir: st.dir } : undefined;
    const filters: Record<string, string> = {};
    for (const f of v.facets || []) { const sel = this.facetSel[`${method}|${f.key}`]; if (sel) filters[f.key] = sel; }
    void this.fetch(method, { _q: { page: st.page, page_size: size, sort, filter: st.filter || "", filters } });
  }

  // serverFilter debounces filter typing: the text lives in filterDraft (non-reactive
  // so keystrokes don't re-render + drop focus); on the debounce we commit it to
  // tableState (one re-render) and refetch.
  private serverFilter(method: string) {
    clearTimeout(this.debFetch.get(method));
    this.debFetch.set(method, setTimeout(() => {
      this.setTable(method, { filter: this.filterDraft[method] ?? "", page: 0 });
      this.serverFetch(method);
    }, 250));
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
    const detailMethod: string | undefined = v?.row_method || data?.on_row || data?.onRow;
    const detailAsButton = !!v?.row_detail_button || !!data?.row_detail_button;
    const onRow = detailMethod && !detailAsButton ? detailMethod : undefined; // whole-row click
    const acts: RowAction[] = v?.row_actions || data?.row_actions || [];
    const editMethod: string | undefined = v?.edit_method || data?.edit_method;
    const editCols: string[] | undefined = v?.edit_columns || data?.edit_columns;
    const canEdit = (ci: number) => !!editMethod && (!editCols || !editCols.length || editCols.includes(cols[ci]));
    const hasTrailing = acts.length > 0 || (!!detailMethod && detailAsButton);
    if (!cols.length && !rows.length) return <div class="msg">empty</div>;

    const key = v?.method || "_t";
    const st = this.tableSt(key);
    const server = !!v?.server;
    const pageSize = v?.page_size && v.page_size > 0 ? v.page_size : TABLE_PAGE; // plugin-declared, else default

    // Server tables: the plugin already returned exactly this page + a total, so we
    // don't filter/sort/slice here — the controls re-call the plugin. Client tables:
    // filter -> sort -> page over row INDICES locally.
    let idx = rows.map((_, i) => i);
    let total: number;
    if (server) {
      total = typeof data?.total === "number" ? data.total : rows.length;
    } else {
      if (st.filter) {
        const f = st.filter.toLowerCase();
        idx = idx.filter((i) => rows[i].some((c) => this.cellStr(c).toLowerCase().includes(f)));
      }
      if (st.sort >= 0) idx.sort((a, b) => this.cmpCells(rows[a][st.sort], rows[b][st.sort]) * st.dir);
      total = idx.length;
    }
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(st.page, pages - 1);
    const shown = server ? idx : idx.slice(page * pageSize, page * pageSize + pageSize);
    const toolbar = server || rows.length > pageSize || st.filter;
    // Control handlers route to the plugin (server) or re-render locally (client).
    const changePage = (p: number) => { this.setTable(key, { page: p }); if (server) this.serverFetch(key); };
    // 3-phase sort: unsorted -> ascending -> descending -> unsorted.
    const changeSort = (ci: number) => {
      let sort = ci, dir: 1 | -1 = 1;
      if (st.sort !== ci) { sort = ci; dir = 1; }
      else if (st.dir === 1) { sort = ci; dir = -1; }
      else { sort = -1; dir = 1; } // was descending -> clear
      this.setTable(key, { sort, dir, page: server ? 0 : st.page });
      if (server) this.serverFetch(key);
    };
    // Server: stash text in filterDraft (no re-render, keeps focus) + debounce. Client:
    // commit to state immediately to re-filter locally.
    const changeFilter = (fv: string) => {
      if (server) { this.filterDraft[key] = fv; this.serverFilter(key); }
      else this.setTable(key, { filter: fv, page: 0 });
    };
    const filterVal = server ? (this.filterDraft[key] ?? st.filter) : st.filter;

    return (
      <div class="tblwrap">
        {toolbar ? (
          <div class="tbar">
            <input class="tfilter" placeholder={server ? "search…" : "filter…"} value={filterVal}
              onInput={(e: any) => changeFilter(e.target.value)} />
            {server && v?.facets ? v.facets.map((f) => {
              const fk = `${key}|${f.key}`;
              return (
                <select class="tfacet" value={this.facetSel[fk] || ""}
                  onChange={(e: any) => { this.facetSel = { ...this.facetSel, [fk]: e.target.value }; this.setTable(key, { page: 0 }); this.serverFetch(key); }}>
                  <option value="">{f.label}: all</option>
                  {f.options.map((o) => <option value={o.value}>{f.label}: {o.label}</option>)}
                </select>
              );
            }) : null}
            <span class="tcount">{total.toLocaleString()}{!server && total !== rows.length ? ` / ${rows.length.toLocaleString()}` : ""} rows</span>
            {pages > 1 ? (
              <span class="tpager">
                <button class="pbtn" disabled={page <= 0} onClick={() => changePage(page - 1)}><loom-icon name="chevron-left" size={13}></loom-icon></button>
                <span class="pnum">{page + 1} / {pages}</span>
                <button class="pbtn" disabled={page >= pages - 1} onClick={() => changePage(page + 1)}><loom-icon name="chevron-right" size={13}></loom-icon></button>
              </span>
            ) : null}
          </div>
        ) : null}
        <div class="gwrap">
          <table class="g">
            <thead><tr>
              {cols.map((c, ci) => (
                <th class="srt" onClick={() => changeSort(ci)}>
                  {c}<loom-icon class={"sarrow" + (st.sort === ci ? "" : " off")} name={st.dir === 1 ? "arrow-up" : "arrow-down"} size={12}></loom-icon>
                </th>
              ))}
              {hasTrailing ? <th class="rax"></th> : null}
            </tr></thead>
            <tbody>{shown.map((i) => {
              const r = rows[i];
              return (
                <tr class={onRow ? "clk" : ""} onClick={onRow ? () => this.openRow(onRow, cols, r, acts, v?.method) : undefined}>
                  {r.map((cell, ci) => {
                    const editable = canEdit(ci);
                    const isEditing = !!this.editCell && this.editCell.row === i && this.editCell.col === ci;
                    if (isEditing) {
                      return (
                        <td class="editing"><input class="cellin" autofocus value={this.cellStr(cell)}
                          onKeyDown={(e: any) => { if (e.key === "Enter") { e.preventDefault(); void this.commitEdit(editMethod!, cols, r, ci, e.target.value, v?.method); } else if (e.key === "Escape") { e.preventDefault(); this.cancelEdit(); } }}
                          onBlur={(e: any) => void this.commitEdit(editMethod!, cols, r, ci, e.target.value, v?.method)} /></td>
                      );
                    }
                    return <td class={editable ? "ecell" : ""} onClick={editable ? (e: any) => { e.stopPropagation(); this.editCell = { key, row: i, col: ci }; } : undefined}>{this.cellNode(cell)}</td>;
                  })}
                  {hasTrailing ? (
                    <td class="rax">
                      {detailMethod && detailAsButton ? (
                        <button class="rowbtn" onClick={(e: any) => { e.stopPropagation(); this.openRow(detailMethod, cols, r, acts, v?.method); }}>
                          <loom-icon name="search" size={11}></loom-icon>view
                        </button>
                      ) : null}
                      {acts.map((a) => (
                        <button class={"rowbtn" + (a.danger ? " bad" : "")} onClick={(e: any) => { e.stopPropagation(); void this.runRowAction(a, cols, r, v?.method); }}>
                          {a.icon ? <hope-plugin-icon plugin={this.surface?.key} name={a.icon} size={11}></hope-plugin-icon> : null}{a.label}
                        </button>
                      ))}
                    </td>
                  ) : null}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
    );
  }

  // commitEdit calls the table's edit_method with {row, column, value} (author's
  // inline-edit RPC), then refetches the owning view. No-op if unchanged. Quiet: no
  // success toast per cell (still audited + error-toasted).
  // cancelEdit drops the inline edit without committing (Escape). Clearing editCell
  // first makes the follow-up blur a no-op via commitEdit's guard.
  private cancelEdit = () => { this.editCell = null; };

  private commitEdit = async (method: string, cols: string[], row: any[], colIdx: number, value: string, viewMethod?: string) => {
    if (!this.editCell) return; // already committed (Enter) or cancelled (Escape) — dedupe the blur
    const s = this.surface;
    const prev = this.cellStr(row[colIdx]);
    this.editCell = null;
    if (!s || value === prev) return;
    const obj = this.rowObj(cols, row);
    const out = await runPluginAction(this.deps(), s.key, { method, label: "Edit" }, { row: obj, column: cols[colIdx], value }, this.surface?.param, { quiet: true });
    if (out?.ok && out.refetch) this.refetchView(viewMethod);
  };

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
    // Same runner as every other action; the row is the extra arg. The plugin's
    // outcome decides: on refusal (ok:false) keep the modal open and don't refetch;
    // on success close it and refetch only if the plugin says the view changed.
    const out = await runPluginAction(this.deps(), s.key, a, { row: obj }, this.surface?.param);
    if (!out || !out.ok) return;
    this.modal = null;
    if (out.refetch) this.refetchView(viewMethod);
  };

  // refetchView reloads a view leaf: a server table via the query protocol, a query
  // view with its current input, else a plain fetch.
  private refetchView(viewMethod?: string) {
    if (!viewMethod || !this.views[viewMethod]) return;
    const v = this.views[viewMethod];
    if (v.server) { this.serverFetch(viewMethod); return; }
    void this.fetch(viewMethod, v.kind === "query" ? { input: this.queryText[viewMethod] ?? "" } : undefined);
  }

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

  // renderChart draws a bar or line chart from {type, labels, series:[{name,values}]}.
  // Multi-series with a legend, min/max-scaled y, gridlines. Colors cycle a small
  // hope-palette set; everything is inline SVG (CSP-safe, no external deps).
  private renderChart(data: any) {
    const type: string = data?.type === "line" ? "line" : "bar";
    const labels: string[] = data?.labels || [];
    const series: { name: string; values: number[] }[] = (data?.series || []).filter((s: any) => Array.isArray(s?.values));
    if (!labels.length || !series.length) return <div class="msg">no data</div>;
    const colors = ["var(--upd)", "var(--ok)", "var(--warn)", "var(--bad)", "var(--mid)"];
    const W = 520, H = 220, padL = 40, padB = 26, padT = 10, padR = 10;
    const iw = W - padL - padR, ih = H - padT - padB;
    let lo = 0, hi = 0;
    for (const s of series) for (const v of s.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi === lo) hi = lo + 1;
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ih;
    const n = labels.length;
    const bandW = iw / n;
    const ticks = [lo, lo + (hi - lo) / 2, hi];
    return (
      <div class="chart">
        <svg viewBox={`0 0 ${W} ${H}`} class="chartsvg">
          {ticks.map((t) => (
            <g>
              <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} class="cgrid"></line>
              <text x={padL - 6} y={y(t) + 3} class="cyl">{Math.round(t)}</text>
            </g>
          ))}
          {type === "bar"
            ? series.map((s, si) => s.values.map((v, i) => {
                const groupW = bandW * 0.7, bw = groupW / series.length;
                const x = padL + i * bandW + bandW * 0.15 + si * bw;
                return <rect x={x} y={y(v)} width={Math.max(1, bw - 1)} height={Math.max(0, y(lo) - y(v))} fill={colors[si % colors.length]}></rect>;
              }))
            : series.map((s, si) => (
                <polyline fill="none" stroke={colors[si % colors.length]} stroke-width={1.75}
                  points={s.values.map((v, i) => `${(padL + i * bandW + bandW / 2).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}></polyline>
              ))}
          {labels.map((l, i) => <text x={padL + i * bandW + bandW / 2} y={H - padB + 14} class="cxl">{l}</text>)}
        </svg>
        {series.length > 1 || series[0].name ? (
          <div class="clegend">{series.map((s, si) => (
            <span class="cleg"><i style={`background:${colors[si % colors.length]}`}></i>{s.name || `series ${si + 1}`}</span>
          ))}</div>
        ) : null}
      </div>
    );
  }

  // renderCards draws a responsive grid of cards from { items: [Card] }. A Card is
  // { title, subtitle?, icon?, tone?, fields?: [{label, value}], to? }. Cells inside
  // fields may be typed (badge/link/etc). A card with `to` is clickable.
  private renderCards(data: any) {
    const items: any[] = data?.items || [];
    if (!items.length) return <div class="msg">empty</div>;
    return (
      <div class="cards">
        {items.map((it) => (
          <div class={"pcard" + (it.to ? " lk" : "") + (this.toneClass(it.tone) ? " " + this.toneClass(it.tone) : "")}
            onClick={it.to ? () => this.navCell(it) : undefined}>
            <div class="pchead">
              {it.icon ? <hope-plugin-icon plugin={this.surface?.key} name={it.icon} size={16}></hope-plugin-icon> : null}
              <div class="pctitle"><span class="pct">{this.cellStr(it.title)}</span>{it.subtitle ? <span class="pcsub">{this.cellStr(it.subtitle)}</span> : null}</div>
            </div>
            {Array.isArray(it.fields) && it.fields.length ? (
              <div class="pcfields">{it.fields.map((f: any) => (
                <div class="pcf"><span class="pcfl">{this.cellStr(f.label)}</span><span class="pcfv">{this.cellNode(f.value)}</span></div>
              ))}</div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  // renderStat draws big-number stat blocks from { stats: [StatBlock] } (or a single
  // block). Each shows a value + label, optional unit/sub/tone/icon.
  private renderStat(data: any) {
    const stats: any[] = Array.isArray(data?.stats) ? data.stats : data && typeof data === "object" && "value" in data ? [data] : [];
    if (!stats.length) return <div class="msg">no data</div>;
    return (
      <div class="stats2">
        {stats.map((st) => (
          <div class={"statb" + (this.toneClass(st.tone) ? " " + this.toneClass(st.tone) : "")}>
            <div class="stlabel">{st.icon ? <hope-plugin-icon plugin={this.surface?.key} name={st.icon} size={12}></hope-plugin-icon> : null}{this.cellStr(st.label)}</div>
            <div class="stval">{this.fmtNum(st.value)}{st.unit ? <span class="stunit"> {st.unit}</span> : null}</div>
            {st.sub ? <div class="stsub">{this.cellStr(st.sub)}</div> : null}
          </div>
        ))}
      </div>
    );
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
  // toneClass allowlists a plugin-supplied tone to hope's semantic set, so untrusted
  // data can't inject arbitrary class strings.
  private toneClass(t: any): string {
    const s = String(t ?? "");
    return ["ok", "warn", "bad", "info", "upd"].includes(s) ? s : "";
  }

  private cellStr(v: any): string {
    if (v == null) return "—";
    if (typeof v === "object") {
      if ("value" in v) return v.value == null ? "—" : String(v.value); // typed cell -> its value
      return JSON.stringify(v);
    }
    return String(v);
  }

  private get router(): LoomRouter { return app.get(LoomRouter); }

  // cellNode renders a table cell. A plain scalar is text; a typed cell object
  // { type, value, ... } renders as a badge/link/time/number/progress/code so dense
  // data reads well. Unknown types fall back to text.
  private cellNode(cell: any): any {
    if (cell && typeof cell === "object" && typeof cell.type === "string") {
      switch (cell.type) {
        case "badge":
        case "chip":
          return <span class={"pill " + this.toneClass(cell.tone)}>{this.cellStr(cell.value)}</span>;
        case "link":
          return <a class="clink" onClick={(e: any) => { e.stopPropagation(); this.navCell(cell); }}>{this.cellStr(cell.value)}</a>;
        case "time":
          return <span class="ctime" data-tip={this.absTime(cell.value)}>{this.relTime(cell.value)}</span>;
        case "number":
          return <span class="cnum">{this.fmtNum(cell.value)}{cell.unit ? " " + cell.unit : ""}</span>;
        case "progress": {
          const p = Math.max(0, Math.min(1, Number(cell.value) || 0));
          return <span class="cprog" data-tip={Math.round(p * 100) + "%"}><i style={`width:${(p * 100).toFixed(1)}%`}></i></span>;
        }
        case "code":
          return <code class="ccode">{this.cellStr(cell.value)}</code>;
        default:
          return this.cellStr(cell.value);
      }
    }
    return this.cellStr(cell);
  }

  // navCell follows a link cell. `to` is PLUGIN-RELATIVE (a page id / path) unless it
  // starts with "/" — hope prefixes /plugin/<thisKey>/ so a plugin never needs to
  // know its own hope key. `href` opens externally.
  private navCell(cell: any) {
    if (cell.to) {
      const to = String(cell.to);
      // In-app nav only. An absolute `to` must be a single-slash path (reject
      // protocol-relative "//host" which routers treat as off-site); relative `to`
      // is resolved under this plugin.
      const abs = to.startsWith("/")
        ? (to.startsWith("//") ? "/" : to)
        : `/plugin/${encodeURIComponent(this.surface?.key || "")}/${to}`;
      this.router.navigate(abs);
    } else if (cell.href) {
      // External link: http(s) only — never javascript:/data:/etc (window.open runs
      // a javascript: URI in the opener's origin even with noopener).
      const href = String(cell.href);
      if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
    }
  }

  private fmtNum(v: any): string {
    const n = Number(v);
    return isNaN(n) ? this.cellStr(v) : n.toLocaleString();
  }
  private toMs(v: any): number {
    if (v == null || v === "") return NaN; // no timestamp -> "—", not epoch ("56y ago")
    const n = Number(v);
    if (isNaN(n)) return NaN;
    return n < 1e12 ? n * 1000 : n; // seconds vs millis
  }
  private absTime(v: any): string {
    const ms = this.toMs(v);
    return isNaN(ms) ? "" : new Date(ms).toLocaleString();
  }
  private relTime(v: any): string {
    const ms = this.toMs(v);
    if (isNaN(ms)) return this.cellStr(v);
    let s = (Date.now() - ms) / 1000;
    const future = s < 0; s = Math.abs(s);
    const u: [number, string][] = [[60, "s"], [60, "m"], [24, "h"], [7, "d"], [4.35, "w"], [12, "mo"], [Infinity, "y"]];
    let val = s, label = "s";
    for (const [div, lab] of u) { if (val < div) { label = lab; break; } val /= div; label = lab; }
    const out = `${Math.round(val)}${label}`;
    return future ? `in ${out}` : `${out} ago`;
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
              <hope-button size="sm" tone={a.danger ? "danger" : "primary"}
                onClick={() => this.runModalAction(a, m)}>
                {a.icon ? <hope-plugin-icon plugin={this.surface?.key} name={a.icon} size={12}></hope-plugin-icon> : null}{a.label}
              </hope-button>
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
