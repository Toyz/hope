// <hope-kvlist> — a compact, reusable key/value list for label/option maps.
// Cleaner than a wall of `key=value` chips: keys are dim and aligned, values
// wrap, and long docker labels (com.docker.compose.*) stay readable. Set the
// `data` property to a Record; empty renders a muted "none".
import { LoomElement, component, styles, css, reactive } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-kvlist")
@styles(theme, css`
  :host { display: block; width: 100%; min-width: 0; flex: 1; }
  .row { display: flex; gap: 12px; padding: 4px 0; min-width: 0; align-items: baseline; }
  .row + .row { border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
  .k { flex: 0 0 auto; max-width: 46%; font: 11.5px/1.5 var(--mono); color: var(--dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v { flex: 1; min-width: 0; font: 11.5px/1.5 var(--mono); color: var(--hi); word-break: break-all; }
  .v.empty { color: var(--dim); }
  .none { font: 11.5px/1.5 var(--mono); color: var(--dim); }
`)
export class KvList extends LoomElement {
  @reactive accessor data: Record<string, string> | null | undefined = null;

  update() {
    const entries = this.data ? Object.entries(this.data) : [];
    if (!entries.length) return <span class="none">none</span>;
    return (
      <div>
        {entries.map(([k, v]) => (
          <div class="row">
            <span class="k" title={k}>{k}</span>
            <span class={"v" + (v ? "" : " empty")}>{v || "—"}</span>
          </div>
        ))}
      </div>
    );
  }
}
