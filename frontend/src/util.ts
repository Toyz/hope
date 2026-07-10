// Small shared helpers with no dependencies, extracted from copies scattered
// across pages/components.

// toggleIn returns a new array with `x` removed if present, else appended — the
// immutable "toggle membership" used by every multi-select checklist (redeploy /
// stop / pull / clone pickers, the rail tree selection, dashboard update picks).
export function toggleIn<T>(arr: T[], x: T): T[] {
  return arr.includes(x) ? arr.filter((v) => v !== x) : [...arr, x];
}

// patchAt returns a copy of arr with element i shallow-merged with p; removeAt
// returns a copy without element i. The immutable row-edit pair the create/deploy
// forms hand-rolled (deploy's patch, service-form's up/del).
export function patchAt<T>(arr: T[], i: number, p: Partial<T>): T[] {
  const next = arr.slice();
  next[i] = { ...next[i], ...p };
  return next;
}
export function removeAt<T>(arr: T[], i: number): T[] {
  return arr.filter((_, j) => j !== i);
}

// splitHost breaks a hostname into { sub, domain } against a set of known zone
// names — subdomain + the matched zone, or {sub:"", domain:""} for a free-text host
// with no match. The tunnel/stack/service forms all did this loop; callers pass their
// zone names (ZoneView[].name or a plain string[]).
export function splitHost(host: string, zoneNames: string[]): { sub: string; domain: string } {
  for (const name of zoneNames) {
    if (host === name) return { sub: "", domain: name };
    if (host.endsWith("." + name)) return { sub: host.slice(0, -(name.length + 1)), domain: name };
  }
  return { sub: "", domain: "" };
}
