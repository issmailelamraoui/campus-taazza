import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';

// Notification, service-worker and PushManager APIs are fake. Every API call,
// including enrollment/logout, is locally intercepted. No actual permission
// dialog, push subscription, OS notification, or campus account is touched.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/web-push/chromium';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const expect = browserExpect.configure({ timeout: 15000 });
const report = { passed: [], errors: [], screenshots: [] };
await mkdir(output, { recursive: true });
const key = Buffer.from([4, ...Array.from({ length: 64 }, (_, index) => index + 1)]).toString('base64url');

async function fixture({ width = 1440, height = 900, theme = 'dark', language = 'fr', ios = false,
  installed = false, supported = true, permission = 'default', outcome = 'granted', enabled = true,
  failFirst = false, holdEnrollment = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900,
    serviceWorkers: 'block', reducedMotion: 'reduce', ...(ios ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' } : {}) });
  await context.addInitScript(({ theme, language, permission, outcome, ios, installed, supported }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = undefined;
    if (ios) {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' });
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: installed });
    }
    const media = window.matchMedia.bind(window);
    if (installed) window.matchMedia = query => query.includes('display-mode: standalone')
      ? { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : media(query);
    window.__pushStats = { permissions: [], subscribe: 0, unsubscribe: 0, register: 0 };
    const subscription = { endpoint: 'https://push.fixture.test/device-one',
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'fixture-public-key', auth: 'fixture-auth' } }; },
      async unsubscribe() { window.__pushStats.unsubscribe++; sessionStorage.removeItem('fake-push-subscribed'); return true; } };
    const manager = {
      async getSubscription() { return sessionStorage.getItem('fake-push-subscribed') ? subscription : null; },
      async subscribe(options) {
        if (options.userVisibleOnly !== true || options.applicationServerKey.byteLength !== 65) throw new Error('Invalid mocked push options');
        window.__pushStats.subscribe++; sessionStorage.setItem('fake-push-subscribed', 'true'); return subscription;
      },
    };
    const registration = { active: { scriptURL: location.origin + '/sw.js' }, scope: location.origin + '/', pushManager: manager };
    const worker = new EventTarget();
    worker.ready = Promise.resolve(registration);
    worker.getRegistration = async () => registration;
    worker.register = async () => { window.__pushStats.register++; return registration; };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
    window.PushManager = class {};
    if (!supported) { delete window.Notification; delete window.PushManager; }
    else {
      class FixtureNotification {
        static get permission() { return sessionStorage.getItem('fake-push-permission') || permission; }
        static requestPermission() {
          window.__pushStats.permissions.push(navigator.userActivation.isActive);
          sessionStorage.setItem('fake-push-permission', outcome); return Promise.resolve(outcome);
        }
      }
      Object.defineProperty(window, 'Notification', { configurable: true, value: FixtureNotification });
    }
    window.__readPushBinding = () => new Promise((resolve, reject) => {
      const open = indexedDB.open('campuslink-push-device-v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('device');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, request = db.transaction('device').objectStore('device').get('active');
        request.onsuccess = () => { db.close(); resolve(request.result || null); }; request.onerror = () => { db.close(); reject(request.error); }; };
    });
  }, { theme, language, permission, outcome, ios, installed, supported });
  let user = { id: 51, username: 'push-fixture', name: 'Push fixture', role: 'student', faculty_id: 'fsa',
    filiere_id: 'data_science', current_semester: 5, language, account_status: 'approved', preferences: {} };
  const errors = [], requests = [];
  let enrollments = 0, binding = null, releaseEnrollment;
  const enrollmentGate = new Promise(resolve => { releaseEnrollment = resolve; });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({ method, path, body });
    const send = (json, status = 200) => route.fulfill({ json, status });
    if (path === '/api/session' && method === 'GET') return send({ user });
    if (['/api/bootstrap', '/api/live'].includes(path) && method === 'GET') return send({ user,
      faculty: { id: 'fsa', code: 'FSA', name: 'Faculté de test' }, resources: [], announcements: [], messages: [],
      notifications: [], unread_count: 0, channels: [], members: [], saved: [], history: [] });
    if (path === '/api/members/51/achievements' && method === 'GET') return send({ achievements: [] });
    if (path === '/api/push/config' && method === 'GET') return send({ enabled, publicKey: enabled ? key : null });
    if (path === '/api/push/subscriptions/status' && method === 'POST') {
      assert.equal(body.expectedUserId, String(user.id));
      return send({ enabled, active: Boolean(binding && body.bindingId === binding), bindingId: binding });
    }
    if (path === '/api/push/subscriptions' && method === 'POST') {
      assert.equal(body.expectedUserId, String(user.id));
      assert.match(body.deviceId, /^[0-9a-f-]{36}$/i); assert.equal(body.subscription.endpoint, 'https://push.fixture.test/device-one');
      enrollments++;
      if (holdEnrollment) await enrollmentGate;
      if (failFirst && enrollments === 1) return send({ error: 'Inscription temporairement indisponible. Réessayez.' }, 503);
      binding = `fixture-binding-${enrollments}`; return send({ ok: true, bindingId: binding });
    }
    if (path === '/api/push/subscriptions' && method === 'DELETE') {
      assert.equal(body.expectedUserId, String(user.id)); assert.equal(body.bindingId, binding);
      binding = null; return send({ ok: true });
    }
    if (path === '/api/logout' && method === 'POST') { user = null; return send({ ok: true }); }
    if (path === '/api/auth/google/config' && method === 'GET') return send({ enabled: false });
    errors.push(`Unexpected fixture API: ${method} ${path}`); return send({ error: 'Unexpected fixture API' }, 503);
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !(failFirst && message.text().includes('503'))) errors.push(message.text()); });
  await page.goto(origin + '/app/profile');
  await expect(page.locator('.push-settings')).toBeVisible();
  await expect(page.locator('.push-settings')).not.toHaveAttribute('data-push-state', 'checking');
  return { context, page, errors, requests, releaseEnrollment,
    async stats() { return page.evaluate(() => window.__pushStats); },
    async binding() { return page.evaluate(() => window.__readPushBinding()); },
  };
}
const card = page => page.locator('.push-settings');
const enable = page => card(page).getByRole('button', { name: 'Activer les notifications', exact: true });
const disable = page => card(page).getByRole('button', { name: 'Désactiver sur cet appareil', exact: true });
async function checked(name, options, run) {
  const f = await fixture(options);
  try {
    await run(f);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(f.errors, []); report.passed.push(name);
  } finally { f.releaseEnrollment(); report.errors.push(...f.errors); await f.context.close(); }
}
async function screenshot(page, name) {
  await card(page).scrollIntoViewIfNeeded();
  const path = `${output}/${name}.png`; await page.screenshot({ path }); report.screenshots.push(path);
}
try {
  await checked('Explicit device opt-in, immutable browser permission, reload reconciliation and per-device disable', {}, async f => {
    const { page } = f;
    assert.deepEqual((await f.stats()).permissions, [], 'Opening preferences never requests permission');
    await enable(page).click(); await expect(card(page)).toHaveAttribute('data-push-state', 'active');
    assert.deepEqual((await f.stats()).permissions, [true], 'Only a real click with active user activation asks permission');
    assert.equal((await f.binding()).userId, '51'); await screenshot(page, 'desktop-dark-active');
    await page.reload(); await expect(disable(page)).toBeVisible();
    assert.deepEqual((await f.stats()).permissions, [], 'Restoring a subscribed device does not ask permission');
    assert.ok(f.requests.some(request => request.path.endsWith('/status')));
    await disable(page).click(); await expect(enable(page)).toBeVisible();
    assert.equal(await f.binding(), null);
    assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
    assert.equal((await f.stats()).unsubscribe, 1);
  });
  await checked('Denied permissions show settings guidance without another permission request', { width: 320, height: 700, permission: 'denied' }, async f => {
    await expect(card(f.page)).toHaveAttribute('data-push-state', 'denied');
    await expect(card(f.page)).toContainText('réglages'); await expect(enable(f.page)).toHaveCount(0);
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.deepEqual((await f.stats()).permissions, []);
    assert.equal(f.requests.filter(request => request.path === '/api/push/subscriptions').length, 0);
    await screenshot(f.page, 'phone-dark-denied');
  });
  await checked('Dismissed permission remains optional and never enrolls or claims success', { width: 390, theme: 'light', outcome: 'default' }, async f => {
    await enable(f.page).click(); await expect(card(f.page).getByRole('alert')).toContainText('plus tard');
    await expect(enable(f.page)).toBeVisible(); assert.equal(await f.binding(), null);
    assert.equal((await f.stats()).subscribe, 0);
    assert.equal(f.requests.filter(request => request.path === '/api/push/subscriptions').length, 0);
  });
  await checked('Server enrollment failure is truthful and retry registers one current binding', { width: 390, theme: 'light', failFirst: true }, async f => {
    await enable(f.page).click(); await expect(card(f.page).getByRole('alert')).toContainText('temporairement');
    await expect(enable(f.page)).toBeEnabled(); assert.equal(await f.binding(), null);
    await enable(f.page).click(); await expect(disable(f.page)).toBeVisible();
    assert.equal((await f.stats()).permissions.length, 1, 'Retry uses already granted permission');
    assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/api/push/subscriptions').length, 2);
    await screenshot(f.page, 'phone-light-active');
  });
  await checked('iPhone browser offers Home Screen instructions without permission or enrollment', { width: 390, ios: true, supported: false, theme: 'light' }, async f => {
    await expect(card(f.page)).toHaveAttribute('data-push-state', 'install');
    await card(f.page).getByRole('button', { name: 'Comment installer', exact: true }).click();
    await expect(card(f.page).locator('ol')).toContainText('écran d’accueil');
    assert.deepEqual((await f.stats()).permissions, []);
    assert.equal(f.requests.filter(request => request.path.startsWith('/api/push/')).length, 0);
    await screenshot(f.page, 'phone-ios-install');
  });
  await checked('An installed iPhone can opt in, and offline logout clears the local binding', { width: 390, ios: true, installed: true }, async f => {
    await enable(f.page).click(); await expect(disable(f.page)).toBeVisible();
    await f.page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
    await f.page.getByRole('button', { name: 'Se déconnecter', exact: true }).last().click();
    await expect(f.page).toHaveURL(/\/login$/);
    await expect.poll(f.binding).toBe(null);
    assert.equal((await f.stats()).unsubscribe, 1);
    assert.equal(f.requests.filter(request => request.path === '/api/logout').length, 0);
  });
  await checked('Late enrollment receipt after logout cannot install an old account binding', { holdEnrollment: true }, async f => {
    await enable(f.page).click();
    await expect.poll(() => f.requests.filter(request => request.path === '/api/push/subscriptions' && request.method === 'POST').length).toBe(1);
    await f.page.getByRole('button', { name: 'Se déconnecter', exact: true }).last().click();
    await expect(f.page).toHaveURL(/\/login$/); f.releaseEnrollment();
    await expect.poll(f.binding).toBe(null);
    assert.equal((await f.stats()).unsubscribe, 1);
  });
  await checked('Unconfigured service stays honest with no enable or permission attempt', { enabled: false, width: 320, language: 'ar', theme: 'light' }, async f => {
    await expect(card(f.page)).toHaveAttribute('data-push-state', 'unconfigured');
    await expect(card(f.page).getByRole('button')).toHaveCount(0);
    assert.deepEqual((await f.stats()).permissions, []);
  });
  console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
