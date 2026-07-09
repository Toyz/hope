// <hope-cached-img> — an <img> whose bytes are persisted in the Cache Storage API, so a
// plugin can opt SPECIFIC images (plugin.ImgCache()) into a durable local cache that
// survives reloads and sessions, independent of the image host's HTTP cache headers. Good
// for immutable, content-addressed art (a badge/canvas keyed by hash) served from a remote
// host you don't control.
//
// Behaviour:
//   - cache HIT  -> serve the stored blob, ZERO network.
//   - cache MISS -> fetch once, store, serve the blob (single load).
//   - fetch blocked (no CORS on the host) / no Cache Storage (insecure context) -> fall back
//     to a normal network <img>. Never worse than an uncached image.
//
// The plugin-surface image cell renders this instead of a plain <img> when the cell is
// ImgCache()-flagged; it keeps the same class/style/lightbox/fallback behaviour, so the
// click + sizing are handled by the host element in plugin-surface.
import { LoomElement, component, prop, reactive, watch, mount, unmount } from "@toyz/loom";

const CACHE = "hope-plugin-images";

@component("hope-cached-img")
export class HopeCachedImg extends LoomElement {
  @prop accessor src = "";
  @prop accessor alt = "";
  @prop accessor imgClass = "";
  @prop accessor imgStyle = "";
  @prop accessor fb = ""; // fallback URL on load error

  @reactive accessor url = ""; // resolved src: a blob: URL (cached) or the direct network URL
  private obj = ""; // the object URL to revoke

  @mount private onM() { void this.resolve(); }
  @watch("src") private onSrc() { void this.resolve(); }
  @unmount private onU() { this.revoke(); }

  private revoke() {
    if (this.obj) { URL.revokeObjectURL(this.obj); this.obj = ""; }
  }

  private resolve = async () => {
    this.revoke();
    const src = this.src;
    if (!src || !/^https?:\/\//i.test(src)) { this.url = src; return; }
    // Cache Storage is unavailable in insecure contexts / very old browsers.
    if (typeof caches === "undefined") { this.url = src; return; }

    let cache: Cache;
    try { cache = await caches.open(CACHE); } catch { this.url = src; return; }
    if (this.src !== src) return; // a newer src superseded this resolve

    // HIT: serve the stored bytes, no network.
    try {
      const hit = await cache.match(src);
      if (hit && hit.ok) {
        const blob = await hit.blob();
        if (this.src !== src) return;
        if (blob.size) { this.obj = URL.createObjectURL(blob); this.url = this.obj; return; }
      }
    } catch { /* fall through to fetch */ }

    // MISS: fetch once, store, serve the blob (single load). Requires CORS on the host.
    try {
      const net = await fetch(src, { mode: "cors", credentials: "omit" });
      if (net.ok) {
        await cache.put(src, net.clone());
        const blob = await net.blob();
        if (this.src !== src) return;
        if (blob.size) { this.obj = URL.createObjectURL(blob); this.url = this.obj; return; }
      }
    } catch { /* blocked (no CORS) / quota — fall back to a direct network load below */ }
    if (this.src === src) this.url = src;
  };

  private onErr = (e: any) => {
    const img = e.target as HTMLImageElement;
    if (this.fb && img.src !== this.fb) img.src = this.fb;
    else img.style.visibility = "hidden";
  };

  update() {
    // No src until resolved, so a broken-image icon never flashes; a HIT resolves in ~ms.
    return <img class={this.imgClass} src={this.url || undefined} alt={this.alt} title={this.alt}
      loading="lazy" {...({ decoding: "async" } as any)} style={this.imgStyle} onError={this.onErr} />;
  }
}
