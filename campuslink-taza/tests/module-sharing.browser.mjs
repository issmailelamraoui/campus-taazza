import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { moduleSharingEnvironment } from './module-sharing.helpers.mjs';

assert.ok(process.env.CAMPUS_TEST_DATABASE_URL, 'Use a dedicated CAMPUS_TEST_DATABASE_URL for the isolated API fixture.');
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const env = await moduleSharingEnvironment({ appOrigin: baseURL });
const resource = await env.addResource(), second = await env.addResource({ module: 'Analyse et algèbre' });
await env.addResource({ module: 'Probabilités et Statistiques', semester: 4 });
await env.db.prepare("UPDATE channels SET read_only=1 WHERE faculty_id='fsa' AND id='important'").run();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [], errors = [], contrasts = [];
await mkdir('test-results/module-sharing', { recursive: true });

async function contextFor({ width = 1440, height = 900, theme = 'dark', language = 'fr', user = 'share.sender' } = {}) {
  await env.db.prepare('UPDATE users SET language=? WHERE id=?').run(language, env.users[user].id);
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ theme, language }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = undefined;
  }, { theme, language });
  const [name, value] = env.cookies[user].split('=');
  await context.addCookies([{ name, value, url: baseURL }]);
  await context.route('**/api/**', async route => {
    const source = new URL(route.request().url());
    const response = await route.fetch({ url: env.origin + source.pathname + source.search });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  return { page, context };
}
async function library(page) {
  await page.goto(baseURL + '/app/library?semester=1');
  await expect(page.locator('.library-module-folder')).toHaveCount(2);
}
const shareButton = page => page.locator('.library-module-tile').filter({ has: page.locator('.library-module-name', { hasText: /^Probabilités et Statistiques$/i }) }).locator('.library-module-share');
const reference = page => page.locator('.community-composer-module');
async function destination(page, index = 0) {
  await expect(page.locator('.module-share-dialog')).toBeVisible();
  await expect(page.locator('.module-share-destinations > button')).toHaveCount(5);
  await expect(page.locator('.module-share-destinations > button').nth(1)).toBeDisabled();
  await page.locator('.module-share-destinations > button').nth(index).click();
  await expect(page.locator('.community-page')).toBeVisible();
  await expect(reference(page)).toBeVisible();
  await expect(reference(page)).toContainText(resource.module);
}
async function fits(page, name) {
  const geometry = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.module-share-dialog button, .community-composer-module button, .community-composer textarea, .community-composer button')]
      .filter(node => node.getBoundingClientRect().width > 0).map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, controls };
  });
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${name}: horizontal page overflow ${JSON.stringify(geometry)}`);
  assert.ok(geometry.controls.every(item => item.left >= -1 && item.right <= geometry.width + 1), `${name}: control overflow`);
}
async function send(page, text) {
  await page.locator('.community-composer textarea').fill(text);
  await page.locator('.community-composer button[type="submit"]').click();
  const message = page.locator('.community-message').filter({ has: page.locator('.community-message-content', { hasText: text }) });
  await expect(message.locator('a.community-shared-module')).toBeVisible();
  await expect(message.locator('.community-delivery-status')).toHaveCount(0);
  return message;
}

async function readableReference(reference, name) {
  const measurements = await reference.evaluate(root => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const blend = (foreground, background) => foreground.slice(0, 3).map((channel, index) => channel * foreground[3] / 255 + background[index] * (1 - foreground[3] / 255));
    const luminance = rgb => rgb.map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    return [...root.querySelectorAll('.community-module-copy small, .community-module-copy strong, .community-module-copy > span')].map(node => {
      const ancestors = [];
      for (let parent = node; parent; parent = parent.parentElement) ancestors.unshift(parent);
      let background = [255, 255, 255];
      for (const parent of ancestors) background = blend(rgba(getComputedStyle(parent).backgroundColor), background);
      const color = getComputedStyle(node).color, foreground = blend(rgba(color), background);
      const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return { text: node.textContent, color, background: background.map(Math.round), ratio: (levels[0] + .05) / (levels[1] + .05) };
    });
  });
  for (const measurement of measurements) assert.ok(measurement.ratio >= 4.5, `${name}: readable module text contrast ${JSON.stringify(measurement)}`);
  contrasts.push({ name, measurements });
}

try {
  for (const settings of [
    { width: 1440, height: 900, theme: 'dark', language: 'fr' },
    { width: 390, height: 844, theme: 'light', language: 'fr' },
    { width: 320, height: 568, theme: 'dark', language: 'ar' },
  ]) {
    const name = `${settings.width}-${settings.theme}-${settings.language}`, { page, context } = await contextFor(settings);
    try {
      await library(page);
      await shareButton(page).click();
      await fits(page, name + '-destinations');
      await destination(page);
      await page.locator('.community-composer textarea').fill('Keep my draft');
      await reference(page).locator('button').click();
      await expect(reference(page)).toHaveCount(0);
      await expect(page.locator('.community-composer textarea')).toHaveValue('Keep my draft');

      await library(page);
      if (settings.width < 900) {
        const tile = shareButton(page).locator('..');
        const box = await tile.boundingBox();
        const pointer = { pointerType: 'touch', pointerId: 7, clientX: box.x + 30, clientY: box.y + 30 };
        await tile.dispatchEvent('pointerdown', pointer);
        await tile.dispatchEvent('pointermove', { ...pointer, clientY: pointer.clientY + 30 });
        await page.waitForTimeout(600);
        await expect(page.locator('.module-share-dialog')).toHaveCount(0);
        await tile.dispatchEvent('pointerup', pointer);
        await tile.dispatchEvent('pointerdown', pointer);
        await expect(page.locator('.module-share-dialog')).toBeVisible();
        await tile.dispatchEvent('pointerup', pointer);
        await tile.locator('.library-module-folder').dispatchEvent('click');
        assert.ok(page.url().includes('/app/library'), 'The release click after a long press must not open the module.');
      } else await shareButton(page).click();
      await destination(page, settings.width === 320 ? 3 : 0);
      await fits(page, name + '-composer');
      await readableReference(reference(page), name + '-composer');
      await page.screenshot({ path: `test-results/module-sharing/${name}-composer.png` });
      const text = `Module partagé — ${name}`;
      const message = await send(page, text);
      await readableReference(message.locator('a.community-shared-module'), name + '-sent');
      await page.screenshot({ path: `test-results/module-sharing/${name}-sent.png` });
      await expect(message.locator('a.community-shared-module')).toHaveAttribute('href', /semester=1&module=Probabilit/);
      const id = await message.getAttribute('id');
      await page.reload();
      const persisted = page.locator(`[id="${id}"]`);
      await expect(persisted.locator('.community-message-content')).toContainText(text);
      await persisted.locator('a.community-shared-module').click();
      await expect(page).toHaveURL(/\/app\/library\?semester=1&module=/);
      await expect(page.locator('.library-results-heading.is-module h2')).toContainText(/PROBABILITÉS ET STATISTIQUES/i);
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.library-share-current-module')).toBeVisible();
      passed.push(`${name}: choose/remove/long-press/send/persist/link exact semester`);
    } finally { await context.close(); }
  }
  const { page, context } = await contextFor({ width: 390, user: 'share.program' });
  try {
    await page.goto(baseURL + '/app/community?channel=general');
    await expect(page.locator('.community-shared-module.is-unavailable').first()).toBeVisible();
    assert.equal(await page.locator('a.community-shared-module').count(), 0, 'Sharing never gives another program a link into its unrelated module list.');
    await fits(page, 'other-program-reference');
    passed.push('Other-program general-chat readers see a safe unavailable module reference');
  } finally { await context.close(); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed }, null, 2));
  await writeFile('test-results/module-sharing/results.json', JSON.stringify({ passed, errors, contrasts }, null, 2));
} finally { await browser.close(); await env.close(); }
