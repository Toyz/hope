# Hope SDK — additions needed for plugin-level commanding

> Status: SHIPPED. All eight items below are implemented — #2 (dependent fields +
> option refetch) earlier, and #1/#3/#4/#5/#6/#7/#8 in this pass. New SDK surface:
> `Field.FieldsMethod` + `p.Fields`, `Field{Type:"number",Min,Max,Step,Unit}` and
> `Type:"multiselect"`, `Field.RefreshEvery`, `ActionPrefill`, `ActionValidate` +
> `p.Validate`/`FieldError`, `ActionConfirm` + `p.Confirm`/`ConfirmResult`, and the
> rich action result (`navigate` / `flyout` in the result map). All additive; old
> plugins/hope unaffected. See `examples/plugins/kitchen-sink` (`issueCommand`).

Context: building the Cosmic Glass mission-control plugin (issue/track/cancel
commands + taskings) hit hard walls in the plugin API. Today `Field.Value` is a
static default only, there's no way to seed a field from the invoking row/page
context, and `OptionsMethod` is fetched once and never re-runs when a sibling
field changes. So per-command parameter forms, context-prefilled targets, and
cascading selects are all impossible with the current plugin API.

These are the Hope additions (SDK `Field`/action schema + prompt-modal frontend)
that would make plugin commanding genuinely functional, in priority order.

## 1. Dynamic per-selection fields (highest impact)
Command parameters differ per command; today they must be stuffed into a
free-form `kv` box. Let a selection **return a field schema**, not just a preview.
- API: `FieldsMethod string` on `Field` (or `p.Fields("method", fn)` where
  `fn(ctx, values) []Field`). On value change, Hope calls it and renders the
  returned typed fields inline as a sub-form.
- Unlocks: pick `capture-image` -> modal renders `target` (text, required) +
  `mode` (select: pan/multispectral/stereo) as real, validated inputs.

## 2. Dependent fields + option refetch
Expose the `dependsOn` / `optionsFrom` mechanism that already exists in the
prompt modal internally to plugins.
- API: `DependsOn string` on `Field`; re-invoke `OptionsMethod(ctx, values)`
  **with current form values** whenever a dependency changes (reset the child).
- Unlocks: constellation -> satellite -> command cascading where each select only
  shows valid choices (no 1,800-item flat list, no invalid combos).

## 3. Context prefill / dynamic defaults (the "prepopulate" gap)
- API: pass the invoking **row/page param into the action** so fields whose `Key`
  matches get prefilled, or add `DefaultsMethod(ctx) map[string]string`. Also let
  `RowAction` / `Buttons` / `HeaderActions` carry a `Prefill map[string]string`.
- Unlocks: commanding from a satellite's page auto-selects that satellite;
  "re-issue" from an order row prefills target+command+params; enum params
  default to their first option.

## 4. Pre-submit validation + gated submit
Bad input is currently only caught after a failed round-trip.
- API: `ValidateMethod(ctx, values) []FieldError`, called on change; render
  per-field errors inline and **disable Run until valid**.
- Unlocks: "target not in view / command not permitted / required param missing"
  shown live, Run disabled until the order is actually issuable.

## 5. Richer typed fields
- API: `number` field type with `Min/Max/Step/Unit`; make `required` do
  client-side validation; add a `multiselect` type.
- Unlocks: proper numeric params (bandwidth, priority) and **batch commanding**
  (multiselect targets -> task N satellites at once).

## 6. Impact confirmation gate
- API: promote the resolve surface to an optional confirm step -
  `ConfirmMethod` / `Danger` on the action (Hope already audit-logs `Danger` row
  actions; extend that to actions).
- Unlocks: irreversible commands (enter-safe-mode, etc.) get a real go/no-go gate.

## 7. Rich action result (not just a toast)
- API: let an action handler return a **component surface** or a
  `navigate` / `openFlyout` directive.
- Unlocks: after issuing, jump straight to the new order's lifecycle flyout.

## 8. Live option state (optional)
- API: `RefreshEvery` on `OptionsMethod`, or an options stream.
- Unlocks: the target picker's "in contact / queues next pass" label stays live
  while the modal is open.

---

Priority: **#1, #2, and #3** are the ones that turn plugin commanding from
"usable" to "excellent" — dynamic per-command fields, cascading valid options,
and context prefill. Those are the exact walls hit while building this.
