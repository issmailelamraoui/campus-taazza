import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const origin = 'https://campus.example';
const workerSource = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const installSource = await readFile(new URL('../src/pwa.js', import.meta.url), 'utf8');

function publicResponse(body = 'static', type = 'text/plain', status = 200) {
  const response = new Response(body, { status, headers: { 'Content-Type': type } });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

function workerHarness() {
  const handlers = new Map();
  const stores = new Map();
  const fetches = [];
  let network = async (request) => publicResponse('static', String(request.url || request).endsWith('.html') ? 'text/html' : 'image/png');
  const key = (request) => new URL(request.url || request, origin).href;
  const caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return { put: async (request, response) => entries.set(key(request), response), match: async (request) => entries.get(key(request)) };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name)
  };
  const self = { location: { origin }, addEventListener: (event, handler) => handlers.set(event, handler), skipWaiting: async () => {}, clients: { claim: async () => {} } };
  runInNewContext(workerSource, { self, caches, URL, Response, fetch: (request, options) => { fetches.push({ request, options }); return network(request, options); } });
  return {
    stores, fetches, setNetwork: (handler) => { network = handler; },
    lifecycle: async (type) => { let wait; handlers.get(type)({ waitUntil: (result) => { wait = result; } }); await wait; },
    request: (path, { method = 'GET', mode = 'cors' } = {}) => {
      let response;
      handlers.get('fetch')({ request: { url: new URL(path, origin).href, method, mode }, respondWith: result => { response = result; } });
      return response;
    }
  };
}

test('manifest provides standalone launch and real PNG icons, including a separate maskable icon', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/app');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.prefer_related_applications, false);
  for (const icon of manifest.icons) {
    const png = await readFile(new URL('../public' + icon.src, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
  }
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
});

test('worker precaches only public offline assets without account cookies', async () => {
  const worker = workerHarness();
  await worker.lifecycle('install');
  assert.equal(worker.fetches.length, 7);
  assert.ok(worker.fetches.every(({ options }) => options.credentials === 'omit'));
  const paths = [...worker.stores.values()][0].keys();
  assert.ok([...paths].every(url => !url.includes('/api/') && !url.includes('/app/')));
});

test('worker never intercepts private APIs, files, avatars, cross-origin, queries or mutations', async () => {
  const worker = workerHarness();
  for (const path of ['/api', '/api/session', '/api/bootstrap', '/api/messages', '/api/events', '/api/files/course.pdf', '/api/avatars/1', '/uploads/course.pdf', '/avatars/1.png', '/assets/index-ABCD1234.js?account=1', 'https://other.example/assets/index-ABCD1234.js']) {
    assert.equal(worker.request(path), undefined, path);
  }
  assert.equal(worker.request('/assets/index-ABCD1234.js', { method: 'POST' }), undefined);
  assert.equal(worker.fetches.length, 0);
  assert.equal(worker.stores.size, 0);
});

test('worker never caches application navigation and uses only generic offline fallback', async () => {
  const worker = workerHarness();
  await worker.lifecycle('install');
  worker.setNetwork(async () => publicResponse('<html>private current user</html>', 'text/html'));
  assert.equal(await (await worker.request('/app/chat/general', { mode: 'navigate' })).text(), '<html>private current user</html>');
  assert.ok([...worker.stores.values()].every(entries => !entries.has(origin + '/app/chat/general')));
  worker.setNetwork(async () => { throw new Error('offline'); });
  assert.equal(await (await worker.request('/app/chat/general', { mode: 'navigate' })).text(), 'static');
  assert.equal(worker.request('/api/bootstrap', { mode: 'navigate' }), undefined);
});

test('worker caches public hashed assets but rejects SPA fallbacks and JSON', async () => {
  const worker = workerHarness();
  worker.setNetwork(async () => publicResponse('public JS', 'text/javascript'));
  const asset = '/assets/index-ABCD1234.js';
  assert.equal(await (await worker.request(asset)).text(), 'public JS');
  assert.equal(worker.fetches.at(-1).options.credentials, 'omit');
  assert.ok([...worker.stores.values()][0].has(origin + asset));
  worker.setNetwork(async () => publicResponse('<html>fallback</html>', 'text/html'));
  await worker.request('/assets/missing-EFGH1234.js');
  assert.ok(![...worker.stores.values()][0].has(origin + '/assets/missing-EFGH1234.js'));
  worker.setNetwork(async () => publicResponse('{"user":"private"}', 'application/json'));
  await worker.request('/assets/invalid-IJKL1234.js');
  assert.ok(![...worker.stores.values()][0].has(origin + '/assets/invalid-IJKL1234.js'));
});

test('worker activation removes its obsolete caches and preserves unrelated caches', async () => {
  const worker = workerHarness();
  worker.stores.set('campuslink-public-v0', new Map());
  worker.stores.set('campuslink-public-v1', new Map());
  worker.stores.set('another-app', new Map());
  await worker.lifecycle('activate');
  assert.deepEqual([...worker.stores.keys()].sort(), ['another-app', 'campuslink-public-v1']);
});

function installHarness(secure = true) {
  const handlers = new Map();
  const registered = [];
  const standalone = { matches: false, addEventListener: () => {} };
  const window = { isSecureContext: secure, matchMedia: () => standalone, addEventListener: (name, handler) => handlers.set(name, handler) };
  const navigator = { serviceWorker: { register: async (...args) => { registered.push(args); } } };
  const sandbox = { window, navigator, document: { readyState: 'complete' } };
  runInNewContext(installSource.replace(/^export /gm, '') + '\nglobalThis.pwa = { initializePwa, promptInstall, getInstallState, subscribeInstall };', sandbox);
  return { pwa: sandbox.pwa, handlers, registered, standalone };
}

test('installation is deferred until a user action, prompted once, and tracks installed events', async () => {
  const harness = installHarness();
  harness.pwa.initializePwa();
  harness.pwa.initializePwa();
  assert.equal(harness.registered.length, 1);
  let prompts = 0, prevented = 0, changes = 0;
  const unsubscribe = harness.pwa.subscribeInstall(() => { changes++; });
  const event = { preventDefault: () => { prevented++; }, prompt: async () => { prompts++; return { outcome: 'dismissed' }; } };
  harness.handlers.get('beforeinstallprompt')(event);
  assert.equal(prevented, 1);
  assert.equal(prompts, 0);
  assert.equal(harness.pwa.getInstallState().prompt, event);
  assert.equal(await harness.pwa.promptInstall(), 'dismissed');
  assert.equal(prompts, 1);
  assert.equal(harness.pwa.getInstallState().prompt, null);
  assert.equal(harness.pwa.getInstallState().installed, false);
  assert.equal(await harness.pwa.promptInstall(), null);
  harness.handlers.get('appinstalled')();
  assert.equal(harness.pwa.getInstallState().installed, true);
  assert.ok(changes >= 3);
  unsubscribe();
});

test('service worker registration is skipped on insecure LAN HTTP', () => {
  const harness = installHarness(false);
  harness.pwa.initializePwa();
  assert.equal(harness.registered.length, 0);
  assert.ok(harness.handlers.has('beforeinstallprompt'));
});
