// VolumeInspector — DI handle + state for the docked volume inspector. URL-driven
// like the container/image inspectors: a volume is inspected at /volumes/:host/:name,
// so opening one NAVIGATES (select/dismiss) and the volumes page's route param
// drives the panel (apply). Anonymous volumes have a hash name; that's still a
// unique key, so they deep-link too (just less pretty).
import { app, bus } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { VolumeInspectorTarget } from "./events";
import { withHost } from "./host-url";

export class VolumeInspector {
  host = "";
  name = "";
  onChange: (() => void) | null = null;

  constructor() {
    bus.on(RouteChanged, (e: RouteChanged) => {
      const p = (e.path || "").split("/");
      const onVol = p[1] === "volumes" && !!p[3];
      if (!onVol && this.isOpen) this.apply("", "");
    });
  }

  get isOpen(): boolean {
    return this.name !== "";
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  select(host: string, name: string, onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    const r = this.router();
    if (r) {
      r.navigate(withHost(host, `/volumes/${encodeURIComponent(name)}`));
      return;
    }
    this.apply(host, name);
  }

  dismiss() {
    const r = this.router();
    if (r) {
      r.navigate(withHost(this.host || "local", "/volumes"));
      return;
    }
    this.apply("", "");
  }

  apply(host: string, name: string) {
    this.host = host;
    this.name = name;
    bus.emit(new VolumeInspectorTarget(host, name));
  }

  close() {
    this.dismiss();
  }
}
