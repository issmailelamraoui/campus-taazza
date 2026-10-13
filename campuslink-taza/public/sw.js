const CACHE = 'campuslink-install-v2';
const OFFLINE = '/offline.html';
const PUBLIC_FILES = [OFFLINE, '/index.html', '/favicon.svg', '/icons/app-192.png', '/icons/app-512.png', '/icons/app-maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);await cache.addAll(PUBLIC_FILES);
    const shell=await cache.match('/index.html'),html=await shell.text();
    const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[\w.-]+\.(?:js|mjs|css))"/g)].map(match=>match[1]);
    await cache.addAll([...new Set(assets)]);await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('campuslink-install-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message',event=>{
  if(event.data?.type!=='CACHE_PUBLIC_ASSETS')return;
  const paths=Array.isArray(event.data.paths)?event.data.paths.filter(path=>typeof path==='string'&&/^\/assets\/[\w.-]+\.(?:js|mjs|css)$/.test(path)).slice(0,40):[];
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll([...new Set(paths)])).then(()=>event.ports[0]?.postMessage({ok:true})).catch(()=>event.ports[0]?.postMessage({ok:false})));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Only the public static application shell and versioned build assets enter
  // Cache Storage. Private documents use explicit, account-scoped IndexedDB.
  if(url.pathname.startsWith('/api/'))return;
  if (request.mode === 'navigate' && !url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(async () => await caches.match('/index.html') || await caches.match(OFFLINE)));
  } else if (/^\/assets\/[\w.-]+\.(?:js|mjs|css)$/.test(url.pathname) && !url.search) {
    event.respondWith(caches.open(CACHE).then(async cache=>{
      const cached=await cache.match(request);if(cached)return cached;
      const response=await fetch(request);
      if(response.ok){await cache.put(request,response.clone());const keys=(await cache.keys()).filter(key=>new URL(key.url).pathname.startsWith('/assets/'));if(keys.length>40)await cache.delete(keys[0]);}
      return response;
    }));
  } else if (PUBLIC_FILES.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
