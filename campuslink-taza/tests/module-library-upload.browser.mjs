import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chooseOption } from './ui.helpers.mjs';

// Every API request stays in this fixture. These regressions never read or
// write campus databases, accounts, storage objects, or private documents.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [];
const reportFilter = (process.env.CAMPUSLINK_MODULE_TEST_FILTER || '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const reportFile = `test-results/module-library-upload${reportFilter ? `-${reportFilter}` : ''}-report.json`;
let activePage;
mkdirSync('test-results', { recursive: true });

const user = { id: 2, username: 'module-fixture', name: 'Fixture Student', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
function resource(id, module, filename, part, extra = {}) {
  return { id, module, filename, title: `Original title ${id}`, faculty_id: 'flaa', filiere_id: 'french_studies', semester: 1, category: 'courses', resource_type: 'courses', part_number: String(part), teacher_name: 'Professeur ancien', created_at: '2026-10-09T10:00:00Z', size: 128, mime: 'application/pdf', library_visible: true, author: user, ...extra };
}
const legacy = () => [
  resource(101, 'XML', 'legacy-first.pdf', 1),
  resource(102, 'xml', 'legacy-second.pdf', 2, { category: 'exercises', resource_type: 'exercises' }),
  resource(103, 'Xml', 'legacy-third.pdf', 3),
  resource(104, ' xMl ', 'legacy-fourth.pdf', 4, { category: 'td', resource_type: 'td' }),
  resource(201, 'Databases', 'database-only.pdf', 1),
  resource(301, 'xml', 'semester-two.pdf', 1, { semester: 2 }),
];
const pdf = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nTest fixture document.\n%%EOF') });

function multipart(request) {
  const contentType = request.headers()['content-type'] || '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  assert.ok(boundary, 'Uploads must send actual multipart form data.');
  const fields = {};
  let filename;
  for (const section of request.postDataBuffer().toString('utf8').split(`--${boundary[1] || boundary[2]}`)) {
    const separator = section.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = section.slice(0, separator);
    const name = /\bname="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    const original = /\bfilename="([^"]+)"/.exec(headers)?.[1];
    const value = section.slice(separator + 4).replace(/\r\n$/, '');
    if (original) filename = original;
    else fields[name] = value;
  }
  assert.ok(filename, 'The original device filename must accompany the upload.');
  return { fields, filename };
}

async function fixture({ width = 1280, height = 900, theme = 'light', documents = legacy(), deferFirst = false, failSecond = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 800, isMobile: width < 800, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [], writes = [], uploads = [], held = [];
  const state = { resources: structuredClone(documents), messages: [], nextId: 1000 };
  await context.addInitScript(theme => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
  }, theme);
  const payload = () => ({ user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: state.resources, messages: state.messages, announcements: [], notifications: [], events: [], saved: [], history: [], channels: [{ id: 'general', read_only: false }], members: [] });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: payload() });
    if (path === '/api/uploads' && request.method() === 'POST') {
      const parsed = multipart(request);
      uploads.push(parsed);
      if (failSecond && uploads.length === 2) return route.fulfill({ status: 503, json: { error: 'Fixture upload retry failure.' } });
      const finish = async () => {
        const { fields, filename } = parsed;
        const item = resource(state.nextId++, fields.module, filename, fields.part_number, { title: fields.title, semester: Number(fields.semester), category: fields.category, resource_type: fields.resource_type, teacher_name: fields.teacher_name, relative_path: fields.relative_path, library_visible: fields.library_visible === 'true' });
        if (item.library_visible) state.resources.push(item);
        parsed.resource = item;
        await route.fulfill({ json: { resource: item } });
      };
      if (deferFirst && uploads.length === 1) { held.push(finish); return; }
      return finish();
    }
    if (path === '/api/messages' && request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push({ path, body });
      const attachments = (body.attachment_ids || []).map(id => uploads.find(item => String(item.resource?.id) === String(id))?.resource).filter(Boolean);
      const message = { id: 9001, client_id: body.client_id, content: body.content, attachments, author: user, faculty_id: 'flaa', filiere_id: 'french_studies', channel: body.channel || 'general', created_at: '2026-10-10T12:00:00Z', reactions: {} };
      state.messages.push(message);
      return route.fulfill({ json: { message } });
    }
    errors.push(`Unexpected fixture API request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request.' } });
  });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/app/library`);
  await expect(page.locator('.library-module-folder').first()).toBeVisible();
  return { context, page, state, uploads, held, errors, writes };
}

const folder = (page, name) => page.locator('.library-module-folder').filter({ has: page.locator('.library-module-name', { hasText: new RegExp(`^${name}$`) }) });
async function allModules(page) {
  await page.locator('.library-results-heading').getByRole('button', { name: 'Tous les modules', exact: true }).click();
  await expect(page.locator('.library-module-folder').first()).toBeVisible();
}
async function upload(page, files) {
  await page.locator('.page-actions').getByRole('button', { name: 'Partager un document', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  await modal.getByRole('button', { name: /^Classer les documents/ }).click();
  return modal;
}
async function editor(modal, index) {
  const row = modal.locator('.upload-file').nth(index);
  if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
  return row.locator('.upload-file-editor');
}
async function chapter(modal, index, value) {
  const fields = await editor(modal, index);
  await expect(fields.locator('input,textarea,[role="combobox"]')).toHaveCount(1);
  await expect(fields.getByLabel(/^Part\/Chapitre/)).toBeVisible();
  await expect(fields.getByLabel(/^(Titre|Module|Semestre|Catégorie|Professeur)/)).toHaveCount(0);
  await fields.getByLabel(/^Part\/Chapitre/).fill(value);
}
async function complete(modal) {
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await expect(modal.locator('.upload-review-list')).toBeVisible();
  await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
  await expect(modal).toHaveCount(0);
}
async function fits(page, name) {
  const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, modal: (() => { const node = document.querySelector('.modal'); if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: node.clientWidth, scrollWidth: node.scrollWidth }; })() }));
  assert.ok(bounds.scrollWidth <= bounds.width + 1, `${name}: page must fit its viewport ${JSON.stringify(bounds)}`);
  if (bounds.modal) assert.ok(bounds.modal.left >= -1 && bounds.modal.right <= bounds.width + 1 && bounds.modal.scrollWidth <= bounds.modal.width + 1, `${name}: upload dialog must fit ${JSON.stringify(bounds)}`);
}
async function scenario(name, run) {
  const filter = process.env.CAMPUSLINK_MODULE_TEST_FILTER;
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  await run(); passed.push(name); console.log(`PASS ${name}`);
}

try {
  await scenario('Existing mixed-case modules become one folder; scope, category, filename search and browser navigation survive', async () => {
    const f = await fixture();
    try {
      const { page } = f;
      await expect(page.locator('.library-module-folder')).toHaveCount(2);
      await expect(page.locator('.library-module-name')).toHaveText(['DATABASES', 'XML']);
      await expect(folder(page, 'XML').locator('.library-module-count')).toContainText('4 documents');
      await expect(page.locator('.document-card')).toHaveCount(0);
      await folder(page, 'XML').click();
      await expect(page).toHaveURL(url => url.searchParams.get('module')?.toUpperCase() === 'XML');
      await expect(page.locator('.document-card')).toHaveCount(4);
      assert.deepEqual((await page.locator('.document-filename').allTextContents()).sort(), ['legacy-first.pdf', 'legacy-fourth.pdf', 'legacy-second.pdf', 'legacy-third.pdf'].sort());
      await expect(page.locator('.document-card').filter({ hasText: 'database-only.pdf' })).toHaveCount(0);
      await expect(page.locator('.library-results-heading h2')).toHaveText('XML');
      await page.goBack();
      await expect(page).toHaveURL(url => url.pathname === '/app/library' && !url.searchParams.has('module'));
      await expect(page.locator('.library-module-folder')).toHaveCount(2).catch(async error => {
        console.log('BACK DEBUG', await page.locator('body').innerText());
        await page.screenshot({ path: 'test-results/module-library-back-failure.png' });
        throw error;
      });
      await page.goForward();
      await expect(page).toHaveURL(url => url.searchParams.get('module')?.toUpperCase() === 'XML');
      await expect(page.locator('.document-card')).toHaveCount(4);
      await page.goBack();
      await expect(page.locator('.library-module-folder')).toHaveCount(2);
      await page.getByRole('tab', { name: /^Exercices/ }).click();
      await expect(page.locator('.library-module-folder')).toHaveCount(1);
      await expect(folder(page, 'XML').locator('.library-module-count')).toContainText('1 document');
      await folder(page, 'XML').click();
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-card')).toContainText('legacy-second.pdf');
      await page.goto(`${baseURL}/app/library?module=xMl`);
      await expect(page.locator('.document-card')).toHaveCount(4);
      await allModules(page);
      const search = page.getByLabel('Rechercher des documents', { exact: true });
      await search.pressSequentially('legacy-third.pdf', { delay: 10 });
      await expect(search).toHaveValue('legacy-third.pdf');
      await expect(page).toHaveURL(url => url.searchParams.get('q') === 'legacy-third.pdf');
      await expect(page.locator('.library-module-folder')).toHaveCount(1);
      await folder(page, 'XML').click();
      await expect(search).toHaveValue('legacy-third.pdf');
      await expect(page).toHaveURL(url => url.searchParams.get('q') === 'legacy-third.pdf');
      await expect(page.locator('.document-card')).toHaveCount(1).catch(async error => {
        console.log('SEARCH DEBUG', JSON.stringify({ url: page.url(), value: await page.getByLabel('Rechercher des documents', { exact: true }).inputValue(), errors: f.errors, body: await page.locator('.library-page').innerText() }));
        await page.screenshot({ path: 'test-results/module-library-search-failure.png' });
        throw error;
      });
      await expect(page.locator('.document-card h3')).toHaveText('Original title 103');
      await page.reload();
      await expect(search).toHaveValue('legacy-third.pdf');
      await expect(page).toHaveURL(url => url.searchParams.get('q') === 'legacy-third.pdf');
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-card h3')).toHaveText('Original title 103');
      await page.goto(`${baseURL}/app/library?semester=2&module=xml`);
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-filename')).toHaveText('semester-two.pdf');
      await fits(page, 'Desktop module library');
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.uploads, []);
      await page.screenshot({ path: 'test-results/module-library-desktop-light.png' });
    } finally { await f.context.close(); }
  });

  await scenario('Large mobile module keeps every original document across bounded 24-card pages', async () => {
    const documents = Array.from({ length: 125 }, (_, index) => resource(index + 1, ['XML', 'xml', 'Xml', 'xMl'][index % 4], `original-${String(index + 1).padStart(3, '0')}.pdf`, index + 1));
    const f = await fixture({ width: 320, height: 640, theme: 'dark', documents });
    try {
      const { page } = f;
      await expect(page.locator('.library-module-folder')).toHaveCount(1);
      await expect(folder(page, 'XML').locator('.library-module-count')).toContainText('125 documents');
      await folder(page, 'XML').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-results/module-library-mobile-320-folders.png' });
      await folder(page, 'XML').tap();
      await expect(page.locator('.library-results-heading')).toContainText('125 documents');
      const seen = new Set();
      const pagination = page.getByRole('navigation', { name: 'Pages des documents', exact: true });
      const next = pagination.getByRole('button', { name: 'Documents suivants', exact: true });
      const previous = pagination.getByRole('button', { name: 'Documents précédents', exact: true });
      await expect(previous).toBeDisabled();
      for (let index = 0; index < 6; index++) {
        await expect(page.locator('.document-card')).toHaveCount(index < 5 ? 24 : 5);
        for (const filename of await page.locator('.document-filename').allTextContents()) {
          assert.ok(!seen.has(filename), 'Pagination must never repeat a document.');
          seen.add(filename);
        }
        await fits(page, `Mobile module page ${index + 1}`);
        if (index < 5) await next.tap();
      }
      assert.equal(seen.size, 125);
      await expect(next).toBeDisabled();
      await expect(page.locator('.library-page-position')).toHaveText('121–125 sur 125');
      await previous.tap();
      await expect(page.locator('.library-page-position')).toHaveText('97–120 sur 125');
      await page.getByLabel('Rechercher des documents', { exact: true }).fill('original-125.pdf');
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-filename')).toHaveText('original-125.pdf');
      await expect(pagination).toHaveCount(0);
      await page.screenshot({ path: 'test-results/module-library-mobile-320-dark.png' });
      await page.goto(`${baseURL}/app/library?module=xml#resource-110`);
      await expect(page.locator('.library-page-position')).toHaveText('97–120 sur 125');
      await expect(page.locator('#resource-110')).toBeVisible();
      await previous.tap();
      await expect(page.locator('.library-page-position')).toHaveText('73–96 sur 125');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator('.library-page-position')).toHaveText('73–96 sur 125');
      await expect(page.locator('#resource-110')).toHaveCount(0);
      await next.tap();
      await expect(page.locator('.library-page-position')).toHaveText('97–120 sur 125');
      await expect(page.locator('#resource-110')).toBeVisible();
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await scenario('Multiple upload edits only chapters, propagates general settings, uses uppercase module titles and rejoins legacy files after reload', async () => {
    const f = await fixture({ width: 390, height: 844, theme: 'dark', deferFirst: true });
    try {
      const { page } = f;
      const modal = await upload(page, [pdf('new-first.pdf'), pdf('new-second.pdf')]);
      const batch = modal.locator('.upload-batch');
      await expect(batch.getByLabel(/^Titre du document/)).toHaveCount(0);
      await batch.getByLabel(/^Module/).fill('Un autre module');
      await chooseOption(batch.getByLabel(/^Semestre/), '2');
      await chooseOption(batch.getByLabel(/^Catégorie/), 'exercises');
      await batch.getByLabel(/^Professeur \/ auteur/).fill('Professeur nouveau');
      await expect(modal.locator('.upload-classification-module bdi')).toHaveText(['Un autre module', 'Un autre module']);
      await expect(modal.locator('.upload-classification-module > span')).toHaveText(['S2', 'S2']);
      await chapter(modal, 0, '5');
      await chapter(modal, 1, '6');
      await chooseOption(batch.getByLabel(/^Semestre/), '1');
      await chooseOption(batch.getByLabel(/^Catégorie/), 'courses');
      await batch.getByLabel(/^Module/).fill(' xMl ');
      await expect(modal.locator('.upload-classification-module bdi')).toHaveText(['xMl', 'xMl']);
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      const review = modal.locator('.upload-review-list');
      await expect(review).toBeVisible();
      await expect(review.locator('strong')).toHaveText(['XML', 'XML']);
      await expect(review).toContainText('new-first.pdf');
      await expect(review).toContainText('new-second.pdf');
      await fits(page, 'Mobile simplified upload');
      await page.screenshot({ path: 'test-results/module-upload-mobile-390-dark.png' });
      await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
      await expect.poll(() => f.held.length).toBe(1);
      await expect(modal.locator('.modal-body .upload-progress-screen')).toBeVisible();
      assert.equal(f.uploads.length, 1, 'A pending upload must not start the next file yet.');
      await f.held.shift()();
      await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
      await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
      assert.equal(f.uploads.length, 2);
      for (const [index, item] of f.uploads.entries()) {
        assert.equal(item.fields.title, 'XML');
        assert.equal(item.fields.module, 'xMl');
        assert.equal(item.fields.semester, '1');
        assert.equal(item.fields.category, 'courses');
        assert.equal(item.fields.teacher_name, 'Professeur nouveau');
        assert.equal(item.fields.part_number, String(index + 5));
        assert.equal(item.fields.library_visible, 'true');
        assert.equal(item.fields.publish_message, 'false');
        assert.equal(item.filename, ['new-first.pdf', 'new-second.pdf'][index]);
      }
      await expect(folder(page, 'XML').locator('.library-module-count')).toContainText('6 documents');
      await folder(page, 'XML').tap();
      await expect(page.locator('.document-card')).toHaveCount(6);
      await page.reload();
      await expect(page.locator('.document-card')).toHaveCount(6);
      const titles = await page.locator('.document-card h3').allTextContents();
      assert.equal(titles.filter(title => title === 'XML').length, 2);
      for (const name of ['legacy-first.pdf', 'legacy-second.pdf', 'legacy-third.pdf', 'legacy-fourth.pdf', 'new-first.pdf', 'new-second.pdf']) await expect(page.locator('.document-filename').filter({ hasText: new RegExp(`^${name.replace('.', '\\.')}$`) })).toHaveCount(1);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await scenario('Required chapters and mixed-case existing, duplicate and complete slots block submission without losing drafts', async () => {
    const f = await fixture();
    try {
      const modal = await upload(f.page, [pdf('conflict-first.pdf'), pdf('conflict-second.pdf')]);
      await modal.locator('.upload-batch').getByLabel(/^Module/).fill(' xml ');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await expect(modal.locator('.upload-error')).toBeVisible();
      await chapter(modal, 0, '01');
      await chapter(modal, 1, '5');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await expect(modal.locator('.upload-error')).toContainText('legacy-first.pdf');
      await chapter(modal, 0, '5');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await expect(modal.locator('.upload-error')).toContainText('Conflit');
      await chapter(modal, 0, 'Complet');
      await chapter(modal, 1, 'COMPLETE');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await expect(modal.locator('.upload-error')).toContainText('Conflit');
      await chapter(modal, 1, '999999999999999999999999999999999999');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await expect(modal.locator('.upload-review-list')).toBeVisible();
      await expect(modal.locator('.upload-review-list')).toContainText('999999999999999999999999999999999999');
      assert.deepEqual(f.uploads, []);
      await modal.getByRole('button', { name: 'Annuler', exact: true }).click();
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await scenario('Single upload retains general title and classification while its individual editor stays chapter-only', async () => {
    const f = await fixture();
    try {
      const modal = await upload(f.page, pdf('individual-original.pdf'));
      const batch = modal.locator('.upload-batch');
      await expect(batch.getByLabel(/^Titre du document/)).toHaveValue('individual-original');
      await batch.getByLabel(/^Titre du document/).fill('A preserved custom title');
      await batch.getByLabel(/^Module/).fill('New automatic module');
      await chapter(modal, 0, 'Complet');
      await complete(modal);
      assert.equal(f.uploads[0].fields.title, 'A preserved custom title');
      assert.equal(f.uploads[0].fields.part_number, 'complete');
      assert.equal(f.uploads[0].filename, 'individual-original.pdf');
      await expect(folder(f.page, 'NEW AUTOMATIC MODULE').locator('.library-module-count')).toContainText('1 document');
      await folder(f.page, 'NEW AUTOMATIC MODULE').click();
      await expect(f.page.locator('.document-card h3')).toHaveText('A preserved custom title');
      await expect(f.page.locator('.document-filename')).toHaveText('individual-original.pdf');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await scenario('Chat multiple files use the same simplified classification and remain outside the Library', async () => {
    const f = await fixture({ width: 390, height: 844, theme: 'light' });
    try {
      const { page } = f;
      await page.goto(`${baseURL}/app/community?channel=general`);
      await expect(page.getByLabel('Votre message', { exact: true })).toBeVisible();
      await page.locator('.community-device-file-input').setInputFiles([pdf('chat-first.pdf'), pdf('chat-second.pdf')]);
      const modal = page.getByRole('dialog', { name: 'Classer les fichiers du message', exact: true });
      await expect(modal.locator('.upload-file-editor')).toHaveCount(1);
      await modal.locator('.upload-batch').getByLabel(/^Module/).fill('xml');
      await chapter(modal, 0, '7');
      await chapter(modal, 1, '8');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await expect(modal.locator('.upload-review-list strong')).toHaveText(['XML', 'XML']);
      await modal.getByRole('button', { name: 'Joindre au message', exact: true }).click();
      await expect(page.locator('.community-composer-attachment')).toHaveCount(2);
      await page.getByLabel('Votre message', { exact: true }).fill('Classified message fixture');
      await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
      await expect(page.locator('[data-message-id="9001"]')).toBeVisible();
      await expect(page.locator('[data-message-id="9001"] .community-device-attachment')).toHaveCount(2);
      assert.equal(f.uploads.length, 2);
      assert.deepEqual(f.uploads.map(item => item.fields.library_visible), ['false', 'false']);
      assert.deepEqual(f.uploads.map(item => item.fields.title), ['XML', 'XML']);
      assert.deepEqual(f.uploads.map(item => item.fields.part_number), ['7', '8']);
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].body.attachment_ids.length, 2);
      assert.equal(f.state.resources.length, legacy().length);
      await page.goto(`${baseURL}/app/library`);
      await expect(folder(page, 'XML').locator('.library-module-count')).toContainText('4 documents');
      await folder(page, 'XML').tap();
      await expect(page.locator('.document-card')).toHaveCount(4);
      await expect(page.locator('.document-filename').filter({ hasText: /^chat-/ })).toHaveCount(0);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await scenario('Partial upload retry preserves completed metadata and sends only the remaining file', async () => {
    const f = await fixture({ failSecond: true });
    try {
      const modal = await upload(f.page, [pdf('retry-first.pdf'), pdf('retry-second.pdf')]);
      await modal.locator('.upload-batch').getByLabel(/^Module/).fill('Retry module');
      await chapter(modal, 0, '1');
      await chapter(modal, 1, '2');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
      await expect(modal.locator('.upload-error')).toContainText('Fixture upload retry failure.');
      assert.equal(f.uploads.length, 2);
      assert.equal(f.state.resources.filter(item => item.filename.startsWith('retry-')).length, 1);
      await modal.getByRole('button', { name: 'Modifier', exact: true }).click();
      await modal.locator('.upload-batch').getByLabel(/^Module/).fill('Other retry module');
      const first = await editor(modal, 0);
      await expect(first.getByLabel(/^Part\/Chapitre/)).toBeDisabled();
      await expect(modal.locator('.upload-file').first().getByRole('button', { name: 'Retirer retry-first.pdf', exact: true })).toBeDisabled();
      await expect(modal.locator('.upload-classification-module bdi')).toHaveText(['Retry module', 'Other retry module']);
      await complete(modal);
      assert.deepEqual(f.uploads.map(item => item.filename), ['retry-first.pdf', 'retry-second.pdf', 'retry-second.pdf']);
      assert.equal(f.uploads[0].fields.title, 'RETRY MODULE');
      assert.equal(f.uploads[2].fields.title, 'OTHER RETRY MODULE');
      const completed = f.state.resources.filter(item => item.filename.startsWith('retry-'));
      assert.equal(completed.length, 2);
      assert.equal(completed.find(item => item.filename === 'retry-first.pdf').module, 'Retry module');
      assert.equal(completed.find(item => item.filename === 'retry-second.pdf').module, 'Other retry module');
      await expect(folder(f.page, 'RETRY MODULE').locator('.library-module-count')).toContainText('1 document');
      await expect(folder(f.page, 'OTHER RETRY MODULE').locator('.library-module-count')).toContainText('1 document');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await scenario('Special module names, blank legacy modules and academic scope retain their actual folder identity', async () => {
    const f = await fixture({ documents: [
      resource(501, 'Straße', 'german-case.pdf', 1),
      resource(502, '', 'unclassified-original.pdf', 1),
      resource(503, 'all', 'literal-all-module.pdf', 1),
      resource(504, 'XML', 'other-program.pdf', 1, { filiere_id: 'arabic_studies' }),
      resource(505, 'XML', 'other-faculty.pdf', 1, { faculty_id: 'feg', filiere_id: 'economics_management' }),
    ] });
    try {
      const { page } = f;
      await expect(page.locator('.library-module-folder')).toHaveCount(3);
      assert.deepEqual((await page.locator('.library-module-name').allTextContents()).sort(), ['ALL', 'STRASSE', 'Sans module'].sort());
      await folder(page, 'STRASSE').click();
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-filename')).toHaveText('german-case.pdf');
      await expect(page).toHaveURL(url => url.searchParams.get('module') === 'straße');
      await allModules(page);
      await page.locator('.library-modules').getByRole('button', { name: 'STRASSE', exact: true }).click();
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-filename')).toHaveText('german-case.pdf');
      await allModules(page);
      await folder(page, 'Sans module').click();
      await expect(page).toHaveURL(url => url.searchParams.has('module') && url.searchParams.get('module') === '');
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-filename')).toHaveText('unclassified-original.pdf');
      await allModules(page);
      await folder(page, 'ALL').click();
      await expect(page).toHaveURL(url => url.searchParams.get('module') === 'all');
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-filename')).toHaveText('literal-all-module.pdf');
      await page.goto(`${baseURL}/app/library?module=all`);
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-filename')).toHaveText('literal-all-module.pdf');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  writeFileSync(reportFile, JSON.stringify({ passed, baseURL }, null, 2));
  console.log(`All ${passed.length} module organization and upload scenarios passed.`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'test-results/module-library-upload-failure.png' }).catch(() => {});
  writeFileSync(reportFile, JSON.stringify({ passed, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally { await browser.close(); }
