// <hope-alerts-bell> — the alert inbox in the top bar. Toasts (hope-app) are for the
// moment an alert fires; this is the persistent record: a bell with a badge count and
// a dropdown of active alerts you can review and dismiss. Fed by the same PluginAlert
// bus events, so a plugin's p.Alert shows here AND toasts. A resolved alert (or an
// explicit dismiss) drops from the list.
import { LoomElement, component, styles, css, reactive, on } from "@toyz/loom";
import { theme } from "../styles";
import { PluginAlert } from "../events";

interface ActiveAlert {
  key: string; // dedupe key, or source|title
  severity: string;
  source: string; // "plugin.<identity>"
  title: string;
  detail: string;
  ts: number; // client receive time
}

function tone(sev: string): string {
  if (/crit|error|high|fatal/i.test(sev)) return "bad";
  if (/warn|med/i.test(sev)) return "warn";
  return "ok";
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  return h + "h ago";
}

// Strip the "plugin." prefix + the host part for a readable source label.
function sourceLabel(source: string): string {
  const s = source.replace(/^plugin\./, "");
  const slash = s.indexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

@component("hope-alerts-bell")
@styles(theme, css`
  :host { position: relative; display: inline-flex; }
  .bell { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 26px;
    color: var(--dim); cursor: pointer; background: none; border: 1px solid transparent; }
  .bell:hover { color: var(--hi); border-color: var(--line); }
  .bell.armed { color: var(--warn); }
  .badge { position: absolute; top: 1px; right: 1px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
    background: var(--bad); color: #fff; border-radius: 7px; font: 700 9px/14px var(--mono); text-align: center; }
  .panel { position: absolute; top: 32px; right: 0; width: 360px; max-height: 60vh; overflow-y: auto; z-index: 1200;
    background: var(--panel); border: 1px solid var(--line2); box-shadow: 0 10px 30px rgba(0,0,0,.5); animation: pop .12s ease both; }
  @keyframes pop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  .phead { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line);
    font: 600 10px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
  .phead .clear { margin-left: auto; color: var(--dim); cursor: pointer; text-transform: none; letter-spacing: 0; font: 11px/1 var(--sans); }
  .phead .clear:hover { color: var(--hi); }
  .empty { padding: 22px 12px; text-align: center; color: var(--dim); font: 12px/1.5 var(--sans); }
  .item { display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .item:last-child { border-bottom: 0; }
  .dot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; }
  .dot.bad { background: var(--bad); } .dot.warn { background: var(--warn); } .dot.ok { background: var(--ok); }
  .body { min-width: 0; flex: 1; }
  .t { color: var(--hi); font: 600 12.5px/1.35 var(--sans); }
  .d { color: var(--mid); font: 12px/1.45 var(--sans); margin-top: 2px; overflow-wrap: anywhere; }
  .meta { margin-top: 4px; color: var(--dim); font: 10px/1 var(--mono); display: flex; gap: 8px; }
  .x { flex: none; align-self: flex-start; color: var(--dim); cursor: pointer; padding: 2px; }
  .x:hover { color: var(--hi); }
`)
export class HopeAlertsBell extends LoomElement {
  @reactive accessor alerts: ActiveAlert[] = [];
  @reactive accessor open = false;

  @on(PluginAlert)
  private onAlert(e: PluginAlert) {
    const key = e.dedupe || `${e.source}|${e.title}`;
    if (e.resolved) {
      this.alerts = this.alerts.filter((a) => a.key !== key);
      return;
    }
    const next: ActiveAlert = { key, severity: e.severity, source: e.source, title: e.title, detail: e.detail, ts: Date.now() };
    const i = this.alerts.findIndex((a) => a.key === key);
    // Newest first; an updated same-key alert moves to the top.
    this.alerts = i >= 0 ? [next, ...this.alerts.filter((_, j) => j !== i)] : [next, ...this.alerts];
  }

  // Close on any outside click / Esc (bound once, inert unless open).
  @on(window, "pointerdown")
  private onDoc(e: PointerEvent) {
    if (this.open && !e.composedPath().includes(this)) this.open = false;
  }
  @on(window, "keydown")
  private onKey(e: KeyboardEvent) {
    if (this.open && e.key === "Escape") this.open = false;
  }

  private dismiss(key: string, e: Event) {
    e.stopPropagation();
    this.alerts = this.alerts.filter((a) => a.key !== key);
  }

  update() {
    const n = this.alerts.length;
    return (
      <>
        <button class={"bell" + (n ? " armed" : "")} title={n ? `${n} active alert${n > 1 ? "s" : ""}` : "no active alerts"} onClick={() => (this.open = !this.open)}>
          <loom-icon name="bell" size={15}></loom-icon>
          {n ? <span class="badge">{n > 99 ? "99+" : n}</span> : null}
        </button>
        {this.open ? (
          <div class="panel">
            <div class="phead">
              alerts
              {n ? <span class="clear" onClick={() => (this.alerts = [])}>clear all</span> : null}
            </div>
            {n === 0 ? (
              <div class="empty">No active alerts.</div>
            ) : (
              this.alerts.map((a) => (
                <div class="item">
                  <span class={"dot " + tone(a.severity)}></span>
                  <div class="body">
                    <div class="t">{a.title}</div>
                    {a.detail ? <div class="d">{a.detail}</div> : null}
                    <div class="meta"><span>{sourceLabel(a.source)}</span><span>{ago(a.ts)}</span></div>
                  </div>
                  <span class="x" title="dismiss" onClick={(e: Event) => this.dismiss(a.key, e)}><loom-icon name="x" size={12}></loom-icon></span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </>
    );
  }
}
