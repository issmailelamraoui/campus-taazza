import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { browserOptions } from './browser-utils.mjs';

// All account APIs are mocked. This suite never creates, deletes or modifies a
// real student, and can run independently of the disposable database suites.
const origin = process.env.CAMPUS_BROWSER_ORIGIN || 'http://localhost:5173';
const user = { id: 90001, username: 'pwa-fixture', name: 'Étudiant test', language: 'fr', role: 'student', faculty_id: 4, filiere_id: 'data_science', current_semester: 5, account_status: 'approved', preferences: {} };
const faculty = { id: 4, code: 'FSA', name: 'Faculté des Sciences Appliquées', arabic: 'كلية العلوم التطبيقية', color: '#24764c', members: 1, online: 1 };
const data = { user, faculty, faculties: [faculty], channels: [], members: [user], messages: [], resources: [], notifications: [], events: [], announcements: [], saved: [], history: [] };
const browser = await chromium.launch(browserOptions());
const errors = [];

async function mockAccounts(context, authenticated = true) {
  await context.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/events/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    const result = pathname === '/api/session' ? { user: authenticated ? user : null } : pathname === '/api/bootstrap' ? data : pathname === '/api/profile' ? { user } : {};
    return route.fulfill({ json: result });
  });
}

async function cachePaths(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const requests = await Promise.all(names.filter(name => name.startsWith('campuslink-public-')).map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)));
    return requests.flat();
  });
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await mockAccounts(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/settings');
  await expect(page.locator('.pwa-install-section')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Ajouter à l’écran d’accueil', exact: true }).click();
  await expect(page.locator('#install-app-guide')).toBeVisible();
  await page.evaluate(() => {
    window.__pwaPrompts = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { window.__pwaPrompts++; window.__pwaGesture = navigator.userActivation.isActive; return { outcome: 'dismissed' }; };
    window.dispatchEvent(event);
  });
  await expect(page.getByRole('button', { name: 'Installer l’application', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.__pwaPrompts), 0);
  await page.getByRole('button', { name: 'Installer l’application', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__pwaPrompts), 1);
  assert.equal(await page.evaluate(() => window.__pwaGesture), true);
  await expect(page.getByRole('button', { name: 'Installer l’application', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.locator('.pwa-installed')).toHaveText('Application installée');
  await page.locator('[data-theme-option=light]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/campuslink-pwa-phone.png', fullPage: false });
  await context.close();
  console.log('PASS phone Settings installation is a user action, one-shot, readable and responsive');

  const ios = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  await mockAccounts(ios);
  const iosPage = await ios.newPage();
  iosPage.on('pageerror', error => errors.push(error.message));
  await iosPage.goto(origin + '/app/settings');
  await iosPage.getByRole('button', { name: 'Ajouter à l’écran d’accueil', exact: true }).click();
  await expect(iosPage.locator('#install-app-guide')).toContainText('Safari');
  await expect(iosPage.locator('#install-app-guide')).toContainText('Partager');
  await ios.close();
  console.log('PASS iPhone gets Safari Share and Add-to-home instructions');

  const lan = await browser.newContext({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36' });
  await lan.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  await mockAccounts(lan);
  const lanPage = await lan.newPage();
  lanPage.on('pageerror', error => errors.push(error.message));
  await lanPage.goto(origin + '/app/settings');
  await expect(lanPage.locator('.pwa-install-note')).toContainText('HTTP');
  await expect(lanPage.locator('.pwa-install-note')).toContainText('raccourci');
  await lanPage.getByRole('button', { name: 'Ajouter à l’écran d’accueil', exact: true }).click();
  await expect(lanPage.locator('#install-app-guide')).toContainText('menu ⋮');
  assert.equal(await lanPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await lan.close();
  console.log('PASS insecure local phone gets honest browser-shortcut guidance');

  const offline = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mockAccounts(offline, false);
  const offlinePage = await offline.newPage();
  offlinePage.on('pageerror', error => errors.push(error.message));
  await offlinePage.goto(origin + '/');
  assert.equal(await offlinePage.evaluate(() => window.isSecureContext), true, 'Use HTTPS or localhost for the worker test');
  await offlinePage.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => offlinePage.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cached = await cachePaths(offlinePage);
  assert.ok(cached.includes('/offline.html'));
  assert.ok(cached.includes('/icons/app-192.png'));
  assert.ok(cached.every(path => !path.startsWith('/api') && !path.startsWith('/app')));
  await offlinePage.evaluate(() => fetch('/api/bootstrap').then(response => response.json()));
  assert.ok(!(await cachePaths(offlinePage)).includes('/api/bootstrap'));
  await offline.setOffline(true);
  await offlinePage.goto(origin + '/app/chat/general');
  await expect(offlinePage.getByRole('heading', { name: 'Vous êtes hors ligne' })).toBeVisible();
  assert.equal(await offlinePage.locator('.chat-message').count(), 0);
  assert.ok(!(await cachePaths(offlinePage)).includes('/app/chat/general'));
  await offline.close();
  console.log('PASS real localhost worker serves generic offline page and keeps private APIs/pages out of caches');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
