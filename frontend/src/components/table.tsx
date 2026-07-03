// <hope-table> — the site-standard data table. It's a thin slot wrapper: put a
// normal <table> inside and it gets the shared table design (fixed layout,
// ellipsis cells, 44px rows, hover/selected states) + a horizontal-scroll guard.
// The actual th/td styling lives in the global theme (styles.ts) as `hope-table
// …` rules, because slotted content is light DOM — so pages write natural table
// markup and use the shared cell classes (link/dim/num/chip/ck/rm/htag).
//
//   <hope-table>
//     <table>
//       <colgroup><col style="width:29%"/>…</colgroup>
//       <thead><tr><th>Repository</th>…</tr></thead>
//       <tbody>{rows.map((r) => <tr onClick={…}><td class="link">{r.name}</td>…</tr>)}</tbody>
//     </table>
//   </hope-table>
import { LoomElement, component, styles, css } from "@toyz/loom";

@component("hope-table")
@styles(css`
  :host { display: block; }
  .scroll { width: 100%; overflow-x: auto; }
`)
export class HopeTable extends LoomElement {
  update() {
    return (
      <div class="scroll">
        <slot></slot>
      </div>
    );
  }
}
