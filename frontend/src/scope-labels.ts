// Canonical UI text for the plugin reverse-capability scopes — the single origin
// for what a scope is called and what it means, so the marketplace disclosure, the
// consent modal, and the inspector toggles can't drift apart (they used to keep
// three hand-maintained copies, and the consent one had already lost spec:label).
// Mirrors the Go scope constants in plugin/schema.go.

// Canonical order so a scope keeps its position across grant/revoke/pending states.
export const SCOPE_ORDER = ["events:subscribe", "events:publish", "storage", "spec:label"];

// Short label — marketplace disclosure + inspector toggles.
const SHORT: Record<string, string> = {
  "events:subscribe": "React to fleet events",
  "events:publish": "Publish events / alerts to hope",
  storage: "Store its config in hope",
  "spec:label": "Add labels to its stack's services",
};

// Full description — the consent modal, where the operator decides.
const LONG: Record<string, string> = {
  "events:subscribe": "React to fleet events — deploys, container and image changes, and other plugins' events.",
  "events:publish": "Publish its own events onto hope (e.g. alerts) that the UI and other plugins can see.",
  storage: "Store its own configuration and state inside hope so it survives restarts.",
  "spec:label": "Add labels to its own stack's services (e.g. Prometheus scrape labels).",
};

// scopeLabel is the short name; scopeDescription is the full sentence. Both fall
// back to the raw scope string for a future/unknown one.
export function scopeLabel(scope: string): string {
  return SHORT[scope] || scope;
}
export function scopeDescription(scope: string): string {
  return LONG[scope] || SHORT[scope] || scope;
}
