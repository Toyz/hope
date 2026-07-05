// Inspector — the DI handle + state for the docked container inspector. The URL
// is the source of truth: a container is inspected at /stack/:host/:project/:id,
// so opening one NAVIGATES (select/dismiss) and the stack page's route param then
// drives the panel state (apply). This keeps a single deep-linkable URL for the
// open container and survives an id change on recreate (navigate to the new id).
//
// State lives here (read by the inspector on mount) and every apply() fires
// InspectorTarget on the bus so the shell (and a mounted inspector) react without
// prop-drilling.
import { app, bus } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { InspectorTarget } from "./events";
import { withHost } from "./host-url";

export class Inspector {
  host = "";
  project = "";
  id = "";
  name = "";
  private wantTab = ""; // initial tab for the next open (consumed on emit)

  constructor() {
    // The panel is bound to /stack/:host/:project/:container. Any navigation to a
    // path without that container segment (fleet, another host, another page)
    // closes it — WITHOUT navigating, so leaving the stack doesn't yank you back
    // to it. The stack page drives the open case via its route param.
    bus.on(RouteChanged, (e: RouteChanged) => {
      const p = (e.path || "").split("/");
      const onContainer = p[1] === "stack" && !!p[4];
      if (!onContainer && this.isOpen) this.apply("", "", "", "");
    });
  }

  get isOpen(): boolean {
    return this.id !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  private path(host: string, project: string, id?: string): string {
    const base = `/stack/${encodeURIComponent(project)}`;
    return withHost(host, id ? `${base}/${encodeURIComponent(id)}` : base);
  }

  // INTENT: the operator picked a container (table row, rail node, recreate hop).
  // Navigate to its URL; the stack route param then applies it to the panel. An
  // optional tab (e.g. "logs") opens the panel straight on that view. With no
  // route context (no project) fall back to setting state directly.
  select(host: string, project: string, id: string, name = "", tab = "") {
    this.wantTab = tab;
    // Already docked on this container: the URL won't change (so no route-driven
    // apply). Re-emit directly so a requested tab still switches.
    if (id === this.id && this.isOpen) {
      bus.emit(new InspectorTarget(host, id, name, tab));
      return;
    }
    const r = this.router();
    if (r && project) {
      r.navigate(this.path(host, project, id));
      return;
    }
    this.apply(host, project, id, name);
  }

  // The inspector consumes the requested tab on open (mount or target switch). Held
  // on the service so it survives the open even if the panel wasn't mounted when
  // the event fired (first open of a closed panel).
  takeTab(): string {
    const t = this.wantTab;
    this.wantTab = "";
    return t;
  }

  // INTENT: the operator closed the panel — strip the container from the URL.
  dismiss() {
    const r = this.router();
    if (r && this.project) {
      r.navigate(this.path(this.host, this.project));
      return;
    }
    this.apply("", "", "", "");
  }

  // STATE: reflect the route param (or a direct hostless set). No navigation, so
  // it's safe to call from the route watcher without a redirect loop.
  apply(host: string, project: string, id: string, name: string) {
    this.host = host;
    this.project = project;
    this.id = id;
    this.name = name;
    bus.emit(new InspectorTarget(host, id, name, this.wantTab));
  }

  // The panel's close button routes here.
  close() {
    this.dismiss();
  }
}
