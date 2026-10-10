import { chromium, expect } from '@playwright/test';
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
const fixtures = await mkdtemp(join(tmpdir(), 'campuslink-chat-classification-'));
const folder = join(fixtures, 'Classified folder');
await mkdir(join(folder, 'nested'), { recursive: true });
await writeFile(join(folder, 'notes.txt'), 'Classified local notes.');
await writeFile(join(folder, 'nested', 'presentation.pptx'), 'Local presentation.');
await writeFile(join(folder, 'nested', 'table.xlsx'), 'Local table.');
await writeFile(join(folder, 'ignored.zip'), 'Unsupported format.');
await mkdir(output, { recursive: true });
const text = { name: 'Classified notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Actual classified file contents.') };
const second = { name: 'Cancelled document.txt', mimeType: 'text/plain', buffer: Buffer.from('Cancelled contents.') };
const passed = [], problems = [];
let activePage;

async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }
async function setup({ width = 1440, height = 1000, theme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 760, reducedMotion: 'reduce' });
  await context.addInitScript(({ prefix, theme }) => {
    if (localStorage.getItem(prefix + 'chat-classification-ready')) return;
    const set = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
    set('session', { id: 'sara.demo', username: 'sara.demo', name: 'Sara Benali', role: 'student' });
    set('selections', { 'sara.demo': { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 } });
    set('theme', theme); set('language', 'fr'); set('chat-classification-ready', true);
  }, { prefix, theme });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => problems.push(`Runtime: ${error.message}`));
  page.on('console', event => { if (event.type() === 'error') problems.push(`Console: ${event.text()}`); });
  page.on('request', request => { if (/\/api\/|neon\.tech|r2\.dev/.test(request.url())) problems.push(`Backend: ${request.url()}`); });
  await page.goto(`${baseURL}/app/community?channel=general`);
  await expect(page.getByLabel('Votre message', { exact: true })).toBeVisible();
  return { context, page };
}
async function choose(page, files, isFolder = false) {
  await page.locator(isFolder ? '.community-device-folder-input' : '.community-device-file-input').setInputFiles(files);
  const modal = page.getByRole('dialog', { name: 'Classer les fichiers du message', exact: true });
  await expect(modal.locator('.upload-file-editor')).toHaveCount(1);
  return modal;
}
async function editor(modal, index) {
  const row = modal.locator('.upload-file').nth(index);
  if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
  return row.locator('.upload-file-editor');
}
async function shared(modal, module, author = '') {
  const batch = modal.locator('.upload-batch');
  await batch.getByLabel(/^Module/).fill(module);
  await batch.getByLabel(/^Professeur \/ auteur/).fill(author);
  await batch.getByRole('button', { name: /Appliquer aux/ }).click();
}
async function attach(modal) {
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await expect(modal.locator('.upload-review-list')).toBeVisible();
  await modal.getByRole('button', { name: 'Joindre au message', exact: true }).click();
  await expect(modal).toHaveCount(0);
}
async function fit(page, name) {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const modal = document.querySelector('.modal');
    const composer = document.querySelector('.community-composer');
    const bottom = document.querySelector('.mobile-bottom-nav');
    const rect = element => element && ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, width: element.clientWidth, scrollWidth: element.scrollWidth });
    return { width: root.clientWidth, height: root.clientHeight, scrollWidth: root.scrollWidth, modal: rect(modal), composer: rect(composer), bottom: bottom && getComputedStyle(bottom).display !== 'none' ? rect(bottom) : null };
  });
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${name}: horizontal page overflow ${JSON.stringify(geometry)}`);
  const overflow = await page.locator('.community-file-classification').evaluateAll(nodes => nodes.map(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth })).filter(size => size.scrollWidth > size.width + 1));
  assert.deepEqual(overflow, [], `${name}: classified file details overflow their card`);
  if (geometry.modal) assert.ok(geometry.modal.left >= -1 && geometry.modal.right <= geometry.width + 1 && geometry.modal.scrollWidth <= geometry.modal.width + 1, `${name}: modal overflow ${JSON.stringify(geometry)}`);
  else if (geometry.bottom) assert.ok(geometry.composer.top >= 0 && geometry.composer.bottom <= geometry.bottom.top + 1, `${name}: composer overlaps navigation ${JSON.stringify(geometry)}`);
}

try {
  await scenario('Chat files require full classification, preserve drafts on cancel and do not add Library resources', async () => {
    const { context, page } = await setup();
    const cancelled = await choose(page, text);
    await expect(cancelled.getByLabel('Faculté attribuée')).not.toHaveValue('');
    await expect(cancelled.getByLabel('Filière attribuée')).not.toHaveValue('');
    await cancelled.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(cancelled.locator('.upload-error')).toBeVisible();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(0);
    await cancelled.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(0);
    const modal = await choose(page, text);
    await shared(modal, ' méthodologie ', 'Dr. Chat');
    await (await editor(modal, 0)).getByLabel(/^Part\/Chapitre/).fill('1');
    // This slot already exists in Library. Sharing it in a discussion remains valid.
    await attach(modal);
    const draft = page.locator('.community-composer-attachment');
    await expect(draft).toHaveCount(1);
    for (const value of ['Classified notes.txt', 'méthodologie', 'S1', 'Cours', 'Part/Chapitre 1', 'Dr. Chat']) await expect(draft).toContainText(value);
    const another = await choose(page, second);
    await another.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(draft).toHaveCount(1);
    await draft.getByRole('button', { name: /^Aperçu / }).click();
    const preview = page.locator('.community-device-preview');
    await expect(preview).toContainText('Actual classified file contents.');
    for (const value of ['Faculté', 'Filière', 'méthodologie', 'Part/Chapitre 1', 'Dr. Chat', 'Sara Benali']) await expect(preview).toContainText(value);
    await preview.locator('.modal-header .icon-btn').click();
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    const stored = await page.evaluate(prefix => JSON.parse(localStorage.getItem(prefix + 'messages')).find(message => message.attachments?.some(file => file.name === 'Classified notes.txt')), prefix);
    const metadata = stored.attachments[0];
    assert.equal(metadata.facultyId, 'flaa'); assert.equal(metadata.filiereId, 'french_studies');
    assert.equal(metadata.semester, 1); assert.equal(metadata.module, 'méthodologie');
    assert.equal(metadata.category, 'courses'); assert.equal(metadata.part, '1'); assert.equal(metadata.author, 'Dr. Chat');
    assert.ok(metadata.facultyName && metadata.filiereName && metadata.title && metadata.uploader && metadata.date);
    assert.ok(!JSON.stringify(stored).includes('blob:') && !JSON.stringify(stored).includes('Actual classified file contents.'));
    await page.getByRole('button', { name: 'Rechercher dans la conversation', exact: true }).click();
    await page.getByRole('textbox', { name: 'Rechercher dans la conversation', exact: true }).fill('Dr. Chat');
    await expect(page.locator(`[data-message-id="${stored.id}"]`)).toBeVisible();
    await page.goto(`${baseURL}/app/library`);
    await expect(page.locator('.document-card').filter({ hasText: 'Classified notes.txt' })).toHaveCount(0);
    await context.close();
  });

  await scenario('Nested chat folders require per-file chapters, block draft conflicts and retain readable metadata on mobile reload', async () => {
    const { context, page } = await setup({ width: 320, height: 640, theme: 'light' });
    const modal = await choose(page, folder, true);
    await expect(modal.locator('.upload-file')).toHaveCount(3);
    await expect(modal.locator('.upload-file-path').filter({ hasText: 'nested' }).first()).toBeVisible();
    await expect(modal.locator('.upload-batch').getByLabel(/^Part\/Chapitre/)).toHaveCount(0);
    await shared(modal, 'Module de discussion');
    for (let index = 0; index < 3; index++) await (await editor(modal, index)).getByLabel(/^Part\/Chapitre/).fill(index < 2 ? '1' : '99999999999999999999999999999999');
    await modal.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(modal.locator('.upload-error')).toContainText('Conflit');
    await expect(page.locator('.community-composer-attachment')).toHaveCount(0);
    await (await editor(modal, 1)).getByLabel(/^Part\/Chapitre/).fill('Complet');
    await modal.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(modal.locator('.upload-review-list')).toBeVisible();
    await fit(page, 'Mobile classification review');
    await page.screenshot({ path: join(output, 'chat-classification-mobile-review.png'), animations: 'disabled' });
    await modal.getByRole('button', { name: 'Joindre au message', exact: true }).click();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(3);
    await fit(page, 'Mobile classified drafts');
    const office = page.locator('.community-composer-attachment').filter({ hasText: 'presentation.pptx' });
    await office.getByRole('button', { name: /^Aperçu / }).click();
    const preview = page.locator('.community-device-preview');
    await expect(preview).toContainText('Module de discussion');
    await expect(preview.locator('iframe')).toHaveCount(0);
    await expect(preview.getByRole('button', { name: 'Télécharger', exact: true })).toBeEnabled();
    await fit(page, 'Mobile classified Office preview');
    await preview.locator('.modal-header .icon-btn').click();
    // A new file cannot reuse a slot already occupied by a pending draft file.
    const pending = await choose(page, second);
    await shared(pending, 'Module de discussion');
    await (await editor(pending, 0)).getByLabel(/^Part\/Chapitre/).fill('1');
    await pending.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(pending.locator('.upload-error')).toContainText('Conflit');
    await pending.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(3);
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    const stored = await page.evaluate(prefix => JSON.parse(localStorage.getItem(prefix + 'messages')).find(message => message.attachments?.length === 3), prefix);
    assert.deepEqual(stored.attachments.map(file => file.part), ['1', 'complete', '99999999999999999999999999999999']);
    assert.ok(stored.attachments.some(file => file.path.includes('/nested/')));
    await page.evaluate(prefix => localStorage.setItem(prefix + 'language', JSON.stringify('ar')), prefix);
    await page.reload();
    const sent = page.locator('.community-message').filter({ has: page.locator('.community-device-attachment') });
    await expect(sent.locator('.community-device-attachment')).toHaveCount(3);
    await expect(sent).toContainText('Module de discussion');
    await expect(sent).toContainText('99999999999999999999999999999999');
    await expect(sent.locator('.community-device-availability').first()).toContainText('الملف غير متاح');
    await fit(page, 'Arabic mobile classified messages');
    await page.screenshot({ path: join(output, 'chat-classification-mobile-arabic.png'), animations: 'disabled' });
    await context.close();
  });
  assert.deepEqual(problems, []);
} catch (error) {
  problems.push(error.stack || String(error));
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: join(output, 'chat-classification-failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(join(output, 'chat-classification-report.json'), JSON.stringify({ passed, problems }, null, 2));
  await browser.close(); await rm(fixtures, { recursive: true, force: true });
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`All ${passed.length} chat classification scenarios passed.`);
