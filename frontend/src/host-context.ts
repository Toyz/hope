// HostContext — the store for which Docker host the UI targets.
//
// Two pieces of client state, persisted (survive reload) and reactive (reading
// them in a component's update() tracks the value, so it re-renders on change):
//   - fleet: the "all hosts" cross-fleet view flag.
//   - activeHost: the host id RPC targets ("" = server default / local). The
//     transport reads it and sets X-Hope-Host, so the target is ambient.
//
// The public setters emit HostChanged on the bus — that's the cross-component
// signal pages listen for (@on(HostChanged)) to refetch (@watch on a plain class
// isn't reliable in loom, so the store emits explicitly).
import { persist, bus } from "@toyz/loom";
import { HostChanged } from "./events";

export class HostContext {
  @persist("hope.fleet") private accessor _fleet = false;
  @persist("hope.host") private accessor _activeHost = "";

  get fleet(): boolean {
    return this._fleet;
  }
  set fleet(v: boolean) {
    if (this._fleet === v) return;
    this._fleet = v;
    this.changed();
  }

  get activeHost(): string {
    return this._activeHost;
  }
  set activeHost(v: string) {
    if (this._activeHost === v) return;
    this._activeHost = v;
    this.changed();
  }

  private changed() {
    bus.emit(new HostChanged(this._activeHost, this._fleet));
  }
}
