// FavoritesService — the app-wide source of truth for rail quick-jump favorites,
// persisted server-side (the Favorites RPC). Any surface that offers a favorite toggle
// (the rail, the stack page, an inspector) injects this, calls has()/toggle(), and
// re-reads all() on the FavoritesChanged bus event. A favorite is keyed by its STABLE
// identity — host + compose project, and for a container the compose SERVICE (never a
// container id, which churns on redeploy).
import { app, bus } from "@toyz/loom";
import { HopeTransport } from "./transport";
import { FavoritesChanged } from "./events";
import type { Favorite } from "./contracts";

export class FavoritesService {
  private favs: Favorite[] = [];
  private loaded = false;

  private rpc(): HopeTransport { return app.get(HopeTransport); }

  // Load once on first use (idempotent). Surfaces call this on mount.
  async ensure(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.reload();
  }

  async reload(): Promise<void> {
    try { this.favs = (await this.rpc().call<Favorite[]>("Favorites", "list", [])) || []; } catch { /* keep last */ }
    bus.emit(new FavoritesChanged());
  }

  all(): Favorite[] { return this.favs; }

  private key(host: string, project: string, service?: string) { return host + " " + project + " " + (service || ""); }

  has(host: string, project: string, service?: string): boolean {
    const k = this.key(host, project, service);
    return this.favs.some((f) => this.key(f.host, f.project, f.service) === k);
  }

  // Add/remove a favorite, optimistically (the UI reacts immediately) then persist the
  // whole list. FavoritesChanged fires so every surface re-reads.
  async toggle(f: Favorite): Promise<void> {
    const k = this.key(f.host, f.project, f.service);
    const on = this.favs.some((x) => this.key(x.host, x.project, x.service) === k);
    this.favs = on ? this.favs.filter((x) => this.key(x.host, x.project, x.service) !== k) : [...this.favs, f];
    bus.emit(new FavoritesChanged());
    try { await this.rpc().call("Favorites", "set", [{ favorites: this.favs }]); } catch { /* best-effort; a reload resyncs */ }
  }
}
