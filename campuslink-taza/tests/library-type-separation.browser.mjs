import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox, expect } from '@playwright/test';
import { chooseOption } from './ui.helpers.mjs';

// All API requests, including uploads, are fulfilled by this local fixture.
// This suite never accesses campus accounts, databases, or object storage.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserName = process.env.CAMPUSLINK_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(browserName));
const browser = await ({ chromium, firefox })[browserName].launch({ headless: true,
  ...(browserName === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const directory = `test-results/library-type-separation/${browserName}`;
await mkdir(directory, { recursive: true });
const passed = [], measurements = [];
const fixtureState = new WeakMap();
const moduleName = 'ADMINISTRATION DES BASES DE DONNÉES ET SYSTÈMES DISTRIBUÉS';
const folderName = 'Dossier partagé des travaux et ressources du semestre';
const nestedName = 'Suite des exercices détaillés et corrigés';

function multipart(request) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers()['content-type'] || '');
  assert.ok(boundary, 'Uploads send multipart form data.');
  const fields = {};
  let filename;
  for (const section of request.postDataBuffer().toString('utf8').split(`--${boundary[1] || boundary[2]}`)) {
    const separator = section.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = section.slice(0, separator), name = /\bname="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    const original = /\bfilename="([^"]+)"/.exec(headers)?.[1];
    if (original) filename = original;
    else fields[name] = section.slice(separator + 4).replace(/\r\n$/, '');
  }
  assert.ok(filename, 'Upload keeps the original filename.');
  return { fields, filename };
}

async function fixture({ width, language = 'fr', theme = 'light', legacy = true }) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 },
    hasTouch: width < 900, reducedMotion: 'reduce', serviceWorkers: 'block',
    ...(browserName === 'chromium' ? { isMobile: width < 900 } : {}) });
  const user = { id: 2, username: 'library.fixture', name: 'Fixture Student', role: 'student',
    faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5,
    current_academic_year: '2026/2027', account_status: 'approved', language };
  const other = { ...user, id: 3, username: 'other.fixture', name: 'Other Student' };
  const resource = (id, category, extra = {}) => ({ id, title: `Fixture document ${id}`, filename: `fixture-${id}.txt`,
    relative_path: `fixture-${id}.txt`, mime: 'text/plain', version: 1, size: 64,
    faculty_id: user.faculty_id, filiere_id: user.filiere_id, semester: 5, module: moduleName,
    category, resource_type: category, part_number: String(id), teacher_name: 'Fixture professor',
    library_visible: true, academic_year: '2026/2027', academic_years: ['2026/2027'],
    created_at: '2026-10-22T10:00:00Z', author: user, ...extra });
  const inFolder = id => `${folderName}/fixture-${id}.txt`;
  const inNested = id => `${folderName}/${nestedName}/fixture-${id}.txt`;
  const resources = [
    resource(101, 'td'), resource(102, 'td', { relative_path: inFolder(102) }),
    resource(103, 'td', { relative_path: inNested(103) }),
    resource(104, 'td', { relative_path: inFolder(104), author: other }),
    resource(201, 'tp'), resource(202, 'tp', { relative_path: inFolder(202) }),
    resource(203, 'tp', { relative_path: inNested(203) }),
    resource(301, 'courses'), resource(302, 'courses', { relative_path: inFolder(302) }),
    ...(legacy ? [resource(401, 'tdtp'), resource(402, 'tdtp', { relative_path: inFolder(402) }),
      resource(403, 'tdtp', { relative_path: inNested(403) })] : []),
  ];
  const errors = [], requests = [], uploads = [];
  let nextId = 1000;
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap' || path === '/api/live') return route.fulfill({ json: { user,
      faculty: { id: user.faculty_id, code: 'FSA', name: 'Fixture faculty' }, resources,
      messages: [], announcements: [], notifications: [], events: [],
      saved: [101, 201, 301].map(id => ({ type: 'resource', id })),
      history: [101, 201, 301].map(resource_id => ({ resource_id })), members: [], channels: [] } });
    if (path === '/api/reading' || path === '/api/knowledge') return route.fulfill({ json: { positions: [], items: [] } });
    if (path === '/api/uploads' && request.method() === 'POST') {
      const uploaded = multipart(request), { fields, filename } = uploaded;
      uploaded.resource = resource(nextId++, fields.category, { title: fields.title, module: fields.module,
        filename, relative_path: fields.relative_path || filename, part_number: fields.part_number,
        resource_type: fields.resource_type, teacher_name: fields.teacher_name,
        semester: Number(fields.semester), library_visible: fields.library_visible === 'true' });
      resources.push(uploaded.resource); uploads.push(uploaded);
      return route.fulfill({ json: { resource: uploaded.resource } });
    }
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request.' } });
  });
  const page = await context.newPage();
  fixtureState.set(page, { resources, language });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/library?semester=5');
  await expect(page.locator('.library-module-folder')).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  return { page, context, errors, requests, uploads, resources };
}

const folderSection = (page, category) => page.locator(`.library-uploaded-folders .library-type-section[data-category="${category}"]`);
const fileSections = (page, category) => page.locator(`.library-year-group .library-type-section[data-category="${category}"]`);
const tab = (page, category) => page.getByRole('tab', { name: new RegExp(`^(?:${category === 'td' ? 'TD|أعمال موجهة' : 'TP|أعمال تطبيقية'})\\s*\\d+$`) });
async function expectCardType(page, id) {
  const { resources, language } = fixtureState.get(page);
  const resource = resources.find(item => String(item.id) === String(id));
  assert.ok(resource, `Every card references a known fixture resource: ${id}`);
  const labels = language === 'ar'
    ? { courses: 'الدروس', td: 'أعمال موجهة', tp: 'أعمال تطبيقية', tdtp: 'TD / TP (قديمة)' }
    : { courses: 'Cours', td: 'TD', tp: 'TP', tdtp: 'TD / TP (anciens)' };
  const badge = page.locator(`.document-card#resource-${id} .document-type`);
  await expect(badge).toHaveText(labels[resource.category]);
  await expect(badge).toBeVisible();
}
async function expectIds(page, expected) {
  await expect(page.locator('.document-card')).toHaveCount(expected.length);
  for (const id of expected) {
    await expect(page.locator(`.document-card#resource-${id}`)).toHaveCount(1);
    await expectCardType(page, id);
  }
}
async function expectCategory(page, category) {
  await expect(page).toHaveURL(url => url.searchParams.get('category') === category);
  await expect(tab(page, category)).toHaveAttribute('aria-selected', 'true');
}
async function fits(page, label) {
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    items: [...document.querySelectorAll('.library-type-section,.library-type-heading,.library-uploaded-folder,.document-card,.document-type,.library-folder-breadcrumbs,.modal')].map(node => {
      const box = node.getBoundingClientRect();
      return { className: node.className, left: box.left, right: box.right, width: node.clientWidth, scrollWidth: node.scrollWidth };
    }) }));
  assert.ok(layout.scrollWidth <= layout.width + 1, `${label}: no horizontal page overflow: ${JSON.stringify(layout)}`);
  for (const item of layout.items) assert.ok(item.left >= -1 && item.right <= layout.width + 1 && item.scrollWidth <= item.width + 2,
    `${label}: category sections, folders and files fit their viewport: ${JSON.stringify(item)}`);
  measurements.push({ label, ...layout });
}
async function expectAllSections(page, { legacy = true } = {}) {
  await expectIds(page, [101, 201, 301, ...(legacy ? [401] : [])]);
  for (const [category, fileId, folderCounts] of [
    ['courses', 301, [1]], ['td', 101, [1, 2]], ['tp', 201, [2]], ...(legacy ? [['tdtp', 401, [2]]] : []),
  ]) {
    await expect(fileSections(page, category).locator('.document-card')).toHaveAttribute('id', `resource-${fileId}`);
    await expect(fileSections(page, category).locator('.library-type-heading')).toBeVisible();
    const section = folderSection(page, category);
    await expect(section.locator('.library-type-heading')).toBeVisible();
    await expect(section.locator('.library-uploaded-folder')).toHaveCount(folderCounts.length);
    const counts = await section.locator('.library-uploaded-folder-copy').evaluateAll(nodes => nodes.map(node => {
      const count = [...node.querySelectorAll('span')].find(span => /^\d+\s/.test(span.textContent.trim()));
      return Number(count?.textContent.trim().match(/^\d+/)?.[0]);
    }).sort());
    assert.deepEqual(counts, folderCounts, `${category}: identical uploader paths count only this category`);
  }
}
async function uploadAs(page, category) {
  await page.locator('.page-actions .btn').click();
  const modal = page.locator('.upload-modal');
  await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `uploaded-${category}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Fixture ${category.toUpperCase()} upload`) });
  await modal.getByRole('button', { name: /^Classer les documents/ }).click();
  const batch = modal.locator('.upload-batch');
  await expect(batch.getByLabel(/^Module/)).toHaveValue(moduleName);
  await expect(batch.getByLabel(/^Semestre/)).toContainText('S5');
  await expect(batch.getByLabel(/^Catégorie/)).toHaveText(category.toUpperCase());
  const row = modal.locator('.upload-file');
  if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
  await chooseOption(row.locator('.upload-file-editor').getByLabel(/^Part\/Chapitre/), category === 'td' ? '18' : '19');
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await expect(modal.locator('.upload-review-list')).toContainText(category.toUpperCase());
  await fits(page, `upload-${category}`);
  await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

try {
  for (const settings of [
    { width: 320, language: 'fr', theme: 'light' }, { width: 320, language: 'ar', theme: 'dark' },
    { width: 390, language: 'fr', theme: 'dark' }, { width: 768, language: 'ar', theme: 'light' },
    { width: 1440, language: 'fr', theme: 'light' }, { width: 1440, language: 'ar', theme: 'dark' },
  ]) {
    const label = `${settings.width}-${settings.language}-${settings.theme}`;
    if (process.env.CAMPUSLINK_LIBRARY_TYPE_FILTER && !label.includes(process.env.CAMPUSLINK_LIBRARY_TYPE_FILTER)) continue;
    const f = await fixture(settings), { page } = f;
    try {
      await expect(tab(page, 'td').locator('.tab-count')).toHaveText('4');
      await expect(tab(page, 'tp').locator('.tab-count')).toHaveText('3');
      await page.locator('.library-module-folder').click();
      await expectAllSections(page);
      await fits(page, label + ': all categories');
      await page.screenshot({ path: `${directory}/${label}-categories.png`, fullPage: true });

      await tab(page, 'td').click();
      await expectCategory(page, 'td');
      await expectIds(page, [101]);
      await expect(page.locator('.library-uploaded-folder')).toHaveCount(2);
      await expect(folderSection(page, 'tp')).toHaveCount(0);
      await folderSection(page, 'td').locator('.library-uploaded-folder').filter({ hasText: '@library.fixture' }).click();
      await expect(page).toHaveURL(url => url.searchParams.get('folder') === folderName && url.searchParams.get('folderOwner') === 'library.fixture' && url.searchParams.get('category') === 'td');
      await expectIds(page, [102]);
      await expect(page.locator('.library-uploaded-folder')).toHaveCount(1);
      await page.locator('.library-uploaded-folder').click();
      await expect(page).toHaveURL(url => url.searchParams.get('folder') === `${folderName}/${nestedName}` && url.searchParams.get('category') === 'td');
      await expectIds(page, [103]);
      await fits(page, label + ': nested TD');
      await page.goBack(); await expectIds(page, [102]); await expectCategory(page, 'td');
      await page.goForward(); await expectIds(page, [103]); await expectCategory(page, 'td');
      await page.reload(); await expectIds(page, [103]); await expectCategory(page, 'td');
      await page.locator('.library-parent-folder').click(); await expectIds(page, [102]);
      await page.locator('.library-parent-folder').click(); await expectIds(page, [101]);
      await expectCategory(page, 'td');

      await tab(page, 'tp').click(); await expectCategory(page, 'tp');
      await expectIds(page, [201]);
      await expect(page.locator('.library-uploaded-folder')).toHaveCount(1);
      await page.goBack(); await expectCategory(page, 'td'); await expectIds(page, [101]);
      await page.goForward(); await expectCategory(page, 'tp'); await expectIds(page, [201]);
      await page.locator('.library-uploaded-folder').click(); await expectIds(page, [202]); await expectCategory(page, 'tp');
      await page.locator('.library-uploaded-folder').click(); await expectIds(page, [203]); await expectCategory(page, 'tp');
      await fits(page, label + ': nested TP');
      await tab(page, 'td').click(); await expectCategory(page, 'td'); await expectIds(page, [101]);
      await expect(page).toHaveURL(url => !url.searchParams.has('folder') && !url.searchParams.has('folderOwner'));

      // Opening the same path from the unfiltered overview must choose the
      // folder's category before traversing it, even with the same uploader.
      await page.goto(origin + '/app/library?' + new URLSearchParams({ semester: '5', module: moduleName }));
      await expectAllSections(page);
      await folderSection(page, 'tp').locator('.library-uploaded-folder').click();
      await expectCategory(page, 'tp'); await expectIds(page, [202]);
      await page.goto(origin + '/app/library?' + new URLSearchParams({ semester: '5', module: moduleName, category: 'tdtp' }));
      await expectIds(page, [401]);
      await expect(page.locator('.library-uploaded-folder')).toHaveCount(1);
      await page.locator('.library-uploaded-folder').click(); await expectIds(page, [402]);
      await expect(page).toHaveURL(url => url.searchParams.get('category') === 'tdtp');

      if (settings.language === 'fr' && [390, 1440].includes(settings.width)) {
        await page.goto(origin + '/app/library?' + new URLSearchParams({ semester: '5', module: moduleName }));
        await expectAllSections(page);
        await tab(page, 'td').click();
        await uploadAs(page, 'td');
        await tab(page, 'tp').click();
        await uploadAs(page, 'tp');
        assert.deepEqual(f.uploads.map(item => item.fields.category), ['td', 'tp']);
        assert.deepEqual(f.uploads.map(item => item.fields.resource_type), ['td', 'tp']);
        await tab(page, 'td').click(); await expectIds(page, [101, 1000]);
        await tab(page, 'tp').click(); await expectIds(page, [201, 1001]);
        await page.reload(); await expectIds(page, [201, 1001]);
        await tab(page, 'td').click(); await expectIds(page, [101, 1000]);
      }
      await page.goto(origin + '/app');
      const recent = page.locator(settings.width < 761 ? '.resource-stack-card.is-active .document-card' : '.document-card-recent:visible');
      await expect(recent).toHaveCount(settings.width < 761 ? 1 : settings.width <= 950 ? 2 : 3);
      for (const card of await recent.all()) await expectCardType(page, (await card.getAttribute('id')).replace(/^resource-/, ''));
      await page.goto(origin + '/app/saved');
      await expectIds(page, [101, 201, 301]);
      await fits(page, label + ': saved document type badges');
      await page.getByRole('tab', { name: settings.language === 'ar' ? 'المستندات التي تمت زيارتها' : 'Récemment consultés', exact: true }).click();
      await expectIds(page, [101, 201, 301]);
      await fits(page, label + ': history document type badges');
      assert.deepEqual(f.errors, []);
      assert.ok(f.requests.filter(request => !request.startsWith('GET ')).every(request => request === 'POST /api/uploads'));
      passed.push(`${label}: independent TD/TP, categorized root files and same-name folders, nesting/back/forward/reload, responsive type badges in library/Home/saved/history${f.uploads.length ? ', preserved upload category' : ''}`);
      console.log(`PASS ${label}`);
    } catch (error) {
      await page.screenshot({ path: `${directory}/${label}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await f.context.close(); }
  }
  if (!process.env.CAMPUSLINK_LIBRARY_TYPE_FILTER) {
    const f = await fixture({ width: 390, legacy: false });
    try {
      await expect(f.page.getByRole('tab', { name: /^TD \/ TP/ })).toHaveCount(0);
      await f.page.locator('.library-module-folder').click();
      await expectAllSections(f.page, { legacy: false });
      assert.deepEqual(f.errors, []);
      passed.push('No empty legacy TD / TP destination appears when all uploaded work has a precise type.');
    } finally { await f.context.close(); }
  }
  const suffix = process.env.CAMPUSLINK_LIBRARY_TYPE_FILTER ? `-${process.env.CAMPUSLINK_LIBRARY_TYPE_FILTER.replace(/[^a-z0-9-]/gi, '_')}` : '';
  await writeFile(`${directory}/results${suffix}.json`, JSON.stringify({ browser: browserName, passed, measurements }, null, 2));
  console.log(JSON.stringify({ browser: browserName, passed }, null, 2));
} finally { await browser.close(); }
