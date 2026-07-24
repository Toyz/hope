// Canonical UI text for the plugin reverse-capability scopes — the single origin
// for what a scope is called and what it means, so the marketplace disclosure, the
// consent modal, and the inspector toggles can't drift apart (they used to keep
// three hand-maintained copies, and the consent one had already lost spec:label).
// Mirrors the Go scope constants in plugin/schema.go.

// Canonical order so a scope keeps its position across grant/revoke/pending states.
export const SCOPE_ORDER = ["events:subscribe", "events:subscribe:plugins", "events:publish", "storage", "spec:label"];

const PLUGIN_SUB_PREFIX = "events:subscribe:plugin:"; // + <name>: events from plugins named <name>

// Short label — marketplace disclosure + inspector toggles.
const SHORT: Record<string, string> = {
  "events:subscribe": "React to fleet events",
  "events:subscribe:plugins": "Receive OTHER plugins' events",
  "events:publish": "Publish events / alerts to hope",
  storage: "Store its config in hope",
  "spec:label": "Add labels to its stack's services",
};

// Full description — the consent modal, where the operator decides.
const LONG: Record<string, string> = {
  "events:subscribe": "React to hope's fleet events — deploys, container state, image updates, agents, tunnels.",
  "events:subscribe:plugins": "Receive events published by ANY other plugin on this hope (their alerts and data). Grant only if this plugin should observe others.",
  "events:publish": "Publish its own events onto hope (e.g. alerts) that the UI and other plugins can see.",
  storage: "Store its own configuration and state inside hope so it survives restarts.",
  "spec:label": "Add labels to its own stack's services (e.g. Prometheus scrape labels).",
};

// scopeLabel is the short name; scopeDescription is the full sentence. Both fall
// back to the raw scope string for a future/unknown one, and format the dynamic
// per-publisher subscribe scope (events:subscribe:plugin:<name>).
export function scopeLabel(scope: string): string {
  if (scope.startsWith(PLUGIN_SUB_PREFIX)) return `React to ${scope.slice(PLUGIN_SUB_PREFIX.length)}'s events`;
  return SHORT[scope] || scope;
}
export function scopeDescription(scope: string): string {
  if (scope.startsWith(PLUGIN_SUB_PREFIX)) return `Receive events published by plugins named "${scope.slice(PLUGIN_SUB_PREFIX.length)}".`;
  return LONG[scope] || SHORT[scope] || scope;
}
