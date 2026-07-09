// hope image cache — a minimal service worker that makes images load from a durable local
// cache after the first view, WITHOUT fetch()/CORS. A page fetch() of a cross-origin image
// is CORS-blocked (no Access-Control-Allow-Origin -> throws), but a service worker caches the
// image's OWN request/response — including OPAQUE cross-origin responses, which an <img> renders
// fine. So an <img src="https://some-host/x.png"> is cached here with no cooperation from that
// host.
//
// Scoped tightly to IMAGE GET requests; every other request passes straight through (no
// respondWith), so this SW can NEVER serve a stale app shell or break a deploy — it only ever
// touches images.
const CACHE = "hope-img-v1";
const MAX = 400; // rough cap by entry count; oldest evicted first

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only images, only GET. Everything else is untouched (falls through to the network).
  if (req.method !== "GET" || req.destination !== "image") return;
  event.respondWith(serve(req));
});

async function serve(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit; // cached bytes — zero network

  try {
    const res = await fetch(req); // opaque for a cross-origin no-cors image — still cacheable
    if (res && (res.ok || res.type === "opaque")) {
      // Cache in the background; don't block the response on the write or the trim.
      cache.put(req, res.clone()).then(() => trim(cache)).catch(() => {});
    }
    return res;
  } catch {
    return hit || Response.error();
  }
}

// Cheap FIFO-ish cap: Cache Storage keeps insertion order, so deleting the first N keys drops
// the oldest entries. Keeps opaque-image storage (which is padded/heavy) bounded.
async function trim(cache) {
  const keys = await cache.keys();
  const over = keys.length - MAX;
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}
