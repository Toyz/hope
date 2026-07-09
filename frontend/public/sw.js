// hope image cache — a minimal service worker that byte-caches images locally WITHOUT
// fetch()/CORS. A page fetch() of a cross-origin image is CORS-blocked, but a service worker
// caches the image's OWN request/response (opaque cross-origin included, which an <img> renders
// fine), so no cooperation from the image host is needed.
//
// OPT-IN PER IMAGE: caching is a plugin choice (plugin.ImgCache()) on a specific image, NOT
// global and NOT per-host. The page registers each flagged image URL (postMessage below); the
// SW caches only those exact URLs and passes every other request straight through. So an image
// the plugin didn't flag is never cached, and non-image requests are never touched — this SW
// can't serve a stale app shell or affect a deploy.
const CACHE = "hope-img-v1";
const ALLOW = "hope-img-allow"; // used as a SET of opted-in URLs (key = url, value = empty)
const MAX = 400; // cap cached image bytes; oldest evicted first
const ALLOW_MAX = 2000; // cap opted-in URLs; oldest evicted first

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The page registers each ImgCache-flagged image URL. The allow-cache IS the set: a URL is
// opted in iff it has an entry.
self.addEventListener("message", (event) => {
  const d = event.data;
  if (d && d.type === "hope-img-cache" && typeof d.url === "string") event.waitUntil(allow(d.url));
});

async function allow(url) {
  try {
    const cache = await caches.open(ALLOW);
    if (await cache.match(url)) return;
    await cache.put(url, new Response(""));
    trim(cache, ALLOW_MAX);
  } catch { /* quota */ }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.destination !== "image") return; // only images
  event.respondWith(handle(req));
});

async function handle(req) {
  const allow = await caches.open(ALLOW);
  if (!(await allow.match(req.url))) return fetch(req); // this exact URL wasn't opted in

  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit; // cached bytes — zero network

  try {
    const res = await fetch(req); // opaque for a cross-origin no-cors image — still cacheable
    if (res && (res.ok || res.type === "opaque")) {
      cache.put(req, res.clone()).then(() => trim(cache, MAX)).catch(() => {});
    }
    return res;
  } catch {
    return hit || Response.error();
  }
}

async function trim(cache, max) {
  const keys = await cache.keys(); // insertion order -> deleting the first N drops the oldest
  const over = keys.length - max;
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}
