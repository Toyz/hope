import { css } from "@toyz/loom";

export const docStyles = css`
  :host { display: block; min-height: 100%; color: var(--hi); }
  .doc { width: 100%; padding: 0 0 80px; }
  section { margin: 0; border-bottom: 1px solid var(--line); background: var(--ink); }
  section > h2 { height: 36px; display: flex; align-items: center; margin: 0; padding: 0 28px;
    border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 72%, var(--ink)); color: var(--dim);
    font: 600 9.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  .body { max-width: 1020px; padding: 16px 28px 18px; }
  h3 { margin: 22px 0 10px; color: var(--mid); font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  h3:first-child { margin-top: 0; }
  p { margin: 0 0 12px; color: var(--mid); font: 12px/1.7 var(--mono); }
  p:last-child { margin-bottom: 0; }
  code, .ic { color: var(--upd); font-family: var(--mono); }
  strong { color: var(--hi); font-weight: 600; }
  ul { display: flex; flex-direction: column; gap: 9px; margin: 4px 0 12px; padding: 0; list-style: none; }
  li { position: relative; padding-left: 16px; color: var(--mid); font: 12px/1.6 var(--mono); }
  ul li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 4px; height: 4px; background: var(--dim); }
  ol { display: grid; gap: 0; margin: 4px 0 12px; padding: 0; list-style: none; counter-reset: step; border-top: 1px solid var(--line); }
  ol li { min-height: 42px; padding: 11px 8px 11px 48px; border-bottom: 1px solid var(--line); counter-increment: step; }
  ol li::before { content: counter(step, decimal-leading-zero); position: absolute; left: 8px; color: var(--upd); font: 600 10px/1.6 var(--mono); }
  .facts { display: grid; grid-template-columns: 180px minmax(0, 1fr); }
  .facts dt, .facts dd { margin: 0; padding: 10px 0; border-bottom: 1px solid var(--line); font: 12px/1.55 var(--mono); }
  .facts dt { color: var(--hi); }
  .facts dd { color: var(--dim); }
  .facts dt:last-of-type, .facts dd:last-of-type { border-bottom: 0; }
  @media (max-width: 700px) {
    .doc { padding-bottom: 56px; }
    section > h2 { padding: 0 16px; }
    .body { padding: 14px 16px 16px; }
    .facts { grid-template-columns: 1fr; }
    .facts dt { padding-bottom: 2px; border-bottom: 0; }
    .facts dd { padding-top: 2px; }
  }
`;
