// <hope-sysbanner> — a system-wide banner pinned above the shell (over the rail +
// topbar), for one critical, app-level condition: the state db isn't durably
// mounted, so some state won't survive a restart/recreate. It's dismissable
// (remembered per-condition, so a worse state re-surfaces it) rather than nagging
// on every page like the old per-page alert did.
import { LoomElement, component, styles, css, reactive, mount, persist } from "@toyz/loom";
import { capabilities } from "../caps";
import { theme } from "../styles";

@component("hope-sysbanner")
@styles(theme, css`
  :host { display: block; }
  .b { display: flex; align-items: center; gap: 11px; padding: 9px 16px;
    background: color-mix(in srgb, var(--warn) 13%, var(--ink));
    border-bottom: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line));
    color: var(--mid); font: 12px/1.5 var(--mono); }
  .b.bad { background: color-mix(in srgb, var(--bad) 15%, var(--ink));
    border-bottom-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .b loom-icon { flex: none; color: var(--warn); }
  .b.bad loom-icon { color: var(--bad); }
  .b .msg { flex: 1; } .b .msg b { color: var(--hi); font-weight: 500; }
  .b .msg code { color: var(--hi); }
  .b .x { background: transparent; border: 0; color: var(--dim); cursor: pointer; display: inline-flex; padding: 4px; }
  .b .x:hover { color: var(--hi); }
`)
export class HopeSysBanner extends LoomElement {
  @reactive accessor off = false;
  @reactive accessor ephemeral = false;
  @persist("hope.sysbanner.dismissed") accessor dismissed = "";

  @mount
  async load() {
    try {
      const c = await capabilities();
      this.off = !c.store_enabled;
      this.ephemeral = c.store_ephemeral;
    } catch { /* leave hidden */ }
  }

  private get key(): string {
    return this.ephemeral ? "ephemeral" : this.off ? "off" : "";
  }

  private dismiss = () => { this.dismissed = this.key; };

  update() {
    const key = this.key;
    if (!key || this.dismissed === key) return;
    return (
      <div class={"b" + (this.ephemeral ? " bad" : "")}>
        <loom-icon name="alert" size={15}></loom-icon>
        <span class="msg">
          {this.ephemeral ? (
            <>State db is on the container filesystem, not a mounted volume — it will be <b>lost on a recreate</b>. Mount a volume at the <code>[store] path</code> directory.</>
          ) : (
            <>No state db mounted — some state (e.g. <b>UI-added registries</b>) won't persist across a restart. Mount a volume and set <code>[store] path</code> to keep it.</>
          )}
        </span>
        <button class="x" title="dismiss" onClick={this.dismiss}><loom-icon name="x" size={14}></loom-icon></button>
      </div>
    );
  }
}
