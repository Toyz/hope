# Changelog — hope plugin SDK

The SDK is a nested Go module, tagged `plugin/vX.Y.Z`. It follows the
[stability policy](../docs/plugin-protocol.md#stability-policy): additive changes are
minor bumps and never break existing plugins; `ProtocolVersion` bumps only on a
breaking change to an existing wire shape (still `1`).

## v0.0.6 — unreleased

The "escape hatch" + chattiness + stabilization release. All additive; plugins built
on v0.0.1–v0.0.5 render unchanged.

### Added
- **Component views (the escape hatch).** `ComponentView` returns a `*Comp` — a tree of
  safe primitives (`Box`/`Stack`/`CRow`/`CGrid`/`Heading`/`CText`/`KeyVal`/`CIcon`/
  `Sparkline`/`CCell`/`Divider`/`Spacer`) hope composes into a custom widget the built-in
  view kinds don't cover. No markup/JS — a typed primitive tree, so the browser stays
  safe. See `component.go`.
- **Inline component nodes.** `plugin.Component(comp)` embeds a `Comp` tree directly in a
  layout, rendered with **no** per-view round-trip — ideal for a small static tile.
- **`Static()` view option.** Marks a view's data fixed for the life of the surface; hope
  fetches once and reuses the cache on tab re-entry / re-navigation instead of re-calling
  the plugin — fewer round-trips, less rate-limit pressure. Pair with `Refreshable()` for
  "load once, refresh on demand".
- **Author-controlled empty states.** `EmptyView(title, EmptyIcon/EmptyText/EmptyComp...)`
  customizes the "no data" state (icon + title + text, or a full `Comp`) instead of the
  generic text.
- **Capability negotiation.** hope advertises the view kinds + features it can render via
  `X-Hope-View-Kinds` / `X-Hope-Features` headers; read them with `plugin.Caps(ctx)` and
  `Caps(ctx).Supports("component")` to degrade gracefully across hope versions.
- **`Cell` type.** A named alias for `map[string]any`, documenting where a rich cell is
  expected (`Badge`/`Link`/… now return `Cell`); a plain map still satisfies it.

## v0.0.5

- `TreeData`/`TreeNode` rich collapsible/clickable tree view; typed view-return structs
  (`TableData` etc.) so handlers return data, not bare maps; `TableData.RowMethod`.

## v0.0.4

- Tooltips with author-controlled placement (`Tip`, `TipPos`); `ActionIcon`/`ActionTip`.

## v0.0.3

- `Buttons` node (content-sized action toolbar); action options.

## v0.0.2

- Stack-view widget surface (`StackWidget`); `DynamicPageFunc` live layouts.

## v0.0.1

- Initial SDK: surfaces (container/page/rail/dashboard/command), view kinds
  (kv/table/query/tree/chart/cards/stat/text/search), actions, streams, settings,
  master-detail pages, rich cells.
