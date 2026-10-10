import { chromium, expect } from '@playwright/test';
import { classifyChatFiles } from './ui.helpers.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = join(process.cwd(), 'test-results');
const prefix = 'campuslink-prototype-v1:';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const fixtures = await mkdtemp(join(tmpdir(), 'campuslink-compact-'));
const folder = join(fixtures, 'Compact folder');
await mkdir(join(folder, 'nested'), { recursive: true });
await writeFile(join(folder, 'notes.txt'), 'Original local folder notes.');
await writeFile(join(folder, 'nested', 'slides.pptx'), 'Original local presentation.');
await mkdir(output, { recursive: true });
const passed = [], problems = [];
let activePage;
const ids = { other: 'compact-other', own: 'compact-own' };
const actions = {
  fr: { reply: 'Répondre', remove: 'Supprimer le message', copy: 'Copier le lien', helpful: 'Utile', cancel: 'Annuler la réponse' },
  ar: { reply: 'رد', remove: 'حذف الرسالة', copy: 'نسخ الرابط', helpful: 'مفيد', cancel: 'إلغاء الرد' },
};
const messageMenu = page => page.locator('.community-message-menu:not(.community-attachment-menu)');
const item = (page, id) => page.locator(`[data-message-id="${id}"]`);

async function setup({ width = 390, height = 844, theme = 'dark', language = 'fr' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 760, reducedMotion: 'reduce', locale: 'fr-FR' });
  await context.addInitScript(({ prefix, theme, language, ids }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__compactCopiedLink = value; } } });
    if (localStorage.getItem(prefix + 'compact-ui-ready')) return;
    const set = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
    set('session', { id: 'sara.demo', username: 'sara.demo', name: 'Sara Benali', role: 'student' });
    set('selections', { 'sara.demo': { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 } });
    set('theme', theme); set('language', language);
    const scope = { facultyId: 'flaa', filiereId: 'french_studies', channel: 'general', pinned: false };
    const history = Array.from({ length: 45 }, (_, index) => ({ ...scope, id: `compact-history-${index}`, author: 'Yassine El Amrani', username: 'yassine.demo', content: `Discussion de travail ${index + 1}. Un historique assez long pour vérifier le défilement des échanges.`, date: `2026-10-07T08:${String(index).padStart(2, '0')}:00Z` }));
    set('messages', [...history,
      { ...scope, id: ids.other, author: 'Yassine El Amrani', username: 'yassine.demo', content: 'Message reçu pour les actions.', date: '2026-10-08T23:58:00Z' },
      { ...scope, id: ids.own, author: 'Sara Benali', username: 'sara.demo', content: 'Mon message pour les actions.', date: '2026-10-08T23:59:00Z' },
    ]);
    set('compact-ui-ready', true);
  }, { prefix, theme, language, ids });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => problems.push(`Runtime: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`Console: ${message.text()}`); });
  page.on('request', request => { if (/\/api\/|neon\.tech|r2\.dev/.test(request.url())) problems.push(`Backend: ${request.url()}`); });
  await page.goto(`${baseURL}/app/community?channel=general`);
  await expect(page.locator('.community-chat')).toBeVisible();
  await expect(item(page, ids.own)).toBeVisible();
  return { context, page };
}

async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }
async function capture(page, name) { await page.screenshot({ path: join(output, `compact-${name}.png`), fullPage: false, animations: 'disabled' }); }
async function menuKeyboard(page, target, key = 'Shift+F10') {
  await target.focus(); await target.press(key);
  await expect(messageMenu(page)).toBeVisible();
}
async function touch(page, target, { hold = 0, move = 0 } = {}) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.locator('.community-message-bubble').boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + Math.min(25, box.height / 2), radiusX: 2, radiusY: 2, force: 1, id: 1 };
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  if (move) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x + move }] });
  }
  if (hold) await page.waitForTimeout(hold);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}
async function fit(page, name) {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const rect = selector => { const element = document.querySelector(selector); const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
    const history = document.querySelector('.community-message-history');
    const bottom = document.querySelector('.mobile-bottom-nav');
    return { width: root.clientWidth, height: root.clientHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, scrollY: window.scrollY, header: rect('.community-chat-header'), history: rect('.community-message-history'), composer: rect('.community-composer'), input: rect('.community-composer-input'), bottom: getComputedStyle(bottom).display !== 'none' ? rect('.mobile-bottom-nav') : null, historyScrollable: history.scrollHeight > history.clientHeight };
  });
  assert.ok(geometry.scrollWidth <= geometry.width + 1 && geometry.scrollHeight <= geometry.height + 2 && geometry.scrollY === 0, `${name}: outer overflow ${JSON.stringify(geometry)}`);
  assert.ok(geometry.header.height <= 88, `${name}: discussion heading must stay compact ${JSON.stringify(geometry)}`);
  assert.ok(geometry.input.height <= 64 && geometry.composer.height <= 100, `${name}: single-line composer must stay compact ${JSON.stringify(geometry)}`);
  assert.ok(geometry.history.height >= geometry.height * 0.48 && geometry.historyScrollable, `${name}: discussion must retain useful viewport space ${JSON.stringify(geometry)}`);
  if (geometry.bottom) assert.ok(geometry.composer.bottom <= geometry.bottom.top + 1, `${name}: bottom navigation covers composer ${JSON.stringify(geometry)}`);
  return geometry;
}
async function menuFits(page) {
  const box = await messageMenu(page).boundingBox();
  const viewport = page.viewportSize();
  const bottom = await page.locator('.mobile-bottom-nav').isVisible() ? await page.locator('.mobile-bottom-nav').boundingBox() : null;
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 0 && box.y + box.height <= (bottom?.y || viewport.height) + 1, `Message menu clipped or under bottom navigation ${JSON.stringify(box)}`);
}

try {
  await scenario('Four mobile destinations stay visible and leave secondary pages in the drawer', async () => {
    const { context, page } = await setup({ width: 320, height: 600 });
    const nav = page.locator('.mobile-bottom-nav');
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveCount(4);
    assert.deepEqual(await nav.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/app', '/app/community', '/app/library', '/app/announcements']);
    for (const path of ['/app', '/app/library', '/app/announcements', '/app/community']) {
      await nav.locator(`a[href="${path}"]`).click();
      await expect(page).toHaveURL(url => url.pathname === path);
      await expect(nav.locator(`a[href="${path}"]`)).toHaveAttribute('aria-current', 'page');
      const box = await nav.boundingBox();
      assert.ok(box.height <= 68 && box.y + box.height <= 601 && box.x >= 0 && box.width <= 320, 'Quick navigation must fit at the foot of the phone');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `Navigation overflow on ${path}`);
    }
    await page.locator('.mobile-menu-button').click();
    await expect(page.locator('.sidebar')).toHaveClass(/\bopen\b/);
    for (const path of ['/app', '/app/community', '/app/library', '/app/announcements']) await expect(page.locator(`.sidebar .nav-item[href="${path}"]`)).not.toBeVisible();
    for (const path of ['/app/notifications', '/app/saved', '/app/profile']) await expect(page.locator(`.sidebar .nav-item[href="${path}"]`)).toBeVisible();
    await page.locator('.sidebar-mobile-close').click();
    await capture(page, 'bottom-navigation-320-dark-fr');
    await context.close();
  });

  await scenario('One attachment trigger offers actual file and recursive folder selection', async () => {
    const { context, page } = await setup({ width: 320, height: 600, theme: 'light' });
    await expect(page.locator('.community-composer-attach')).toHaveCount(1);
    await expect(page.locator('.community-composer-folder')).toHaveCount(0);
    const trigger = page.locator('.community-composer-attach');
    await trigger.click();
    const picker = page.locator('.community-attachment-menu');
    await expect(picker.getByRole('menuitem')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click();
    const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), picker.getByRole('menuitem', { name: /^Fichiers/ }).click()]);
    assert.equal(await fileChooser.element().getAttribute('webkitdirectory'), null);
    await fileChooser.setFiles({ name: 'Compact notes.txt', mimeType: 'text/plain', buffer: Buffer.from('These are the actual selected notes.') });
    await classifyChatFiles(page, 'Notes compactes');
    await expect(page.locator('.community-composer-attachment')).toHaveCount(1);
    await trigger.click();
    const [folderChooser] = await Promise.all([page.waitForEvent('filechooser'), picker.getByRole('menuitem', { name: /^Dossier/ }).click()]);
    assert.notEqual(await folderChooser.element().getAttribute('webkitdirectory'), null);
    await folderChooser.setFiles(folder);
    await classifyChatFiles(page, 'Dossier compact');
    await expect(page.locator('.community-composer-attachment')).toHaveCount(3);
    await expect(page.locator('.community-composer-attachment').filter({ hasText: 'nested' })).toHaveCount(1);
    await expect(picker).toHaveCount(0);
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    const sent = page.locator('.community-message').filter({ has: page.locator('.community-attachment-file', { hasText: 'Compact notes.txt' }) });
    await expect(sent.locator('.community-attachment-file')).toHaveCount(3);
    await sent.locator('.community-attachment-file').filter({ hasText: 'Compact notes.txt' }).click();
    await expect(page.getByRole('dialog')).toContainText('These are the actual selected notes.');
    await page.keyboard.press('Escape');
    await fit(page, 'Unified mobile picker after sending');
    await capture(page, 'unified-picker-320-light-fr');
    await context.close();
  });

  await scenario('Touch tap and scrolling do not open actions; a held message opens visible actions', async () => {
    const { context, page } = await setup({ width: 320, height: 600 });
    const received = item(page, ids.other);
    await expect(page.locator('.community-message-menu-trigger,.community-message-toolbar')).toHaveCount(0);
    await touch(page, received);
    await expect(messageMenu(page)).toHaveCount(0);
    await touch(page, received, { hold: 650, move: 20 });
    await expect(messageMenu(page)).toHaveCount(0);
    await touch(page, received, { hold: 650 });
    await expect(messageMenu(page)).toBeVisible(); await menuFits(page);
    await expect(messageMenu(page).getByRole('menuitem', { name: actions.fr.remove, exact: true })).toHaveCount(0);
    await messageMenu(page).getByRole('menuitem', { name: actions.fr.reply, exact: true }).click();
    await expect(messageMenu(page)).toHaveCount(0);
    await expect(page.locator('.community-composer-reply')).toContainText('Message reçu pour les actions.');
    await page.getByRole('button', { name: actions.fr.cancel, exact: true }).click();
    await touch(page, item(page, ids.own), { hold: 650 });
    await expect(messageMenu(page).getByRole('menuitem', { name: actions.fr.remove, exact: true })).toBeVisible();
    await messageMenu(page).getByRole('menuitem', { name: actions.fr.copy, exact: true }).click();
    await expect(messageMenu(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__compactCopiedLink)).toContain(`message=${ids.own}`);
    await context.close();
  });

  await scenario('Outside taps, another message, scrolling and navigation fully dismiss actions', async () => {
    const { context, page } = await setup({ width: 320, height: 600 });
    const own = item(page, ids.own);
    const assertClosed = async () => { await expect(messageMenu(page)).toHaveCount(0); await expect(page.locator('.community-message.has-open-menu')).toHaveCount(0); };
    await touch(page, own, { hold: 650 });
    await page.locator('.community-composer textarea').tap();
    await assertClosed();
    await touch(page, own, { hold: 650 });
    await item(page, ids.other).locator('.community-message-avatar').tap();
    await assertClosed();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await touch(page, own, { hold: 650 });
    await page.locator('.community-message-history').evaluate(node => { node.scrollTop = 0; });
    await assertClosed();
    await own.scrollIntoViewIfNeeded();
    await touch(page, own, { hold: 650 });
    await page.locator('.mobile-bottom-nav a[href="/app/library"]').tap();
    await expect(page).toHaveURL(/\/app\/library$/); await assertClosed();
    await page.locator('.mobile-bottom-nav a[href="/app/community"]').tap();
    await page.getByRole('button', { name: 'Chat général', exact: true }).click();
    await assertClosed();
    await context.close();
  });

  await scenario('Desktop right click and keyboard expose actions with complete dismissal', async () => {
    const { context, page } = await setup({ width: 1440, height: 900 });
    await expect(page.locator('.mobile-bottom-nav')).not.toBeVisible();
    await fit(page, 'Desktop compact chat');
    const own = item(page, ids.own);
    await own.locator('.community-message-bubble').click({ button: 'right' });
    await expect(messageMenu(page)).toBeVisible(); await menuFits(page);
    await page.keyboard.press('Escape');
    await expect(messageMenu(page)).toHaveCount(0); await expect(own).toBeFocused();
    await menuKeyboard(page, own, 'Enter');
    await page.keyboard.press('End');
    await expect(messageMenu(page).getByRole('menuitem', { name: actions.fr.remove, exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await menuKeyboard(page, item(page, ids.other));
    await messageMenu(page).getByRole('menuitemcheckbox', { name: actions.fr.helpful, exact: true }).click();
    await expect(messageMenu(page)).toHaveCount(0);
    await expect(item(page, ids.other).locator('.community-reaction.is-active')).toHaveCount(1);
    await menuKeyboard(page, own);
    await item(page, ids.other).focus();
    await expect(messageMenu(page)).toHaveCount(0);
    await item(page, ids.other).press('Shift+F10');
    await expect(messageMenu(page)).toHaveCount(1);
    await expect(item(page, ids.other)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await capture(page, 'desktop-compact-dark-fr');
    await context.close();
  });

  for (const theme of ['dark', 'light']) await scenario(`320×600 Arabic ${theme}: compact discussion, composer and visible menus`, async () => {
    const { context, page } = await setup({ width: 320, height: 600, language: 'ar', theme });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await fit(page, `Small RTL ${theme}`);
    await touch(page, item(page, ids.own), { hold: 650 });
    await expect(messageMenu(page)).toBeVisible(); await menuFits(page);
    await expect(messageMenu(page).getByRole('menuitem', { name: actions.ar.remove, exact: true })).toBeVisible();
    await capture(page, `held-message-320-${theme}-ar`);
    await page.keyboard.press('Escape');
    await expect(messageMenu(page)).toHaveCount(0);
    await page.locator('.mobile-bottom-nav a[href="/app/library"]').tap();
    const card = page.locator('.document-card').first();
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    assert.ok(cardBox.height <= 250, `Small phone resource card takes excessive space: ${cardBox.height}`);
    const metadata = await card.innerText();
    assert.match(metadata, /S1/); assert.match(metadata, /PDF/); assert.match(metadata, /\.pdf/);
    await expect(card.locator('.document-author bdi')).toHaveText('Équipe pédagogique');
    const pageBounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(pageBounds.scrollWidth <= pageBounds.width + 1, `Small RTL library horizontal overflow ${JSON.stringify(pageBounds)}`);
    await card.locator('.document-main').click();
    await expect(page.locator('.preview-modal')).toBeVisible();
    await expect(page.locator('.preview-modal')).toContainText('S1');
    await page.keyboard.press('Escape');
    await capture(page, `cards-320-${theme}-ar`);
    await context.close();
  });

  assert.deepEqual(problems, [], 'Compact UI runtime, console and backend isolation');
  await writeFile(join(output, 'compact-ui-report.json'), JSON.stringify({ passed, problems, baseURL }, null, 2));
  console.log(`\n${passed.length} compact UI scenarios passed. Artifacts: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await capture(activePage, 'failure').catch(() => {});
  await writeFile(join(output, 'compact-ui-report.json'), JSON.stringify({ passed, problems, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally {
  await browser.close(); await rm(fixtures, { recursive: true, force: true });
}
