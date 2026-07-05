// hope design system — "terminal instrument".
//
// Flat and precise. No glows, no drop shadows as decoration, no gradients.
// Near-monochrome: a few exact grays carry the structure; green/amber/red are
// the ONLY hues and mean exactly one thing each. Hairline rules, tabular
// monospace, deliberate alignment — instrumentation, not a web list.
//
// theme is an adopted CSSStyleSheet (parsed once, shared) — pass it in the
// @styles(...) array, e.g. @styles(theme, css`…page…`), rather than
// interpolating it into every component's template.
import { css } from "@toyz/loom";

export const theme = css`
  :host {
    --ink: #0A0C11;
    --panel: #0E1118;
    --raised: #141823;
    --line: #1B212E;     /* hairline */
    --line2: #2A3343;    /* brighter hairline / hover */

    --hi: #E7ECF3;       /* primary text */
    --mid: #9AA4B4;      /* secondary */
    --dim: #5A6376;      /* labels, idle */
    --faint: #353D4D;    /* idle marks */

    --ok: #46B27B;       /* running */
    --warn: #E0A23B;     /* degraded */
    --bad: #EC5C5C;      /* down / loop */
    --upd: #4E9BD9;      /* image update available */

    /* status glyphs (SVG masks, tinted by background-color) */
    --mk-dot: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='9' fill='%23000'/%3E%3C/svg%3E");
    --mk-ring: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='7.5' fill='none' stroke='%23000' stroke-width='3'/%3E%3C/svg%3E");
    --mk-spin: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 3a9 9 0 0 1 9 9' fill='none' stroke='%23000' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E");

    --mono: "SF Mono", "JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

    color: var(--hi);
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
  }
  *, *::before, *::after { box-sizing: border-box; }
  a { color: inherit; text-decoration: none; }

  .mid { color: var(--mid); }
  .dim { color: var(--dim); }
  .num { font-variant-numeric: tabular-nums; }

  /* state marks — crisp SVG glyphs (mask + tint), never a glow.
     idle/stopped reads as a hollow ring; active states a filled dot;
     restarting a spinning arc. */
  .mark { width: 9px; height: 9px; flex: none; background-color: var(--faint);
    -webkit-mask: var(--mk-ring) center / contain no-repeat; mask: var(--mk-ring) center / contain no-repeat; }
  .mark.ok, .mark.warn, .mark.bad, .mark.upd { -webkit-mask-image: var(--mk-dot); mask-image: var(--mk-dot); }
  .mark.ok { background-color: var(--ok); }
  .mark.warn { background-color: var(--warn); }
  .mark.bad { background-color: var(--bad); }
  .mark.upd { background-color: var(--upd); }
  .mark.loop { background-color: var(--bad); -webkit-mask-image: var(--mk-spin); mask-image: var(--mk-spin);
    animation: spin .9s linear infinite; }

  /* buttons — flat, hairline, hover brightens the border only */
  .btn {
    font: 500 12px/1 var(--mono); color: var(--mid); letter-spacing: .02em;
    background: transparent; border: 1px solid var(--line); border-radius: 0;
    padding: 7px 11px; cursor: pointer; transition: color .1s, border-color .1s;
  }
  .btn:hover { color: var(--hi); border-color: var(--line2); }
  .btn:focus-visible { outline: 1px solid var(--hi); outline-offset: 1px; }
  .btn:disabled { opacity: .35; cursor: not-allowed; }

  /* ─────────────────────────────────────────────────────────────────────────
     view system — the shared explorer page shell. Every page uses these so the
     header / stats / table / spacing read identically (the mock, as one system,
     not per-page CSS). Full-bleed: hairlines span the pane; content aligns at 28px.
     ───────────────────────────────────────────────────────────────────────── */
  .vhead { display: flex; align-items: center; gap: 11px; padding: 22px 28px 0; }
  .vhead .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--dim); }
  .vhead .dot.ok { background: var(--ok); } .vhead .dot.warn { background: var(--warn); }
  .vhead .dot.bad { background: var(--bad); } .vhead .dot.upd { background: var(--upd); }
  .vhead .dot.off { background: var(--bad); opacity: .5; }
  .vhead h1 { margin: 0; font: 700 18px/1 var(--mono); letter-spacing: .01em; color: var(--hi); }
  .vhead .meta { margin-left: 6px; color: var(--dim); font: 500 11px/1.4 var(--mono); word-break: break-all; }
  .vhead .grow { flex: 1; }
  .vhead .act { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px; border: 1px solid var(--line2);
    background: transparent; color: var(--mid); cursor: pointer; font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .vhead .act:hover { color: var(--hi); border-color: var(--dim); }
  .vhead .act:disabled { opacity: .5; cursor: default; }
  .vhead .act loom-icon { color: var(--dim); }

  .vstats { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-end; padding: 16px 28px 18px; border-bottom: 1px solid var(--line); }
  .vstats .s { display: flex; flex-direction: column; gap: 6px; }
  .vstats .s .k { color: var(--dim); font: 600 9.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .vstats .s .v { color: var(--hi); font: 500 15px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .vstats .s .v .t { color: var(--dim); }
  .vstats .s .v.vlink { background: transparent; border: 0; padding: 0; text-align: left; color: var(--upd); cursor: pointer;
    font: 500 15px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .vstats .s .v.vlink:hover { text-decoration: underline; }
  .vstats .grow { flex: 1; }

  .vpad { padding: 18px 28px; }

  .vtable { width: 100%; border-collapse: collapse; }
  .vtable thead th { text-align: left; padding: 12px 14px; color: var(--dim); font: 600 9.5px/1 var(--mono);
    letter-spacing: .14em; text-transform: uppercase; border-bottom: 1px solid var(--line); }
  .vtable th:first-child, .vtable td:first-child { padding-left: 28px; }
  .vtable th:last-child, .vtable td:last-child { padding-right: 28px; }
  .vtable th.r, .vtable td.r { text-align: right; }
  .vtable tbody td { padding: 0 14px; height: 46px; border-bottom: 1px solid var(--line); color: var(--mid);
    font: 13px/1.35 var(--mono); font-variant-numeric: tabular-nums; }
  .vtable tbody tr { cursor: pointer; }
  .vtable tbody tr:hover td { background: var(--raised); }
  .vtable tbody tr.sel td { background: color-mix(in srgb, var(--upd) 13%, transparent); color: var(--hi); }
  .vtable tbody tr.sel td:first-child { box-shadow: inset 2px 0 0 var(--upd); }
  .vtable td .nm { display: flex; align-items: center; gap: 10px; color: var(--hi); }
  .vtable td.chev { width: 44px; text-align: right; color: var(--dim); }
  .vtable tbody tr:hover td.chev { color: var(--hi); }

  /* card — a bordered summary panel (header / body of rows / footer). Grids of
     these are the fleet host cards today; reusable for any summary grid. */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  .card { border: 1px solid var(--line); background: var(--panel); }
  .card.click { cursor: pointer; }
  .card.click:hover { border-color: var(--line2); }
  .card-h { display: flex; align-items: center; gap: 9px; padding: 13px 14px; border-bottom: 1px solid var(--line); }
  .card-h .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dim); }
  .card-h .dot.ok { background: var(--ok); } .card-h .dot.warn { background: var(--warn); }
  .card-h .dot.bad { background: var(--bad); } .card-h .dot.upd { background: var(--upd); }
  .card-h .dot.off { background: var(--bad); opacity: .5; }
  .card-h h3 { margin: 0; font: 700 14px/1 var(--mono); color: var(--hi); }
  .card-h .kind { color: var(--dim); font: 600 9px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .card-h .grow { flex: 1; }
  .card-h .roll { color: var(--mid); font: 13px/1 var(--mono); font-variant-numeric: tabular-nums; }
  .card-h .roll .t { color: var(--dim); }
  .card-b { padding: 6px 0; min-height: 40px; }
  .card-row { display: flex; align-items: center; gap: 9px; padding: 6px 14px; color: var(--mid); font: 12px/1 var(--mono); }
  .card-row.click { cursor: pointer; }
  .card-row.click:hover { background: var(--raised); color: var(--hi); }
  .card-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-row .rt { margin-left: auto; color: var(--mid); font-variant-numeric: tabular-nums; }
  .card-row .rt .t { color: var(--dim); }
  .card-f { display: flex; align-items: center; gap: 6px; padding: 10px 14px; border-top: 1px solid var(--line); }
  .btn.danger:hover { color: var(--bad); border-color: var(--bad); }

  /* segmented bar (used sparingly) */
  .seg { display: flex; gap: 1px; width: 100%; }
  .seg > i { flex: 1 1 0; height: var(--seg-h, 6px); background: var(--faint); }
  .seg > i.ok { background: var(--ok); }
  .seg > i.warn { background: var(--warn); }
  .seg > i.bad, .seg > i.loop { background: var(--bad); }
  .seg > i.upd { background: var(--upd); }

  /* <hope-alert> slotted-message emphasis (light DOM, so styled globally) */
  hope-alert b { color: var(--hi); font-weight: 600; }
  hope-alert code { color: var(--hi); font-family: var(--mono); }

  /* tooltip — flat, hairline, no shadow */
  [data-tip] { position: relative; }
  [data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute; bottom: calc(100% + 7px); left: 50%; transform: translateX(-50%);
    background: var(--ink); border: 1px solid var(--line2); color: var(--hi);
    font: 500 11px/1.3 var(--mono); white-space: nowrap; padding: 5px 8px; border-radius: 0;
    z-index: 50; pointer-events: none;
  }

  .spin { animation: spin 1s linear infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .mark.loop { animation: none; } }

  pre {
    background: #070A0F; border: 1px solid var(--line); border-radius: 0;
    padding: 14px; margin: 0; overflow: auto;
    font: 12px/1.6 var(--mono); color: #BFC9D8;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #1a2130; }
  ::-webkit-scrollbar-thumb:hover { background: #232c3d; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-corner { background: transparent; }
`;

export function markClass(state: string): string {
  if (state === "running") return "ok";
  if (state === "restarting") return "loop";
  if (state === "created" || state === "paused") return "warn";
  return "";
}

export type Severity = "loop" | "warn" | "down" | "ok";

export function stackSeverity(running: number, total: number, restarting: boolean): Severity {
  if (restarting) return "loop";
  if (running === 0) return "down";
  if (running < total) return "warn";
  return "ok";
}

export function severityRank(s: Severity): number {
  return { loop: 0, warn: 1, down: 2, ok: 3 }[s];
}

// The single sev -> .mark class mapping (green/amber/red/blue/spin). "down" has
// no glyph class -> the neutral faint ring. A healthy stack with an image update
// available shows the blue update dot instead of green.
export function severityMark(sev: Severity, hasUpdate = false): string {
  if (sev === "ok") return hasUpdate ? "upd" : "ok";
  if (sev === "down") return ""; // faint ring
  return sev; // loop | warn
}

// The single sev -> human health word, shown next to the mark.
export function healthLabel(sev: Severity): string {
  return { ok: "healthy", warn: "degraded", down: "down", loop: "restarting" }[sev];
}

// The single sev -> <hope-chip> tone (ok green / warn amber / bad red / neutral).
// "down" is neutral (a fully-stopped stack isn't an error), loop is the loudest.
export function severityTone(sev: Severity): string {
  return { ok: "ok", warn: "warn", down: "", loop: "bad" }[sev];
}
