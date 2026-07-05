// platform — tiny OS check so keyboard hints show the right modifier: ⌘ on macOS,
// Ctrl everywhere else. (loom's @hotkey "mod" already maps to the right physical
// key; this is only for what we DISPLAY.)
const plat =
  typeof navigator !== "undefined"
    ? (navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent || ""
    : "";

export const IS_MAC = /mac/i.test(plat);

/** The modifier label to show in a shortcut hint: "⌘" on Mac, "Ctrl" elsewhere. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** A full shortcut label, e.g. modLabel("K") -> "⌘K" or "Ctrl K". */
export function modLabel(key: string): string {
  return IS_MAC ? `${MOD_KEY}${key}` : `${MOD_KEY} ${key}`;
}
