// Shared styles for the networks + volumes pages (same list/usage layout).
export const resourceStyles = `
  :host { display: block; min-height: 100vh; background: var(--ink); }

  .bar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink);
  }
  .bar .s { display: flex; align-items: center; gap: 8px; padding: 0 16px; border-right: 1px solid var(--line); white-space: nowrap; }
  .bar .grow { flex: 1; border-right: 1px solid var(--line); }
  .bar .back { display: flex; align-items: center; gap: 5px; color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .back:hover { color: var(--hi); }
  .bar .crumb { font: 600 13px/1 var(--mono); letter-spacing: .04em; color: var(--hi); }
  .bar .nav .navlink { font: 600 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); cursor: pointer; }
  .bar .nav .navlink:hover { color: var(--hi); }
  .bar .nav .navlink.on { color: var(--hi); }
  .bar .act { padding: 0; }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }
  .bar .act button:disabled { opacity: .55; cursor: default; }

  main { padding: 28px 40px 96px; max-width: 1340px; margin: 0 auto; }
  .empty { padding: 40px; text-align: center; color: var(--dim); border: 1px solid var(--line); }

  .summary { display: flex; align-items: center; border: 1px solid var(--line); margin-bottom: 20px; }
  .summary .stat { display: flex; flex-direction: column; gap: 5px; padding: 11px 16px; border-right: 1px solid var(--line); }
  .summary .k { font: 600 9.5px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .summary .v { font: 600 15px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }

  .search { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); padding: 0 14px; margin-bottom: 16px; }
  .search .ico { color: var(--dim); display: flex; }
  .search input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--hi); font: 400 13px/1 var(--mono); padding: 12px 0; }

  .rlist { border: 1px solid var(--line); }
  .rrow { display: flex; align-items: center; gap: 13px; padding: 0 16px; height: 46px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .rrow:last-child { border-bottom: none; }
  .rrow:hover { background: var(--raised); }
  .rrow.empty { cursor: default; }
  .rrow.empty:hover { background: transparent; }
  .rrow .grow { flex: 1; }
  .rrow .rdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); }
  .rrow .rdot.on { background: var(--ok); }
  .rrow .rname { font: 600 13px/1 var(--mono); color: var(--hi); letter-spacing: .01em; }
  .rrow .rmeta { font: 500 11px/1 var(--mono); color: var(--dim); letter-spacing: .04em; }
  .rrow .rcount { font: 600 13px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; }
  .rrow .rcount .t { color: var(--dim); font-weight: 400; }
  .rrow .chev { color: var(--dim); transition: transform .15s ease; }
  .rrow .chev.up { transform: rotate(180deg); }
  .rrow .chevpad { width: 14px; }

  .users { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px 14px 37px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.012); }
  .users .user { font: 500 12px/1 var(--mono); color: var(--mid); border: 1px solid var(--line); padding: 6px 9px; cursor: pointer; white-space: nowrap; }
  .users .user:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .users .user b { color: var(--hi); font-weight: 600; }
  .users .user .sep { color: var(--dim); }
`;
