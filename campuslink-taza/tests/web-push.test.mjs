import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePushPublicKey, disablePushDevice, getPushCapability, setPushAccount } from '../src/lib/web-push.js';

// Pure capability inspection must not request permission, contact a server,
// subscribe, or wait for a worker. Browser fixtures cover the asynchronous UI.
function inBrowser(options, run) {
  const descriptors = new Map(['window', 'navigator', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = [];
  const win = { isSecureContext: true,
    Notification: { requestPermission() { calls.push('permission'); throw new Error('No permission prompt in unit tests'); } },
    PushManager: function PushManager() {},
    matchMedia(query) { assert.equal(query, '(display-mode: standalone)'); return { matches: options.standalone === true }; },
  };
  const serviceWorker = {};
  Object.defineProperty(serviceWorker, 'ready', { get() { calls.push('worker-ready'); throw new Error('Capability inspection must not await a worker'); } });
  const nav = { userAgent: options.userAgent || 'Mozilla/5.0 Android Chrome', platform: options.platform || 'Linux',
    maxTouchPoints: options.maxTouchPoints ?? 1, standalone: options.navigatorStandalone === true, serviceWorker };
  if (options.insecure) win.isSecureContext = false;
  if (options.missing === 'Notification') delete win.Notification;
  if (options.missing === 'PushManager') delete win.PushManager;
  if (options.missing === 'serviceWorker') delete nav.serviceWorker;
  for (const [name, value] of [['window', options.noWindow ? undefined : win], ['navigator', nav],
    ['fetch', () => { calls.push('network'); throw new Error('No real network in unit tests'); }]]) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try { run(); assert.deepEqual(calls, [], 'Inspecting capability is passive'); }
  finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('VAPID decoding preserves an uncompressed 65-byte public point with URL-safe padding variants', () => {
  const expected = new Uint8Array(65).fill(255); expected[0] = 4; expected[3] = 251;
  const key = Buffer.from(expected).toString('base64url');
  assert.ok(key.includes('-') && key.includes('_'), 'Fixture exercises both URL-safe substitutions');
  for (const encoded of [key, key + '=', key + '==']) {
    // Only correct padding variants should decode; 65 bytes requires one '='.
    if (encoded.endsWith('==')) {
      assert.throws(() => decodePushPublicKey(encoded), { code: 'CONFIGURATION' });
    } else assert.deepEqual(decodePushPublicKey(encoded), expected);
  }
});

test('VAPID decoding rejects malformed base64, wrong lengths and compressed or invalid point prefixes', () => {
  for (const value of ['', null, undefined, 42, {}, '*not-base64*', 'data:application/octet-stream,AAAA', 'AA AA', '____=unexpected']) {
    assert.throws(() => decodePushPublicKey(value), { code: 'CONFIGURATION' }, `Reject malformed value ${String(value)}`);
  }
  for (const length of [0, 1, 32, 64, 66, 100]) {
    const bytes = new Uint8Array(length).fill(4);
    assert.throws(() => decodePushPublicKey(Buffer.from(bytes).toString('base64url')), { code: 'CONFIGURATION' }, `Reject ${length}-byte point`);
  }
  for (const prefix of [0, 2, 3, 5, 255]) {
    const bytes = new Uint8Array(65).fill(17); bytes[0] = prefix;
    assert.throws(() => decodePushPublicKey(Buffer.from(bytes).toString('base64url')), { code: 'CONFIGURATION' }, `Reject point prefix ${prefix}`);
  }
});

test('capability inspection rejects an unavailable browser or insecure context without browser side effects', () => {
  for (const options of [{ noWindow: true }, { insecure: true }]) inBrowser(options, () => {
    assert.deepEqual(getPushCapability(), { supported: false, reason: 'insecure' });
  });
});

test('supported non-iOS browsers do not need home-screen installation', () => {
  inBrowser({}, () => assert.deepEqual(getPushCapability(), { supported: true, reason: null, ios: false, installed: false }));
  inBrowser({ standalone: true }, () => assert.deepEqual(getPushCapability(), { supported: true, reason: null, ios: false, installed: true }));
});

test('every required browser API is checked independently without requesting permission', () => {
  for (const missing of ['Notification', 'PushManager', 'serviceWorker']) inBrowser({ missing }, () => {
    assert.deepEqual(getPushCapability(), { supported: false, reason: 'unsupported', ios: false, installed: false });
  });
});

test('iPhone, iPod, iPad and desktop-mode touch iPad get installation guidance before support detection', () => {
  const configurations = [
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone' },
    { userAgent: 'Mozilla/5.0 (iPod touch)', platform: 'iPod' },
    { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad' },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 },
  ];
  for (const configuration of configurations) inBrowser({ ...configuration, missing: 'PushManager' }, () => {
    assert.deepEqual(getPushCapability(), { supported: false, reason: 'install', ios: true, installed: false });
  });
});

test('either standalone signal enables iOS capability checks while a regular Mac remains a desktop browser', () => {
  const ios = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', platform: 'iPhone' };
  for (const signal of [{ standalone: true }, { navigatorStandalone: true }]) inBrowser({ ...ios, ...signal }, () => {
    assert.deepEqual(getPushCapability(), { supported: true, reason: null, ios: true, installed: true });
  });
  inBrowser({ ...ios, navigatorStandalone: true, missing: 'Notification' }, () => {
    assert.deepEqual(getPushCapability(), { supported: false, reason: 'unsupported', ios: true, installed: true });
  });
  inBrowser({ platform: 'MacIntel', maxTouchPoints: 1, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }, () => {
    assert.deepEqual(getPushCapability(), { supported: true, reason: null, ios: false, installed: false });
  });
});

test('device disable still attempts browser unsubscribe when local ownership storage cannot be read', async () => {
  const names = ['window', 'navigator', 'indexedDB', 'fetch', 'localStorage'];
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let unsubscribed = 0, network = 0;
  const registration = { active: {}, pushManager: {
    async getSubscription() { return { async unsubscribe() { unsubscribed++; return true; } }; },
  } };
  const values = {
    window: { isSecureContext: true, Notification: {}, PushManager() {},
      matchMedia: () => ({ matches: false }), dispatchEvent() {} },
    navigator: { userAgent: 'Chrome fixture', platform: 'Linux', maxTouchPoints: 0, onLine: true,
      serviceWorker: { ready: Promise.resolve(registration), async getRegistration() { return registration; } } },
    indexedDB: { open() {
      const request = {};
      queueMicrotask(() => { request.error = new Error('Fixture storage unavailable'); request.onerror?.(); });
      return request;
    } },
    fetch: () => { network++; throw new Error('No network in helper unit tests'); },
    localStorage: { setItem() {} },
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    setPushAccount('51');
    // Reporting the storage problem is permitted; skipping browser unsubscribe
    // would leave the old account's OS subscription live after logout.
    await disablePushDevice({ detachServer: false }).catch(() => {});
    assert.equal(unsubscribed, 1, 'Storage failure cannot bypass local OS unsubscribe');
    assert.equal(network, 0);
  } finally {
    setPushAccount(null);
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('device disable completes without waiting for worker installation when no registration exists', async () => {
  const names = ['window', 'navigator', 'indexedDB', 'fetch', 'localStorage'];
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let readyReads = 0, registrations = 0, network = 0;
  const serviceWorker = { async getRegistration(scope) { assert.equal(scope, '/'); registrations++; return undefined; } };
  Object.defineProperty(serviceWorker, 'ready', { get() { readyReads++; throw new Error('Cleanup cannot wait for worker installation'); } });
  const store = new Map();
  const db = { close() {}, transaction() {
    const transaction = { objectStore() { return {
      get(key) {
        const request = {};
        queueMicrotask(() => { request.result = store.get(key); request.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); });
        return request;
      },
      put(value, key) { store.set(key, value); }, delete(key) { store.delete(key); },
    }; }, abort() { transaction.onabort?.(); } };
    return transaction;
  } };
  const values = {
    window: { isSecureContext: true, Notification: {}, PushManager() {}, matchMedia: () => ({ matches: false }), dispatchEvent() {} },
    navigator: { userAgent: 'Chrome fixture', platform: 'Linux', maxTouchPoints: 0, onLine: true, serviceWorker },
    indexedDB: { open() { const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess?.(); }); return request; } },
    fetch: () => { network++; throw new Error('No network in helper unit tests'); }, localStorage: { setItem() {} },
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    setPushAccount('51');
    assert.deepEqual(await disablePushDevice({ detachServer: false }), { active: false });
    assert.equal(readyReads, 0, 'Logout must not depend on serviceWorker.ready');
    assert.equal(registrations, 1);
    assert.equal(network, 0);
    assert.equal(store.has('active'), false);
  } finally {
    setPushAccount(null);
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
