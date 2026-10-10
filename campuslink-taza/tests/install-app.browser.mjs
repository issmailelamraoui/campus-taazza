import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const seenKey = 'campuslink-prototype-v1:install-prompt-seen-v1';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
mkdirSync('test-results', { recursive: true });

const user = { id: 202, username: 'install-fixture', name: 'Install Fixture', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
const bootstrap = { user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: [], announcements: [], messages: [], notifications: [], events: [], saved: [], history: [], channels: [{ id: 'general', read_only: false }], members: [] };

async function setup({ width = 390, height = 844, theme = 'dark', seen = false, standalone = false, ios = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, ...(ios ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : {}) });
  const errors = [], mutations = [];
  await context.addInitScript(({ theme, seen, standalone, ios, seenKey }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    if (seen && !localStorage.getItem(seenKey)) localStorage.setItem(seenKey, 'true');
    if (standalone) {
      const original = window.matchMedia.bind(window);
      window.matchMedia = query => query.includes('display-mode: standalone') || query.includes('display-mode:standalone')
        ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true; } }
        : original(query);
    }
    if (ios) {
      Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'iPhone' });
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => standalone });
    }
  }, { theme, seen, standalone, ios, seenKey });
  // Every API call stays local; these flows never create or update real data.
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${path}`);
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: bootstrap });
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors, mutations, width, theme };
}

const installModal = page => page.getByRole('dialog', { name: 'Installer CampusLink', exact: true });

async function finish(fixture) {
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.mutations, [], 'Installing or choosing instructions must never mutate server data.');
  await fixture.context.close();
}

async function fakePrompt(page, outcome) {
  await page.evaluate(outcome => {
    window.__installPrompts = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { window.__installPrompts++; };
    event.userChoice = Promise.resolve({ outcome, platform: 'web' });
    window.dispatchEvent(event);
    window.__installPromptPrevented = event.defaultPrevented;
  }, outcome);
}

try {
  for (const config of [{ width: 320, height: 600, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
    const fixture = await setup(config), { page } = fixture;
    try {
      await page.goto(`${baseURL}/`);
      const modal = installModal(page);
      await expect(modal).toBeVisible();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), seenKey), 'true');
      const bounds = await modal.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= config.width + 1, 'Install dialog must fit narrow phones.');
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= config.height + 1, 'Install dialog must remain within the phone viewport.');
      await page.screenshot({ path: `test-results/install-first-${config.width}-${config.theme}.png` });
      await modal.getByRole('button', { name: 'Plus tard', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await page.reload();
      await page.waitForTimeout(1100);
      await expect(installModal(page)).toHaveCount(0);
      await page.goto(`${baseURL}/app/profile`);
      await expect(page.locator('.install-settings-card')).toBeVisible();
      await page.waitForTimeout(900);
      await expect(installModal(page)).toHaveCount(0);
      await page.locator('.install-settings-card').getByRole('button', { name: 'Installer l’application', exact: true }).click();
      await expect(installModal(page)).toBeVisible();
      await installModal(page).getByRole('button', { name: 'Comment installer', exact: true }).click();
      await expect(page.locator('.install-instructions')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(installModal(page)).toHaveCount(0);
      const name = page.getByLabel('Nom affiché', { exact: true });
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).userSelect), 'none');
      assert.equal(await name.evaluate(node => getComputedStyle(node).userSelect), 'text');
      await name.fill('Text selection remains editable');
      await name.evaluate(node => { node.focus(); node.setSelectionRange(5, 14); });
      assert.deepEqual(await name.evaluate(node => [node.selectionStart, node.selectionEnd]), [5, 14]);
      assert.equal(await page.getByLabel('À propos', { exact: true }).evaluate(node => getComputedStyle(node).userSelect), 'text');
      await page.locator('.settings-card').first().getByRole('combobox', { name: 'Langue', exact: true }).click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      // Use a real held touch on non-editable text; CSS must suppress browser selection.
      const heading = page.getByRole('heading', { name: 'Profil', exact: true });
      await heading.scrollIntoViewIfNeeded();
      const target = await heading.boundingBox(), client = await fixture.context.newCDPSession(page);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2 }] });
      await page.waitForTimeout(650);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(await page.evaluate(() => window.getSelection()?.toString() || ''), '');
      await client.detach();
      console.log(`PASS first visit only, Profile fallback, usable selects and editable text (${config.width}px ${config.theme})`);
    } finally { await finish(fixture); }
  }

  {
    const fixture = await setup({ seen: true }), { page } = fixture;
    try {
      await page.goto(`${baseURL}/app/profile`);
      await expect(page.locator('.install-settings-card')).toBeVisible();
      await fakePrompt(page, 'accepted');
      assert.equal(await page.evaluate(() => window.__installPromptPrevented), true);
      await page.locator('.install-settings-card').getByRole('button', { name: 'Installer l’application', exact: true }).click();
      await installModal(page).getByRole('button', { name: 'Installer maintenant', exact: true }).click();
      await expect(installModal(page)).toHaveCount(0);
      assert.equal(await page.evaluate(() => window.__installPrompts), 1);
      await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
      await expect(page.locator('.install-settings-card').getByRole('button', { name: 'Application installée', exact: true })).toBeDisabled();
      console.log('PASS native prompt is triggered only by a click and installed state reaches Profile');
    } finally { await finish(fixture); }
  }

  {
    const fixture = await setup({ seen: true }), { page } = fixture;
    try {
      await page.goto(`${baseURL}/app/profile`);
      await expect(page.locator('.install-settings-card')).toBeVisible();
      await fakePrompt(page, 'dismissed');
      await page.locator('.install-settings-card').getByRole('button', { name: 'Installer l’application', exact: true }).click();
      await installModal(page).getByRole('button', { name: 'Installer maintenant', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__installPrompts), 1);
      await expect(page.locator('.install-instructions')).toBeVisible();
      await expect(installModal(page).getByRole('button', { name: 'Installer maintenant', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.reload();
      await expect(page.locator('.install-settings-card')).toBeVisible();
      await page.waitForTimeout(1100);
      await expect(installModal(page)).toHaveCount(0);
      console.log('PASS dismissing browser installation consumes the prompt and does not repeat the welcome');
    } finally { await finish(fixture); }
  }

  {
    const fixture = await setup({ standalone: true }), { page } = fixture;
    try {
      await page.goto(`${baseURL}/app/profile`);
      await expect(page.locator('.install-settings-card').getByRole('button', { name: 'Application installée', exact: true })).toBeDisabled();
      await page.waitForTimeout(1100);
      await expect(installModal(page)).toHaveCount(0);
      console.log('PASS standalone application suppresses the first-visit installation popup');
    } finally { await finish(fixture); }
  }

  {
    const fixture = await setup({ ios: true, theme: 'light' }), { page } = fixture;
    try {
      await page.goto(`${baseURL}/`);
      await expect(installModal(page)).toBeVisible();
      await installModal(page).getByRole('button', { name: 'Comment installer', exact: true }).click();
      await expect(page.locator('.install-instructions')).toBeVisible();
      await expect(page.locator('.install-instructions')).toContainText(/Partager|Safari/);
      await expect(page.locator('.install-instructions')).toContainText(/écran d’accueil|écran d'accueil/);
      await page.screenshot({ path: 'test-results/install-ios-light.png' });
      console.log('PASS iOS manual installation instructions');
    } finally { await finish(fixture); }
  }
} finally {
  await browser.close();
}
