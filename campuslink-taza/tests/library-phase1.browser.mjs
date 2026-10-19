import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { chooseOption } from './ui.helpers.mjs';

// Every API call, including reading/history writes, remains inside this fixture.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const directory = 'test-results/library-phase1';
await mkdir(directory, { recursive: true });
const passed = [], measurements = [];
const moduleName = 'ADMINISTRATION DES BASES DE DONNÉES ET SYSTÈMES DISTRIBUÉS';
const facultyPrograms = [['fsa', 'data_science'], ['flaa', 'french_studies'], ['feg', 'economics'], ['fsjp', 'public_law']];

async function fixture({ width, language = 'fr', theme = 'light', faculty = 0 }) {
  const [facultyId, program] = facultyPrograms[faculty];
  const height = width < 500 ? 740 : 900;
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const user = { id: 2, name: 'Fixture Student', username: 'library.fixture', role: 'student', account_status: 'approved', faculty_id: facultyId, filiere_id: program, current_semester: 1, current_academic_year: '2026/2027', language };
  const other = { ...user, id: 3, username: 'other.fixture', name: 'Other Student' };
  const resource = (id, extra = {}) => ({ id, title: `Title reserved for details ${id}`, filename: `private-name-${id}.txt`, relative_path: `private-name-${id}.txt`, mime: 'text/plain', version: 1, size: 128, faculty_id: facultyId, filiere_id: program, semester: 1, module: moduleName, category: 'courses', resource_type: 'courses', part_number: String(id), teacher_name: 'Professor reserved for details', library_visible: true, academic_year: '2026/2027', academic_years: ['2026/2027'], created_at: '2026-10-01T10:00:00Z', author: user, ...extra });
  const resources = [resource(1), resource(2, { part_number: '125' }), resource(3, { relative_path: 'Cours/chapitre.txt' }), resource(4, { relative_path: 'Cours/Travaux dirigés/exercice.txt' }), resource(5, { relative_path: 'Cours/autre.txt', author: other })];
  const errors = [], writes = [];
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: facultyId, code: facultyId.toUpperCase(), name: 'Fixture faculty' }, resources, messages: [], announcements: [], notifications: [], saved: [], history: [], events: [], channels: [], members: [] } });
    if (path === '/api/reading' || path === '/api/knowledge') return route.fulfill({ json: { positions: [], items: [] } });
    if (path === '/api/history' || path.endsWith('/position')) { writes.push(path); return route.fulfill({ json: { ok: true, position: { ...request.postDataJSON(), revision: 1 } } }); }
    const reading = /^\/api\/reading\/(\d+)$/.exec(path);
    if (reading) { const item = resources.find(item => item.id === Number(reading[1])); return route.fulfill({ json: { document: { ...item, currentVersion: 1, url: `/api/reading/${item.id}/file?version=1` }, position: null, previousPositions: [], recovery: [] } }); }
    if (/^\/api\/reading\/\d+\/file$/.test(path)) return route.fulfill({ contentType: 'text/plain', body: 'Readable local fixture text. No private campus document is accessed.' });
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/library?semester=1');
  await expect(page.locator('.library-module-folder')).toHaveCount(1);
  return { page, context, user, errors, writes, width, language, theme, facultyId };
}
async function fits(f, label) {
  const geometry = await f.page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, items: [...document.querySelectorAll('.document-card,.library-uploaded-folder,.modal')].map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: node.clientWidth, scrollWidth: node.scrollWidth }; }) }));
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${label}: viewport overflow ${JSON.stringify(geometry)}`);
  for (const item of geometry.items) assert.ok(item.left >= -1 && item.right <= geometry.width + 1 && item.scrollWidth <= item.width + 1, `${label}: component overflow ${JSON.stringify(item)}`);
  measurements.push({ label, ...geometry });
}
try {
  for (const [index, width] of [320, 360, 390, 768, 1024, 1440, 1920].entries()) {
    if (process.env.CAMPUSLINK_LIBRARY_PHASE1_WIDTH && width !== Number(process.env.CAMPUSLINK_LIBRARY_PHASE1_WIDTH)) continue;
    const f = await fixture({ width, language: index % 2 ? 'ar' : 'fr', theme: index % 2 ? 'dark' : 'light', faculty: index % 4 });
    const { page } = f, label = `${width}-${f.language}-${f.facultyId}`;
    try {
      await fits(f, label + ': modules');
      await page.locator('.library-module-folder').click();
      await expect(page.locator('.document-card')).toHaveCount(2);
      await expect(page.locator('.document-copy h3')).toHaveText([moduleName, moduleName]);
      await expect(page.locator('#resource-1 .document-uploader bdi')).toHaveText('@library.fixture');
      await expect(page.locator('#resource-2 .part-label')).toContainText('125');
      assert.ok(!(await page.locator('#resource-1').innerText()).includes('private-name-1'));
      assert.ok(!(await page.locator('#resource-1').innerText()).includes('Professor reserved'));
      await expect(page.locator('.library-uploaded-folder')).toHaveCount(2);
      await fits(f, label + ': files');
      await page.screenshot({ path: `${directory}/${label}-module.png`, fullPage: true });
      await page.locator('.library-uploaded-folder').filter({ hasText: '@library.fixture' }).click();
      await expect(page).toHaveURL(url => url.searchParams.get('folder') === 'Cours' && url.searchParams.get('folderOwner') === 'library.fixture');
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-3');
      await expect(page.locator('.library-uploaded-folder')).toHaveCount(1);
      await page.locator('.library-uploaded-folder').click();
      await expect(page).toHaveURL(url => url.searchParams.get('folder') === 'Cours/Travaux dirigés');
      await expect(page.locator('.library-folder-breadcrumbs')).toBeInViewport();
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-4');
      await fits(f, label + ': nested directory');
      await page.reload();
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-4');
      await page.locator('.library-parent-folder').click();
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-3');
      await page.locator('.library-parent-folder').click();
      await expect(page.locator('.document-card')).toHaveCount(2);
      await page.locator('.library-uploaded-folder').filter({ hasText: '@other.fixture' }).click();
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-5');
      await page.goBack();
      await expect(page.locator('.document-card')).toHaveCount(2);
      if (width === 320 || width === 1440) {
        await page.locator('#resource-1 .document-main').click();
        const reader = page.locator('.study-reader-modal');
        await expect(reader.locator('.reader-text-document')).toContainText('Readable local fixture text.');
        await reader.locator('.reader-tools-toggle').click();
        await reader.locator('.reader-info-toggle').click();
        await expect(reader.locator('.reader-file-details')).toContainText('private-name-1.txt');
        await expect(reader.locator('.reader-file-details')).toContainText('Professor reserved for details');
        await fits(f, label + ': file details');
        await page.keyboard.press('Escape');
        await expect(reader).toHaveCount(0);
        await expect(page.locator('#resource-1 .document-main')).toBeFocused();
      }
      await page.locator('.page-actions .btn').click();
      const upload = page.locator('.upload-modal');
      await upload.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: 'local-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Local upload fixture') });
      await upload.locator('.upload-footer .btn-primary').click();
      await upload.locator('.upload-file button[aria-expanded]').click();
      const part = upload.locator('.upload-file-editor [role="combobox"]');
      await part.click();
      const options = page.getByRole('listbox').getByRole('option');
      assert.deepEqual(await options.evaluateAll(nodes => nodes.map(node => node.dataset.value)), ['complete', ...Array.from({ length: 20 }, (_, index) => String(index + 1))]);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await expect(part).toContainText('20');
      await chooseOption(part, 'complete');
      await upload.locator('.upload-batch input[role="combobox"]').fill('Nouveau module');
      await upload.locator('.upload-footer .btn-primary').click();
      await expect(upload.locator('.upload-review-list')).toBeVisible();
      await fits(f, label + ': upload review');
      await page.screenshot({ path: `${directory}/${label}-upload.png`, fullPage: true });
      await page.keyboard.press('Escape');
      assert.deepEqual(f.errors, []);
      assert.ok(f.writes.every(path => path === '/api/history' || path.endsWith('/position')));
      passed.push(`${label}: four-field cards, legacy chapters, separate nested folders, URL/back/reload, exact 21 chapter choices, upload review`);
      console.log(`PASS ${label}`);
    } catch (error) { await page.screenshot({ path: `${directory}/${label}-failure.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await f.context.close(); }
  }
  await writeFile(`${directory}/results${process.env.CAMPUSLINK_LIBRARY_PHASE1_WIDTH ? '-'+Number(process.env.CAMPUSLINK_LIBRARY_PHASE1_WIDTH) : ''}.json`, JSON.stringify({ passed, measurements }, null, 2));
} finally { await browser.close(); }
