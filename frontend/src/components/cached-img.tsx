// <hope-cached-img> — a thin <img> wrapper for ImgCache()-flagged images.
//
// Byte caching is handled transparently by the image-cache SERVICE WORKER (public/sw.js),
// which caches the image's OWN request/response CORS-free (opaque cross-origin responses
// included). This element therefore does NOT fetch() the bytes itself — a page fetch() of a
// cross-origin image is CORS-blocked and would just spam the console and fall back to the
// network anyway. Kept as a component so ImgCache() has a stable render path (and a future
// per-image hook), and so the image cell can keep its class/style/lightbox/fallback wiring.
import { LoomElement, component, prop, mount, watch } from "@toyz/loom";

@component("hope-cached-img")
export class HopeCachedImg extends LoomElement {
  @prop accessor src = "";
  @prop accessor alt = "";
  @prop accessor imgClass = "";
  @prop accessor imgStyle = "";
  @prop accessor fb = ""; // fallback URL on load error

  // Caching is OPT-IN PER IMAGE: an image only reaches this element when the plugin flagged it
  // with ImgCache(), so register THIS exact URL with the image-cache service worker — that's how
  // the SW knows which specific images to cache. Non-flagged images render as a plain <img>,
  // are never registered, and are never cached.
  @mount private onM() { this.allow(); }
  @watch("src") private onSrc() { this.allow(); }
  private allow() {
    if (!/^https?:\/\//i.test(this.src) || !("serviceWorker" in navigator)) return;
    const url = this.src;
    // reg.active is the SW even before it controls this page, so the URL is persisted for the
    // next load even if this one isn't intercepted yet.
    navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "hope-img-cache", url })).catch(() => {});
  }

  private onErr = (e: any) => {
    const img = e.target as HTMLImageElement;
    if (this.fb && img.src !== this.fb) img.src = this.fb; // swap to the fallback once
    else img.style.visibility = "hidden";                  // no/failed fallback -> hide the broken icon
  };

  update() {
    return <img class={this.imgClass} src={this.src || undefined} alt={this.alt} title={this.alt}
      loading="lazy" {...({ decoding: "async" } as any)} style={this.imgStyle} onError={this.onErr} />;
  }
}
