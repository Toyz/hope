// The host-redirect catch-all. Every host-scoped page carries its host in the URL
// (see host-url.ts). A host-less or unknown path — a bare /stack/foo, /images, /,
// a shared old bookmark — matches no specific route and falls through to this
// wildcard, whose guard rewrites it to the canonical hosted form BEFORE render.
// So every URL the app actually shows carries a host; the ambient target can
// never disagree with the address bar.
import { LoomElement, component, app } from "@toyz/loom";
import { guard, route, type RouteInfo } from "@toyz/loom/router";
import { HostContext } from "./host-context";
import { canonicalize } from "./host-url";

@route("*", { guards: ["hostpin"] })
@component("page-redirect")
export class PageRedirect extends LoomElement {
  // Named guard on the catch-all. Runs pre-render; returning a string redirects.
  // Reads the default host via the container (not `this`), so it works whether or
  // not this component is ever instantiated.
  @guard("hostpin")
  hostpin(routeInfo: RouteInfo): true | string {
    if (routeInfo.params.host) return true; // already hosted
    const host = app.has(HostContext) ? app.get(HostContext).defaultHost() : "local";
    return canonicalize(routeInfo.path, host);
  }

  update() {
    // never shown — the guard always redirects before this renders
  }
}
