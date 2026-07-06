// ResourceInspector — the shared DI handle + state behind the three docked
// resource inspectors (image / network / volume); they were byte-for-byte the
// same but for a route segment and a bus event, so that lives here once.
//
// The URL is the source of truth: a resource is inspected at /<seg>/:host/:ref,
// so opening one NAVIGATES (select/dismiss) and the page's route param drives the
// panel (apply). The fleet ("all hosts") view is the exception — it has no
// single-host URL to own the panel, and a ref can exist on several hosts, so a
// per-host deep-link would be both wrong (drops you out of fleet) and ambiguous.
// There we open/close IN PLACE, carrying the row's real host, which the panel
// RPCs against (callOn(host)).
//
// A subclass only picks its route segment + the target event to emit. State is
// read by the panel on mount, and apply() fires the event so the shell (and a
// mounted panel) react without prop-drilling.
import { app, bus, LoomEvent } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { withHost } from "./host-url";
import { HostContext } from "./host-context";

export abstract class ResourceInspector {
  host = "";
  ref = "";
  onChange: (() => void) | null = null;

  // The URL path segment ("images" | "networks" | "volumes")…
  protected abstract readonly seg: string;
  // …and the bus event that opens/closes the matching docked panel.
  protected abstract event(host: string, ref: string): LoomEvent;

  constructor() {
    // Bound to /<seg>/:host/:ref. Any navigation without that ref segment (the
    // list, another host, another page) closes the panel — WITHOUT navigating,
    // so leaving the page doesn't yank you back. The page drives the open case
    // via its route param.
    bus.on(RouteChanged, (e: RouteChanged) => {
      const p = (e.path || "").split("/");
      const onPage = p[1] === this.seg && !!p[3];
      if (!onPage && this.isOpen) this.apply("", "");
    });
  }

  get isOpen(): boolean {
    return this.ref !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  private fleet(): boolean {
    return app.has(HostContext) && app.get(HostContext).fleet;
  }

  // INTENT: the operator picked a row (or a cross-link, e.g. a container's image
  // field). Navigate to /<seg>/:host/:ref; the page's route param then applies
  // it. In fleet mode, open in place instead (see the file header).
  select(host: string, ref: string, onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    const r = this.router();
    if (r && !this.fleet()) {
      r.navigate(withHost(host, `/${this.seg}/${encodeURIComponent(ref)}`));
      return;
    }
    this.apply(host, ref);
  }

  // INTENT: the operator closed the panel — strip the ref from the URL (in fleet
  // there's no ref in the URL, so just clear the in-place state).
  dismiss() {
    const r = this.router();
    if (r && !this.fleet()) {
      r.navigate(withHost(this.host || "local", `/${this.seg}`));
      return;
    }
    this.apply("", "");
  }

  // STATE: reflect the route param (or a direct in-place set). No navigation, so
  // it's safe to call from the route watcher without a redirect loop.
  apply(host: string, ref: string) {
    this.host = host;
    this.ref = ref;
    bus.emit(this.event(host, ref));
  }

  close() {
    this.dismiss();
  }
}
