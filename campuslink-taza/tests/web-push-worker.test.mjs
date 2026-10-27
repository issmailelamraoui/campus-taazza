import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// No browser permission, push service, API or operating-system notification is
// involved. Each VM represents an already-installed, closed-page worker.
const origin = 'https://campus.test';
const owned = { userId: '51', bindingId: 'binding-fixture-51' };
const validPayload = { bindingId: owned.bindingId, notificationId: 714,
  title: 'Une réponse à votre question', body: 'Un étudiant vous a répondu.' };
const plain = value => JSON.parse(JSON.stringify(value));

async function workerFixture({ active = owned, databaseFailure = false, windows = [], show } = {}) {
  const listeners = {}, shown = [], fetched = [], cacheCalls = [], databaseCalls = [], clientCalls = [];
  let state = structuredClone(active), closeCount = 0;
  const db = {
    objectStoreNames: { contains: name => name === 'device' },
    createObjectStore() {}, close() {},
    transaction(store) {
      assert.equal(store, 'device', 'Push ownership has its own account state store');
      return { objectStore(name) {
        assert.equal(name, 'device');
        return { get(key) {
          assert.equal(key, 'active');
          const request = {};
          queueMicrotask(() => { request.result = structuredClone(state); request.onsuccess?.(); });
          return request;
        } };
      } };
    },
  };
  const indexedDB = { open(name, version) {
    databaseCalls.push({ name, version });
    assert.equal(name, 'campuslink-push-device-v1');
    const request = {};
    queueMicrotask(() => {
      if (databaseFailure) { request.error = new Error('Fixture IndexedDB unavailable'); request.onerror?.(); }
      else { request.result = db; request.onsuccess?.(); }
    });
    return request;
  } };
  const clients = {
    async matchAll(options) { clientCalls.push({ action: 'matchAll', options: plain(options) }); return windows; },
    async openWindow(url) { clientCalls.push({ action: 'openWindow', url }); return {}; },
    async claim() {},
  };
  const registration = { scope: origin + '/',
    async showNotification(title, options) {
      shown.push({ title, options: plain(options) });
      if (show) await show();
    },
  };
  const worker = { location: { origin, href: origin + '/sw.js' }, clients, registration, indexedDB,
    addEventListener(name, listener) { listeners[name] = listener; }, async skipWaiting() {} };
  const context = vm.createContext({ self: worker, registration, indexedDB, URL, Set, Promise, Request, Response,
    console, queueMicrotask, setTimeout, clearTimeout,
    caches: {
      async open(name) { cacheCalls.push(name); throw new Error('Push must not use the public shell cache'); },
      async keys() { cacheCalls.push('keys'); return []; },
    },
    async fetch(input, options) { fetched.push({ input: String(input), options }); return new Response('{}'); },
  });
  vm.runInContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  function emit(name, event) {
    assert.equal(typeof listeners[name], 'function', `The installed worker handles ${name}`);
    const waits = [];
    listeners[name]({ ...event, waitUntil(promise) { waits.push(Promise.resolve(promise)); } });
    return { waits, complete: Promise.all(waits) };
  }
  return { shown, fetched, cacheCalls, databaseCalls, clientCalls,
    state(value) { state = structuredClone(value); },
    async push(payload = validPayload, { malformed = false, missing = false } = {}) {
      const data = missing ? undefined : { json() { if (malformed) throw new SyntaxError('Malformed payload'); return payload; } };
      return emit('push', { data });
    },
    click(data) { return emit('notificationclick', { notification: {
      data, close() { closeCount++; },
    } }); },
    closed() { return closeCount; },
  };
}

function assertNoNetworkOrCache(worker) {
  assert.deepEqual(worker.fetched, [], 'Delivery and clicking do not read, mutate or delete inbox/API data');
  assert.deepEqual(worker.cacheCalls, [], 'Private push data never enters the public shell cache');
}

test('a matching device binding displays while all pages are closed and waits for notification completion', async () => {
  let finishShow;
  const showFinished = new Promise(resolve => { finishShow = resolve; });
  const worker = await workerFixture({ show: () => showFinished });
  const task = await worker.push();
  assert.ok(task.waits.length, 'Push extends the worker lifetime with waitUntil');
  let completed = false;
  task.complete.then(() => { completed = true; });
  // Let the mocked ownership read complete without completing showNotification.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.shown.length, 1);
  assert.equal(completed, false, 'The push event stays alive until the OS display promise finishes');
  const displayed = worker.shown[0];
  assert.equal(displayed.title, validPayload.title);
  assert.equal(displayed.options.body, validPayload.body);
  assert.equal(Number(displayed.options.data.notificationId), validPayload.notificationId);
  assert.equal(displayed.options.data.bindingId, owned.bindingId);
  assert.ok(String(displayed.options.icon).startsWith('/icons/'), 'The notification uses an existing public app icon');
  finishShow(); await task.complete;
  assert.equal(completed, true);
  assertNoNetworkOrCache(worker);
});

test('a missing, disabled or different account binding cannot expose a private push', async () => {
  for (const active of [null, {}, { userId: '51' }, { bindingId: owned.bindingId },
    { userId: '62', bindingId: 'new-account-binding' }]) {
    const worker = await workerFixture({ active });
    await (await worker.push()).complete;
    assert.deepEqual(worker.shown, [], `No display for unowned state ${JSON.stringify(active)}`);
    assertNoNetworkOrCache(worker);
  }
});

test('unavailable ownership storage fails closed without a private notification or API fallback', async () => {
  const worker = await workerFixture({ databaseFailure: true });
  await (await worker.push()).complete;
  assert.deepEqual(worker.shown, []);
  assertNoNetworkOrCache(worker);
});

test('malformed data and nonpositive, unsafe or injected notification IDs are ignored', async () => {
  const worker = await workerFixture();
  for (const notificationId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '714&redirect=https://evil.test', 'not-an-id']) {
    await (await worker.push({ ...validPayload, notificationId })).complete;
  }
  await (await worker.push(null)).complete;
  await (await worker.push(validPayload, { malformed: true })).complete;
  await (await worker.push(validPayload, { missing: true })).complete;
  assert.deepEqual(worker.shown, []);
  assertNoNetworkOrCache(worker);
});

test('click closes the notification, navigates and focuses an existing same-origin app window with a derived URL', async () => {
  const calls = [];
  const outside = { url: 'https://outside.test/app', async navigate(url) { calls.push(['external-navigation', url]); }, async focus() { calls.push(['external-focus']); } };
  const app = { url: origin + '/app/library', async navigate(url) { calls.push(['navigate', url]); return app; }, async focus() { calls.push(['focus']); return app; } };
  const worker = await workerFixture({ windows: [outside, app] });
  const task = worker.click({ ...validPayload, url: 'https://evil.test/steal', path: '//evil.test/steal' });
  assert.ok(task.waits.length, 'Click waits for its asynchronous ownership and window work');
  await task.complete;
  assert.equal(worker.closed(), 1);
  assert.equal(calls.filter(([action]) => action === 'navigate').length, 1);
  const destination = new URL(calls.find(([action]) => action === 'navigate')[1], origin);
  assert.equal(destination.href, origin + '/app/notifications?push=714');
  assert.equal(calls.filter(([action]) => action === 'focus').length, 1);
  assert.equal(calls.some(([action]) => action.startsWith('external')), false);
  assert.equal(worker.clientCalls.filter(call => call.action === 'openWindow').length, 0);
  const matched = worker.clientCalls.find(call => call.action === 'matchAll');
  assert.equal(matched.options.type, 'window');
  assert.equal(matched.options.includeUncontrolled, true);
  assertNoNetworkOrCache(worker);
});

test('a click with no same-origin window opens only the canonical notifications route', async () => {
  const worker = await workerFixture({ windows: [{ url: 'https://outside.test/app' }] });
  await worker.click({ ...validPayload, url: 'javascript:alert(1)' }).complete;
  assert.equal(worker.closed(), 1);
  const opened = worker.clientCalls.filter(call => call.action === 'openWindow');
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0].url, origin).href, origin + '/app/notifications?push=714');
  assertNoNetworkOrCache(worker);
});

test('a previously displayed notice closes without navigation after logout or account switch', async () => {
  const worker = await workerFixture();
  await (await worker.push()).complete;
  const data = worker.shown[0].options.data;
  for (const state of [null, { userId: '62', bindingId: 'other-account-binding' }]) {
    worker.state(state);
    await worker.click(data).complete;
  }
  assert.equal(worker.closed(), 2);
  assert.deepEqual(worker.clientCalls, [], 'An old account notice cannot open under a new account');
  assertNoNetworkOrCache(worker);
});

test('invalid click identity never falls back to a supplied external or private URL', async () => {
  const worker = await workerFixture();
  for (const notificationId of [0, -9, 2.5, 'https://evil.test', Number.MAX_SAFE_INTEGER + 1]) {
    await worker.click({ bindingId: owned.bindingId, notificationId, url: 'https://evil.test' }).complete;
  }
  await worker.click({ notificationId: 714, url: '/api/files/private' }).complete;
  assert.deepEqual(worker.clientCalls, []);
  assert.equal(worker.closed(), 6);
  assertNoNetworkOrCache(worker);
});
