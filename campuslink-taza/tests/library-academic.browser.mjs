import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chooseOption } from './ui.helpers.mjs';

// API fixtures isolate this suite from accounts, PostgreSQL and R2.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
let activePage;
mkdirSync('test-results', { recursive: true });
const ownScope = semesters => ({ facultyId: 'flaa', filiereId: 'french_studies', semesters });
const student = { id: 2, name: 'Étudiante test', username: 'academic-fixture', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 3, current_academic_year: '2026/2027', account_status: 'approved', language: 'fr', uploadCapabilities: { scopes: [ownScope([3, 4])], source: 'study_year' } };
const doc = (id, year, extra = {}) => ({ id, title: `Document ${String(id).padStart(3, '0')}`, filename: `cours-${id}.pdf`, module: 'Linguistique', faculty_id: 'flaa', filiere_id: 'french_studies', semester: 3, category: 'courses', resource_type: 'courses', part_number: String(id), academic_year: year || null, academic_years: year ? [year] : [], mime: 'application/pdf', size: 128, created_at: '2026-10-10T00:00:00Z', author_id: 2, author: student, library_visible: true, ...extra });
function multipart(request) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers()['content-type']);
  assert.ok(boundary);
  const fields = {};
  let filename;
  for (const section of request.postDataBuffer().toString('utf8').split(`--${boundary[1] || boundary[2]}`)) {
    const separator = section.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = section.slice(0, separator);
    const name = /\bname="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    const original = /\bfilename="([^"]+)"/.exec(headers)?.[1];
    if (original) filename = original;
    else fields[name] = section.slice(separator + 4).replace(/\r\n$/, '');
  }
  return { fields, filename };
}
async function fixture({ user = student, resources = [], width = 1280, failSecond = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 800, hasTouch: width < 800, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const state = { resources: structuredClone(resources), next: 1000 }, uploads = [], corrections = [], errors = [];
  await context.addInitScript(() => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', '"dark"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', code: 'FLAA', name: 'Faculté test' }, resources: state.resources, announcements: [], messages: [], notifications: [], saved: [], history: [], channels: [], members: [] } });
    if (path === '/api/uploads' && request.method() === 'POST') {
      const parsed = multipart(request);
      uploads.push(parsed);
      if (failSecond && uploads.length === 2) return route.fulfill({ status: 503, json: { error: 'Interruption de test. Réessayez.' } });
      const f = parsed.fields;
      const resource = doc(state.next++, f.academic_year, { filename: parsed.filename, title: f.title, semester: Number(f.semester), module: f.module, part_number: f.part_number, category: f.category, resource_type: f.resource_type, filiere_id: f.filiere_id, faculty_id: f.faculty_id, relative_path: f.relative_path, author: user });
      state.resources.push(resource);
      return route.fulfill({ json: { resource } });
    }
    const correction = /^\/api\/resources\/(\d+)\/academic-years$/.exec(path);
    if (correction && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      corrections.push({ id: correction[1], ...body });
      const resource = state.resources.find(item => String(item.id) === correction[1]);
      resource.academic_years = body.academic_years;
      resource.academic_year = body.academic_year;
      return route.fulfill({ json: { resource } });
    }
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/app/library?semester=3&module=linguistique`);
  await expect(page.getByRole('heading', { name: 'Bibliothèque', exact: true })).toBeVisible();
  return { context, page, state, uploads, corrections, errors };
}
async function startUpload(page, entries = [{ name: 'notes.py', mimeType: 'text/plain', buffer: Buffer.from('print("bonjour")\n') }]) {
  await page.locator('.page-actions').getByRole('button', { name: 'Partager un document', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(entries);
  await modal.getByRole('button', { name: /^Classer les documents/ }).click();
  return modal;
}
async function setPart(modal, index, value) {
  const row = modal.locator('.upload-file').nth(index);
  await row.getByRole('button', { name: /^Modifier / }).click();
  await chooseOption(row.getByLabel(/^Part\/Chapitre/), /^(complet|complete)$/i.test(value) ? 'complete' : value);
}
async function options(page, trigger) {
  await trigger.click();
  const values = await page.getByRole('listbox').locator('[role="option"]').evaluateAll(items => items.map(item => item.getAttribute('data-value')));
  await trigger.press('Escape');
  return values;
}
async function fits(page) {
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, modal: (() => { const el = document.querySelector('.modal'); return el ? { width: el.clientWidth, scroll: el.scrollWidth } : null; })() }));
  assert.ok(sizes.scroll <= sizes.width + 1, JSON.stringify(sizes));
  if (sizes.modal) assert.ok(sizes.modal.scroll <= sizes.modal.width + 1, JSON.stringify(sizes));
}
async function scenario(name, run) { await run(); results.push(name); console.log(`PASS ${name}`); }

try {
  await scenario('Current year precedes past years and unknown after pagination; filters and reuse preserve one record', async () => {
    const resources = [doc(1, null), doc(2, '2024/2025'), doc(3, '2025/2026'), ...Array.from({ length: 26 }, (_, i) => doc(i + 10, '2026/2027'))];
    resources.push(doc(80, '2024/2025', { academic_years: ['2024/2025', '2026/2027'] }));
    const f = await fixture({ resources });
    try {
      await expect(f.page.locator('.library-year-heading h3')).toHaveText(['2026/2027']);
      await expect(f.page.locator('.document-card')).toHaveCount(24);
      await f.page.getByRole('button', { name: 'Documents suivants', exact: true }).click();
      await expect(f.page.locator('.library-year-heading h3')).toHaveText(['2026/2027', '2025/2026', '2024/2025', 'Année inconnue']);
      await expect(f.page.locator('.library-year-group').last().locator('.document-card')).toHaveAttribute('id', 'resource-1');
      await chooseOption(f.page.getByLabel('Année universitaire d’utilisation'), '2024/2025');
      await expect(f.page.locator('.library-year-heading h3')).toHaveText(['2024/2025']);
      await expect(f.page.locator('.document-card')).toHaveCount(2);
      assert.equal(await f.page.locator('#resource-80').count(), 1);
      await chooseOption(f.page.getByLabel('Année universitaire d’utilisation'), 'unknown');
      await expect(f.page.locator('.document-card')).toHaveAttribute('id', 'resource-1');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await scenario('Authorized year correction and multi-year reuse update one existing document on mobile', async () => {
    const f = await fixture({ resources: [doc(1, null)], width: 390 });
    try {
      await f.page.getByRole('button', { name: 'Corriger l’année de cours-1.pdf' }).click();
      const modal = f.page.getByRole('dialog');
      await chooseOption(modal.getByLabel('Année universitaire', { exact: true }), '2025/2026');
      await modal.getByRole('button', { name: 'Ajouter une année de réutilisation', exact: true }).click();
      await chooseOption(modal.getByLabel('Année universitaire', { exact: true }).nth(1), '2026/2027');
      await fits(f.page);
      await modal.getByRole('button', { name: 'Enregistrer', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(f.page.locator('.library-year-heading h3')).toHaveText(['2026/2027']);
      await expect(f.page.locator('#resource-1')).toHaveCount(1);
      assert.equal(f.state.resources.length, 1);
      assert.deepEqual(f.corrections[0].academic_years.sort(), ['2025/2026', '2026/2027']);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await scenario('Ordinary upload exposes only its semester pair and configured academic year', async () => {
    const f = await fixture({ width: 390 });
    try {
      const modal = await startUpload(f.page);
      assert.deepEqual(await options(f.page, modal.getByLabel(/^Semestre/)), ['3', '4']);
      await expect(modal.getByLabel('Année universitaire', { exact: true })).toContainText('2026/2027');
      await chooseOption(modal.getByLabel(/^Semestre/), '4');
      await modal.getByLabel(/^Module/).fill('Linguistique');
      await setPart(modal, 0, 'Complet');
      await fits(f.page);
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
      await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
      assert.equal(f.uploads[0].filename, 'notes.py');
      assert.equal(f.uploads[0].fields.semester, '4');
      assert.equal(f.uploads[0].fields.academic_year, '2026/2027');
      assert.equal(f.uploads[0].fields.filiere_id, 'french_studies');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await scenario('Server XP capability permits six own-program semesters and revocation returns the pair', async () => {
    for (const semesters of [[1, 2, 3, 4, 5, 6], [3, 4]]) {
      const f = await fixture({ user: { ...student, validated_xp: 10000, uploadCapabilities: { scopes: [ownScope(semesters)], source: semesters.length === 6 ? 'xp_leader' : 'study_year' } } });
      try {
        const modal = await startUpload(f.page);
        assert.deepEqual(await options(f.page, modal.getByLabel(/^Semestre/)), semesters.map(String));
        await expect(modal.getByLabel('Filière de destination', { exact: true })).toHaveCount(0);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
  });
  await scenario('Appointed administrator destination choices contain only server-authorized programs', async () => {
    const scopes = [ownScope([1, 2, 3, 4, 5, 6]), { facultyId: 'flaa', filiereId: 'arabic_studies', semesters: [5, 6] }];
    const f = await fixture({ user: { ...student, role: 'faculty_admin', filiere_id: null, uploadCapabilities: { scopes, source: 'appointment' } } });
    try {
      const modal = await startUpload(f.page);
      assert.deepEqual(await options(f.page, modal.getByLabel('Filière de destination', { exact: true })), ['french_studies', 'arabic_studies']);
      await chooseOption(modal.getByLabel('Filière de destination', { exact: true }), 'arabic_studies');
      assert.deepEqual(await options(f.page, modal.getByLabel(/^Semestre/)), ['5', '6']);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await scenario('Broad formats keep separate parts, academic metadata and completed entries during retry', async () => {
    const entries = [{ name: 'cours.html', mimeType: 'text/html', buffer: Buffer.from('<h1>Cours</h1><script>window.uploadExecuted=true</script>') }, { name: 'donnees.csv', mimeType: 'text/csv', buffer: Buffer.from('année,valeur\n2026,10\n') }];
    const f = await fixture({ failSecond: true });
    try {
      const modal = await startUpload(f.page, entries);
      await modal.getByLabel(/^Module/).fill('Linguistique');
      await setPart(modal, 0, '1'); await setPart(modal, 1, '2');
      await modal.getByRole('button', { name: /^Vérifier/ }).click();
      await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
      await expect(modal.locator('.upload-error')).toContainText('Interruption de test');
      await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
      await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
      assert.deepEqual(f.uploads.map(item => item.filename), ['cours.html', 'donnees.csv', 'donnees.csv']);
      assert.ok(f.uploads.every(item => item.fields.academic_year === '2026/2027'));
      assert.equal(await f.page.evaluate(() => window.uploadExecuted), undefined);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  writeFileSync('test-results/library-academic-report.json', JSON.stringify({ passed: results }, null, 2));
  console.log(`All ${results.length} academic library and scoped upload scenarios passed.`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'test-results/library-academic-failure.png' }).catch(() => {});
  writeFileSync('test-results/library-academic-report.json', JSON.stringify({ passed: results, error: error.message }, null, 2));
  throw error;
} finally { await browser.close(); }
