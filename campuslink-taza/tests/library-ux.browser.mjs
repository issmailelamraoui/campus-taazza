import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';
import { chooseOption } from './ui.helpers.mjs';

// Account, library, and live traffic stays inside this fixture. No reader,
// uploads, campus databases, or connected user state is touched by these tests.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/library-ux/chromium';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const expect = browserExpect.configure({ timeout: 15000 });
const report = { passed: [], layouts: [], errors: [] };
const alpha = 'ADMINISTRATION DES BASES DE DONNÉES ET SYSTÈMES D’INFORMATION DISTRIBUÉS';
const alphaKey = alpha.toLocaleLowerCase();
const beta = 'STATISTIQUES ET PROBABILITÉS';
const urlState = page => new URL(page.url()).searchParams;

async function fixture({ width = 1440, height = 960, theme = 'dark', language = 'fr' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900,
    serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ theme, language }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { theme, language });
  const user = { id: 3, username: 'library-ux-fixture', name: 'Library UX fixture', role: 'student',
    account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5,
    current_academic_year: '2026/2027', language };
  const resource = (id, module, overrides = {}) => ({ id, module, title: `beacon document ${id}`,
    filename: `beacon-document-${id}.pdf`, faculty_id: 'fsa', filiere_id: 'data_science', semester: 5,
    category: 'courses', resource_type: 'courses', part_number: String(id % 3 + 1), teacher_name: 'Professeure Amal',
    academic_year: '2026/2027', academic_years: ['2026/2027'], author: user, author_id: 3,
    created_at: new Date(Date.now() - id * 1000).toISOString(), size: 512, mime: 'application/pdf', library_visible: true,
    ...overrides });
  const resources = [
    ...Array.from({ length: 30 }, (_, index) => resource(1001 + index, alpha,
      index === 0 ? { title: 'outside-marker beacon document' } : {})),
    ...Array.from({ length: 25 }, (_, index) => resource(2001 + index, beta)),
    resource(3001, alpha, { title: 'inside-folder notes', filename: 'inside-folder.pdf', relative_path: 'Archive/week-1/inside-folder.pdf' }),
    resource(3002, alpha, { title: 'inside-folder exercises', filename: 'inside-exercises.pdf', relative_path: 'Archive/week-1/inside-exercises.pdf', category: 'exercises', resource_type: 'exercises' }),
    resource(3003, 'XML', { title: 'XML overview', filename: 'xml-overview.pdf', category: 'exams', resource_type: 'exams', academic_year: '2025/2026', academic_years: ['2025/2026'] }),
    resource(9001, alpha, { filiere_id: 'information_systems' }),
    resource(9002, alpha, { faculty_id: 'feg', filiere_id: 'economics' }),
    resource(9003, alpha, { semester: 3 }),
    resource(9004, alpha, { library_visible: false }),
    resource(9005, alpha, { status: 'removed' }),
  ];
  const errors = [], writes = [];
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    if (path === '/api/session' && request.method() === 'GET') return route.fulfill({ json: { user } });
    if (path === '/api/modules' && request.method() === 'GET') return route.fulfill({ json: { modules: [] } });
    if ((path === '/api/bootstrap' || path === '/api/live') && request.method() === 'GET') return route.fulfill({ json: {
      user, faculty: { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées' }, resources,
      messages: [], announcements: [], notifications: [], saved: [], history: [], events: [], members: [], channels: [],
    } });
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected Library UX fixture request' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  await page.goto(`${origin}/app/library?semester=5`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.library-module-folder')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, writes, resources, width, height, theme, language };
}

const search = page => page.locator('.library-toolbar .library-search input');
const documentIds = page => page.locator('.document-card').evaluateAll(nodes => nodes.map(node => node.id));
async function fits(f, state) {
  const layout = await f.page.evaluate(() => {
    const root = document.documentElement;
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const tabs = [...document.querySelectorAll('.library-category-tabs [role="tab"]')];
    return { width: root.clientWidth, scrollWidth: root.scrollWidth,
      firstModuleTop: document.querySelector('.library-module-folder') ? rect(document.querySelector('.library-module-folder')).top + scrollY : null,
      boxes: [...document.querySelectorAll('.library-browse-controls,.library-module-trigger,.library-results-header,.document-card,.library-filter-panel')].map(node => ({ className: node.className, ...rect(node) })),
      tabs: tabs.map(rect) };
  });
  assert.ok(layout.scrollWidth <= layout.width + 1, `${state}: the page has no horizontal overflow`);
  for (const box of layout.boxes) assert.ok(box.left >= -1 && box.right <= layout.width + 1, `${state}: ${box.className} fits its screen`);
  if (layout.tabs.length) assert.ok(Math.max(...layout.tabs.map(tab => tab.top)) - Math.min(...layout.tabs.map(tab => tab.top)) <= 1, `${state}: document categories stay on one scrollable row`);
  report.layouts.push({ label: `${f.width}-${f.language}-${f.theme}-${state}`, ...layout });
}

async function directSearchAndPagination(f) {
  const { page } = f;
  await search(page).fill('beacon');
  await expect(page.locator('.document-card')).toHaveCount(24);
  assert.equal(urlState(page).has('module'), false, 'Semester-wide search must not silently pick a module');
  assert.equal(urlState(page).get('q'), 'beacon');
  await expect(page.locator('.library-module-folder')).toHaveCount(0);
  await expect(page.locator('.library-page-position')).toContainText('55');
  const first = await documentIds(page);
  assert.ok(first.every(id => !id.startsWith('resource-9')), 'Other faculties/programs/semesters and hidden files remain excluded');
  await page.locator('.library-pagination button').last().click();
  await expect(page.locator('.document-card')).toHaveCount(24);
  const next = await documentIds(page), pageValue = urlState(page).get('documentsPage');
  assert.ok(pageValue, 'Document pagination is represented in its shareable URL');
  assert.equal(next.some(id => first.includes(id)), false, 'The next page contains another 24 documents');
  const secondURL = page.url();
  await page.reload();
  await expect.poll(() => documentIds(page)).toEqual(next);
  assert.equal(urlState(page).get('documentsPage'), pageValue, 'Reload keeps the selected document page');
  await page.goBack();
  await expect.poll(() => documentIds(page)).toEqual(first);
  await page.goForward();
  await expect.poll(() => documentIds(page)).toEqual(next);
  assert.equal(page.url(), secondURL);
  await search(page).fill('outside-marker');
  await expect(page.locator('.document-card')).toHaveCount(1);
  await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-1001');
  assert.equal(urlState(page).has('documentsPage'), false, 'Changing filters returns to the first document page');
  report.passed.push('Semester-wide document search, academic exclusions,24-item pages,URL reload/history,query-reset page');
}

async function folderScope(f) {
  const { page } = f;
  const query = new URLSearchParams({ semester: '5', module: alphaKey, folder: 'Archive/week-1', folderOwner: '3' });
  await page.goto(`${origin}/app/library?${query}`);
  await expect(page.locator('.document-card')).toHaveCount(2);
  await search(page).fill('outside-marker');
  await expect(page.locator('.document-card')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toBeVisible();
  // The wider-scope action is named by the product and is distinct from reset.
  const widen = page.locator('.library-search-whole-module');
  await expect(widen).toBeVisible();
  await widen.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#resource-1001')).toBeVisible();
  assert.equal(urlState(page).get('module'), alphaKey);
  assert.equal(urlState(page).get('q'), 'outside-marker', 'Widening folder search preserves the question being asked');
  assert.equal(urlState(page).has('folder'), false);
  assert.equal(urlState(page).has('folderOwner'), false);
  await search(page).fill('inside-folder');
  await expect(page.locator('.document-card')).toHaveCount(2);
  assert.deepEqual((await documentIds(page)).sort(), ['resource-3001', 'resource-3002'], 'A module-root search includes matching documents in uploaded subfolders');
  report.passed.push('Folder search empty state offers explicit wider module scope while preserving query and selected module');
}

async function documentDeepLinks(f) {
  const { page } = f;
  for (const scope of [{ module: alphaKey }, { view: 'documents' }]) {
    const params = new URLSearchParams({ semester: '5', documentsPage: '999', ...scope });
    await page.goto(`${origin}/app/library?${params}#resource-1027`);
    const target = page.locator('#resource-1027');
    await expect(target).toBeVisible();
    await expect.poll(() => urlState(page).get('documentsPage')).toBe('2');
    assert.equal(new URL(page.url()).hash, '#resource-1027', 'Automatic page selection retains the document deep link');
    await expect.poll(() => target.evaluate(node => {
      const box = node.getBoundingClientRect();
      const header = document.querySelector('.app-header')?.getBoundingClientRect();
      return box.top >= (header?.bottom || 0) - 1 && box.bottom <= innerHeight + 1;
    }), { message: 'A shared document link actually brings its target into view' }).toBe(true);
  }
  report.passed.push('Module and overview Documents deep links override stale pages,retain hash,and reveal the document on page2');
}

try {
  const desktop = await fixture();
  try {
    await fits(desktop, 'overview');
    await desktop.page.screenshot({ path: `${output}/1440-fr-dark-overview.png`, fullPage: true });
    const picker = desktop.page.locator('.library-module-trigger');
    await picker.focus(); await desktop.page.keyboard.press('Enter');
    await expect(desktop.page.locator('.library-module-search input')).toBeFocused();
    await desktop.page.screenshot({ path: `${output}/1440-fr-dark-picker.png`, fullPage: true });
    await desktop.page.keyboard.press('Escape');
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await expect(picker).toBeFocused();
    await desktop.page.locator('.library-view-switch button[data-view="documents"]').click();
    await expect(desktop.page.locator('.document-card')).toHaveCount(24);
    assert.equal(urlState(desktop.page).get('view'), 'documents');
    await expect(desktop.page.locator('.library-results-count')).toContainText('58');
    await desktop.page.locator('.library-view-switch button[data-view="modules"]').click();
    await expect(desktop.page.locator('.library-module-folder')).toHaveCount(3);
    await expect(desktop.page.locator('.document-card')).toHaveCount(0);
    assert.equal(urlState(desktop.page).has('view'), false);
    report.passed.push('Explicit Documents/Modules views preserve the selected semester; keyboard picker focus and Escape work');
    await directSearchAndPagination(desktop);
    await fits(desktop, 'documents');
    await desktop.page.screenshot({ path: `${output}/1440-fr-dark-documents.png`, fullPage: true });
    await folderScope(desktop);
    await documentDeepLinks(desktop);
    await desktop.page.goto(`${origin}/app/library?semester=5&view=documents&date=garbage`);
    await expect(desktop.page.locator('.document-card')).toHaveCount(24);
    await expect.poll(() => urlState(desktop.page).get('date')).toBe(null);
    await search(desktop.page).fill('missing-ux-document');
    await expect(desktop.page.locator('.empty-state')).toBeVisible();
    const filteredEmpty = await desktop.page.locator('.empty-state h3').textContent();
    await desktop.page.locator('.semester-choice').filter({ hasText: /^S6$/ }).click();
    await expect(desktop.page.locator('.empty-state')).toBeVisible();
    await desktop.page.locator('.library-clear-filters').click();
    await expect(search(desktop.page)).toHaveValue('');
    assert.notEqual(await desktop.page.locator('.empty-state h3').textContent(), filteredEmpty, 'An empty semester is distinguished from a search with no matches');
    report.passed.push('Invalid date URLs are cleaned and empty semesters have a distinct state from empty searches');
    assert.deepEqual(desktop.errors, []);
    assert.deepEqual(desktop.writes, []);
  } finally { report.errors.push(...desktop.errors); await desktop.context.close(); }

  for (const settings of [
    { width: 320, height: 700, language: 'fr', theme: 'dark' },
    { width: 390, height: 844, language: 'ar', theme: 'light' },
    { width: 768, height: 1024, language: 'fr', theme: 'light' },
    { width: 1440, height: 960, language: 'ar', theme: 'dark' },
  ]) {
    const f = await fixture(settings), { page } = f, label = `${f.width}-${f.language}-${f.theme}`;
    try {
      await fits(f, 'overview');
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `${output}/${label}-overview.png`, fullPage: true });
      const filters = page.locator('.library-toolbar-actions button[aria-controls="library-filters"]');
      await expect(filters).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.library-academic-year-control')).toBeHidden();
      await filters.click();
      await chooseOption(page.locator('.library-academic-year-control').getByRole('combobox'), '2025/2026');
      await search(page).fill('XML overview');
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-3003');
      await fits(f, 'advanced-year-search');
      await page.locator('.library-clear-filters').focus();
      await page.keyboard.press('Enter');
      await expect(search(page)).toBeFocused();
      const tabs = page.locator('.library-category-tabs [role="tab"]');
      await tabs.first().focus();
      await page.keyboard.press('End');
      await expect(tabs.last()).toBeFocused();
      await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
      const lastVisible = await tabs.last().evaluate(node => {
        const r = node.getBoundingClientRect(), owner = node.parentElement.getBoundingClientRect();
        return r.left >= Math.max(owner.left, 0) - 1 && r.right <= Math.min(owner.right, innerWidth) + 1;
      });
      assert.ok(lastVisible, 'Keyboard navigation brings the last category into the scrollable strip');
      await expect(page.locator('.empty-state')).toBeVisible();
      await page.locator('.empty-state button').first().click();
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      await fits(f, 'after-empty-reset');
      await page.locator('.library-module-trigger').click();
      await expect(page.locator('.library-module-picker')).toBeVisible();
      await page.screenshot({ path: `${output}/${label}-picker.png`, fullPage: true });
      const moduleChoice = page.locator('.library-module-picker .module-choice').filter({ hasText: alpha });
      await moduleChoice.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.library-results-heading.is-module h2')).toHaveText(alpha);
      await expect(page.locator('.library-results-heading.is-module')).toBeFocused();
      await fits(f, 'module');
      await page.screenshot({ path: `${output}/${label}-module.png`, fullPage: true });
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.writes, []);
      report.passed.push(`${label}: compact overview/picker/module,advanced-year search,keyboard category scrolling,no overflow`);
    } finally { report.errors.push(...f.errors); await f.context.close(); }
  }
  console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
