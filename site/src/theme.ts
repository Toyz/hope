// hope's design system, verbatim — the docs site IS hope's chrome, so it shares the
// exact tokens (terminal-instrument: flat, near-monochrome, hairline rules, mono type).
// Kept in sync with frontend/src/styles.ts by hand; it changes rarely.
import { css } from "@toyz/loom";

export const theme = css`
  :host {
    --ink: #0A0C11;
    --panel: #0E1118;
    --raised: #141823;
    --line: #1B212E;
    --line2: #2A3343;

    --hi: #E7ECF3;
    --mid: #9AA4B4;
    --dim: #5A6376;
    --faint: #353D4D;

    --ok: #46B27B;
    --warn: #E0A23B;
    --bad: #EC5C5C;
    --upd: #4E9BD9;

    --on-accent: #06080d;
    --scrim: rgba(4, 6, 10, .66);

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
`;
