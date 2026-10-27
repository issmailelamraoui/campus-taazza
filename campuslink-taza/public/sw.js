const CACHE = 'campuslink-install-v3';
const OFFLINE = '/offline.html';
const PUBLIC_FILES = [OFFLINE, '/index.html', '/favicon.svg', '/icons/app-192.png', '/icons/app-512.png', '/icons/app-maskable-512.png', '/icons/apple-touch-icon.png'];
const ASSET_LIMIT = 80;
const shellAssets = html => [...html.matchAll(/(?:src|href)="(\/assets\/[\w.-]+\.(?:js|mjs|css))"/g)].map(match => match[1]);
async function trimAssets(cache) {
  const shell = await cache.match('/index.html');
  const protectedAssets = new Set(shell ? shellAssets(await shell.text()) : []);
  const keys = (await cache.keys()).filter(key => new URL(key.url).pathname.startsWith('/assets/'));
  let count = keys.length;
  for (const key of keys) {
    if (count <= ASSET_LIMIT) break;
    if (!protectedAssets.has(new URL(key.url).pathname)) { await cache.delete(key); count--; }
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);await cache.addAll(PUBLIC_FILES);
    const shell=await cache.match('/index.html'),html=await shell.text();
    const assets=shellAssets(html);
    await cache.addAll([...new Set(assets)]);await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('campuslink-install-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message',event=>{
  if(event.data?.type!=='CACHE_PUBLIC_ASSETS')return;
  const paths=Array.isArray(event.data.paths)?[...new Set(event.data.paths.filter(path=>typeof path==='string'&&/^\/assets\/[\w.-]+\.(?:js|mjs|css)$/.test(path)))].slice(-ASSET_LIMIT):[];
  event.waitUntil(caches.open(CACHE).then(async cache=>{await cache.addAll(paths);await trimAssets(cache);}).then(()=>event.ports[0]?.postMessage({ok:true})).catch(()=>event.ports[0]?.postMessage({ok:false})));
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
      // Public build assets are identical for every same-origin requester.
      // Development/preview servers may add Vary: Origin while module scripts
      // send an Origin header that the installation fetch did not include.
      const cached=await cache.match(request,{ignoreVary:true});if(cached)return cached;
      const response=await fetch(request);
      if(response.ok){try{await cache.put(request,response.clone());await trimAssets(cache);}catch{}}
      return response;
    }));
  } else if (PUBLIC_FILES.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(request,{ignoreVary:true}).then(cached => cached || fetch(request)));
  }
});

// Push ownership is separate from the public/offline caches. A stale account
// binding cannot show private text after this device is disabled or signed out.
async function activePushBinding() {
  return new Promise(resolve => {
    try {
      const open = indexedDB.open('campuslink-push-device-v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('device');
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const request = db.transaction('device').objectStore('device').get('active');
          request.onsuccess = () => { db.close(); resolve(request.result || null); };
          request.onerror = () => { db.close(); resolve(null); };
        } catch { db.close(); resolve(null); }
      };
    } catch { resolve(null); }
  });
}
function pushNotificationId(value) {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    const notificationId = pushNotificationId(payload?.notificationId);
    if (!notificationId || typeof payload?.bindingId !== 'string') return;
    const active = await activePushBinding();
    if (!active?.userId || !active.bindingId || active.bindingId !== payload.bindingId) return;
    await self.registration.showNotification(typeof payload.title === 'string' ? payload.title.slice(0, 100) : 'CampusLink Taza', {
      body: typeof payload.body === 'string' ? payload.body.slice(0, 240) : '',
      icon: '/icons/app-192.png', badge: '/icons/app-192.png',
      tag: `campuslink-${payload.bindingId}-${notificationId}`,
      data: { notificationId, bindingId: payload.bindingId },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data, notificationId = pushNotificationId(data?.notificationId);
    if (!notificationId || typeof data?.bindingId !== 'string') return;
    const active = await activePushBinding();
    if (!active?.userId || active.bindingId !== data.bindingId) return;
    // The payload cannot select an external URL or bypass the account-aware
    // notification opening flow in the application.
    const href = new URL(`/app/notifications?push=${notificationId}`, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      try {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if (client.url !== href) await client.navigate(href);
        await client.focus(); return;
      } catch { /* A closing window can no longer be focused. */ }
    }
    await self.clients.openWindow(href);
  })());
});
