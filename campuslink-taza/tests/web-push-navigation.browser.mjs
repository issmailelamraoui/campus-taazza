import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';

// All authentication, notification reads and destination data are isolated API
// fixtures. Notification permission and the service-worker APIs are mocked.
// No actual account login, push, permission dialog, or read mutation occurs.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/web-push-navigation/chromium';
const pendingKey = 'campuslink-prototype-v1:pending-push';
const expect = browserExpect.configure({ timeout: 15000 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { passed: [], errors: [], requests: [], screenshots: [] };
await mkdir(output, { recursive: true });

async function fixture({ signedIn = true, forbidden = false, resource = false, width = 1440 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 900,
    serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', '"dark"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    const streams = [];
    window.EventSource = class extends EventTarget {
      constructor() { super(); streams.push(this); }
      close() { const index = streams.indexOf(this); if (index >= 0) streams.splice(index, 1); }
    };
    window.__pushNavigationArrival = () => streams.forEach(stream => stream.dispatchEvent(
      new MessageEvent('update', { data: '{"notifications":true}' })));
    const registration = { active: { scriptURL: location.origin + '/sw.js' }, scope: location.origin + '/',
      pushManager: { async getSubscription() { return null; } } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      ready: Promise.resolve(registration), async register() { return registration; },
      async getRegistration() { return registration; },
    } });
    class FixtureNotification {
      static permission = 'default';
      static requestPermission() {
        sessionStorage.setItem('unexpected-push-permission', 'true');
        throw new Error('This navigation test must never request notification permission');
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FixtureNotification });
    window.PushManager = class {};
  });
  const approvedUser = { id: forbidden ? 62 : 51, username: 'push-navigation-fixture', name: 'Push navigation fixture',
    role: 'student', account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science',
    current_semester: 5, language: 'fr', preferences: {} };
  let user = signedIn ? approvedUser : null;
  const teacher = { id: 52, name: 'Fixture classmate', username: 'fixture.classmate', role: 'student' };
  const question = { id: 81, title: 'QUESTION CIBLE DU PUSH', body: 'Une question à retrouver après le clic système.',
    author_id: 51, author: { ...approvedUser, id: 51 }, module: 'Data science', resource_id: null };
  const answer = { id: 9, body: 'RÉPONSE EXACTE DU PUSH', author_id: 52, author: teacher, score: 0, my_vote: 0 };
  const notification = { id: 42, type: resource ? 'resources' : 'mentions', title: 'Destination exacte de la notification',
    body: 'Un contenu destiné au compte de test.', read: false, read_at: null,
    created_at: new Date().toISOString(), popup_eligible: false, target_available: true,
    path: resource ? '/app/resources/courses/s5/push-document#resource-91' : '/app/campus?tab=forum&question=81&answer=9' };
  let notices = forbidden ? [] : [notification], bootstrapCount = 0;
  const errors = [], requests = [];
  const payload = () => ({ user, faculty: { id: 'fsa', code: 'FSA', name: 'Faculté de test' },
    resources: [], messages: [], announcements: [], notifications: notices,
    unread_count: notices.filter(item => !item.read).length, admin_unread_count: 0,
    discussion_unread_count: 0, discussion_unread_counts: [], has_more: false,
    channels: [], members: [], saved: [], history: [], events: [], messages_complete: true });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method()) || url.origin !== new URL(origin).origin) {
      errors.push(`Blocked non-fixture request: ${request.method()} ${request.url()}`);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({ method, path, userId: user?.id ?? null, body });
    const send = (json, status = 200) => route.fulfill({ json, status });
    if (path === '/api/session' && method === 'GET') return send({ user });
    if (['/api/bootstrap', '/api/live'].includes(path) && method === 'GET') { bootstrapCount++; return send(payload()); }
    if (path === '/api/auth/google/config' && method === 'GET') return send({ enabled: false });
    if (path === '/api/login' && method === 'POST' && !signedIn) {
      assert.deepEqual(body, { username: approvedUser.username, password: 'browser-fixture-only' });
      user = approvedUser; return send({ user });
    }
    if (path === '/api/notifications/42' && method === 'GET') {
      assert.ok(user, 'A pending push ID must not be fetched before authentication');
      if (forbidden) return send({ error: 'Notification indisponible.' }, 404);
      return send({ notification: notices.find(item => item.id === 42) });
    }
    if (path === '/api/notifications/42/read' && method === 'POST' && !forbidden) {
      assert.ok(user); notices = notices.map(item => item.id === 42 ? { ...item, read: true, read_at: item.read_at || new Date().toISOString() } : item);
      return send(payload());
    }
    if (path === '/api/campus/forum/81' && method === 'GET') return send({ question, answers: [answer], comments: [] });
    if (path === '/api/campus/forum/81/attachments' && method === 'GET') return send({ attachments: [], can_upload: false,
      limits: { maxFiles: 5, maxFileBytes: 20971520, maxTotalBytes: 52428800 } });
    if (path === '/api/modules' && method === 'GET' && resource) return send({ modules: [] });
    if (path === '/api/files/91' && method === 'GET' && resource) return route.fulfill({ contentType: 'text/plain; charset=utf-8', body: 'SOURCE EXACTE DU PUSH — document 91' });
    if (path === '/api/history' && method === 'POST' && resource) {
      assert.equal(String(body.resource_id), '91'); return send({ ok: true });
    }
    errors.push(`Unexpected fixture API: ${method} ${path}`);
    return send({ error: 'Unexpected navigation fixture request' }, 503);
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !(forbidden && /(?:status of )404\b/.test(message.text()))) errors.push(message.text());
  });
  return { page, context, errors, requests,
    async arrive() {
      const before = bootstrapCount;
      notices = [{ ...notification, id: 43, title: 'Nouvelle notification reçue' }, ...notices];
      await page.evaluate(() => window.__pushNavigationArrival());
      await expect.poll(() => bootstrapCount).toBeGreaterThan(before);
    },
  };
}
const reads = f => f.requests.filter(request => request.path === '/api/notifications/42/read');
async function pending(page) { return page.evaluate(key => sessionStorage.getItem(key), pendingKey); }
async function screenshot(page, name) {
  const path = `${output}/${name}.png`; await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
}
async function checked(name, options, run) {
  const f = await fixture(options);
  try {
    await run(f);
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem('unexpected-push-permission')), null);
    assert.deepEqual(f.errors, []); report.passed.push(name);
  } finally {
    report.errors.push(...f.errors); report.requests.push({ check: name, requests: f.requests });
    await f.context.close();
  }
}

try {
  await checked('A generic notification arrival does not fetch a push ID or mark anything read', {}, async f => {
    const { page } = f;
    await page.goto(origin + '/app/notifications');
    await expect(page.locator('.notification-item[data-notification-id="42"]')).toBeVisible();
    await f.arrive(); await expect(page.locator('.notification-item[data-notification-id="43"]')).toBeVisible();
    assert.equal(f.requests.filter(request => /^\/api\/notifications\/42(?:\/read)?$/.test(request.path)).length, 0);
    assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
    assert.equal(await pending(page), null);
  });

  await checked('A signed-in system click fetches the own receipt and opens its exact forum answer once', {}, async f => {
    const { page } = f;
    await page.goto(origin + '/app/notifications?push=42');
    await expect(page).toHaveURL(url => url.pathname === '/app/campus' && url.searchParams.get('question') === '81' && url.searchParams.get('answer') === '9');
    await expect(page.getByRole('heading', { name: 'QUESTION CIBLE DU PUSH', exact: true })).toBeVisible();
    await expect(page.locator('#answer-9')).toContainText('RÉPONSE EXACTE DU PUSH');
    assert.equal(reads(f).length, 1);
    const fetchIndex = f.requests.findIndex(request => request.path === '/api/notifications/42');
    const readIndex = f.requests.findIndex(request => request.path === '/api/notifications/42/read');
    assert.ok(fetchIndex >= 0 && readIndex > fetchIndex, 'A read follows authenticated own-row verification');
    assert.equal(await pending(page), null);
    await screenshot(page, 'desktop-exact-forum-answer');
    await page.reload(); await expect(page.locator('#answer-9')).toBeVisible();
    assert.equal(reads(f).length, 1, 'Reloading the destination never replays the consumed system click');
  });

  await checked('A signed-out system click survives login and opens the exact source document on a phone', { signedIn: false, resource: true, width: 390 }, async f => {
    const { page } = f;
    await page.goto(origin + '/app/notifications?push=42');
    await expect(page).toHaveURL(/\/login$/);
    assert.equal(JSON.parse(await pending(page)).id, '42');
    assert.equal(f.requests.some(request => request.path === '/api/notifications/42'), false);
    assert.equal(reads(f).length, 0);
    await page.locator('#login-username').fill('push-navigation-fixture');
    await page.locator('#login-password').fill('browser-fixture-only');
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/api/files/91');
    await expect(page.locator('body')).toContainText('SOURCE EXACTE DU PUSH — document 91');
    assert.equal(reads(f).length, 1);
    assert.ok(f.requests.filter(request => request.path === '/api/notifications/42').every(request => request.userId === 51));
    assert.equal(await pending(page), null);
    await screenshot(page, 'phone-login-to-exact-document');
  });

  await checked('A push ID unavailable to the signed-in account stays in the inbox without a read or foreign destination', { forbidden: true, width: 390 }, async f => {
    const { page } = f;
    await page.goto(origin + '/app/notifications?push=42');
    await expect(page).toHaveURL(origin + '/app/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    assert.equal(reads(f).length, 0);
    assert.equal(f.requests.some(request => request.path.startsWith('/api/campus/') || request.path.startsWith('/api/files/')), false);
    assert.equal(await pending(page), null);
    assert.equal(new URL(page.url()).origin, new URL(origin).origin);
    await screenshot(page, 'phone-wrong-account-safe-inbox');
  });
  console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
