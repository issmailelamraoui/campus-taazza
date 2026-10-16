import assert from 'node:assert/strict';
import { chromium, firefox, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { moduleSharingEnvironment } from './module-sharing.helpers.mjs';

assert.ok(process.env.CAMPUS_TEST_DATABASE_URL, 'Use a dedicated CAMPUS_TEST_DATABASE_URL for the isolated API fixture.');
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserName = process.env.CAMPUSLINK_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(browserName));
const env = await moduleSharingEnvironment({ appOrigin: baseURL });
const longModule = 'ADMINISTRATION DES BASES DE DONNEES';
for (const module of [longModule, 'XML', 'الاحتمالات والإحصاء']) await env.addResource({ module, semester: 5 });
const browser = await ({ chromium, firefox })[browserName].launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const passed = [], errors = [];
const directory = `test-results/library-module-responsive/${browserName}`;
await mkdir(directory, { recursive: true });

async function contextFor({ width, language, theme }) {
  await env.db.prepare('UPDATE users SET language=? WHERE id=?').run(language, env.users['share.sender'].id);
  const context = await browser.newContext({ viewport: { width, height: width < 900 ? 844 : 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ language, theme }) => {
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = undefined;
  }, { language, theme });
  const [name, value] = env.cookies['share.sender'].split('=');
  await context.addCookies([{ name, value, url: baseURL }]);
  await context.route('**/api/**', async route => {
    const source = new URL(route.request().url());
    const response = await route.fetch({ url: env.origin + source.pathname + source.search });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}

async function readableTitle(title, action, label, minimumWidth = 90) {
  const geometry = await title.evaluate((node, selector) => {
    const root = node.closest('.library-module-tile, .library-results-header');
    const control = root.querySelector(selector);
    const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const owner = node.closest('.library-module-folder, .library-results-title, .module-choice');
    const glyphs = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      for (let offset = 0; offset < text.length; offset++) {
        if (!text.textContent[offset].trim()) continue;
        const range = document.createRange();
        range.setStart(text, offset); range.setEnd(text, offset + 1);
        const rectangle = range.getBoundingClientRect();
        const hit = document.elementFromPoint(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
        glyphs.push({ ...box({ getBoundingClientRect: () => rectangle }), covered: hit !== node && !node.contains(hit) });
      }
    }
    return { title: box(node), owner: box(owner), action: box(control), glyphs, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  }, action);
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${label}: no page overflow`);
  assert.ok(geometry.title.width >= minimumWidth, `${label}: title keeps useful reading width: ${JSON.stringify(geometry)}`);
  const overlap = Math.min(geometry.title.right, geometry.action.right) - Math.max(geometry.title.left, geometry.action.left) > 1
    && Math.min(geometry.title.bottom, geometry.action.bottom) - Math.max(geometry.title.top, geometry.action.top) > 1;
  assert.equal(overlap, false, `${label}: sharing never overlaps the title`);
  for (const glyph of geometry.glyphs) {
    assert.ok(glyph.left >= geometry.owner.left - 1 && glyph.right <= geometry.owner.right + 1, `${label}: every character fits its own button`);
    assert.equal(glyph.covered, false, `${label}: every character remains visible and unobstructed`);
  }
  assert.ok(geometry.action.width >= 40 && geometry.action.height >= 40, `${label}: usable share control`);
  return geometry;
}

try {
  for (const settings of [
    { width: 320, language: 'fr', theme: 'dark' },
    { width: 320, language: 'ar', theme: 'light' },
    { width: 390, language: 'fr', theme: 'light' },
    { width: 390, language: 'ar', theme: 'dark' },
    { width: 1440, language: 'fr', theme: 'dark' },
    { width: 1440, language: 'ar', theme: 'light' },
  ]) {
    const label = `${settings.width}-${settings.language}-${settings.theme}`;
    const { page, context } = await contextFor(settings);
    try {
      await page.goto(baseURL + '/app/library?semester=5');
      await expect(page.locator('html')).toHaveAttribute('dir', settings.language === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('.library-module-folder')).toHaveCount(3);
      await page.locator('.library-module-trigger').click();
      await expect(page.locator('.library-module-picker .library-module-tile')).toHaveCount(3);
      for (const module of [longModule, 'XML', 'الاحتمالات والإحصاء']) {
        const choice = page.locator('.library-module-picker .module-choice > span[dir="auto"]').filter({ hasText: new RegExp(`^${module}$`) });
        await choice.scrollIntoViewIfNeeded();
        await readableTitle(choice, '.library-module-share', `${label}: module picker ${module}`, 50);
      }
      await page.locator('.library-module-trigger').click();
      for (const module of [longModule, 'XML', 'الاحتمالات والإحصاء']) {
        const title = page.locator('.library-module-name').filter({ hasText: new RegExp(`^${module}$`) });
        await title.scrollIntoViewIfNeeded();
        await expect(title).toBeVisible();
        await readableTitle(title, '.library-module-share', `${label}: ${module}`);
      }
      await page.locator('.library-module-name').filter({ hasText: /^XML$/ }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${directory}/${label}-folders.png` });

      const longTitle = page.locator('.library-module-name').filter({ hasText: longModule });
      await longTitle.locator('xpath=ancestor::button').click();
      const selectedTitle = page.locator('.library-results-heading.is-module h2');
      await expect(selectedTitle).toHaveText(longModule);
      await selectedTitle.scrollIntoViewIfNeeded();
      const selected = await readableTitle(selectedTitle, '.library-share-current-module', `${label}: selected module`, settings.width < 900 ? 190 : 250);
      if (settings.width < 900) assert.ok(selected.action.top >= selected.title.bottom, `${label}: share action sits below the full-width title`);
      await page.screenshot({ path: `${directory}/${label}-module.png` });
      await page.locator('.library-share-current-module').click();
      await expect(page.locator('.module-share-dialog')).toBeVisible();
      await expect(page.locator('.module-share-dialog .community-module-copy strong')).toHaveText(longModule);
      passed.push(`${label}: three complete module names, separate share controls, full-width selected heading, working share dialog`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/results.json`, JSON.stringify({ passed, errors }, null, 2));
  console.log(JSON.stringify({ browser: browserName, passed }, null, 2));
} finally { await browser.close(); await env.close(); }
