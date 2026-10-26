import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox, expect } from '@playwright/test';

// Every API request is intercepted. These UI checks cannot authenticate against
// or write to a developer's campus database or object storage.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserName = process.env.CAMPUSLINK_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(browserName));
const browser = await ({ chromium, firefox })[browserName].launch({
  headless: true,
  ...(browserName === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}),
});
const directory = `test-results/library-browse-clarity/${browserName}`;
await mkdir(directory, { recursive: true });
const passed = [], measurements = [];
const moduleName = 'ADMINISTRATION DES BASES DE DONNÉES ET SYSTÈMES D’INFORMATION DISTRIBUÉS';
const firstAuthor = 'Professeure Amal Benabdellah et équipe pédagogique';
const secondAuthor = 'الأستاذ عبد الرحمن المتخصص في قواعد البيانات';
const longFilename = 'administration_des_bases_de_donnees_et_systemes_information_distribues_chapitre_complet_cours_detaille_2026_2027.pdf';

function fixturePDF() {
  const stream = 'BT /F1 20 Tf 48 780 Td (Library clarity fixture document) Tj /F1 13 Tf 0 -32 Td (Readable document opens from its library card.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}
const pdf = fixturePDF();
function resources(user) {
  const resource = (id, overrides = {}) => ({
    id, title: `Document ${id}`, filename: `document-${id}.pdf`, mime: 'application/pdf',
    version: 1, currentVersion: 1, size: pdf.length, faculty_id: 'fsa', filiere_id: 'data_science',
    semester: 5, module: moduleName, category: 'courses', resource_type: 'courses',
    teacher_name: firstAuthor, part_number: '1', academic_year: '2026/2027', academic_years: ['2026/2027'],
    library_visible: true, author: user, created_at: new Date(Date.now() - 86400000).toISOString(),
    ...overrides,
  });
  return [
    resource(101, { title: 'Cours beacon : administration des bases de données et des systèmes répartis — chapitre complet', filename: longFilename }),
    resource(102, { title: 'Exercices beacon', category: 'exercises', resource_type: 'exercises', part_number: '2' }),
    resource(103, { title: 'Examen des bases de données', category: 'exams', resource_type: 'exams', teacher_name: secondAuthor, academic_year: '2025/2026', academic_years: ['2025/2026'], part_number: '3' }),
    resource(104, { title: 'Cours sans année', teacher_name: secondAuthor, academic_year: null, academic_years: [], part_number: '2', created_at: new Date(Date.now() - 45 * 86400000).toISOString() }),
    resource(105, { title: 'Correction du chapitre', category: 'corrections', resource_type: 'correction', part_number: '2' }),
    resource(201, { module: 'XML', title: 'Introduction XML' }),
    resource(301, { module: 'الاحتمالات والإحصاء', title: 'الاحتمالات والإحصاء: الدرس الكامل' }),
    resource(401, { semester: 3, module: 'Autre semestre', title: 'Excluded semester fixture' }),
  ];
}
async function fixture(settings) {
  const { width, language, theme } = settings;
  const height = width === 320 ? 700 : width < 900 ? 900 : 1000;
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900,
    ...(browserName === 'chromium' ? { isMobile: width < 900 } : {}), reducedMotion: 'reduce', serviceWorkers: 'block' });
  const user = { id: 3, name: 'Library clarity fixture student', username: 'library-fixture', role: 'student',
    account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5,
    current_academic_year: '2026/2027', language };
  const items = resources(user), requests = [], writes = [], errors = [];
  let revision = 0;
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
    if (path === '/api/modules' && request.method() === 'GET') return route.fulfill({ json: { modules: [] } });
    if (path === '/api/bootstrap' || path === '/api/live') return route.fulfill({ json: { user, faculty: { id: 'fsa', code: 'FSA', name: 'Fixture faculty' }, resources: items,
      messages: [], announcements: [], notifications: [], saved: [], history: [], events: [], members: [], channels: [{ id: 'general', read_only: false }] } });
    if (path === '/api/history') { writes.push({ path, body: request.postDataJSON() }); return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/reading') return route.fulfill({ json: { positions: [] } });
    if (path === '/api/knowledge') return route.fulfill({ json: { items: [] } });
    const reading = /^\/api\/reading\/(\d+)(?:\/(file|position))?$/.exec(path);
    if (reading) {
      const item = items.find(item => String(item.id) === reading[1]);
      assert.ok(item, `Unknown reader resource ${path}`);
      if (reading[2] === 'file') return route.fulfill({ contentType: 'application/pdf', body: pdf });
      if (reading[2] === 'position') { writes.push({ path, body: request.postDataJSON() }); return route.fulfill({ json: { position: { ...request.postDataJSON(), revision: ++revision } } }); }
      return route.fulfill({ json: { document: { ...item, url: `/api/reading/${item.id}/file?version=1` }, position: null, previousPositions: [], recovery: [] } });
    }
    if (/^\/api\/files\/\d+$/.test(path)) return route.fulfill({ contentType: 'application/pdf', body: pdf });
    if (/^\/api\/document-index\/\d+$/.test(path)) return route.fulfill({ json: { index: { resourceId: Number(path.split('/').at(-1)), version: 1, status: 'ready', pageCount: 1, searchable: true } } });
    if (/^\/api\/document-relations\/\d+$/.test(path)) return route.fulfill({ json: { state: 'suggestions', canVerify: false, suggestions: [], mappings: [], limited: false } });
    if (/^\/api\/document-repairs\/\d+$/.test(path)) return route.fulfill({ json: { currentVersion: 1, canReview: false, proposals: [] } });
    if (/^\/api\/resource-supplements\/\d+$/.test(path)) return route.fulfill({ json: { items: [], canManage: false, policy: { perMain: 20 } } });
    if (/^\/api\/reading-activity\/\d+\/start$/.test(path)) return route.fulfill({ status: 409, json: { code: 'DOCUMENT_INDEX_REQUIRED', error: 'Activity rewards intentionally disabled in interface fixture.' } });
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected interface fixture request.' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/library?semester=5');
  await expect(page.locator('.library-module-folder')).toHaveCount(3, { timeout: 30000 });
  return { context, page, items, requests, writes, errors, settings, height };
}

async function fits(page, label) {
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    cards: [...document.querySelectorAll('.library-module-tile,.library-browse-controls,.document-card,.library-filter-panel,.library-active-filters')].map(node => {
      const r = node.getBoundingClientRect(); return { className: node.className, left: r.left, right: r.right, width: r.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    }) }));
  assert.ok(layout.scrollWidth <= layout.width + 1, `${label}: no horizontal page overflow: ${JSON.stringify(layout)}`);
  for (const node of layout.cards) {
    assert.ok(node.left >= -1 && node.right <= layout.width + 1 && node.scrollWidth <= node.clientWidth + 2, `${label}: library sections fit: ${JSON.stringify(node)}`);
  }
  measurements.push({ label, ...layout });
}
async function readable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const layout = await locator.evaluate(node => {
    const r = node.getBoundingClientRect(), style = getComputedStyle(node), lines = [];
    const owner = node.closest('.library-module-folder,.module-choice,.library-results-title,.document-main,.library-filter-chip') || node;
    const ownerBox = owner.getBoundingClientRect();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      for (let offset = 0; offset < text.length; offset++) {
        if (!text.textContent[offset].trim()) continue;
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
        const glyph = range.getBoundingClientRect();
        lines.push({ left: glyph.left, right: glyph.right, top: glyph.top, bottom: glyph.bottom });
      }
    }
    return { text: node.textContent, box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      owner: { left: ownerBox.left, right: ownerBox.right, top: ownerBox.top, bottom: ownerBox.bottom },
      height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: style.overflowY,
      lineClamp: style.webkitLineClamp, textOverflow: style.textOverflow, lines };
  });
  assert.ok(!layout.lineClamp || layout.lineClamp === 'none', `${label}: readable content is not clamped.`);
  assert.notEqual(layout.textOverflow, 'ellipsis', `${label}: readable content is not replaced with an ellipsis.`);
  // Firefox includes Arabic font overhang in scrollHeight even with fully
  // visible overflow. Check actual clipping and the containing control rather
  // than equating a line-box metric with invisible text.
  if (layout.height && ['hidden', 'clip', 'auto', 'scroll'].includes(layout.overflow)) assert.ok(layout.scrollHeight <= layout.height + 2, `${label}: content is not vertically clipped: ${JSON.stringify(layout)}`);
  for (const glyph of layout.lines) assert.ok(glyph.left >= layout.box.left - 1 && glyph.right <= layout.box.right + 1 && glyph.top >= layout.owner.top - 2 && glyph.bottom <= layout.owner.bottom + 2,
    `${label}: all text fits its visible bounds: ${JSON.stringify({ text: layout.text, box: layout.box, glyph })}`);
}
async function usable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const geometry = await locator.evaluate(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right, name: node.getAttribute('aria-label') || node.textContent }; });
  assert.ok(geometry.width >= 39.5 && geometry.height >= 39.5, `${label}: touch target at least 40px: ${JSON.stringify(geometry)}`);
}
async function choose(page, control, value) {
  await control.click();
  await page.locator(`.custom-select-popup [role="option"][data-value=${JSON.stringify(value)}]`).click();
}
async function remove(page, name) {
  const item = page.locator(`.library-active-filters [data-filter="${name}"]`);
  const button = await item.getAttribute('role') === 'button' || await item.evaluate(node => node.tagName === 'BUTTON') ? item : item.getByRole('button');
  const keys = await page.locator('.library-filter-chips button[data-filter]').evaluateAll(nodes => nodes.map(node => node.dataset.filter));
  const index = keys.indexOf(name), remaining = keys.filter(key => key !== name);
  const next = remaining[Math.min(index, remaining.length - 1)];
  await expect(button).toHaveAttribute('aria-label', /Retirer le filtre|إزالة|حذف/);
  await usable(button, `Remove ${name}`);
  await button.focus(); await page.keyboard.press('Enter');
  await expect(item).toHaveCount(0);
  if (next) await expect(page.locator(`.library-filter-chips button[data-filter="${next}"]`)).toBeFocused();
  else await expect(page.locator('.library-toolbar .library-search input')).toBeFocused();
}
const urlState = page => new URL(page.url()).searchParams;
async function moduleRetained(page) {
  assert.equal(urlState(page).get('semester'), '5', 'Filtering retains the selected semester.');
  assert.equal(urlState(page).get('module'), moduleName.toLocaleLowerCase(), 'Filtering retains the selected module.');
}

try {
  for (const settings of [
    { width: 320, language: 'fr', theme: 'dark' }, { width: 320, language: 'ar', theme: 'light' },
    { width: 390, language: 'fr', theme: 'light' }, { width: 390, language: 'ar', theme: 'dark' },
    { width: 768, language: 'fr', theme: 'dark' }, { width: 768, language: 'ar', theme: 'light' },
    { width: 1440, language: 'fr', theme: 'light' }, { width: 1440, language: 'ar', theme: 'dark' },
  ]) {
    const label = `${settings.width}-${settings.language}-${settings.theme}`;
    if (process.env.CAMPUSLINK_CLARITY_TEST_FILTER && !label.includes(process.env.CAMPUSLINK_CLARITY_TEST_FILTER)) continue;
    const f = await fixture(settings), { page } = f;
    try {
      const ar = settings.language === 'ar';
      await expect(page.locator('html')).toHaveAttribute('dir', ar ? 'rtl' : 'ltr');
      await fits(page, `${label}: overview`);
      for (const title of await page.locator('.library-module-name').all()) await readable(title, `${label}: overview module name`);
      await page.screenshot({ path: `${directory}/${label}-overview.png`, fullPage: true });
      const picker = page.locator('.library-module-trigger');
      await usable(picker, `${label}: module picker`);
      await picker.focus(); await page.keyboard.press('Enter');
      await expect(picker).toHaveAttribute('aria-expanded', 'true');
      const moduleSearch = page.getByRole('textbox', { name: ar ? 'البحث عن وحدة' : 'Rechercher un module', exact: true });
      await moduleSearch.fill('administration');
      await expect(page.locator('.library-module-picker .library-module-tile')).toHaveCount(1);
      const choice = page.locator('.library-module-picker .module-choice').filter({ hasText: moduleName });
      await readable(choice.locator('span[dir="auto"]'), `${label}: full picker module name`);
      await choice.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.document-card')).toHaveCount(5);
      await moduleRetained(page);
      await readable(page.locator('.library-results-heading.is-module h2'), `${label}: selected module title`);
      await expect(page.locator('.library-results-count')).toContainText('5');
      await fits(page, `${label}: open module`);
      const categories = page.locator('.library-category-tabs [role="tab"]');
      await expect(categories).toHaveCount(8);
      for (const tab of await categories.all()) await usable(tab, `${label}: category`);
      await readable(page.locator('#resource-101 .document-copy h3'), `${label}: full module name`);
      await expect(page.locator('#resource-101 .document-main')).toHaveAttribute('aria-label', `${ar ? 'فتح المستند' : 'Ouvrir le document'} : ${f.items[0].title}`);
      await expect(page.locator('#resource-101 .document-open-label')).toHaveText(ar ? 'فتح المستند' : 'Ouvrir le document');
      await usable(page.locator('#resource-101 .save-btn'), `${label}: save document`);
      for (const selector of ['.document-copy h3', '.document-uploader bdi', '.document-type', '.part-label']) {
        await readable(page.locator(`#resource-101 ${selector}`), `${label}: ${selector}`);
      }
      for (const [id, text] of [[101, ar ? 'الدروس' : 'Cours'], [102, ar ? 'التمارين' : 'Exercices'], [103, ar ? 'الامتحانات' : 'Examens'], [104, ar ? 'الدروس' : 'Cours'], [105, ar ? 'التصحيحات' : 'Corrections']]) {
        const type = page.locator(`#resource-${id} .document-type`);
        await expect(type).toHaveText(text);
        await expect(type).toBeVisible();
      }
      await expect(page.locator('#resource-101 .document-filename,#resource-101 .document-author,#resource-101 .document-filiere,#resource-101 .document-date,#resource-101 .document-file-details')).toHaveCount(0);
      await expect(page.locator('#resource-101 .document-uploader bdi')).toHaveText('@library-fixture');
      await page.screenshot({ path: `${directory}/${label}-module.png`, fullPage: true });
      const pdfSearch = page.locator('.library-pdf-search'), pdfSummary = pdfSearch.locator('summary');
      await usable(pdfSummary, `${label}: advanced PDF search disclosure`);
      await pdfSummary.focus(); await page.keyboard.press('Enter');
      await expect(pdfSearch).toHaveJSProperty('open', true);
      await expect(pdfSearch.locator('.library-pdf-scope')).toContainText(ar ? 'جميع ملفات PDF المتاحة' : 'tous les PDF accessibles');
      await expect(pdfSearch.getByRole('searchbox', { name: ar ? 'البحث في ملفات PDF المفهرسة' : 'Rechercher dans les PDF indexés', exact: true })).toBeVisible();
      await fits(page, `${label}: expanded PDF search`);
      await pdfSummary.focus(); await page.keyboard.press('Enter');
      await expect(pdfSearch).toHaveJSProperty('open', false);

      // The share button opens the real dialog and returns keyboard focus.
      const share = page.locator('.library-share-current-module');
      await usable(share, `${label}: share module`);
      await share.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.module-share-dialog')).toBeVisible();
      await expect(page.locator('.module-share-dialog .community-module-copy strong')).toHaveText(moduleName);
      for (const destination of await page.locator('.module-share-destinations button').all()) await usable(destination, `${label}: share destination`);
      await page.keyboard.press('Escape');
      await expect(page.locator('.module-share-dialog')).toHaveCount(0);
      await expect(share).toBeFocused();

      const search = page.getByRole('textbox', { name: ar ? 'البحث في الوثائق' : 'Rechercher des documents', exact: true });
      await search.fill('beacon');
      await expect(page.locator('.document-card')).toHaveCount(2);
      await categories.nth(1).click();
      await expect(page.locator('.document-card')).toHaveCount(1);
      const filters = page.locator('.library-toolbar-actions button[aria-controls="library-filters"]');
      await usable(filters, `${label}: advanced filters`);
      await filters.click();
      await expect(filters).toHaveAttribute('aria-expanded', 'true');
      const year = page.locator('.library-academic-year-control').getByRole('combobox');
      await usable(year, `${label}: academic year`);
      await choose(page, year, '2026/2027');
      const author = page.locator('#library-filters').getByRole('combobox').nth(0);
      await usable(author, `${label}: author filter`);
      await choose(page, author, firstAuthor);
      for (const key of ['query', 'category', 'year', 'author']) await expect(page.locator(`.library-active-filters [data-filter="${key}"]`)).toBeVisible();
      await expect(page.locator('.document-card')).toHaveCount(1);
      await fits(page, `${label}: filter controls and active chips`);
      await page.screenshot({ path: `${directory}/${label}-filters.png`, fullPage: true });
      await remove(page, 'author'); await moduleRetained(page);
      assert.equal(urlState(page).get('q'), 'beacon'); assert.equal(urlState(page).get('category'), 'courses'); assert.equal(urlState(page).get('year'), '2026/2027');
      await remove(page, 'query'); await remove(page, 'year');
      await expect(page.locator('.document-card')).toHaveCount(2);
      await remove(page, 'category');
      await expect(page.locator('.document-card')).toHaveCount(5);
      await moduleRetained(page);
      await page.goBack();
      await expect(page.locator('.document-card')).toHaveCount(2);
      await expect(categories.nth(1)).toHaveAttribute('aria-selected', 'true');
      await page.goForward();
      await expect(page.locator('.document-card')).toHaveCount(5);
      await expect(categories.nth(0)).toHaveAttribute('aria-selected', 'true');

      // Keyboard tab navigation follows the reading direction and all labels
      // remain available, including the last category on a 320px screen.
      await categories.nth(0).focus(); await page.keyboard.press(ar ? 'ArrowLeft' : 'ArrowRight');
      await expect(categories.nth(1)).toBeFocused();
      await expect(categories.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.document-card')).toHaveCount(2);
      await page.keyboard.press('End');
      await expect(categories.nth(7)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.document-card')).toHaveCount(0);
      await expect(page.locator('.empty-state')).toBeVisible();
      await page.locator('.empty-state').getByRole('button').click();
      await expect(page.locator('.document-card')).toHaveCount(5);
      await moduleRetained(page);

      const sort = page.locator('.library-sort').getByRole('combobox');
      await usable(sort, `${label}: sorting`);
      await sort.focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
      await expect(sort).toContainText(ar ? 'حسب الجزء' : 'Par chapitre');
      await search.fill('no-such-library-file');
      await expect(page.locator('.empty-state')).toBeVisible();
      await expect(page.locator('.document-card')).toHaveCount(0);
      await page.locator('.library-clear-filters').focus(); await page.keyboard.press('Enter');
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('');
      await expect(page.locator('.document-card')).toHaveCount(5);
      await expect(sort).toContainText(ar ? 'حسب الجزء' : 'Par chapitre');
      await moduleRetained(page);
      assert.equal(urlState(page).get('sort'), 'part', 'Reset preserves the selected sort order in shareable URLs.');
      assert.deepEqual([...urlState(page).keys()].sort(), ['module', 'semester', 'sort']);
      await choose(page, year, 'unknown');
      await expect(page.locator('.document-card')).toHaveCount(1);
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-104');
      await page.locator('.library-filter-chips button[data-filter="year"]').click();
      await expect(page.locator('.library-filter-chips button[data-filter="year"]')).toHaveCount(0);
      await expect(search).not.toBeFocused();
      await expect(page.locator('.document-card')).toHaveCount(5);
      await choose(page, author, secondAuthor);
      await choose(page, page.locator('#library-filters').getByRole('combobox').nth(1), '2');
      await expect(page.locator('.document-card')).toHaveCount(1);
      await choose(page, page.locator('#library-filters').getByRole('combobox').nth(2), '7');
      await expect(page.locator('.empty-state')).toBeVisible();
      for (const key of ['author', 'part', 'date']) await expect(page.locator(`.library-active-filters [data-filter="${key}"]`)).toBeVisible();
      await remove(page, 'date');
      await expect(page.locator('.document-card')).toHaveAttribute('id', 'resource-104');
      await page.locator('.library-clear-filters').focus(); await page.keyboard.press('Enter');
      await expect(search).toBeFocused();
      await expect(page.locator('.document-card')).toHaveCount(5);
      await moduleRetained(page);

      // Optional study tools must still use the selected document after filtering.
      // Ordinary native PDF opening is verified by responsive-native-pdf.browser.mjs.
      await page.locator('#resource-101 .document-secondary-actions .icon-btn').first().focus(); await page.keyboard.press('Enter');
      const reader = page.locator('.study-reader-modal');
      await expect(reader).toBeVisible();
      await expect(reader.locator('canvas[aria-label="Page 1"]')).toBeVisible();
      assert.ok(f.requests.includes('GET /api/reading/101'), 'Reader opens the selected document.');
      await expect.poll(() => reader.locator('canvas[aria-label="Page 1"]').evaluate(canvas => {
        if (!canvas.width || !canvas.height) return false;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, Math.ceil(canvas.height / 3)).data;
        let paper = 0, ink = 0;
        for (let index = 0; index < pixels.length; index += 16) {
          if (pixels[index + 3] > 240) paper++;
          if (pixels[index + 3] > 240 && pixels[index] < 150 && pixels[index + 1] < 150 && pixels[index + 2] < 150) ink++;
        }
        return paper > 100 && ink > 5;
      }), { message: 'The selected document actually paints visible text on its PDF canvas.' }).toBe(true);
      await page.keyboard.press('Escape');
      await expect(reader).toHaveCount(0);
      await expect(page.locator('#resource-101 .document-secondary-actions .icon-btn').first()).toBeFocused();
      await moduleRetained(page);
      assert.ok(f.writes.every(write => write.path === '/api/history' || /^\/api\/reading\/101\/position$/.test(write.path)), 'Only reading/history fixture writes are permitted.');
      assert.deepEqual(f.errors, []);
      passed.push(`${label}: full names and metadata, touch controls, keyboard navigation, independent filters, module-preserving reset, sharing and document opening`);
      console.log(`PASS ${label}`);
    } catch (error) {
      await page.screenshot({ path: `${directory}/${label}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await f.context.close(); }
  }
  const suffix = process.env.CAMPUSLINK_CLARITY_TEST_FILTER ? `-${process.env.CAMPUSLINK_CLARITY_TEST_FILTER.replace(/[^a-z0-9-]/gi, '_')}` : '';
  await writeFile(`${directory}/results${suffix}.json`, JSON.stringify({ browser: browserName, passed, measurements }, null, 2));
  console.log(JSON.stringify({ browser: browserName, passed }, null, 2));
} finally { await browser.close(); }
