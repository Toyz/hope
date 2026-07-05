// <hope-plugin-surface> — the surface-agnostic renderer for a plugin's UI. It
// walks a getLayout layout node (section/tabs/row/grid/leaf) and mounts the
// view-kind components (kv/table/query/tree), action buttons, and stream slots,
// calling the plugin through Plugins.call. The SAME component renders a container
// panel now and a full page later — it doesn't care which surface hosts it.
import { LoomElement, component, styles, css, reactive, prop, watch, mount, unmount } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { HopeTransport } from "../transport";
import { PromptService, type PromptField } from "../prompt";
import { ToastService } from "../toast";
import { theme } from "../styles";

interface Node {
  kind: string;
  title?: string;
  ref?: string;
  size?: number;
  children?: Node[];
}
interface ViewDesc { method: string; label: string; kind: string }
interface ActionDesc { method: string; label: string; fields?: PromptField[]; danger?: boolean }
interface StreamDesc { method: string; label: string; kind: string }
interface Schema { views?: ViewDesc[]; actions?: ActionDesc[]; streams?: StreamDesc[] }
export interface Surface { key: string; name: string; title?: string; node: Node; schema: Schema }

type Cell = { loading: boolean; error?: string; data?: any };

@component("hope-plugin-surface")
@styles(theme, css`
  :host { display: block; min-height: 0; }
  .sec { padding: 4px 0 10px; }
  .sect { padding: 12px 16px 8px; color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; padding: 0 4px; }
  .row > * { flex: 1 1 240px; min-width: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; padding: 0 4px; }

  .tabs { display: flex; gap: 2px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .tb { padding: 8px 12px; color: var(--dim); cursor: pointer; font: 600 10.5px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tb:hover { color: var(--mid); }
  .tb.on { color: var(--hi); border-bottom-color: var(--upd); }

  .leaf { padding: 6px 16px 12px; min-width: 0; }
  .llabel { color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; margin-bottom: 8px; }
  .msg { color: var(--dim); font: 12px/1.5 var(--mono); padding: 6px 0; }
  .msg.bad { color: var(--bad); }

  table.g { width: 100%; border-collapse: collapse; font: 12px/1.5 var(--mono); }
  table.g th { position: sticky; top: 0; background: var(--panel); text-align: left; padding: 7px 12px; border-bottom: 1px solid var(--line); color: var(--dim); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  table.g td { padding: 6px 12px; border-bottom: 1px solid var(--line); color: var(--mid); vertical-align: top; }
  .gwrap { max-height: 320px; overflow: auto; border: 1px solid var(--line); }

  .qbar { display: flex; gap: 8px; margin-bottom: 10px; }
  .qbar textarea { flex: 1; min-height: 54px; resize: vertical; background: var(--ink); border: 1px solid var(--line); color: var(--hi); font: 12px/1.5 var(--mono); padding: 8px 10px; }
  .qbar textarea:focus { outline: none; border-color: var(--line2); }

  ul.tree { list-style: none; margin: 0; padding: 0 0 0 4px; font: 12px/1.7 var(--mono); }
  ul.tree ul { list-style: none; margin: 0; padding-left: 16px; border-left: 1px solid var(--line); }
  ul.tree li { color: var(--mid); }
  ul.tree li > .lb { color: var(--hi); }

  .streams { display: flex; gap: 26px; flex-wrap: wrap; padding: 4px 0; }
  .stream { display: inline-flex; flex-direction: column; gap: 6px; padding: 8px 0; }
  .stream .k { color: var(--dim); font: 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .08em; }
  .stream .v { color: var(--upd); font: 600 20px/1 var(--mono); font-variant-numeric: tabular-nums; }
`)
export class HopePluginSurface extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ToastService) accessor toast!: ToastService;

  @prop accessor host = "";
  @prop accessor surface: Surface | null = null;

  @reactive accessor cells: Record<string, Cell> = {};
  @reactive accessor tabSel: Record<string, number> = {};
  @reactive accessor queryText: Record<string, string> = {};
  @reactive accessor streamData: Record<string, any> = {};

  private views: Record<string, ViewDesc> = {};
  private actions: Record<string, ActionDesc> = {};
  private streams: Record<string, StreamDesc> = {};
  private abort?: AbortController;

  @mount onMount() { this.rebuild(); }
  @watch("surface") onSurface() { this.rebuild(); }
  @unmount onUnmount() { this.abort?.abort(); }

  private rebuild() {
    const s = this.surface;
    this.abort?.abort(); // tear down any previous streams (goroutine-leak class)
    this.abort = new AbortController();
    this.views = {};
    this.actions = {};
    this.streams = {};
    this.cells = {};
    this.streamData = {};
    if (!s) return;
    for (const v of s.schema.views || []) this.views[v.method] = v;
    for (const a of s.schema.actions || []) this.actions[a.method] = a;
    for (const st of s.schema.streams || []) this.streams[st.method] = st;
    // Fetch every view referenced in the tree; open a subscription per stream.
    for (const ref of this.leafRefs(s.node)) {
      if (this.views[ref]) void this.fetch(ref);
      else if (this.streams[ref]) void this.subscribe(ref);
    }
  }

  // Subscribe to a plugin stream; each data frame updates the live value. The
  // AbortController (torn down on unmount / surface change) cancels the fetch, and
  // hope cancels the plugin's stream in turn.
  private async subscribe(method: string) {
    const s = this.surface;
    if (!s || !this.abort) return;
    try {
      for await (const frame of this.rpc.streamWithSignal<any>("Stream", "pluginStream", [s.key, method], this.abort.signal)) {
        if (frame?.type === "data") this.streamData = { ...this.streamData, [method]: frame.data };
        else if (frame?.type === "error") this.streamData = { ...this.streamData, [method]: { error: frame.error } };
      }
    } catch {
      /* aborted or transport closed */
    }
  }

  private leafRefs(n: Node | undefined, acc: string[] = []): string[] {
    if (!n) return acc;
    if (n.kind === "leaf" && n.ref) acc.push(n.ref);
    for (const c of n.children || []) this.leafRefs(c, acc);
    return acc;
  }

  private async fetch(method: string, args?: any) {
    const s = this.surface;
    if (!s) return;
    this.cells = { ...this.cells, [method]: { loading: true } };
    try {
      const data = await this.rpc.call<any>("Plugins", "call", [{ key: s.key, method, args }]);
      this.cells = { ...this.cells, [method]: { loading: false, data } };
    } catch (e: any) {
      this.cells = { ...this.cells, [method]: { loading: false, error: e?.message ?? "call failed" } };
    }
  }

  private runAction = async (a: ActionDesc) => {
    const s = this.surface;
    if (!s) return;
    let args: any = undefined;
    if (a.fields && a.fields.length) {
      const v = await this.prompt.ask({ title: a.label, submitLabel: "Run", fields: a.fields });
      if (!v) return;
      args = v;
    }
    try {
      const res = await this.rpc.call<any>("Plugins", "call", [{ key: s.key, method: a.method, args }]);
      this.toast.ok(res && typeof res === "object" && res.message ? String(res.message) : `${a.label} ok`);
    } catch (e: any) {
      this.toast.error(`${a.label} — ${e?.message ?? "failed"}`);
    }
  };

  // ── rendering ──
  private renderNode(n: Node, idKey: string): any {
    switch (n.kind) {
      case "section":
        return (
          <div class="sec">
            {n.title ? <div class="sect">{n.title}</div> : null}
            {(n.children || []).map((c, i) => this.renderNode(c, idKey + "." + i))}
          </div>
        );
      case "tabs": {
        const kids = n.children || [];
        const sel = this.tabSel[idKey] ?? 0;
        return (
          <div>
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
        return <div class="row">{(n.children || []).map((c, i) => this.renderNode(c, idKey + "." + i))}</div>;
      case "grid":
        return <div class="grid">{(n.children || []).map((c, i) => this.renderNode(c, idKey + "." + i))}</div>;
      case "leaf":
        return this.renderLeaf(n.ref || "");
      default:
        return null;
    }
  }

  private labelOf(n: Node): string {
    const r = n.ref || "";
    return this.views[r]?.label || this.actions[r]?.label || this.streams[r]?.label || "";
  }

  private renderLeaf(ref: string) {
    if (this.actions[ref]) {
      const a = this.actions[ref];
      return <div class="leaf"><hope-button size="sm" tone={a.danger ? "danger" : "primary"} onClick={() => this.runAction(a)}>{a.label}</hope-button></div>;
    }
    if (this.streams[ref]) {
      const st = this.streams[ref];
      const d = this.streamData[ref];
      return <div class="leaf"><div class="llabel">{st.label}</div>{d != null ? this.renderStream(d) : <div class="msg">connecting…</div>}</div>;
    }
    const v = this.views[ref];
    if (!v) return null;
    const cell = this.cells[ref];
    return (
      <div class="leaf">
        <div class="llabel">{v.label}</div>
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
        return this.renderTable(data);
      case "tree":
        return this.renderTree(data?.nodes || []);
      default:
        return <div class="msg">unsupported view</div>;
    }
  }

  private renderQuery(v: ViewDesc, cell: Cell | undefined) {
    const text = this.queryText[v.method] ?? "";
    return (
      <div>
        <div class="qbar">
          <textarea placeholder="enter query…" onInput={(e: any) => (this.queryText = { ...this.queryText, [v.method]: e.target.value })}>{text}</textarea>
          <hope-button size="sm" tone="primary" icon="play" onClick={() => this.fetch(v.method, { input: this.queryText[v.method] ?? "" })}>run</hope-button>
        </div>
        {cell?.loading ? <div class="msg">running…</div> : cell?.error ? <div class="msg bad">{cell.error}</div> : cell?.data ? this.renderTable(cell.data) : <div class="msg">no results yet</div>}
      </div>
    );
  }

  private renderTable(data: any) {
    const cols: string[] = data?.columns || [];
    const rows: any[][] = data?.rows || [];
    if (!cols.length && !rows.length) return <div class="msg">empty</div>;
    return (
      <div class="gwrap">
        <table class="g">
          <thead><tr>{cols.map((c) => <th>{c}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr>{r.map((cell) => <td>{this.cellStr(cell)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }

  private renderStream(d: any) {
    if (d && typeof d === "object" && d.error) return <div class="msg bad">{String(d.error)}</div>;
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

  update() {
    const s = this.surface;
    if (!s || !s.node) return <div class="msg" style="padding:16px">no panel</div>;
    return this.renderNode(s.node, "r");
  }
}
