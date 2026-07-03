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

  /* <hope-table> — the standard data table. The <table> is slotted (light DOM),
     so it's styled here globally. Put a normal <table> inside <hope-table> and use
     these cell classes. table-layout:fixed + ellipsis = aligned columns, no wrap. */
  hope-table table { width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--line); }
  hope-table table.flat { border: 0; } /* inside a <hope-panel>, the panel owns the border */
  hope-table thead th { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line);
    font: 600 10px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  hope-table th.r, hope-table td.r { text-align: right; }
  hope-table tbody td { padding: 0 14px; height: 44px; border-bottom: 1px solid var(--line);
    font: 12.5px/1.3 var(--mono); color: var(--mid); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  hope-table tbody tr:last-child td { border-bottom: none; }
  hope-table tbody tr:hover td { background: var(--raised); }
  hope-table tbody tr.sel td { background: color-mix(in srgb, var(--upd) 8%, transparent); }
  hope-table tbody tr.click { cursor: pointer; }
  hope-table th.pl, hope-table td.pl { padding-left: 16px; }
  /* Cells holding a box widget (checkbox / remove button) in a narrow column:
     the widget overflows the content box, and the cell's text-overflow:ellipsis
     would paint a stray ellipsis mark ("…") beside it. Clip those cells only —
     text columns (Size, etc.) still ellipsize. */
  hope-table th:has(.ck), hope-table td:has(.ck), hope-table td:has(.rm) { text-overflow: clip; }
  /* cell utility classes */
  hope-table .link, hope-table td.link { color: var(--hi); cursor: pointer; }
  hope-table .link:hover, hope-table td.link:hover { color: var(--upd); text-decoration: underline; text-underline-offset: 3px; }
  hope-table .dim { color: var(--dim); }
  hope-table .hi, hope-table td.hi { color: var(--hi); }
  hope-table .num, hope-table td.num { font-variant-numeric: tabular-nums; }
  hope-table td.cmd { white-space: normal; overflow-wrap: anywhere; word-break: normal; color: var(--hi); } /* argv / long text wraps at spaces */
  hope-table .ck { display: inline-block; width: 15px; height: 15px; border: 1px solid var(--line2); cursor: pointer; vertical-align: middle; }
  hope-table .ck:hover { border-color: var(--mid); }
  hope-table .ck.on { background: var(--upd); border-color: var(--upd); box-shadow: inset 0 0 0 3px var(--panel); }
  hope-table .rm { display: inline-grid; place-items: center; width: 28px; height: 28px; background: transparent;
    border: 1px solid transparent; color: var(--dim); cursor: pointer; }
  hope-table .rm:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); background: var(--raised); }

  /* tooltip — flat, hairline, no shadow */
  [data-tip] { position: relative; }
  [data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute; bottom: calc(100% + 7px); left: 50%; transform: translateX(-50%);
    background: var(--ink); border: 1px solid var(--line2); color: var(--hi);
    font: 500 11px/1.3 var(--mono); white-space: nowrap; padding: 5px 8px; border-radius: 0;
    z-index: 50; pointer-events: none;
  }

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
