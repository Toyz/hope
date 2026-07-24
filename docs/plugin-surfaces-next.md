# Plugin surfaces — next: wizard, card, paged collections

Three additive plugin-surface features, all the same contract: declared in `hope.schema`
(JSON), rendered by hope, data + logic owned by the plugin. No bespoke state.

Build order (dependency): **wizard** (standalone) → **card** (an item template) →
**paged collection** (the general engine; card/table are item templates over it).

---

## 1. Wizard — stepped forms

"`PromptOpts`, but steps." A multi-step dialog that reuses everything the prompt modal
already does (fields, groups, cascading `optionsFetch`, conditional `dependsOn`, resolve
surfaces) and adds a stepper + back/next/finish + values that accumulate across steps.

Where cascading/conditional shine: step 1 picks a DB host → step 2's "database" select
populates from it (`optionsFetch` reads accumulated values via `Params(ctx)`).

- **Schema**: an action/prompt gains `steps: [{ title, hint?, fields: []Field, resolve? }]`.
  A wizard is just an ordered list of the field-sets the modal already renders.
- **Modal**: a stepper header; Back/Next/Finish; per-step validation (can't advance with an
  invalid required field); accumulate values into one map; the final submit hands the merged
  map to the action (same result shape as today).
- **Conditional steps**: a step may declare `dependsOn`/`dependsValue` — skipped when unmet.
- **(Later) async gate on Next**: a step can run an RPC to probe/validate before advancing
  (like `resolve`, but it gates progression). Adds failure states — defer to a follow-up.
- **SDK**: `Step(title, ...Field)` + `Wizard(steps ...Step)` on an action; frontend
  `PromptOpts.steps`.

---

## 2. Card — a mountable item

A component primitive with chrome + a body that can host live/interactive regions — the
thing you render *per item* in a grid, or standalone.

- **Header**: icon + title + subtitle + a tone status stripe + an actions region (buttons
  bound to actions). Optional collapsible.
- **Body**: any component tree (existing primitives), AND — the leap — a **mount by
  reference**: `mount: "<method>"` pulls a whole view/stream inline, hope owning its
  lifecycle (start/stop a stream on visibility). A card can host a live table or stream.
- **SDK**: `Card(...)` builder with `.Header`, `.Mount(method)`, `.Actions(...)`.
- Distinct from the existing data-driven `renderCards` hero cards — this is a *component
  primitive*, composable anywhere (including as a paged item template).

---

## 3. Paged collection — the general engine ("anything pageable")

hope owns paging; the plugin owns the item renderer. Cards/tables are just item templates
over this. It reuses the **server-paging tables already have** (request a page, return items
+ total/cursor), with the row renderer generalized to "any component per item."

### Contract
- **`source` method** (server-paged): request `{ cursor|offset, size, filter?, sort? }` →
  response `{ items: [...], total?, nextCursor? }`. Plugin chooses offset (returns `total`)
  or cursor (returns `nextCursor`).
- **Item resolution (A + B)** — per item `{ type?, data, comp? }`:
  - **A (inline):** `comp` present → render that component tree directly. The escape hatch
    for a one-off/special item.
  - **B (typed template):** else look up the item's `type` in the view's registered
    **item templates** and bind `data` into it. A template is a component tree whose values
    reference item fields (`{title}`, a `cell:{field}`), declared ONCE per type — so a page
    of N items costs zero extra round-trips (bound client-side).
  - **Resolution order:** inline `comp` → `type` template → a default/auto renderer (an
    untyped item still shows).
- **Binding reuses the table cell/column model** — typed cells bound to row fields already
  exist; B is that, generalized from "a row" to "any item layout." Not a new concept.

### Layout + controls (hope-owned)
- **`layout`**: `list` | `grid` | `flow` — how hope arranges the item components.
- **`infinite` vs pager**: cards lean infinite-scroll (load-more on scroll); tables lean a
  pager. Per view.
- **filter/sort** travel with the page request (as server tables already do) — a card grid
  gets search/facets for free.
- **loading/empty/error** states owned by hope.

### The unification
- A **table** = a paged collection whose item template is a **row**.
- A **card grid** = the same collection whose item template is a **card**.
- A **mixed feed** = several templates keyed by `type`, each item dispatched by its type.
- Any item may override with an inline `comp`.

So table/card/feed collapse into: **one paged engine + per-type item templates (B) + an
inline escape hatch (A)**, over the existing server-paging.

### SDK
- `Paged(source, ...opts)` view/component; `ItemTemplate(type, comp)` registrations;
  `Layout("grid")`, `Infinite()`, `Cursor()`; the page method returns
  `Page{ Items []Item, Total int, NextCursor string }` where `Item{ Type, Data, Comp }`.

---

## Phases & todos

### Phase 1 — Wizard
- [ ] SDK: `Step` + `Wizard` (action steps); schema `steps`
- [ ] Frontend: `PromptOpts.steps`; prompt-modal stepper + Back/Next/Finish + per-step
      validation + accumulated values; conditional steps (`dependsOn`)
- [ ] kitchen-sink: a demo wizard exercising cascading across steps

### Phase 2 — Card primitive
- [ ] SDK: `Card` builder (header/tone/actions/body)
- [ ] Frontend: card component in `renderComponent` (chrome + body)
- [ ] Mount-by-reference: `mount: "<method>"` hosts a view/stream inline (lifecycle)
- [ ] kitchen-sink: a card demo

### Phase 3 — Paged collection
- [ ] SDK: `Paged` + `ItemTemplate(type, comp)` + `Page`/`Item` types + layout/infinite/cursor
- [ ] Frontend: paged-collection renderer — server-page fetch (cursor/offset), infinite/pager,
      layout (list/grid/flow), A/B item resolution, template data-binding (reuse cell binding),
      filter/sort passthrough, loading/empty/error
- [ ] Refactor: express the existing server table as a paged collection with a row template
      (or leave tables as-is and add paged alongside — decide during build)
- [ ] kitchen-sink: a paged grid of cards + a mixed-type feed

### Phase 4 — verify
- [ ] Wizard: multi-step, step-2 options depend on step-1, conditional step skipped, one result
- [ ] Card: header/actions/mounted stream live; collapsible
- [ ] Paged: infinite scroll + pager; cursor + offset; 4 mixed types each render by template;
      an inline-`comp` item overrides; filter/sort narrow the page; empty/error states
- [ ] Old-SDK plugins unaffected (all additive; unknown kinds skip)

## Critical files
- SDK: `plugin/component.go` (Card, Paged, Item/Page, ItemTemplate), `plugin/schema.go`
  (steps, paged/card kinds, layout/cursor flags), `plugin/plugin.go` (Wizard/Step builders,
  the source/page method registration), `plugin/cells.go` (binding reuse)
- Frontend: `src/components/prompt-modal-impl.tsx` (wizard steps), `src/prompt.ts`
  (`steps`), `src/components/plugin-surface.tsx` (`renderComponent` card + paged renderer +
  item resolution + template binding), `src/plugin-run.ts` (page fetch wiring)
- `examples/plugins/kitchen-sink` — demos for each
