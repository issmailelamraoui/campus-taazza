const CACHE_PREFIX = 'campuslink-public-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const STATIC_FILES = [
  '/offline.html', '/favicon.svg', '/manifest.webmanifest',
  '/icons/app-192.png', '/icons/app-512.png',
  '/icons/app-maskable-512.png', '/icons/apple-touch-icon.png'
];

function cacheablePath(pathname) {
  return STATIC_FILES.includes(pathname)
    || /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|ttf|png|svg)$/.test(pathname)
    || /^\/fonts\/(?:dm-sans|noto-sans-arabic|cormorant-garamond)-(?:400|600)\.ttf$/.test(pathname);
}

function cacheableResponse(response, pathname) {
  if (!response.ok || response.type !== 'basic') return false;
  const type = response.headers.get('Content-Type') || '';
  // A static file may fall through to the SPA HTML when missing. Never store
  // that response or any application HTML, API, avatar or academic document.
  return pathname === '/offline.html'
    ? type.startsWith('text/html')
    : !type.startsWith('text/html') && !type.includes('application/json');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(STATIC_FILES.map(async (pathname) => {
      const response = await fetch(pathname, { credentials: 'omit', cache: 'reload' });
      if (!cacheableResponse(response, pathname)) throw new Error('Public offline asset unavailable.');
      await cache.put(pathname, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin
    || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // Pages always come from the network. Only a generic public page is served
    // when offline; private messages and resources never enter Cache Storage.
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match('/offline.html')) || Response.error();
    }));
    return;
  }
  if (url.search || !cacheablePath(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request, { credentials: 'omit' });
    if (cacheableResponse(response, url.pathname)) await cache.put(request, response.clone());
    return response;
  })());
});
