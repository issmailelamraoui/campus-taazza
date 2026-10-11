import { chromium, expect } from '@playwright/test';
import { classifyChatFiles } from './ui.helpers.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = join(process.cwd(), 'test-results');
const prefix = 'campuslink-prototype-v1:';
const installedChromium = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const chromiumPath = process.env.CAMPUSLINK_CHROMIUM || (existsSync(installedChromium) ? installedChromium : undefined);
const labels = {
  fr: { message: 'Votre message', send: 'Envoyer le message', reply: 'Répondre', actions: 'Actions du message', attach: 'Joindre un document', copy: 'Copier le lien', remove: 'Supprimer le message', cancelReply: 'Annuler la réponse' },
  en: { message: 'Your message', send: 'Send message', reply: 'Reply', actions: 'Message actions', attach: 'Attach a document', copy: 'Copy link', remove: 'Delete message', cancelReply: 'Cancel reply' },
  ar: { message: 'رسالتكم', send: 'إرسال الرسالة', reply: 'رد', actions: 'إجراءات الرسالة', attach: 'إرفاق مستند', copy: 'نسخ الرابط', remove: 'حذف الرسالة', cancelReply: 'إلغاء الرد' },
};
const fixtureIds = { other: 'reference-other', own: 'reference-own-1', grouped: 'reference-own-2', reply: 'reference-own-reply' };
const fixtureText = { other: 'Un échange entre étudiants.', own: 'Première petite bulle.', grouped: 'Deuxième petite bulle.', reply: 'Une réponse dans la bulle.' };
const problems = [];
const passed = [];
let activePage;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function scenario(name, run) {
  await run();
  passed.push(name);
  console.log(`PASS ${name}`);
}

async function capture(page, name) {
  await page.screenshot({ path: join(output, `community-reference-${name}.png`), fullPage: false, animations: 'disabled' });
}

// Explicit local demo fixtures make alignment, grouping and ownership checks
// deterministic. The init marker preserves mutations when a scenario reloads.
async function setup({ role = 'student', language = 'fr', theme = 'dark', width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', locale: 'fr-FR' });
  await context.addInitScript(({ prefix, role, language, theme, fixtureIds, fixtureText }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedMessageLink = value; } } });
    if (localStorage.getItem(prefix + 'community-reference-test-ready')) return;
    const username = role === 'admin' ? 'admin.demo' : 'sara.demo';
    const set = (name, value) => localStorage.setItem(prefix + name, JSON.stringify(value));
    set('session', { id: username, username, name: role === 'admin' ? 'Issmail' : 'Sara Benali', role, bio: '' });
    set('selections', { 'sara.demo': { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 } });
    set('language', language);
    set('theme', theme);
    const scope = { facultyId: 'flaa', filiereId: 'french_studies', channel: 'general', pinned: false };
    const own = { author: role === 'admin' ? 'Issmail' : 'Sara Benali', username };
    const other = { author: 'Yassine El Amrani', username: 'yassine.demo' };
    const history = Array.from({ length: 55 }, (_, index) => ({ ...scope, ...other, id: `reference-history-${index}`, content: `Échange de révision ${index + 1}. Nous partageons des questions et des méthodes pour préparer nos séances de travail.`, date: `2026-10-08T08:${String(index).padStart(2, '0')}:00+01:00` }));
    set('messages', [...history,
      { ...scope, ...other, id: fixtureIds.other, content: fixtureText.other, date: '2026-10-08T09:00:00+01:00' },
      { ...scope, ...own, id: fixtureIds.own, content: fixtureText.own, date: '2026-10-08T09:02:00+01:00' },
      { ...scope, ...own, id: fixtureIds.grouped, content: fixtureText.grouped, date: '2026-10-08T09:03:00+01:00' },
      { ...scope, ...own, id: fixtureIds.reply, content: fixtureText.reply, replyTo: fixtureIds.other, date: '2026-10-08T09:04:00+01:00' },
    ]);
    set('community-reference-test-ready', true);
  }, { prefix, role, language, theme, fixtureIds, fixtureText });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => problems.push(`Page error: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`Console error: ${message.text()}`); });
  page.on('request', request => { if (/\/api\//.test(request.url()) || /neon\.tech|r2\.dev/.test(request.url())) problems.push(`Backend request: ${request.url()}`); });
  await page.goto(`${baseURL}/app/community?channel=general`);
  await expect(page.locator('.community-chat')).toBeVisible();
  await expect(page.locator(`#${fixtureIds.reply}`)).toBeVisible();
  return { context, page };
}

function message(page, id) {
  return page.locator(`[data-message-id="${id}"]`);
}

async function menu(page, item, language = 'fr') {
  await item.focus();
  await item.press('Shift+F10');
  await expect(page.getByRole('menu', { name: labels[language].actions, exact: true })).toBeVisible();
}

async function longPress(page, item) {
  await item.scrollIntoViewIfNeeded();
  const bounds = await item.locator('.community-message-bubble').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(bounds.height / 2, 25));
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

async function send(page, text, language = 'fr') {
  await page.getByLabel(labels[language].message, { exact: true }).fill(text);
  await page.getByRole('button', { name: labels[language].send, exact: true }).click();
  const item = page.locator('.community-message').filter({ has: page.locator('.community-message-content', { hasText: text }) });
  await expect(item).toHaveCount(1);
  await expect(item).toBeVisible();
  return item;
}

async function viewportFits(page, name) {
  const bounds = await page.evaluate(() => {
    const root = document.documentElement;
    const history = document.querySelector('.community-message-history');
    const composer = document.querySelector('.community-composer');
    const rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    return { width: root.clientWidth, height: root.clientHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, scrollY: window.scrollY, history: rect(history), composer: rect(composer), historyScrollable: history.scrollHeight > history.clientHeight, overflow: getComputedStyle(history).overflowY };
  });
  assert.ok(bounds.scrollWidth <= bounds.width + 1, `${name}: horizontal page overflow ${JSON.stringify(bounds)}`);
  assert.ok(bounds.scrollHeight <= bounds.height + 2, `${name}: outer page scroll ${JSON.stringify(bounds)}`);
  assert.equal(bounds.scrollY, 0, `${name}: outer page moved`);
  assert.ok(bounds.composer.top >= 0 && bounds.composer.bottom <= bounds.height + 1, `${name}: composer outside viewport`);
  assert.ok(bounds.composer.left >= -1 && bounds.composer.right <= bounds.width + 1, `${name}: composer clipped horizontally`);
  assert.ok(bounds.history.height >= 100, `${name}: history has no usable space`);
  assert.ok(bounds.historyScrollable && ['auto', 'scroll'].includes(bounds.overflow), `${name}: long history must scroll internally`);
  return bounds;
}

async function alignment(page, name) {
  await expect(message(page, fixtureIds.own)).toHaveClass(/is-own/);
  await expect(message(page, fixtureIds.other)).not.toHaveClass(/is-own/);
  await expect(message(page, fixtureIds.grouped)).toHaveClass(/is-grouped/);
  await expect(message(page, fixtureIds.grouped).locator('.community-message-meta')).toHaveCount(0);
  await expect(message(page, fixtureIds.grouped).locator('.avatar')).toHaveCount(0);
  const shape = await page.evaluate(({ fixtureIds }) => {
    const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    const bubble = id => document.getElementById(id).querySelector('.community-message-bubble');
    const own = bubble(fixtureIds.own);
    const grouped = bubble(fixtureIds.grouped);
    const incoming = bubble(fixtureIds.other);
    const reply = bubble(fixtureIds.reply);
    const reference = reply.querySelector('.community-reply-reference');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const draw = canvas.getContext('2d');
    draw.fillStyle = getComputedStyle(own).backgroundColor;
    draw.fillRect(0, 0, 1, 1);
    return { history: rect(document.querySelector('.community-message-history')), own: rect(own), grouped: rect(grouped), incoming: rect(incoming), reply: rect(reply), reference: reference ? rect(reference) : null, radius: parseFloat(getComputedStyle(own).borderTopLeftRadius), color: [...draw.getImageData(0, 0, 1, 1).data] };
  }, { fixtureIds });
  const midpoint = (shape.history.left + shape.history.right) / 2;
  assert.ok(shape.own.right > midpoint + 15, `${name}: own bubbles must stay physically right, including RTL ${JSON.stringify(shape)}`);
  assert.ok(shape.incoming.left < midpoint - 15, `${name}: incoming bubbles must stay physically left ${JSON.stringify(shape)}`);
  assert.ok(shape.history.right - shape.own.right < 100, `${name}: own bubble is detached from the right edge`);
  assert.ok(shape.incoming.left - shape.history.left < 100, `${name}: incoming bubble is detached from the left edge`);
  assert.ok(Math.abs(shape.grouped.right - shape.own.right) <= 1, `${name}: grouped own bubbles must share a right edge`);
  assert.ok(shape.grouped.top - shape.own.bottom < shape.own.top - shape.incoming.bottom, `${name}: grouped bubbles must have a smaller gap than a new author`);
  assert.ok(shape.radius >= 12, `${name}: messages should have rounded bubbles`);
  assert.ok(shape.color[0] > shape.color[2], `${name}: own bubble must use the warm palette ${shape.color}`);
  assert.ok(shape.reference && shape.reference.left >= shape.reply.left && shape.reference.right <= shape.reply.right && shape.reference.top >= shape.reply.top && shape.reference.bottom <= shape.reply.bottom, `${name}: reply reference must be inset within its bubble`);
  const ownReply = message(page, fixtureIds.reply);
  await expect(ownReply.locator('.community-message-toolbar,.community-message-menu-trigger')).toHaveCount(0);
  await menu(page, ownReply, await page.locator('html').getAttribute('lang'));
  const actionPanel = page.locator('.community-message-menu');
  await expect(actionPanel.getByRole('menuitem')).toHaveCount(6);
  await expect(actionPanel.getByRole('menuitemcheckbox')).toHaveCount(2);
  const bounds = await actionPanel.boundingBox();
  const viewport = await page.viewportSize();
  assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y >= -1 && bounds.y + bounds.height <= viewport.height + 1, `${name}: message actions outside viewport ${JSON.stringify(bounds)}`);
  await page.keyboard.press('Escape');
  await expect(actionPanel).toHaveCount(0);
}

try {
  await scenario('Quick reply, inset reply and composer cancellation', async () => {
    const { context, page } = await setup();
    const item = message(page, fixtureIds.other);
    await menu(page, item);
    await page.getByRole('menuitem', { name: labels.fr.reply, exact: true }).click();
    await expect(page.locator('.community-composer-reply')).toContainText(fixtureText.other);
    await expect(page.getByLabel(labels.fr.message, { exact: true })).toBeFocused();
    await page.getByRole('button', { name: labels.fr.cancelReply, exact: true }).click();
    await expect(page.locator('.community-composer-reply')).toHaveCount(0);
    await menu(page, item);
    await page.getByRole('menuitem', { name: labels.fr.reply, exact: true }).click();
    const reply = await send(page, 'Réponse envoyée depuis les actions rapides.');
    await expect(reply.locator('.community-message-bubble .community-reply-reference')).toContainText(fixtureText.other);
    await expect(page.locator('.community-composer-reply')).toHaveCount(0);
    await context.close();
  });

  await scenario('Like and heart toggle independently and survive reload', async () => {
    const { context, page } = await setup();
    let item = message(page, fixtureIds.other);
    await menu(page, item);
    await page.getByRole('menuitemcheckbox', { name: 'Utile', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await menu(page, item);
    await expect(page.getByRole('menuitemcheckbox', { name: 'Utile', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemcheckbox', { name: 'J’aime', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(item.locator('.community-message-reactions .community-reaction.is-active')).toHaveCount(2);
    await page.reload();
    item = message(page, fixtureIds.other);
    await expect(item.locator('.community-reaction.is-active')).toHaveCount(2);
    await item.locator('.community-reaction.is-active').first().click();
    await expect(item.locator('.community-reaction.is-active')).toHaveCount(1);
    await page.reload();
    item = message(page, fixtureIds.other);
    await expect(item.locator('.community-reaction.is-active')).toHaveCount(1);
    await item.locator('.community-reaction.is-active').click();
    await expect(item.locator('.community-reaction')).toHaveCount(0);
    await context.close();
  });

  await scenario('Copy link resolves to the selected message after reload', async () => {
    const { context, page } = await setup();
    await menu(page, message(page, fixtureIds.grouped));
    await page.getByRole('menuitem', { name: labels.fr.copy, exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__copiedMessageLink)).toBeTruthy();
    const copied = new URL(await page.evaluate(() => window.__copiedMessageLink));
    assert.equal(copied.pathname, '/app/community');
    assert.equal(copied.searchParams.get('channel'), 'general');
    assert.equal(copied.searchParams.get('message'), fixtureIds.grouped);
    await page.goto(copied.href);
    await expect(message(page, fixtureIds.grouped)).toHaveClass(/is-highlighted/);
    await viewportFits(page, 'Copied message link');
    await context.close();
  });

  await scenario('Student deletion is limited to own messages and persists locally', async () => {
    const { context, page } = await setup();
    await menu(page, message(page, fixtureIds.other));
    await expect(page.getByRole('menuitem', { name: labels.fr.remove, exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await menu(page, message(page, fixtureIds.grouped));
    await page.getByRole('menuitem', { name: labels.fr.remove, exact: true }).click();
    await expect(message(page, fixtureIds.grouped)).toHaveCount(0);
    await expect(message(page, fixtureIds.other)).toHaveCount(1);
    const seededId = 'community-v2-flaa-french_studies-general-04';
    await expect(message(page, seededId)).toHaveCount(1);
    await menu(page, message(page, seededId));
    await page.getByRole('menuitem', { name: labels.fr.remove, exact: true }).click();
    await expect(message(page, seededId)).toHaveCount(0);
    await page.reload();
    await expect(message(page, fixtureIds.grouped)).toHaveCount(0);
    await expect(message(page, seededId)).toHaveCount(0);
    await expect(message(page, fixtureIds.other)).toHaveCount(1);
    await context.close();
  });

  await scenario('Administrator can delete an incoming message locally', async () => {
    const { context, page } = await setup({ role: 'admin' });
    await menu(page, message(page, fixtureIds.other));
    await page.getByRole('menuitem', { name: labels.fr.remove, exact: true }).click();
    await expect(message(page, fixtureIds.other)).toHaveCount(0);
    await page.reload();
    await expect(message(page, fixtureIds.other)).toHaveCount(0);
    await expect(message(page, fixtureIds.own)).toHaveCount(1);
    await context.close();
  });

  await scenario('Unified attachment menu selects device files and presents actual local contents', async () => {
    const { context, page } = await setup();
    const selectedTitle = 'Notes originales.txt';
    await page.getByRole('button', { name: labels.fr.attach, exact: true }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('.community-attachment-menu').getByRole('menuitem', { name: /^Fichiers/ }).click(),
    ]);
    await chooser.setFiles({ name: selectedTitle, mimeType: 'text/plain', buffer: Buffer.from('Contenu réel du fichier local.') });
    await classifyChatFiles(page, 'Révision des notes originales');
    await expect(page.locator('.community-attachments-modal')).toHaveCount(0);
    await expect(page.locator('.community-composer-attachment')).toContainText(selectedTitle);
    const item = await send(page, 'Je partage ce document pour nos révisions.');
    await expect(item.locator('.community-attachment-file')).toContainText(selectedTitle);
    await expect(page.locator('.community-composer-attachment')).toHaveCount(0);
    await item.locator('.community-attachment-file').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Contenu réel du fichier local.');
    await page.locator('.modal-header .icon-btn').click();
    const id = await item.getAttribute('data-message-id');
    const stored = await page.evaluate(({ prefix, id }) => JSON.parse(localStorage.getItem(prefix + 'messages')).find(message => message.id === id), { prefix, id });
    assert.equal(stored.attachments.length, 1);
    assert.equal(stored.attachments[0].name, selectedTitle);
    assert.ok(!JSON.stringify(stored).includes('blob:'), 'Device URLs must not be persisted');
    await page.reload();
    await expect(message(page, id).locator('.community-attachment-file')).toContainText(selectedTitle);
    await capture(page, 'attachment-dark-fr');
    await context.close();
  });

  await scenario('Multiple device attachment drafts remain channel-specific and searchable after reload', async () => {
    const { context, page } = await setup();
    const selectedTitle = 'Notes à retrouver.txt';
    await page.locator('.community-device-file-input').setInputFiles([
      { name: selectedTitle, mimeType: 'text/plain', buffer: Buffer.from('Notes locales') },
      { name: 'Diaporama.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from('Office file') },
    ]);
    await classifyChatFiles(page, 'Documents à retrouver');
    await expect(page.locator('.community-composer-attachment')).toHaveCount(2);
    await expect(page.getByRole('button', { name: labels.fr.send, exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'S1–S2', exact: true }).click();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(0);
    await expect(page.getByRole('button', { name: labels.fr.send, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Chat général', exact: true }).click();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(2);
    await expect(page.getByLabel(labels.fr.message, { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: labels.fr.send, exact: true }).click();
    const item = page.locator('.community-message').filter({ has: page.locator('.community-message-attachment') });
    await expect(item).toHaveCount(1);
    await expect(item.locator('.community-attachment-file')).toHaveCount(2);
    const id = await item.getAttribute('data-message-id');
    await page.reload();
    await expect(message(page, id).locator('.community-attachment-file')).toHaveCount(2);
    await page.getByRole('button', { name: 'Rechercher dans la conversation', exact: true }).click();
    await page.getByRole('textbox', { name: 'Rechercher dans la conversation', exact: true }).fill(selectedTitle);
    await expect(page.locator('.community-message')).toHaveCount(1);
    await expect(message(page, id).locator('.community-attachment-file').first()).toContainText(selectedTitle);
    await context.close();
  });

  await scenario('Mobile long press opens first-message actions without a visible three-dot trigger', async () => {
    const { context, page } = await setup({ language: 'ar', width: 320, height: 600 });
    const history = page.locator('.community-message-history');
    await history.evaluate(node => { node.scrollTop = 0; });
    await expect.poll(() => history.evaluate(node => node.scrollTop)).toBe(0);
    await page.mouse.move(0, 0);
    const first = page.locator('.community-message').first();
    await expect(first.locator('.community-message-menu-trigger,.community-message-toolbar')).toHaveCount(0);
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await longPress(page, first);
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    const bounds = await page.getByRole('menu').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y >= 0 && bounds.y + bounds.height <= 600, `Mobile first-message menu outside viewport ${JSON.stringify(bounds)}`);
    await capture(page, 'long-press-320x600-dark-ar');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(first).toBeFocused();
    await viewportFits(page, 'Idle mobile first-message action menu');
    await context.close();
  });

  for (const theme of ['dark', 'light']) for (const settings of [{ language: 'fr', width: 1440, height: 900 }, { language: 'ar', width: 390, height: 844 }, { language: 'ar', width: 320, height: 600 }]) {
    const name = `${settings.language} ${theme} ${settings.width}×${settings.height}`;
    await scenario(`${name}: right and left bubbles, grouping, inset reply and internal scrolling`, async () => {
      const { context, page } = await setup({ ...settings, theme });
      await expect(page.locator('html')).toHaveAttribute('dir', settings.language === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const initial = await viewportFits(page, name);
      await alignment(page, name);
      await capture(page, `${settings.width}x${settings.height}-${theme}-${settings.language}`);
      const history = page.locator('.community-message-history');
      await history.evaluate(node => { node.scrollTop = 0; });
      await history.hover();
      await page.mouse.wheel(0, 500);
      await expect.poll(() => history.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      const scrolled = await viewportFits(page, `${name} after history scroll`);
      assert.ok(Math.abs(initial.composer.top - scrolled.composer.top) <= 1, `${name}: composer moved while history scrolled`);
      assert.ok(Math.abs(initial.composer.bottom - scrolled.composer.bottom) <= 1, `${name}: composer bottom moved while history scrolled`);
      await context.close();
    });
  }

  assert.deepEqual(problems, [], 'Community reference runtime, console and backend isolation');
  await writeFile(join(output, 'community-reference-report.json'), JSON.stringify({ passed, problems, baseURL }, null, 2));
  console.log(`\n${passed.length} community reference scenarios passed. Artifacts: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await capture(activePage, 'failure').catch(() => {});
  await writeFile(join(output, 'community-reference-report.json'), JSON.stringify({ passed, problems, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally {
  await browser.close();
}
