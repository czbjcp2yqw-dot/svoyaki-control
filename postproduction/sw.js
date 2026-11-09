const VERSION = 'svoyaki-shell-v14';
const FILES = ['./','./styles.css?v=14','./app.mjs?v=14','./schedule.mjs?v=13','./calendar-pdf.mjs?v=14','./calendar-font.mjs','./manifest.webmanifest','./icon.png','./icon-512.png']
  .map(path=>new URL(path,self.registration.scope).href);
self.addEventListener('install', event => event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('svoyaki-shell-')&&key!==VERSION).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method!=='GET' || url.origin!==location.origin || !FILES.includes(url.href)) return;
  event.respondWith(fetch(event.request).catch(()=>caches.match(url.href)));
});
