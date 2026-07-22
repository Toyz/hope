// <hope-palette> — the global command palette (the ⌘K "jump to" search). Opens on
// mod+k (cmd on mac, ctrl elsewhere) or a click on the topbar search box, fuzzy-
// matches across hosts, stacks, containers, and the resource/system pages, and
// navigates on select. Keyboard-first: arrows to move, enter to go, escape to
// close — all via loom's @hotkey system.
import { LoomElement, component, styles, css, reactive, on, query, app } from "@toyz/loom";
import { hotkey } from "@toyz/loom/element";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { PaletteToggle } from "../events";
import { withHost, stackPath, containerPath } from "../host-url";
import { UNGROUPED } from "../const";
import { signalModal } from "../modal";
import type { HostView, StackSummary } from "../contracts";
import { theme } from "../styles";

type Kind = "page" | "host" | "stack" | "container" | "plugin";
type Entry = { kind: Kind; label: string; sub?: string; icon: string; to: string; hay: string };

const KIND_LABEL: Record<Kind, string> = { page: "page", host: "host", stack: "stack", container: "container", plugin: "plugin" };

// A light subsequence fuzzy score: every query char must appear in order; a
// contiguous run and a start-of-word match score higher. Returns -1 on no match.
function score(query: string, hay: string): number {
  if (!query) return 0;
  let qi = 0, s = 0, run = 0, prev = -2;
  for (let hi = 0; hi < hay.length && qi < query.length; hi++) {
    if (hay[hi] === query[qi]) {
      s += 1;
      if (hi === prev + 1) { run += 1; s += run * 2; } else run = 0;
      if (hi === 0 || hay[hi - 1] === " " || hay[hi - 1] === "/" || hay[hi - 1] === "-") s += 3;
      prev = hi;
      qi++;
    }
  }
  return qi === query.length ? s : -1;
}

@component("hope-palette")
@styles(theme, css`
  :host { position: fixed; inset: 0; z-index: 1200; display: none; }
  :host([open]) { display: block; }
  .scrim { position: absolute; inset: 0; background: rgba(4, 6, 10, .6); backdrop-filter: blur(2px); animation: pfade .1s ease both; }
  @keyframes pfade { from { opacity: 0; } to { opacity: 1; } }
  .box { position: absolute; top: 12vh; left: 50%; transform: translateX(-50%); width: 620px; max-width: 92vw;
    background: var(--panel); border: 1px solid var(--line2); box-shadow: 0 24px 60px rgba(0,0,0,.5);
    animation: ppop .12s cubic-bezier(.2,.8,.3,1) both; display: flex; flex-direction: column; max-height: 66vh; }
  @keyframes ppop { from { opacity: 0; transform: translateX(-50%) translateY(-6px); } to { opacity: 1; transform: translateX(-50%); } }
  .qbar { display: flex; align-items: center; gap: 11px; padding: 0 15px; height: 50px; border-bottom: 1px solid var(--line); flex: none; }
  .qbar loom-icon { color: var(--dim); flex: none; }
  .qbar input { flex: 1; background: transparent; border: 0; outline: none; color: var(--hi); font: 400 14px/1 var(--mono); }
  .qbar input::placeholder { color: var(--dim); }
  .qbar .esc { border: 1px solid var(--line2); color: var(--dim); padding: 2px 6px; font: 500 10px/1 var(--mono); flex: none; }
  .list { overflow-y: auto; padding: 6px 0; min-height: 0; }
  .row { display: flex; align-items: center; gap: 12px; padding: 9px 15px; cursor: pointer; }
  .row loom-icon { color: var(--dim); flex: none; }
  .row.on { background: color-mix(in srgb, var(--upd) 14%, transparent); }
  .row.on::before { content: ""; position: absolute; left: 0; width: 2px; height: 34px; background: var(--upd); margin-top: -9px; }
  .row.on loom-icon { color: var(--upd); }
  .row .lb { color: var(--hi); font: 13px/1 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .sub { color: var(--dim); font: 11px/1 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .grow { flex: 1; }
  .row .kind { color: var(--faint); font: 600 9px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; flex: none; }
  .empty { padding: 26px 15px; text-align: center; color: var(--dim); font: 12.5px/1.5 var(--mono); }
`)
export class HopePalette extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @query("input") accessor input!: HTMLInputElement;

  @reactive accessor open = false;
  @reactive accessor query = "";
  @reactive accessor sel = 0;
  @reactive accessor items: Entry[] = [];

  private get router(): LoomRouter { return app.get(LoomRouter); }

  @on(PaletteToggle) private onToggle() { this.toggle(); }

  @hotkey("mod+k", { global: true })
  private toggle() { this.open ? this.close() : this.openIt(); }

  @hotkey("escape", { global: true })
  private onEsc() { if (this.open) this.close(); }

  @hotkey("arrowdown")
  private down() { if (this.open) this.sel = Math.min(this.sel + 1, Math.max(0, this.filtered().length - 1)); }
  @hotkey("arrowup")
  private up() { if (this.open) this.sel = Math.max(this.sel - 1, 0); }
  @hotkey("enter")
  private enter() { if (this.open) this.go(this.filtered()[this.sel]); }

  private openIt() {
    this.open = true;
    this.toggleAttribute("open", true);
    this.query = "";
    this.sel = 0;
    signalModal(this, true);
    void this.load();
    queueMicrotask(() => this.input?.focus());
  }
  private close() {
    this.open = false;
    this.toggleAttribute("open", false);
    signalModal(this, false);
  }

  private async load() {
    const hosts = (await this.rpc.call<HostView[]>("System", "hosts", []).catch(() => [])) || [];
    const e: Entry[] = [];
    const push = (kind: Kind, label: string, icon: string, to: string, sub?: string) =>
      e.push({ kind, label, icon, to, sub, hay: (label + " " + (sub || "") + " " + kind).toLowerCase() });

    push("page", "fleet", "box", "/");

    // Resource pages are host-scoped, so one entry per host + the all-hosts view.
    const RESOURCE_PAGES = [["box", "images"], ["database", "volumes"], ["link", "networks"], ["globe", "tunnels"]] as const;
    for (const [icon, page] of RESOURCE_PAGES) {
      for (const h of hosts) push("page", page, icon, withHost(h.id, "/" + page), h.id);
      push("page", page, icon, withHost("all", "/" + page), "all hosts");
    }
    // deploy is host-scoped but has no fleet view — one per host.
    for (const h of hosts) push("page", "deploy", "rocket", withHost(h.id, "/deploy"), h.id);

    push("page", "agents", "server", "/agents");
    push("page", "registries", "database", "/registries");
    push("page", "audit", "list", "/audit");

    for (const h of hosts) push("host", h.id, "server", `/host/${h.id}`, h.kind === "local" ? "local daemon" : "agent");

    const connected = hosts.filter((h) => h.connected);
    const per = await Promise.all(
      connected.map((h) =>
        this.rpc.callOn<StackSummary[]>(h.id, "Stacks", "list", []).then((s) => ({ host: h.id, stacks: s || [] })).catch(() => ({ host: h.id, stacks: [] as StackSummary[] })),
      ),
    );
    for (const { host, stacks } of per) {
      for (const s of stacks) {
        if (s.project !== UNGROUPED) push("stack", s.project, "box", stackPath(host, s.project), host);
        for (const c of s.containers || []) push("container", c.service || c.name, "terminal", containerPath(host, s.project, c.id), `${s.project === UNGROUPED ? "loose" : s.project} · ${host}`);
      }
    }

    // Plugin pages — the command surface. Every navigable leaf becomes an entry.
    const pps = (await this.rpc.call<any[]>("Plugins", "pages", []).catch(() => [])) || [];
    for (const pp of pps) {
      const walk = (nodes: any[], trail: string) => {
        for (const n of nodes || []) {
          if (n.children && n.children.length) walk(n.children, trail ? `${trail} / ${n.title}` : n.title);
          else push("plugin", n.title, n.icon || "plugin", `/plugin/${encodeURIComponent(pp.key)}/${n.path}`, pp.name + (trail ? ` · ${trail}` : ""));
        }
      };
      walk(pp.pages, "");
    }
    this.items = e;
  }

  private filtered(): Entry[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.items.slice(0, 40);
    return this.items
      .map((it) => ({ it, s: score(q, it.hay) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.it);
  }

  private go(entry?: Entry) {
    if (!entry) return;
    this.close();
    this.router.navigate(entry.to);
  }

  private onInput = (e: any) => { this.query = e.target.value; this.sel = 0; };

  update() {
    const rows = this.open ? this.filtered() : [];
    if (this.sel >= rows.length) this.sel = Math.max(0, rows.length - 1);
    return (
      <>
        <div class="scrim" onClick={() => this.close()}></div>
        <div class="box">
          <div class="qbar">
            <loom-icon name="search" size={15}></loom-icon>
            <input placeholder="Jump to host, stack, container…" value={this.query} onInput={this.onInput} spellcheck={false} autocomplete="off" />
            <span class="esc">ESC</span>
          </div>
          <div class="list">
            {rows.length ? rows.map((r, i) => (
              <div class={"row" + (i === this.sel ? " on" : "")} style="position:relative" onMouseEnter={() => (this.sel = i)} onClick={() => this.go(r)}>
                <loom-icon name={r.icon} size={14}></loom-icon>
                <span class="lb">{r.label}</span>
                {r.sub ? <span class="sub">{r.sub}</span> : null}
                <span class="grow"></span>
                <span class="kind">{KIND_LABEL[r.kind]}</span>
              </div>
            )) : <div class="empty">No matches.</div>}
          </div>
        </div>
      </>
    );
  }
}
