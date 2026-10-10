import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Network fixtures keep these interface checks independent of real campus
// databases, user accounts, uploaded documents and storage credentials.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [];
const report = 'test-results/library-clarity-report.json';
let activePage;
mkdirSync('test-results', { recursive: true });

const user = { id: 2, username: 'clarity-fixture', name: 'Fixture Student', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
const longModule = 'ADMINISTRATION DES BASES DE DONNÉES ET SYSTÈMES D’INFORMATION DISTRIBUÉS';
const categories = ['courses', 'exercises', 'td', 'corrections', 'exams', 'rattrapage'];
const tabLabels = ['Tous', 'Cours', 'Exercices', 'TD / TP', 'Corrections', 'Examens', 'Rattrapages'];
function document(id, module, category = 'courses', extra = {}) {
  return { id, module, filename: `fixture-document-${id}.pdf`, title: `Fixture document ${id}`, faculty_id: 'flaa', filiere_id: 'french_studies', semester: 1, category, resource_type: category, part_number: String(id), teacher_name: 'Fixture Lecturer', created_at: '2026-10-10T10:00:00Z', size: 512, mime: 'application/pdf', library_visible: true, author: user, ...extra };
}
const documents = () => [
  ...categories.map((category, index) => document(index + 1, longModule, category)),
  document(11, 'XML'), document(12, 'xml'), document(13, 'Straße'),
  document(14, 'البرمجة وقواعد البيانات'), document(15, ''),
  ...Array.from({ length: 30 }, (_, index) => document(100 + index, `Module complémentaire ${String(index + 1).padStart(2, '0')}`)),
];
const pdf = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nInterface upload fixture.\n%%EOF') });
function multipart(request) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers()['content-type'] || '');
  assert.ok(boundary, 'The interface must send multipart file uploads.');
  const fields = {};
  let filename;
  for (const section of request.postDataBuffer().toString('utf8').split(`--${boundary[1] || boundary[2]}`)) {
    const separator = section.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const header = section.slice(0, separator);
    const name = /\bname="([^"]+)"/.exec(header)?.[1];
    if (!name) continue;
    const original = /\bfilename="([^"]+)"/.exec(header)?.[1];
    if (original) filename = original;
    else fields[name] = section.slice(separator + 4).replace(/\r\n$/, '');
  }
  assert.ok(filename, 'Uploads must retain the original filename.');
  return { fields, filename };
}
async function fixture({ width = 390, height = 844, theme = 'light', holdUploads = false, failSecond = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 800, isMobile: width < 800, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { resources: documents(), nextId: 1000 };
  const errors = [], uploads = [], held = [];
  await context.addInitScript(theme => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
  }, theme);
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/session') return route.fulfill({ json: { user } });
    if (pathname === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: state.resources, messages: [], announcements: [], notifications: [], events: [], saved: [], history: [], channels: [{ id: 'general', read_only: false }], members: [] } });
    if (pathname === '/api/uploads' && request.method() === 'POST') {
      const parsed = multipart(request); uploads.push(parsed);
      const finish = async () => {
        if (failSecond && uploads.length === 2) return route.fulfill({ status: 503, json: { error: 'Fixture interrupted upload.' } });
        const { fields, filename } = parsed;
        const resource = document(state.nextId++, fields.module, fields.category, { filename, title: fields.title, semester: Number(fields.semester), part_number: fields.part_number, teacher_name: fields.teacher_name });
        state.resources.push(resource);
        await route.fulfill({ json: { resource } });
      };
      if (holdUploads) { held.push({ filename: parsed.filename, finish }); return; }
      return finish();
    }
    errors.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request.' } });
  });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/app/library`);
  await expect(page.locator('.library-module-folder').first()).toBeVisible();
  return { context, page, state, errors, uploads, held };
}
async function fits(page, label, { modalHeight = false } = {}) {
  const bounds = await page.evaluate(() => {
    const dialog = document.querySelector('.modal');
    const r = dialog?.getBoundingClientRect();
    return { viewportWidth: document.documentElement.clientWidth, viewportHeight: innerHeight, pageWidth: document.documentElement.scrollWidth, modal: r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: dialog.clientWidth, scrollWidth: dialog.scrollWidth } : null };
  });
  assert.ok(bounds.pageWidth <= bounds.viewportWidth + 1, `${label}: page must not scroll horizontally: ${JSON.stringify(bounds)}`);
  if (bounds.modal) {
    assert.ok(bounds.modal.left >= -1 && bounds.modal.right <= bounds.viewportWidth + 1 && bounds.modal.scrollWidth <= bounds.modal.width + 1, `${label}: dialog must fit horizontally: ${JSON.stringify(bounds)}`);
    if (modalHeight) assert.ok(bounds.modal.top >= -1 && bounds.modal.bottom <= bounds.viewportHeight + 1, `${label}: dialog must remain within a short screen: ${JSON.stringify(bounds)}`);
  }
}
async function fullyReadable(locator, label) {
  await expect(locator).toBeVisible();
  const layout = await locator.evaluate(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node), range = document.createRange();
    range.selectNodeContents(node);
    return { clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, overflow: style.overflow, lineClamp: style.webkitLineClamp, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, lines: [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })) };
  });
  assert.ok(!layout.lineClamp || layout.lineClamp === 'none', `${label}: module names must not be line-clamped.`);
  assert.ok(layout.scrollHeight <= layout.clientHeight + 2, `${label}: module names must not be vertically clipped: ${JSON.stringify(layout)}`);
  for (const r of layout.lines) assert.ok(r.left >= layout.box.left - 1 && r.right <= layout.box.right + 1 && r.top >= layout.box.top - 2 && r.bottom <= layout.box.bottom + 2, `${label}: complete text must fit its visible bounds: ${JSON.stringify(layout)}`);
}
async function immediatelyOnScreen(locator, label) {
  // Read the committed layout without scrolling the page ourselves. A text
  // node that exists below the fold does not solve first-glance orientation.
  await expect.poll(() => locator.evaluate(node => {
    const header = document.querySelector('.app-header');
    const navigation = document.querySelector('.mobile-bottom-nav');
    const headerBox = header?.getBoundingClientRect();
    const navigationBox = navigation?.getBoundingClientRect();
    const top = headerBox && ['fixed', 'sticky'].includes(getComputedStyle(header).position) ? Math.max(0, headerBox.bottom) : 0;
    const bottom = navigationBox?.height && getComputedStyle(navigation).display !== 'none' ? Math.min(innerHeight, navigationBox.top) : innerHeight;
    const r = node.getBoundingClientRect();
    return { fullyVisible: r.top >= top - 1 && r.bottom <= bottom + 1 && r.left >= -1 && r.right <= innerWidth + 1, top, bottom, box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
  }), { message: `${label}: must appear fully within the usable screen without a test scroll`, timeout: 5000 }).toMatchObject({ fullyVisible: true });
}
async function categoriesVisible(page, label) {
  const tabs = page.getByRole('tablist', { name: 'Choisir une catégorie', exact: true });
  await tabs.scrollIntoViewIfNeeded();
  await expect(tabs.getByRole('tab')).toHaveCount(7);
  const layout = await tabs.evaluate(node => ({ width: document.documentElement.clientWidth, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, tabs: [...node.querySelectorAll('[role="tab"]')].map(tab => { const r = tab.getBoundingClientRect(); return { text: tab.textContent, left: r.left, right: r.right, height: r.height }; }) }));
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${label}: categories must be visible without horizontal scrolling.`);
  for (const tab of layout.tabs) {
    assert.ok(tab.left >= 0 && tab.right <= layout.width + 1, `${label}: every category must fit: ${JSON.stringify(tab)}`);
    if (layout.width < 800) assert.ok(tab.height >= 40, `${label}: each category needs a usable touch target: ${JSON.stringify(tab)}`);
  }
}
async function upload(page, names) {
  await page.locator('.page-actions').getByRole('button', { name: 'Partager un document', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(names.map(pdf));
  await modal.getByRole('button', { name: /^Classer les documents/ }).click();
  await modal.locator('.upload-batch').getByLabel(/^Module/).fill('Interface Upload');
  for (const [index] of names.entries()) {
    const row = modal.locator('.upload-file').nth(index);
    if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
    await row.getByLabel(/^Part\/Chapitre/).fill(String(index + 1));
  }
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  return modal;
}
async function pending(modal, count, total, filename) {
  await expect(modal.getByRole('heading', { name: 'Envoi des documents…', exact: true })).toHaveCount(1);
  await expect(modal.locator('.upload-spinner')).toHaveCount(1);
  const progress = modal.getByRole('progressbar', { name: 'Documents envoyés', exact: true });
  await expect(progress).toHaveCount(1);
  await expect(progress).toHaveAttribute('aria-valuenow', String(count));
  await expect(progress).toHaveAttribute('aria-valuemax', String(total));
  await expect(modal.locator('.upload-progress-count')).toHaveText(new RegExp(`^${count}\\s*/\\s*${total}$`));
  await expect(modal.locator('.upload-current-file-name')).toHaveText(filename);
  await expect(modal.locator('.upload-current-file-name')).toBeVisible();
}
async function scenario(name, run) {
  const filter = process.env.CAMPUSLINK_CLARITY_TEST_FILTER;
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  await run(); passed.push(name); console.log(`PASS ${name}`);
}

try {
  for (const width of [320, 390]) for (const theme of ['light', 'dark']) await scenario(`${width}px ${theme}: searchable module picker, full current folder name and all categories are clear and usable`, async () => {
    const f = await fixture({ width, height: width === 320 ? 640 : 844, theme });
    try {
      const { page } = f;
      const choose = page.getByRole('button', { name: 'Choisir un module', exact: true });
      await expect(choose).toBeVisible();
      await page.screenshot({ path: `test-results/library-clarity-${width}-${theme}-overview.png` });
      await choose.tap();
      await expect(choose).toHaveAttribute('aria-expanded', 'true');
      const moduleSearch = page.getByRole('textbox', { name: 'Rechercher un module', exact: true });
      await immediatelyOnScreen(moduleSearch, 'Module search immediately after opening the picker');
      await immediatelyOnScreen(page.locator('.library-modules .module-choice').first(), 'First module choice immediately after opening the picker');
      await moduleSearch.fill('administration');
      await expect(page.locator('.library-modules .module-choice')).toHaveCount(2);
      const choice = page.locator('.library-modules').getByRole('button', { name: longModule, exact: true });
      await fullyReadable(choice.locator('span[dir="auto"]'), 'Search result long module');
      await page.screenshot({ path: `test-results/library-clarity-${width}-${theme}-picker.png` });
      await choice.tap();
      await expect(page).toHaveURL(url => url.searchParams.get('module')?.toUpperCase() === longModule);
      await expect(page.locator('.document-card')).toHaveCount(6);
      const title = page.locator('.library-results-heading h2');
      await expect(title).toHaveText(longModule);
      await immediatelyOnScreen(title, 'Current module heading immediately after choosing a module');
      await fullyReadable(title, 'Current folder heading');
      await page.locator('.library-results-heading').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/library-clarity-${width}-${theme}-folder.png` });
      await categoriesVisible(page, `${width}px ${theme}`);
      await page.screenshot({ path: `test-results/library-clarity-${width}-${theme}-categories.png` });
      for (const [index, text] of tabLabels.entries()) {
        const tab = page.getByRole('tab', { name: new RegExp(`^${text.replace('/', '\\/')}(?:\\s|\\d|$)`) });
        await tab.tap();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.document-card')).toHaveCount(index === 0 ? 6 : 1);
        await expect(title).toHaveText(longModule);
        await fits(page, `${width}px ${theme}: ${text}`);
      }
      await page.getByRole('tab', { name: /^Tous/ }).tap();
      await page.getByRole('button', { name: 'Changer de module', exact: true }).tap();
      await immediatelyOnScreen(moduleSearch, 'Module search immediately after changing the module');
      await immediatelyOnScreen(page.locator('.library-modules .module-choice').first(), 'First module choice immediately after changing the module');
      await moduleSearch.fill('straße');
      await page.locator('.library-modules').getByRole('button', { name: 'STRASSE', exact: true }).tap();
      await expect(page).toHaveURL(url => url.searchParams.get('module') === 'straße');
      await expect(page.locator('.document-filename')).toHaveText('fixture-document-13.pdf');
      await page.goBack();
      await expect(title).toHaveText(longModule);
      await page.locator('.library-results-heading').getByRole('button', { name: 'Tous les modules', exact: true }).tap();
      await expect(page.locator('.library-module-folder')).toHaveCount(35);
      await page.getByRole('button', { name: 'Choisir un module', exact: true }).tap();
      await moduleSearch.fill('module complémentaire 30');
      await page.locator('.library-modules').getByRole('button', { name: 'MODULE COMPLÉMENTAIRE 30', exact: true }).tap();
      await expect(page.locator('.document-filename')).toHaveText('fixture-document-129.pdf');
      await expect(page.getByLabel('Rechercher des documents', { exact: true })).toHaveValue('');
      await page.getByRole('button', { name: 'Changer de module', exact: true }).tap();
      await moduleSearch.fill('Sans module');
      await page.locator('.library-modules').getByRole('button', { name: 'Sans module', exact: true }).tap();
      await expect(page).toHaveURL(url => url.searchParams.has('module') && url.searchParams.get('module') === '');
      await expect(page.locator('.document-filename')).toHaveText('fixture-document-15.pdf');
      assert.deepEqual(f.errors, []); assert.deepEqual(f.uploads, []);
    } finally { await f.context.close(); }
  });

  for (const theme of ['light', 'dark']) await scenario(`Desktop ${theme}: complete folder context and category navigation remain usable`, async () => {
    const f = await fixture({ width: 1280, height: 900, theme });
    try {
      const { page } = f;
      await page.locator('.library-module-folder').filter({ has: page.locator('.library-module-name', { hasText: longModule }) }).click();
      await expect(page.locator('.document-card')).toHaveCount(6);
      await fullyReadable(page.locator('.library-results-heading h2'), 'Desktop full folder name');
      await categoriesVisible(page, `Desktop ${theme}`);
      await page.getByRole('tab', { name: /^Examens/ }).click();
      await expect(page.locator('.document-filename')).toHaveText('fixture-document-5.pdf');
      await fits(page, `Desktop ${theme}`);
      await page.screenshot({ path: `test-results/library-clarity-desktop-${theme}.png` });
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  for (const size of [{ width: 320, height: 640, theme: 'light', names: ['one-original-document.pdf'] }, { width: 390, height: 844, theme: 'dark', names: ['first-original-document.pdf', 'second-original-document.pdf'] }, { width: 640, height: 360, theme: 'light', names: ['landscape-original-document.pdf'] }]) await scenario(`${size.width}×${size.height}: one upload panel shows truthful held-request progress and current filename`, async () => {
    const f = await fixture({ ...size, holdUploads: true });
    try {
      const modal = await upload(f.page, size.names);
      await expect.poll(() => f.held.length).toBe(1);
      for (const [index, filename] of size.names.entries()) {
        await pending(modal, index, size.names.length, filename);
        assert.equal(f.uploads.length, index + 1, 'Files must upload sequentially while the current request is pending.');
        await fits(f.page, `Pending ${size.width}×${size.height}`, { modalHeight: true });
        await modal.locator('.modal-header').scrollIntoViewIfNeeded();
        await f.page.screenshot({ path: `test-results/library-upload-${size.width}-${size.height}-${index + 1}.png` });
        await f.held.shift().finish();
        if (index + 1 < size.names.length) await expect.poll(() => f.held.length).toBe(1);
      }
      await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
      await expect(modal.getByRole('progressbar')).toHaveCount(0);
      await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
      await expect(modal).toHaveCount(0);
      assert.deepEqual(f.uploads.map(item => item.filename), size.names);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await scenario('Partial upload retry resumes at the completed count and sends only the failed original file', async () => {
    const f = await fixture({ width: 390, height: 844, theme: 'light', holdUploads: true, failSecond: true });
    try {
      const modal = await upload(f.page, ['retry-first.pdf', 'retry-second.pdf']);
      await expect.poll(() => f.held.length).toBe(1);
      await pending(modal, 0, 2, 'retry-first.pdf');
      await f.held.shift().finish();
      await expect.poll(() => f.held.length).toBe(1);
      await pending(modal, 1, 2, 'retry-second.pdf');
      await f.held.shift().finish();
      await expect(modal.locator('.upload-error')).toContainText('Fixture interrupted upload.');
      await expect(modal.getByRole('progressbar')).toHaveCount(0);
      await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
      await expect.poll(() => f.held.length).toBe(1);
      await pending(modal, 1, 2, 'retry-second.pdf');
      assert.deepEqual(f.uploads.map(item => item.filename), ['retry-first.pdf', 'retry-second.pdf', 'retry-second.pdf']);
      await f.page.screenshot({ path: 'test-results/library-upload-partial-retry.png' });
      await f.held.shift().finish();
      await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
      assert.equal(f.state.resources.filter(item => item.filename.startsWith('retry-')).length, 2);
      await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  writeFileSync(report, JSON.stringify({ passed, baseURL }, null, 2));
  console.log(`All ${passed.length} library clarity and upload feedback scenarios passed.`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'test-results/library-clarity-failure.png' }).catch(() => {});
  writeFileSync(report, JSON.stringify({ passed, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally { await browser.close(); }
