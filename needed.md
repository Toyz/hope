# Hope SDK — needed: per-row conditional row actions

> Status: SHIPPED (Option A). RowAction now has ShowWhenKey / ShowWhenValue /
> DisableInsteadOfHide, evaluated per row against the row's cells (a Badge/Code/Link
> cell compares by its text), applied identically to the inline row button and the
> RowFlyout footer. Handler guard can stay as defense-in-depth. Backward compatible
> (no new fields = unchanged); feature-detect via Caps(ctx).Supports(
> "row-actions-conditional"). See examples/plugins/kitchen-sink "orders". Option B
> (per-row provider RPC) not built — Option A covers the case without the extra RPC.

## Problem

`RowActions(...RowAction)` attaches action buttons to a table, but the set is
**static** — the same buttons render on every row, and the same set is reused as
the flyout (`RowFlyout`) footer. There is no way to show/hide/disable a row
action based on that row's data.

Concrete case (cosmic-glass commanding): a command order can be cancelled **only
while it is still `queued`**. Once it has been uplinked to the spacecraft
(`uplinked`/`tasked`/`executed`/`completed`/`failed`/`cancelled`) it is committed
and cannot be recalled. Today the **Cancel** button still renders on those rows
and in the timeline flyout footer; the handler has to reject the click after the
fact with an error toast. The operator sees an actionable button that isn't
actually actionable.

Workarounds tried and why they fall short:
- **Handler guard** (current): `cancel-order` reads the row `state` and refuses
  anything past `queued`. Correct, but the button is still present and clickable
  — misleading UX, and the rejection only surfaces after the click.
- **Component-level button in the flyout body**: `Comp` nodes (`Box`, `CText`,
  `KeyVal`, `Buttons`…) can't trigger a row/action call with the row context, so
  a conditional Cancel can't be rendered inside the `order-detail` flyout body.
- **Static `RowActions`**: no `When`/predicate/`Disabled` field on `RowAction`,
  so it can't be gated per row.

## Requirement

Let a plugin decide, **per row**, whether a row action is shown, hidden, or
shown-but-disabled — and have the table buttons AND the `RowFlyout` footer honor
that decision consistently.

### Option A (preferred): a visibility predicate on the row data

Add an optional field-driven gate to `RowAction` that hope evaluates against the
row before rendering the button:

```go
type RowAction struct {
    Method string
    Label  string
    Icon   string
    Danger bool
    Fields []Field
    Tip    *Tooltip
    // NEW — conditional visibility, evaluated per row against the row's cells.
    // Show the button ONLY when the row's ShowWhenKey cell equals ShowWhenValue
    // (or, when ShowWhenValue is empty, when that cell is non-empty/truthy).
    // Mirrors Field.DependsOn / DependsValue so it's a familiar shape.
    ShowWhenKey   string `json:"showWhenKey,omitempty"`
    ShowWhenValue string `json:"showWhenValue,omitempty"`
    // Optional: render disabled (greyed, with Tip as the reason) instead of
    // hidden when the predicate fails.
    DisableInsteadOfHide bool `json:"disableInsteadOfHide,omitempty"`
}
```

Usage:

```go
var cancelRowAction = plugin.RowAction{
    Method: "cancel-order", Label: "Cancel", Danger: true,
    ShowWhenKey: "state", ShowWhenValue: "queued",
    Tip: plugin.Tip("Cancel this order (only possible while still queued)"),
}
```

Semantics:
- The predicate reads the row's rendered cells by column key (the same map the
  action handler already receives as `row`). A `Badge`/`Code`/`Link` cell
  compares by its text value.
- When the predicate fails: hide the button (default), or render it disabled
  with the `Tip` shown as the reason when `DisableInsteadOfHide` is set.
- Applies identically to the inline row buttons and the `RowFlyout` footer.

### Option B: a per-row actions provider (more general)

A registered method that returns the action set for a given row, so the plugin
computes visibility/labels in Go:

```go
type RowActionsFunc func(ctx context.Context, row map[string]any) ([]RowAction, error)
func (p *Plugin) RowActionsProvider(method string, fn RowActionsFunc) *Plugin
// referenced from the view:
plugin.RowActionsMethod("order-row-actions")
```

hope calls it per visible row (batchable) and renders exactly what it returns —
so cosmic-glass returns `[cancel]` for `queued` rows and `[]` otherwise. More
flexible (dynamic labels, danger, fields per row) at the cost of an extra RPC.

## Acceptance criteria

- A `queued` order shows **Cancel** in both the table row and the timeline
  flyout footer; a `uplinked`/`tasked`/`executed`/`completed`/… order shows **no
  Cancel** (or a disabled one with an explanatory tooltip).
- No change required to the action handler to achieve the visual gating (the
  handler guard can remain as defense-in-depth).
- Backward compatible: a `RowAction` with none of the new fields behaves exactly
  as today (shown on every row). Older hope ignores the unknown fields.
- Feature-detectable (e.g. a `row-actions-conditional` capability) so a plugin
  can fall back to the always-shown button + handler guard on an older hope.

## Notes / references

- Field already has the analogous `DependsOn`/`DependsValue` gating; Option A
  intentionally reuses that mental model for rows.
- Wire shape today: `ViewDesc.RowActions []RowAction` (`schema.go`), rendered as
  table buttons and as the `RowFlyout` footer.
- Consumer: `plugins/cosmic-glass/main.go` — `cancelRowAction`, `cancelOrder`,
  order state constants in `plugins/cosmic-common/mission.go`
  (`OrderQueued`/`OrderUplinked`/`OrderTasked`/`OrderExecuted`/`OrderCompleted`/
  `OrderFailed`/`OrderCancelled`).
