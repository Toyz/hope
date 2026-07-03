// <hope-table> — the site-standard data table. Columns are declared with a
// render fn; the component owns the header design + cell chrome so tables read
// the same everywhere. Cells render inside this component's shadow, so render fns
// use the utility classes defined here (link/dim/num/chip) rather than page CSS.
//
//   const cols: HopeColumn<Net>[] = [
//     { label: "network", render: (n) => <span class="link" onClick={...}>{n.name}</span> },
//     { label: "ip", render: (n) => n.ip || "—" },
//     { label: "aliases", grow: true, render: (n) => n.aliases.join(", ") || "—",
//       tip: (n) => n.aliases.join(", ") || undefined },
//   ];
//   <hope-table columns={cols} rows={nets}></hope-table>
//
// A `grow` column absorbs slack so the data clusters left. Pass onRowClick for
// clickable rows. Object/fn props are @reactive (set by property, not attribute).
import { LoomElement, component, styles, css, reactive } from "@toyz/loom";
import { theme } from "../styles";

export type HopeColumn<T = any> = {
  label?: string;
  align?: "right";
  grow?: boolean; // this column's width is 100% → absorbs slack (data stays left)
  width?: string; // fixed CSS width (e.g. "130px")
  nowrap?: boolean;
  render: (row: T) => any;
  tip?: (row: T) => string | undefined; // data-tip on the cell
  cls?: (row: T) => string; // extra td class
};

@component("hope-table")
@styles(theme, css`
  :host { display: block; }
  .wrap { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; white-space: nowrap; padding: 9px 14px; border-bottom: 1px solid var(--line);
    font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim);
    background: color-mix(in srgb, var(--ink) 45%, var(--panel)); }
  th.r { text-align: right; }
  td { padding: 8px 14px; border-bottom: 1px solid var(--line); font: 12px/1.4 var(--mono); color: var(--mid);
    vertical-align: top; }
  td.r { text-align: right; }
  td.nowrap { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 0; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr.click { cursor: pointer; }
  tbody tr:hover td { background: var(--raised); }
  .empty td { padding: 26px 14px; text-align: center; color: var(--dim); }

  /* cell utility classes for render fns (they render inside this shadow) */
  .link { color: var(--hi); cursor: pointer; }
  .link:hover { color: var(--upd); text-decoration: underline; text-underline-offset: 3px; }
  .dim { color: var(--dim); }
  .num { font-variant-numeric: tabular-nums; }
  .chip { display: inline-block; font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
    padding: 3px 7px; border: 1px solid var(--line2); color: var(--mid); }
`)
export class HopeTable extends LoomElement {
  @reactive accessor columns: HopeColumn[] = [];
  @reactive accessor rows: any[] = [];
  @reactive accessor onRowClick: ((row: any) => void) | null = null;
  @reactive accessor empty = "Nothing to show.";

  update() {
    const cols = this.columns || [];
    const rows = this.rows || [];
    return (
      <div class="wrap">
        <table>
          <colgroup>
            {cols.map((c) => (
              <col style={c.grow ? "width:100%" : c.width ? `width:${c.width}` : ""} />
            ))}
          </colgroup>
          <thead>
            <tr>{cols.map((c) => <th class={c.align === "right" ? "r" : ""}>{c.label || ""}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr class={this.onRowClick ? "click" : ""} onClick={this.onRowClick ? () => this.onRowClick!(row) : undefined}>
                  {cols.map((c) => {
                    const cls = [c.align === "right" ? "r" : "", c.nowrap ? "nowrap" : "", c.cls ? c.cls(row) : ""].filter(Boolean).join(" ");
                    return <td class={cls} data-tip={c.tip ? c.tip(row) : undefined}>{c.render(row)}</td>;
                  })}
                </tr>
              ))
            ) : (
              <tr class="empty"><td colSpan={cols.length || 1}>{this.empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }
}
