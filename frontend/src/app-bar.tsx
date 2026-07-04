// appBar — the per-page action strip inside the explorer shell's main zone.
//
// Navigation, the host scope, breadcrumb, refresh and exit now live in the shell
// (hope-topbar + hope-rail), so this no longer carries them. It renders only the
// page-specific action buttons (and an optional page refresh), right-aligned at
// the top of the page. Kept as a helper with the same signature so pages don't
// each change; `active`/`hostSwitch` are ignored now that the rail owns nav.
export function appBar(
  _active: string,
  actions: unknown[] = [],
  opts: { hostSwitch?: boolean; onRefresh?: () => void; refreshing?: boolean } = {},
) {
  return (
    <div class="bar pbar">
      <div class="grow"></div>
      {actions}
      {opts.onRefresh ? (
        <div class="s act"><hope-refresh run={() => opts.onRefresh!()}></hope-refresh></div>
      ) : null}
    </div>
  );
}
