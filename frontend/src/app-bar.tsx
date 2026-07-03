// appBar — the shared top status-bar shell for the system pages (back crumb +
// host switch + nav + exit). It was copy-pasted across ~7 pages; only the nav's
// active key and the middle action buttons differ, so those are the parameters.
//
// It's a JSX builder (not a shadow component) so it renders inside the calling
// page's shadow root and picks up that page's .bar CSS unchanged. Router / auth /
// host state come straight from DI, so callers pass no wiring.
import { app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "./auth-store";
import { HostContext } from "./host-context";

// active: the <hope-nav> active key. actions: page-specific action cells (each a
// `<div class="s act">…</div>`, nulls allowed) placed before Exit. hostSwitch:
// include the host picker (false for pages with no host context, e.g. API docs).
// onRefresh: when set, render the standard refresh control (spins while busy) so
// every page's refresh looks + behaves the same instead of each rolling its own.
export function appBar(
  active: string,
  actions: unknown[] = [],
  opts: { hostSwitch?: boolean; onRefresh?: () => void; refreshing?: boolean } = {},
) {
  const router = app.get(LoomRouter);
  const auth = app.get(AuthStore);
  const hostCtx = app.get(HostContext);
  const hostSwitch = opts.hostSwitch !== false;
  return (
    <div class="bar">
      <div class="s">
        <span class="back" onClick={() => router.navigate("/")}>
          <loom-icon name="chevron-left" size={13}></loom-icon> {hostCtx.fleet ? "all hosts" : "fleet"}
        </span>
      </div>
      {hostSwitch ? <div class="s act"><hope-host-switch></hope-host-switch></div> : null}
      <hope-nav active={active}></hope-nav>
      <div class="grow"></div>
      {actions}
      {opts.onRefresh ? (
        <div class="s act">
          <button style="display:inline-flex;align-items:center;gap:6px" disabled={!!opts.refreshing} onClick={() => opts.onRefresh!()}>
            <loom-icon class={opts.refreshing ? "spin" : ""} name="rotate" size={13} color="var(--upd)"></loom-icon>refresh
          </button>
        </div>
      ) : null}
      <div class="s act"><button style="display:inline-flex;align-items:center;gap:6px" onClick={() => auth.logout()}><loom-icon name="logout" size={12}></loom-icon>exit</button></div>
    </div>
  );
}
