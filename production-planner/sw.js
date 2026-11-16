const CACHE = "planer-svoyaki-legacy-v1";
const FILES = ["./", "./index.html", "./cloud.js", "./cloud.css", "./manifest.webmanifest", "./icon.svg"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((x) => /^(planer-cloud-|planer-mvp-|planer-svoyaki-legacy-)/.test(x) && x !== CACHE).map((x) => caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(e.request, copy));
    }
    return response;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))));
});