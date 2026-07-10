// Small shared helpers with no dependencies, extracted from copies scattered
// across pages/components.

// toggleIn returns a new array with `x` removed if present, else appended — the
// immutable "toggle membership" used by every multi-select checklist (redeploy /
// stop / pull / clone pickers, the rail tree selection, dashboard update picks).
export function toggleIn<T>(arr: T[], x: T): T[] {
  return arr.includes(x) ? arr.filter((v) => v !== x) : [...arr, x];
}
