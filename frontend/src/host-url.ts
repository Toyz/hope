// host-url — the URL is the single source of truth for which Docker host the UI
// targets. Every host-scoped page carries the host at path-segment index 2 (the
// first param slot): /stack/:host/:project, /container/:host/:id, /images/:host,
// … and the dashboard at /host/:host. The host token is a real host id (e.g.
// "local", an agent id) or the reserved "all" for the cross-fleet view.
//
// Keeping the host in the URL (not a hidden localStorage value) means the target
// can never silently diverge from what the address bar says — bookmarkable,
// shareable, and impossible to act on one host while a stale ambient value
// points at another.

/** Reserved host token for the all-hosts (fleet) overview. */
export const FLEET = "all";

/** Pages that carry a :host segment. Anything else (agents, api-docs, login) is
 *  host-agnostic and never rewritten. */
export const HOST_PAGES = new Set([
  "stack",
  "container",
  "images",
  "volumes",
  "networks",
  "tunnels",
  "deploy",
]);

// withHost inserts (or replaces) the host in a bare page path, at the first param
// slot. "/stack/foo" + local -> "/stack/local/foo"; "/images" -> "/images/local";
// "/" (dashboard) -> "/host/local".
export function withHost(host: string, barePath: string): string {
  if (barePath === "/" || barePath === "" || barePath.startsWith("/host/")) {
    return `/host/${host}`;
  }
  const segs = barePath.split("/"); // "/stack/foo" -> ["", "stack", "foo"]
  segs.splice(2, 0, host); // -> ["", "stack", "local", "foo"]
  return segs.join("/");
}

// stripHost removes the host segment from a hosted path, yielding the bare page
// path. "/stack/local/foo" -> "/stack/foo"; "/images/local" -> "/images";
// "/host/local" -> "/". The inverse of withHost.
export function stripHost(path: string): string {
  if (path.startsWith("/host/")) return "/";
  const segs = path.split("/"); // ["", "stack", "local", "foo"]
  if (segs.length >= 3) segs.splice(2, 1); // drop the host slot
  return segs.join("/") || "/";
}

// canonicalize maps any host-less (or unknown) path to its canonical hosted form,
// used by the redirect guard so every rendered URL carries a host. A host-scoped
// page gets the host spliced in; the root and anything unrecognized fall back to
// that host's dashboard.
export function canonicalize(path: string, host: string): string {
  if (path === "/" || path === "") return `/host/${host}`;
  const page = path.split("/")[1] ?? "";
  if (HOST_PAGES.has(page)) return withHost(host, path);
  return `/host/${host}`;
}
