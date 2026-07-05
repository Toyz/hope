// ImageInspector — the DI handle + state for the docked image inspector. Like the
// container inspector, the URL is the source of truth: an image is inspected at
// /images/:host/:id, so opening one NAVIGATES (select/dismiss) and the images
// page's route param drives the panel (apply). This makes it deep-linkable and
// lets "inspect the image" work from anywhere (a container's image field) by
// routing to the images page. onChange lets the page refetch after a mutation.
import { app, bus } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { ImageInspectorTarget } from "./events";
import { withHost } from "./host-url";

export class ImageInspector {
  host = "";
  ref = "";
  onChange: (() => void) | null = null;

  constructor() {
    // The panel is bound to /images/:host/:id. Any navigation without that id
    // segment (the images list, another page) closes it — without navigating.
    bus.on(RouteChanged, (e: RouteChanged) => {
      const p = (e.path || "").split("/");
      const onImage = p[1] === "images" && !!p[3];
      if (!onImage && this.isOpen) this.apply("", "");
    });
  }

  get isOpen(): boolean {
    return this.ref !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  // INTENT: the operator picked an image (a row, or a container's image field).
  // Navigate to /images/:host/:id; the images-page route param then applies it.
  select(host: string, ref: string, onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    const r = this.router();
    if (r) {
      r.navigate(withHost(host, `/images/${encodeURIComponent(ref)}`));
      return;
    }
    this.apply(host, ref);
  }

  // INTENT: the operator closed the panel — strip the id from the URL.
  dismiss() {
    const r = this.router();
    if (r) {
      r.navigate(withHost(this.host || "local", "/images"));
      return;
    }
    this.apply("", "");
  }

  // STATE: reflect the route param. No navigation (safe from the route watcher).
  apply(host: string, ref: string) {
    this.host = host;
    this.ref = ref;
    bus.emit(new ImageInspectorTarget(host, ref));
  }

  close() {
    this.dismiss();
  }
}
