import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [];
const user = { id: 3, username: 'navigation-fixture', name: 'Étudiant test', role: 'student', account_status: 'approved', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 3, language: 'fr' };
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800, serviceWorkers: 'block' });
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    try {
      await context.addInitScript(() => {
        window.EventSource = undefined;
        localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
        localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
      });
      await context.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill({ json: { user } });
        if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', name: 'Faculté test' }, resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [] } });
        return route.fulfill({ json: {} });
      });
      let importRequested = false;
      await context.route(/\/(?:src\/pages\/LibraryPage\.jsx|assets\/LibraryPage-[^/]+\.js)(?:\?|$)/, async route => {
        importRequested = true;
        await delayed;
        await route.continue().catch(() => {});
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(baseURL + '/app');
      await expect(page.locator('.app-shell')).toBeVisible();
      await page.evaluate(() => {
        window.navigationRetryMessages = [];
        new MutationObserver(() => {
          if (document.body.innerText.includes('Réessayer')) window.navigationRetryMessages.push('Réessayer appeared');
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      const nav = width < 800 ? page.locator('.mobile-bottom-nav') : page.locator('.sidebar');
      await nav.locator('a[href="/app/library"]').click();
      await expect.poll(() => importRequested).toBe(true);
      await expect(page.locator('#main-content .page-loading')).toBeVisible();
      await expect(page.locator('.app-shell')).toBeVisible();
      await expect(page.locator('.app-header')).toBeVisible();
      await expect(nav).toBeVisible();
      await expect(page.getByRole('button', { name: 'Réessayer', exact: true })).toHaveCount(0);
      // Hold the chunk long enough to exercise a visible pending route, rather
      // than merely checking the final result of a fast local navigation.
      await page.waitForTimeout(650);
      await expect(page.locator('#main-content .page-loading')).toBeVisible();
      release();
      await expect(page.locator('.library-page')).toBeVisible();
      await expect(page.locator('#main-content .page-loading')).toHaveCount(0);
      assert.deepEqual(await page.evaluate(() => window.navigationRetryMessages), []);
      assert.deepEqual(errors, []);
      passed.push(`${width}px: delayed route keeps shell/navigation visible and never flashes Réessayer`);
      console.log('PASS ' + passed.at(-1));
    } finally { release(); await context.close(); }
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/navigation-loading-browser-report.json', JSON.stringify({ passed }, null, 2));
} finally { await browser.close(); }
