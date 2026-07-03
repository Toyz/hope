// <hope-refresh run={() => this.load()}> — the shared refresh control in the top
// bar. It brackets the (async) handler with Refreshing(true)…Refreshing(false)
// on the bus, plus a minimum visible beat, so the spin lasts exactly as long as
// the work (and still shows for a beat when a refetch returns in a few ms — the
// original bug). Every mounted control ref-counts the bus events, so a refresh
// from any source spins them all.
import { LoomElement, component, styles, css, reactive, on } from "@toyz/loom";
import { theme } from "../styles";
import { Refreshing, withRefresh } from "../events";

@component("hope-refresh")
@styles(theme, css`
  :host { display: inline-flex; align-items: stretch; height: 100%; }
  button { display: inline-flex; align-items: center; gap: 7px; height: 100%; padding: 0 16px;
    background: transparent; border: 0; color: var(--dim); cursor: pointer;
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  button:hover { color: var(--hi); }
  button:disabled { cursor: default; }
  loom-icon { color: var(--upd); }
`)
export class HopeRefresh extends LoomElement {
  // The async refetch, set as a property by the caller (non-`on*` fn prop).
  accessor run: (() => unknown) | undefined = undefined;

  @reactive accessor spinning = false;
  private inflight = 0; // ref-count of active refreshes seen on the bus

  @on(Refreshing)
  private onRefreshing(e: Refreshing) {
    this.inflight = Math.max(0, this.inflight + (e.active ? 1 : -1));
    this.spinning = this.inflight > 0;
  }

  private trigger = () => { void withRefresh(() => this.run?.()); };

  update() {
    return (
      <button onClick={this.trigger} disabled={this.spinning}>
        <loom-icon class={this.spinning ? "spin" : ""} name="rotate" size={13}></loom-icon>refresh
      </button>
    );
  }
}
