import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
// Chrome correctly refuses installation in incognito contexts. Use a temporary,
// isolated regular profile to check the actual browser installation criteria.
const userDataDir = mkdtempSync(join(tmpdir(), 'campuslink-install-check-'));
const context = await chromium.launchPersistentContext(userDataDir, { ...(existsSync(executablePath) ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], viewport: { width: 390, height: 844 }, colorScheme: 'light' });
let revision = 1;
try {
  await context.addInitScript(() => {
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', '"en"');
    localStorage.setItem('campuslink-prototype-v1:theme', '"dark"');
    window.EventSource = undefined;
  });
  // No real authentication or database writes: the worker must bypass all API data.
  await context.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/session' ? { user: null } : { revision } }));
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const client = await context.newCDPSession(page);
  const manifest = await client.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  const details = JSON.parse(manifest.data);
  assert.equal(details.display, 'standalone');
  assert.equal(details.start_url, '/app');
  for (const icon of details.icons) {
    const dimensions = await page.evaluate(async src => {
      const image = new Image(); image.src = src; await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, icon.src);
    assert.equal(dimensions, icon.sizes);
  }
  const installability = await client.send('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, []);
  console.log('PASS real Chromium installability checks: manifest, scope, standalone, 192/512 icons and service worker');

  assert.equal(await page.evaluate(async () => (await (await fetch('/api/install-fixture', { cache: 'no-store' })).json()).revision), 1);
  revision = 2;
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/install-fixture', { cache: 'no-store' })).json()).revision), 2);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const requests = await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)));
    return requests.flat();
  });
  assert.ok(cached.includes('/offline.html'));
  assert.ok(cached.length > 0 && cached.every(path => path === '/offline.html' || path === '/favicon.svg' || path.startsWith('/icons/')));
  console.log('PASS API revisions remain live and caches contain only public install assets');

  await context.setOffline(true);
  await page.goto(`${baseURL}/app/profile`);
  await expect(page.locator('#title')).toHaveText('You are offline');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(18, 18, 16)');
  await expect(page.locator('#retry')).toHaveText('Try again');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  console.log('PASS offline navigation keeps the saved dark theme despite a light OS and reconnect returns to normal authentication');
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
