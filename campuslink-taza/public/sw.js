const CACHE = 'campuslink-install-v1';
const OFFLINE = '/offline.html';
const PUBLIC_FILES = [OFFLINE, '/favicon.svg', '/icons/app-192.png', '/icons/app-512.png', '/icons/app-maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('campuslink-install-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // API responses, private files, and authenticated pages always use the network.
  if (request.mode === 'navigate' && !url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
  } else if (PUBLIC_FILES.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
