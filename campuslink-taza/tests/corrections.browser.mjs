import { chromium, expect } from '@playwright/test';
import { chooseOption, autocompleteValues, classifyChatFiles } from './ui.helpers.mjs';
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
const fixtures = await mkdtemp(join(tmpdir(), 'campuslink-corrections-'));
const folder = join(fixtures, 'Original folder');
const passed = [], problems = [];
let activePage;
await mkdir(output, { recursive: true });
await mkdir(join(folder, 'nested', 'deeper'), { recursive: true });
const extensions = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt'];
for (const [index, extension] of extensions.entries()) {
  await writeFile(join(index % 2 ? join(folder, 'nested', 'deeper') : folder, `Original ${index}.${extension}`), extension === 'txt' ? 'Device text preview — actual file contents.' : 'Local fixture');
}
await writeFile(join(folder, 'ignored.zip'), 'Unsupported file');
const png = { name: 'Actual image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64') };
const text = { name: 'Original notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Device text preview — actual file contents.') };

async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }
async function capture(page, name) { await page.screenshot({ path: join(output, `corrections-${name}.png`), fullPage: false, animations: 'disabled' }); }
async function setup({ width = 1440, height = 1000, theme = 'dark', language = 'fr', messages = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  await context.addInitScript(({ prefix, theme, language, messages }) => {
    if (localStorage.getItem(prefix + 'corrections-ready')) return;
    const set = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
    set('session', { id: 'sara.demo', username: 'sara.demo', name: 'Sara Benali', role: 'student' });
    set('selections', { 'sara.demo': { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 } });
    set('theme', theme); set('language', language);
    if (messages.length) set('messages', messages);
    set('corrections-ready', true);
  }, { prefix, theme, language, messages });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => problems.push(`Runtime: ${error.message}`));
  page.on('console', event => { if (event.type() === 'error') problems.push(`Console: ${event.text()}`); });
  page.on('request', request => { if (/\/api\/|neon\.tech|r2\.dev/.test(request.url())) problems.push(`Backend: ${request.url()}`); });
  return { context, page };
}
async function fit(page, name) {
  const bounds = await page.evaluate(() => {
    const root = document.documentElement;
    const modal = document.querySelector('.modal');
    return { width: root.clientWidth, scrollWidth: root.scrollWidth, modal: modal ? { left: modal.getBoundingClientRect().left, right: modal.getBoundingClientRect().right, width: modal.clientWidth, scrollWidth: modal.scrollWidth } : null };
  });
  assert.ok(bounds.scrollWidth <= bounds.width + 1, `${name}: page overflow ${JSON.stringify(bounds)}`);
  if (bounds.modal) assert.ok(bounds.modal.left >= -1 && bounds.modal.right <= bounds.width + 1 && bounds.modal.scrollWidth <= bounds.modal.width + 1, `${name}: modal overflow ${JSON.stringify(bounds)}`);
}
async function close(page) { await page.locator('.modal-header .icon-btn').last().click(); }
async function upload(page, files, isFolder = false) {
  await page.locator('.page-actions button').click();
  const modal = page.getByRole('dialog');
  await modal.locator(isFolder ? 'input[webkitdirectory]' : 'input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  await modal.getByRole('button', { name: /Classer les documents/ }).click();
  return modal;
}
async function editor(modal, index) {
  const row = modal.locator('.upload-file').nth(index);
  if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
  return row.locator('.upload-file-editor');
}
async function shared(modal, module) {
  const batch = modal.locator('.upload-batch');
  await batch.getByLabel(/^Module/).fill(module);
  await batch.getByRole('button', { name: /Appliquer aux/ }).click();
}
async function confirm(modal) {
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await expect(modal.locator('.upload-review-list')).toBeVisible();
  await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Documents ajoutés' })).toBeVisible();
  await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
}

try {
  if (process.env.CAMPUSLINK_TEST_SCOPE !== 'resources') {
  await scenario('Faculty general sharing and program-year isolation across academic assignments', async () => {
    const base = { facultyId: 'flaa', filiereId: 'french_studies', author: 'Yassine', username: 'yassine.demo', date: '2026-10-08T10:00:00Z' };
    const messages = [
      { ...base, id: 'faculty-own', channel: 'general', content: 'French program faculty chat' },
      { ...base, id: 'faculty-other-program', filiereId: 'arabic_studies', channel: 'general', content: 'Arabic program faculty chat' },
      { ...base, id: 'faculty-forbidden', facultyId: 'feg', filiereId: 'economics', channel: 'general', content: 'Other faculty separate chat' },
      { ...base, id: 'year-first', channel: 'semester-1', content: 'First semester combined year' },
      { ...base, id: 'year-second', channel: 'semester-2', content: 'Second semester same year' },
      { ...base, id: 'year-other-program', filiereId: 'arabic_studies', channel: 'year-1', content: 'Arabic program own year' },
    ];
    const { context, page } = await setup({ messages });
    await page.goto(`${baseURL}/app/community?channel=general`);
    await expect(page.locator('#faculty-own')).toHaveCount(1);
    await expect(page.locator('#faculty-other-program')).toHaveCount(1);
    await expect(page.locator('#faculty-forbidden')).toHaveCount(0);
    for (const label of ['Entraide', 'Vie étudiante']) await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'S1–S2', exact: true }).click();
    await expect(page).toHaveURL(/channel=year-1/);
    await expect(page.locator('#year-first')).toHaveCount(1);
    await expect(page.locator('#year-second')).toHaveCount(1);
    await expect(page.locator('#year-other-program')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Semestre [1-6]$/ })).toHaveCount(0);
    await page.evaluate(prefix => localStorage.setItem(prefix + 'selections', JSON.stringify({ 'sara.demo': { facultyId: 'flaa', filiereId: 'arabic_studies', semester: 6 } })), prefix);
    await page.reload();
    await expect(page.locator('#year-other-program')).toHaveCount(1);
    await expect(page.locator('#year-first')).toHaveCount(0);
    await page.getByRole('button', { name: 'Chat général', exact: true }).click();
    await expect(page.locator('#faculty-own')).toHaveCount(1);
    await expect(page.locator('#faculty-other-program')).toHaveCount(1);
    for (const label of ['S1–S2', 'S3–S4', 'S5–S6']) { await page.getByRole('button', { name: label, exact: true }).click(); await expect(page.getByLabel('Votre message', { exact: true })).toBeVisible(); }
    await capture(page, 'three-year-navigation'); await context.close();
  });

  await scenario('Mixed device folder attachments preview and removal fit the mobile chat', async () => {
    const { context, page } = await setup({ width: 320, height: 600, theme: 'light' });
    await page.goto(`${baseURL}/app/community?channel=general`);
    await page.locator('.community-composer-attach').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('.community-attachment-menu').getByRole('menuitem', { name: /^Dossier/ }).click(),
    ]);
    await chooser.setFiles(folder);
    await classifyChatFiles(page, 'Fichiers du dossier mobile');
    await expect(page.locator('.community-composer-attachment')).toHaveCount(extensions.length);
    await expect(page.locator('.community-composer-attachment').filter({ hasText: 'deeper' }).first()).toBeVisible();
    const first = page.locator('.community-composer-attachment').first();
    await first.getByRole('button', { name: /^Retirer / }).click();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(extensions.length - 1);
    await fit(page, 'Small mobile device folder composer');
    const geometry = await page.locator('.community-composer').evaluate(element => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, height: window.innerHeight }));
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height + 1, `Attachment composer clipped ${JSON.stringify(geometry)}`);
    await capture(page, 'chat-folder-mobile-light');
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    await expect(page.locator('.community-composer-attachment')).toHaveCount(0);
    const item = page.locator('.community-message').filter({ has: page.locator('.community-message-attachment') });
    await expect(item.locator('.community-attachment-file')).toHaveCount(extensions.length - 1);
    const stored = await page.evaluate(prefix => JSON.parse(localStorage.getItem(prefix + 'messages')).find(message => message.attachments?.length === 11), prefix);
    assert.equal(stored.attachments.length, 11);
    assert.ok(!JSON.stringify(stored).includes('blob:'));
    await page.reload();
    await expect(page.locator('.community-message').filter({ has: page.locator('.community-message-attachment') }).locator('.community-attachment-file')).toHaveCount(11);
    await context.close();
  });

  }
  if (process.env.CAMPUSLINK_TEST_SCOPE !== 'community') {
  await scenario('Required single-file classification, freely typed module and unlimited chapter', async () => {
    const { context, page } = await setup();
    await page.goto(`${baseURL}/app/library`);
    await expect(page.locator('.semester-choice')).toHaveCount(6);
    const modal = await upload(page, text);
    const moduleInput = modal.locator('.upload-batch').getByLabel(/^Module/);
    await expect(moduleInput).toHaveValue('');
    await moduleInput.fill('méth');
    await expect.poll(() => autocompleteValues(moduleInput)).toEqual(['Méthodologie']);
    await chooseOption(modal.locator('.upload-batch').getByLabel(/^Semestre/), '3');
    await moduleInput.fill('méth');
    await expect.poll(() => autocompleteValues(moduleInput)).toEqual([]);
    await moduleInput.fill('po');
    await expect.poll(() => autocompleteValues(moduleInput)).toEqual(['Poésie']);
    await chooseOption(modal.locator('.upload-batch').getByLabel(/^Semestre/), '1');
    await shared(modal, 'Nouveau module libre');
    await modal.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(modal.locator('.upload-error')).toBeVisible();
    const fields = await editor(modal, 0);
    await expect(fields.getByLabel(/^Module/)).toHaveValue('Nouveau module libre');
    await expect(fields.getByLabel(/^Part\/Chapitre/)).toHaveValue('');
    await fields.getByLabel(/^Part\/Chapitre/).fill('999999999999999999999999999999999999999');
    await confirm(modal);
    const card = page.locator('.document-card').filter({ hasText: text.name });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('999999999999999999999999999999999999999');
    await expect(card).toContainText('TXT');
    await card.locator('.document-main').click();
    await expect(page.locator('.preview-modal')).toContainText(text.name);
    await expect(page.locator('.preview-modal')).toContainText('Device text preview — actual file contents.');
    await expect(page.locator('.preview-modal')).toContainText('Nouveau module libre');
    await expect(page.locator('.preview-modal')).toContainText('Sara Benali');
    await capture(page, 'text-details'); await close(page);
    const second = await upload(page, png);
    await shared(second, ' nouveau   MODULE libre ');
    await (await editor(second, 0)).getByLabel(/^Part\/Chapitre/).fill('999999999999999999999999999999999999999');
    await second.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(second.locator('.upload-error')).toBeVisible();
    await (await editor(second, 0)).getByLabel(/^Part\/Chapitre/).fill('Complet');
    await confirm(second);
    const imageCard = page.locator('.document-card').filter({ hasText: png.name });
    await expect(imageCard).toContainText('Complet');
    await imageCard.locator('.document-main').click();
    await expect(page.locator('.preview-modal img')).toBeVisible();
    await expect.poll(() => page.locator('.preview-modal img').evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
    await close(page);
    const suggestions = await upload(page, text);
    const typed = suggestions.locator('.upload-batch').getByLabel(/^Module/);
    await typed.fill('nouveau module');
    await expect.poll(() => autocompleteValues(typed)).toHaveLength(1);
    await close(page);
    await page.reload();
    await expect(page.locator('.document-card').filter({ hasText: text.name })).toHaveCount(0);
    await expect(page.locator('.document-card').filter({ hasText: png.name })).toHaveCount(0);
    await context.close();
  });

  await scenario('Recursive mixed-format educational folder, per-file conflict review and independent categories', async () => {
    const { context, page } = await setup({ theme: 'light', width: 390, height: 844 });
    await page.goto(`${baseURL}/app/library`);
    const modal = await upload(page, folder, true);
    await expect(modal.locator('.upload-file')).toHaveCount(extensions.length);
    await expect(modal.locator('.upload-file-path').filter({ hasText: 'deeper' }).first()).toBeVisible();
    await shared(modal, 'Dossier éducatif partagé');
    await expect(modal.locator('.upload-batch').getByLabel(/^Part\/Chapitre/)).toHaveCount(0);
    for (let index = 0; index < extensions.length; index++) {
      const fields = await editor(modal, index);
      await fields.getByLabel(/^Part\/Chapitre/).fill(index < 4 ? '1' : String(index));
      if (index < 4) await chooseOption(fields.getByLabel(/^Catégorie/), ['courses', 'exercises', 'exams', 'rattrapage'][index]);
    }
    const duplicate = await editor(modal, 1);
    await chooseOption(duplicate.getByLabel(/^Catégorie/), 'courses');
    await modal.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(modal.locator('.upload-error')).toBeVisible();
    await chooseOption((await editor(modal, 1)).getByLabel(/^Catégorie/), 'exercises');
    await modal.getByRole('button', { name: /^Vérifier/ }).click();
    await expect(modal.locator('.upload-review-list')).toBeVisible();
    await expect(modal.locator('.upload-review-list')).toContainText('Dossier éducatif partagé');
    await expect(modal.locator('.upload-review-list')).toContainText('Original');
    await fit(page, 'Mobile folder classification'); await capture(page, 'folder-review-mobile-light');
    await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
    await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
    await page.getByLabel('Rechercher des documents').fill('Dossier éducatif partagé');
    await expect(page.locator('.document-card')).toHaveCount(extensions.length);
    const office = page.locator('.document-card').filter({ hasText: 'Original 5.doc' });
    await office.locator('.document-main').click();
    await expect(page.locator('.preview-modal')).toContainText('Original 5.doc');
    await expect(page.locator('.preview-modal iframe')).toHaveCount(0);
    await expect(page.locator('.preview-modal .pdf-sheet')).toHaveCount(0);
    await expect(page.locator('.preview-modal').getByRole('button', { name: 'Télécharger', exact: true })).toBeEnabled();
    await fit(page, 'Mobile Office file details'); await capture(page, 'office-details-mobile-light'); await close(page);
    for (const label of ['Cours', 'Exercices', 'Examens', 'Rattrapages']) {
      await page.getByRole('tab', { name: new RegExp(`^${label}`) }).click();
      await expect(page.locator('.document-card')).not.toHaveCount(0);
      await expect(page.locator('.document-category')).toHaveText(Array(await page.locator('.document-card').count()).fill(label));
    }
    await fit(page, 'Mobile resource metadata'); await capture(page, 'resource-categories-mobile-light'); await context.close();
  });

  }
  assert.deepEqual(problems, [], 'No frontend runtime errors or backend requests');
  await writeFile(join(output, 'corrections-report.json'), JSON.stringify({ passed, problems, baseURL }, null, 2));
  console.log(`\n${passed.length} requested-correction scenarios passed.`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await capture(activePage, 'failure').catch(() => {});
  await writeFile(join(output, 'corrections-report.json'), JSON.stringify({ passed, problems, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally { await browser.close(); await rm(fixtures, { recursive: true, force: true }); }
