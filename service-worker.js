/* Offline-first static GitHub Pages build, scoped to this repository path. */
const VERSION = 'svoyaki-offline-pages-v3';
const ROOT = self.registration.scope;
const SHELL_FILES = [
  './','./index.html','./styles.css','./app.js','./engine.js',
  './ics.js','./storage.js','./sync.js','./manifest.webmanifest',
  './icons/favicon-192.png','./icons/icon-180.png','./icons/icon-512.png',
  './data/kpp.json','./data/seed.json'
];
const absolute = path => new URL(path, ROOT).href;
const indexUrl = absolute('./index.html');
self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(async cache => {
    // Fail install rather than falsely reporting a complete offline package.
    await cache.addAll(SHELL_FILES.map(path => new Request(absolute(path), {cache:'reload'})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('svoyaki-offline-') && key!==VERSION).map(key=>caches.delete(key))
  )).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method!=='GET')return;
  const url = new URL(req.url);
  if(url.origin!==self.location.origin || !url.href.startsWith(ROOT))return;
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(res=>res.ok?res:Promise.reject(new Error('Offline page unavailable')))
      .catch(async ()=>(await caches.match(indexUrl))||Response.error()));
    return;
  }
  event.respondWith(caches.match(req,{ignoreSearch:true}).then(hit=>hit||fetch(req).then(res=>{
    if(res.ok) {const copy=res.clone(); event.waitUntil(caches.open(VERSION).then(c=>c.put(req,copy)));}
    return res;
  })));
});