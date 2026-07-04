// HostContext — the store for which Docker host the UI targets. The URL is the
// source of truth: every host-scoped page carries the host token in its path
// (see host-url.ts), and this store mirrors that token so the transport and the
// pages read one value that can never diverge from the address bar.
//
//   - activeHost: the host id RPC targets ("" = default/active host or fleet).
//     The transport reads it and sets X-Hope-Host, so the target is ambient.
//   - fleet: the "all hosts" cross-fleet view (URL host token === "all").
//
// The setters NAVIGATE (rewrite the URL's host segment) rather than write hidden
// state; a RouteChanged then syncs the mirror and emits HostChanged — the
// cross-component signal pages listen for (@on(HostChanged)) to refetch in place.
import { app, bus, reactive, persist } from "@toyz/loom";
import { LoomRouter, RouteChanged } from "@toyz/loom/router";
import { HostChanged } from "./events";
import { FLEET, canonicalize, stripHost } from "./host-url";

export class HostContext {
  // The host token from the URL (a real id, "all", or "" before the first route).
  // Reactive so a component reading activeHost/fleet in update() re-renders when
  // the host changes.
  @reactive private accessor _host = "";
  // The last real host seen — the default a host-less URL redirects to. Persisted
  // so a fresh tab lands on the host you last used rather than always local.
  @persist("hope.host") private accessor _lastHost = "";

  constructor() {
    bus.on(RouteChanged, (e: RouteChanged) => this.sync(e.params.host ?? ""));
    this.sync(this.router()?.current.params.host ?? "");
  }

  private router(): LoomRouter | null {
    return app.has(LoomRouter) ? app.get(LoomRouter) : null;
  }

  private sync(host: string) {
    if (host && host !== FLEET) this._lastHost = host;
    if (host === this._host) return;
    this._host = host;
    bus.emit(new HostChanged(this.activeHost, this.fleet));
  }

  /** Raw URL host token: a real id, "all", or "". */
  get token(): string {
    return this._host;
  }

  /** The host RPC targets: "" for the default/active host or the fleet view. */
  get activeHost(): string {
    return this._host === FLEET ? "" : this._host;
  }
  set activeHost(v: string) {
    this.go(v || this.defaultHost());
  }

  /** The all-hosts cross-fleet overview (URL host token === "all"). */
  get fleet(): boolean {
    return this._host === FLEET;
  }
  set fleet(v: boolean) {
    if (v) this.go(FLEET);
    else if (this._host === FLEET) this.go(this.defaultHost());
  }

  /** The host a host-less URL should resolve to (last used, else local). */
  defaultHost(): string {
    return this._lastHost || "local";
  }

  // Navigate the current page to a different host, keeping the page + its params.
  private go(host: string) {
    if (host === this._host) return;
    const r = this.router();
    if (!r) return;
    r.navigate(canonicalize(stripHost(location.pathname), host));
  }
}
