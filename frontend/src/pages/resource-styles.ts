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
  .summary .v.warnv { color: var(--warn); }
  .summary .v .t { color: var(--dim); font-weight: 400; font-style: normal; }

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

  /* host pill + toolbar/filters (match the images page) */
  .htag { display: inline-block; width: 96px; box-sizing: border-box; text-align: center; vertical-align: middle;
    margin-right: 11px;
    font: 600 9.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim);
    padding: 4px 7px; border: 1px solid var(--line); border-radius: 5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .toolbar .grow { flex: 1; }
  .filters { display: flex; gap: 6px; }
  .fchip { display: inline-flex; align-items: center; gap: 7px; padding: 7px 11px; background: transparent;
    border: 1px solid var(--line); color: var(--dim); font: 600 11px/1 var(--mono); letter-spacing: .1em;
    text-transform: uppercase; cursor: pointer; }
  .fchip:hover { color: var(--hi); border-color: var(--line2); }
  .fchip.on { color: var(--hi); border-color: var(--mid); background: var(--raised); }
  .fchip .fn { color: var(--dim); font-weight: 400; }
  .fchip.on .fn { color: var(--mid); }
  .pbtn { padding: 8px 13px; background: transparent; border: 1px solid var(--line); color: var(--mid);
    font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; cursor: pointer; }
  .pbtn:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .pbtn.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .pbtn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }

  /* resource table (same shape as the images table) */
  table { width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--line); }
  colgroup col.c-sel { width: 40px; }
  colgroup col.c-name { width: 40%; }
  colgroup col.c-meta { width: 22%; }
  colgroup col.c-use { width: 30%; }
  colgroup col.c-act { width: 8%; }
  th.sel, td.sel { padding-left: 16px; padding-right: 0; }
  td.sel { cursor: pointer; }
  td.sel:hover .ck { border-color: var(--mid); }
  .ck { display: inline-block; width: 15px; height: 15px; border: 1px solid var(--line2); cursor: pointer; vertical-align: middle; }
  .ck:hover { border-color: var(--mid); }
  .ck.on { background: var(--upd); border-color: var(--upd); box-shadow: inset 0 0 0 3px var(--panel); }
  tr.sel td { background: color-mix(in srgb, var(--upd) 8%, transparent); }
  .selbar { display: flex; align-items: center; gap: 12px; margin-left: 12px; }
  .selbar .seln { font: 600 12px/1 var(--mono); color: var(--upd); }
  .selbar .grow { flex: 1; }
  thead th { font: 600 10px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
    text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); }
  th.r, td.r { text-align: right; }
  tbody td { padding: 0 14px; height: 44px; border-bottom: 1px solid var(--line); font: 12.5px/1.3 var(--mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--raised); }
  td.rname { color: var(--hi); }
  td.rmeta { color: var(--dim); font-variant-numeric: tabular-nums; }
  td.use { color: var(--mid); }
  td.use .none { color: var(--dim); }
  .rm { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .rm:hover { color: var(--bad); }

  /* detail modal (same as the images modal) */
  .dmodal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
    background: rgba(4, 6, 10, .66); backdrop-filter: blur(3px); }
  .dbox { width: 600px; max-width: 100%; background: var(--panel); border: 1px solid var(--line2); }
  .dhead { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--line); }
  .dhead .dt { font: 600 14px/1.2 var(--mono); color: var(--hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dhead .grow { flex: 1; }
  .dx { display: inline-grid; place-items: center; width: 30px; height: 30px; background: transparent; border: 0; color: var(--dim); cursor: pointer; }
  .dx:hover { color: var(--hi); }
  .dfacts { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .dfacts .st { display: flex; flex-direction: column; gap: 5px; padding: 12px 16px; border-right: 1px solid var(--line); }
  .dfacts .sk { font: 600 9px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); font-style: normal; }
  .dfacts .sv { font: 600 14px/1 var(--mono); color: var(--hi); font-variant-numeric: tabular-nums; font-style: normal; }
  .dbody { padding: 6px 18px 12px; }
  .drow { display: flex; gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .drow:last-child { border-bottom: 0; }
  .drow.top { align-items: flex-start; }
  .dk { flex: 0 0 96px; font: 600 10px/1.8 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .dv { flex: 1; min-width: 0; font: 12.5px/1.6 var(--mono); color: var(--hi); display: flex; flex-wrap: wrap; align-items: center; word-break: break-all; }
  .dv .dim { color: var(--dim); }
  .ub { display: inline-block; font: 12px/1 var(--mono); color: var(--mid); border: 1px solid var(--line); padding: 5px 8px; margin: 0 6px 6px 0; cursor: pointer; }
  .ub:hover { color: var(--hi); border-color: var(--line2); background: var(--raised); }
  .ub .ubp { color: var(--dim); }
  .dacts { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--ink) 55%, var(--panel)); }
  .dacts .grow { flex: 1; }
  .dnote { font: 11px/1.4 var(--mono); color: var(--warn); }
`;
