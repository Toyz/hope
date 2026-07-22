// Audit — the fleet-wide audit log: one page combining every recorded action across
// core operations (container lifecycle, stack ops, image/volume/network changes) and
// plugin actions, with who did it, from where (stack + host), and whether it worked.
// Backed by the reusable audit engine (Audit.list). A row flyout shows the full detail
// + any structured metadata tied to the event.
import { LoomElement, component, styles, css, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { Refreshing } from "../events";
import { ago } from "../format";
import type { AuditEntry } from "../contracts";
import { theme } from "../styles";

// The category filter chips (""=all). Order mirrors how often you'd audit them.
const CATS = ["", "container", "stack", "image", "volume", "network", "tunnel", "plugin", "agent", "registry"];

// Source → pill tone: an operator (a person) vs a plugin vs hope itself.
function sourceTone(s: string): string {
  return s === "operator" ? "op" : s === "plugin" ? "pl" : "sys";
}

// cleanTarget drops the redundant "<host>|" prefix from a plugin identity
// (host|project/service) — the host is already its own column — so the target reads as
// "project/service". Non-plugin targets (container names, image refs) pass through.
function cleanTarget(t: string | undefined): string {
  if (!t) return "";
  const bar = t.indexOf("|");
  return bar >= 0 ? t.slice(bar + 1) : t;
}

@route("/audit")
@component("hope-audit")
@styles(theme, css`
  :host { display: block; min-height: 100%; background: var(--ink); }
  .wrap { padding: 0 0 40px; }
  .filters { display: flex; flex-wrap: wrap; gap: 7px; padding: 14px 28px 10px; }
  .chip { padding: 4px 11px; border: 1px solid var(--line2); background: var(--panel); color: var(--dim); cursor: pointer;
    font: 11px/1.5 var(--mono); letter-spacing: .04em; text-transform: uppercase; }
  .chip:hover { color: var(--mid); border-color: color-mix(in srgb, var(--upd) 40%, var(--line2)); }
  .chip.on { color: var(--hi); border-color: var(--upd); background: color-mix(in srgb, var(--upd) 12%, var(--panel)); }
  .empty { padding: 60px 28px; color: var(--dim); font: 13px/1.7 var(--mono); text-align: center; }
  .tw { padding: 0 28px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 780px; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--ink); text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line2);
    color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; white-space: nowrap; }
  tbody td { padding: 9px 12px; border-bottom: 1px solid var(--line); color: var(--mid); font: 12px/1.4 var(--mono);
    vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  tbody tr { cursor: pointer; }
  tbody tr:hover td { background: var(--raised); color: var(--hi); }
  tbody tr.bad td { color: color-mix(in srgb, var(--bad) 55%, var(--mid)); }
  .when { color: var(--dim); font-variant-numeric: tabular-nums; }
  .who { color: var(--hi); }
  .act { color: var(--hi); }
  .act.dng::before { content: "! "; color: var(--warn); }
  .dim { color: var(--dim); }
  /* source pill */
  .src { display: inline-block; padding: 1px 7px; border: 1px solid var(--line2); font: 9.5px/1.6 var(--mono);
    letter-spacing: .06em; text-transform: uppercase; }
  .src.op { color: var(--upd); border-color: color-mix(in srgb, var(--upd) 40%, var(--line2)); }
  .src.pl { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line2)); }
  .src.sys { color: var(--dim); }
  /* status dot */
  .st { display: inline-flex; align-items: center; gap: 6px; }
  .st::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  .st.err::before { background: var(--bad); }
  .st .ms { color: var(--dim); font-variant-numeric: tabular-nums; }
  /* detail flyout */
  .scrim { position: fixed; inset: 0; z-index: 900; background: color-mix(in srgb, var(--ink) 40%, transparent); }
  .fly { position: fixed; top: 0; right: 0; bottom: 0; width: 440px; max-width: 100%; z-index: 901; background: var(--panel);
    border-left: 1px solid var(--line2); display: flex; flex-direction: column; animation: slidein .16s cubic-bezier(.2,.8,.3,1) both; }
  @keyframes slidein { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
  .fhead { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line); }
  .fhead .ft { flex: 1; color: var(--hi); font: 600 13px/1.2 var(--mono); }
  .fhead .fx { background: transparent; border: 0; color: var(--dim); cursor: pointer; display: flex; padding: 2px; }
  .fhead .fx:hover { color: var(--hi); }
  .fbody { overflow-y: auto; padding: 6px 0 20px; }
  .frow { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 14px; padding: 8px 18px; font: 12px/1.5 var(--mono); }
  .frow .fk { color: var(--dim); }
  .frow .fv { color: var(--hi); min-width: 0; word-break: break-all; }
  .frow .fv.err { color: var(--bad); }
  .fmeta { margin: 8px 18px 0; padding: 12px; background: var(--ink); border: 1px solid var(--line); }
  .fmeta .fml { color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; margin-bottom: 8px; }
  .fmeta pre { margin: 0; color: var(--mid); font: 11.5px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; }
`)
export class AuditPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;

  @reactive accessor entries: AuditEntry[] = [];
  @reactive accessor loading = true;
  @reactive accessor cat = ""; // active category filter ("" = all)
  @reactive accessor flyout: AuditEntry | null = null;

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      app.get(LoomRouter).navigate("/login");
      return;
    }
    void this.load();
  }

  // Refetch on the shared refresh beat so the log stays live with the rest of the app.
  @on(Refreshing)
  private onRefresh(e: Refreshing) { if (!e.active) void this.load(); }

  private async load() {
    this.loading = true;
    try {
      this.entries = (await this.rpc.call<AuditEntry[]>("Audit", "list", [{ category: this.cat, limit: 500 }])) || [];
    } catch {
      this.entries = [];
    } finally {
      this.loading = false;
    }
  }

  private setCat(c: string) {
    if (c === this.cat) return;
    this.cat = c;
    void this.load();
  }

  private metaText(e: AuditEntry): string {
    if (e.meta == null) return "";
    try {
      return typeof e.meta === "string" ? e.meta : JSON.stringify(e.meta, null, 2);
    } catch {
      return String(e.meta);
    }
  }

  update() {
    return (
      <>
        <hope-phead heading="Audit" scope="primary" meta="fleet-wide trail of who did what, where, and when — core operations + plugin actions">
          <hope-refresh slot="actions"></hope-refresh>
        </hope-phead>
        <div class="wrap">
          <div class="filters">
            {CATS.map((c) => (
              <span class={"chip" + (this.cat === c ? " on" : "")} onClick={() => this.setCat(c)}>{c || "all"}</span>
            ))}
          </div>
          {this.loading && !this.entries.length ? (
            <div class="empty">loading…</div>
          ) : !this.entries.length ? (
            <div class="empty">No audit events{this.cat ? " in " + this.cat : ""} yet.<br />Actions across the fleet — container lifecycle, stack ops, plugin actions — are recorded here.</div>
          ) : (
            <div class="tw">
              <table>
                <thead>
                  <tr>
                    <th>when</th><th>actor</th><th>source</th><th>action</th><th>stack</th><th>target</th><th>host</th><th>status</th>
                  </tr>
                </thead>
                <tbody>
                  {this.entries.map((e) => (
                    <tr class={e.ok ? "" : "bad"} onClick={() => (this.flyout = e)}>
                      <td class="when">{ago(e.time)}</td>
                      <td class="who">{e.actor || "—"}</td>
                      <td><span class={"src " + sourceTone(e.source)}>{e.source}</span></td>
                      <td><span class={"act" + (e.danger ? " dng" : "")}>{e.category}:{e.action}</span></td>
                      <td>{e.project || <span class="dim">—</span>}</td>
                      <td>{cleanTarget(e.target) || <span class="dim">—</span>}</td>
                      <td>{e.host || <span class="dim">—</span>}</td>
                      <td><span class={"st" + (e.ok ? "" : " err")}>{e.ok ? "ok" : "fail"}{e.ms ? <span class="ms">· {e.ms}ms</span> : null}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {this.flyout ? (
          <>
            <div class="scrim" onClick={() => (this.flyout = null)}></div>
            <div class="fly">
              <div class="fhead">
                <loom-icon name={this.flyout.ok ? "check" : "alert"} size={15} color={this.flyout.ok ? "var(--ok)" : "var(--bad)"}></loom-icon>
                <span class="ft">{this.flyout.category}:{this.flyout.action}</span>
                <button class="fx" onClick={() => (this.flyout = null)}><loom-icon name="x" size={15}></loom-icon></button>
              </div>
              <div class="fbody">
                <div class="frow"><span class="fk">when</span><span class="fv">{new Date(this.flyout.time).toLocaleString()}</span></div>
                <div class="frow"><span class="fk">actor</span><span class="fv">{this.flyout.actor || "—"}</span></div>
                <div class="frow"><span class="fk">source</span><span class="fv">{this.flyout.source}</span></div>
                <div class="frow"><span class="fk">stack</span><span class="fv">{this.flyout.project || "—"}</span></div>
                <div class="frow"><span class="fk">target</span><span class="fv">{cleanTarget(this.flyout.target) || "—"}</span></div>
                <div class="frow"><span class="fk">host</span><span class="fv">{this.flyout.host || "—"}</span></div>
                <div class="frow"><span class="fk">status</span><span class="fv">{this.flyout.ok ? "ok" : "failed"}{this.flyout.danger ? " · destructive" : ""}{this.flyout.ms ? ` · ${this.flyout.ms}ms` : ""}</span></div>
                {this.flyout.detail ? <div class="frow"><span class="fk">detail</span><span class="fv">{this.flyout.detail}</span></div> : null}
                {this.flyout.err ? <div class="frow"><span class="fk">error</span><span class="fv err">{this.flyout.err}</span></div> : null}
                {this.flyout.meta != null ? (
                  <div class="fmeta"><div class="fml">metadata</div><pre>{this.metaText(this.flyout)}</pre></div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </>
    );
  }
}
