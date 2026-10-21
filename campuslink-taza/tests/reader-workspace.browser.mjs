import { chromium, firefox, expect as playwrightExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chooseOption } from './ui.helpers.mjs';

// All API calls stay inside the browser fixture, including position and note
// writes. This suite never needs a database, a private file, or server seeding.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserName = process.env.CAMPUSLINK_READER_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await (browserName === 'firefox' ? firefox : chromium).launch({ ...(browserName === 'chromium' && existsSync(executablePath) ? { executablePath } : {}), headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const artifact = name => `test-results/${browserName === 'firefox' ? 'firefox-' : ''}${name}`;
const passed = [], measurements = [];
const expect = playwrightExpect.configure({ timeout: 10000 });
let activePage;
mkdirSync('test-results', { recursive: true });

function multipagePDF(pageCount = 3) {
  const escape = value => value.replace(/[\\()]/g, '\\$&');
  const pages = [
    ['Workspace fixture - page 1', 'Database administration: read the actual document.', 'Page one verifies initial reading space.'],
    ['Workspace fixture - page 2', 'Transactions keep database changes consistent.', 'Page two verifies continuous scroll navigation.'],
    ['Workspace fixture - page 3', 'Search beacon: indexing helps locate a passage.', 'Page three verifies search and private note source.'],
  ];
  while (pages.length < pageCount) pages.push([`Workspace fixture - page ${pages.length + 1}`, 'Continuous scrolling fixture.', 'Only nearby pages need canvas memory.']);
  const streams = pages.map(lines => `BT /F1 19 Tf 48 790 Td (${escape(lines[0])}) Tj /F1 12 Tf ${lines.slice(1).map(line => `0 -32 Td (${escape(line)}) Tj`).join(' ')} ET`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_,index) => `${4+index*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.flatMap((stream, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ]),
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

async function fixture({ width = 1300, height = 874, language = 'fr', theme = 'dark', fail = '', pageCount = 3, startPage = 1, savedPosition = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(browserName === 'chromium' ? { isMobile: width < 800 } : {}), hasTouch: width < 800, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const user = { id: 3, name: 'Student fixture', username: 'reader-fixture', role: 'student', account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5, current_academic_year: '2026/2027', language };
  const pdf = multipagePDF(pageCount);
  const base = { faculty_id: 'fsa', filiere_id: 'data_science', semester: 5, module: 'Administration des bases de donnees', version: 1, filename: 'administration.pdf', mime: 'application/pdf', size: pdf.length, library_visible: true, author: user, academic_year: '2026/2027', academic_years: ['2026/2027'], created_at: '2026-10-13T00:00:00Z' };
  const main = { ...base, id: 41, title: 'Administration Des Bases De Donnees', category: 'courses', resource_type: 'courses', part_number: 'complete' };
  const compare = { ...base, id: 42, title: 'Travaux diriges des bases de donnees', category: 'td', resource_type: 'td', part_number: '1' };
  const resources = [main, compare], notes = [], writes = [], errors = [], requests = [];
  const attempts = { metadata: 0, file: 0 };
  let positionRevision = 0;
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    requests.push({ path, method: request.method() });
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'fsa', name: 'Faculty fixture' }, resources, messages: [], announcements: [], notifications: [], saved: [], history: [], channels: [], members: [] } });
    if (/^\/api\/reading\/\d+\/file$/.test(path) || /^\/api\/files\/\d+$/.test(path)) {
      if (path === '/api/reading/41/file') {
        attempts.file++;
        if (fail === 'file' && attempts.file === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary PDF fixture failure' }) });
      }
      return route.fulfill({ contentType: 'application/pdf', body: pdf });
    }
    const reading = /^\/api\/reading\/(\d+)$/.exec(path);
    if (reading) {
      const resource = resources.find(item => item.id === Number(reading[1]));
      if (resource.id === 41) {
        attempts.metadata++;
        if (fail === 'metadata' && attempts.metadata === 1) return route.fulfill({ status: 503, json: { error: 'Temporary metadata fixture failure' } });
      }
      return route.fulfill({ json: { document: { ...resource, currentVersion: 1, url: `/api/reading/${resource.id}/file?version=1` }, position: savedPosition, previousPositions: [], recovery: [] } });
    }
    if (path.endsWith('/position')) {
      const body = request.postDataJSON();
      writes.push({ path, body });
      return route.fulfill({ json: { position: { ...body, revision: ++positionRevision } } });
    }
    if (path === '/api/knowledge' && request.method() === 'GET') return route.fulfill({ json: { items: notes.filter(note => !url.searchParams.has('resourceId') || Number(note.resourceId) === Number(url.searchParams.get('resourceId'))) } });
    if (path === '/api/knowledge' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const item = { ...body, source: { title: body.title }, revision: 1, createdAt: '2026-10-13T12:00:00Z', updatedAt: '2026-10-13T12:00:00Z' };
      notes.push(item);
      writes.push({ path, body });
      return route.fulfill({ status: 201, json: { item } });
    }
    if (path === '/api/reading') return route.fulfill({ json: { positions: [] } });
    if (path.startsWith('/api/resource-supplements/')) return route.fulfill({ json: { mainResourceId: Number(path.split('/').pop()), items: [], canManage: false, policy: { perMain: 20 } } });
    if (path.startsWith('/api/document-relations/')) return route.fulfill({ json: { resourceId: Number(path.split('/').pop()), version: 1, state: 'suggestions', canVerify: false, suggestions: [], mappings: [], limited: false } });
    if (path.startsWith('/api/document-repairs/')) return route.fulfill({ json: { currentVersion: 1, canReview: false, proposals: [] } });
    if (path.startsWith('/api/document-index/')) {
      writes.push({ path, body: request.postDataJSON() });
      return route.fulfill({ status: 201, json: { index: { resourceId: Number(path.split('/').pop()), version: 1, status: 'ready', pageCount: 3, searchable: true } } });
    }
    if (path === '/api/reports') {
      writes.push({ path, body: request.postDataJSON() });
      return route.fulfill({ status: 201, json: { ok: true } });
    }
    if (path === '/api/saved') return route.fulfill({ json: { saved: true } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', error => errors.push(error.message));
  const openedAt = Date.now();
  await page.goto(origin + `/app/library?mode=study&document=41${startPage ? `&page=${startPage}` : ''}&version=1`);
  const dialog = page.locator('.study-reader-modal');
  await expect(dialog).toBeVisible();
  const pane = dialog.locator('.reader-pane').first();
  return { context, page, dialog, pane, main, errors, writes, requests, notes, attempts, openedAt, width, height, language, theme };
}

async function rendered(f, number = 1, pane = f.pane) {
  const canvas = pane.locator(`canvas[aria-label="Page ${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(pane.locator(`.reader-page-slot[data-pdf-page="${number}"] .reader-text-layer`)).toContainText(`Workspace fixture - page ${number}`);
  if (pane === f.pane) {
    await expect(f.dialog.locator('.modal-header h2')).toHaveText(f.main.title);
    await expect(f.dialog.locator('.reader-document-context')).toContainText('S5');
    await expect(f.dialog.locator('.reader-document-context')).toContainText(f.main.module);
    await expect(f.dialog.locator('.reader-document-context .badge')).toHaveClass(/document-category-courses/);
  }
  const painted = () => canvas.evaluate(node => {
    const values = node.getContext('2d').getImageData(0, 0, node.width, Math.min(node.height, 400)).data;
    let opaque = 0, dark = 0;
    for (let index = 0; index < values.length; index += 16) {
      if (values[index + 3] > 240) opaque++;
      if (values[index + 3] > 240 && values[index] < 120 && values[index + 1] < 120 && values[index + 2] < 120) dark++;
    }
    return { opaque, dark, width: node.width, height: node.height };
  });
  await expect.poll(async () => {
    const pixels = await painted();
    return pixels.opaque > 100 && pixels.dark > 5;
  }, { message: 'PDF canvas must contain a painted page and readable text.' }).toBe(true);
}

async function fits(f) {
  const geometry = await f.dialog.evaluate(dialog => {
    const scroll = dialog.querySelector('.reader-pane-active .reader-scroll') || dialog.querySelector('.reader-scroll');
    const canvas = scroll.querySelector('canvas');
    const frame = dialog.getBoundingClientRect(), bounds = scroll.getBoundingClientRect(), paper = canvas.getBoundingClientRect();
    const root = document.documentElement;
    return { modal: { top: frame.top, bottom: frame.bottom, height: frame.height }, reading: { top: bounds.top, bottom: bounds.bottom, height: bounds.height, width: bounds.width, clientHeight: scroll.clientHeight }, canvas: { top: paper.top, bottom: paper.bottom, width: paper.width }, toolbarHeight: dialog.querySelector('.reader-controls').getBoundingClientRect().height, width: root.clientWidth, documentWidth: root.scrollWidth, dialogWidth: dialog.clientWidth, dialogScrollWidth: dialog.scrollWidth, modalBodyScroll: dialog.querySelector('.modal-body').scrollTop };
  });
  const landscape = f.width > f.height && f.height < 600;
  const minimum = landscape ? .48 : f.width < 800 ? .58 : .65;
  const maximumTop = landscape ? .47 : f.width < 800 ? .35 : .24;
  const topLimit = f.width < 800 ? Math.min(230, maximumTop * geometry.modal.height) : maximumTop * geometry.modal.height;
  assert.ok(geometry.documentWidth <= geometry.width + 1, 'No page overflow: ' + JSON.stringify(geometry));
  assert.ok(geometry.dialogScrollWidth <= geometry.dialogWidth + 1, 'No modal overflow: ' + JSON.stringify(geometry));
  assert.ok(geometry.reading.height / geometry.modal.height >= minimum, 'The document gets a substantial reading viewport: ' + JSON.stringify(geometry));
  assert.ok(geometry.reading.top - geometry.modal.top <= topLimit + 1, 'The PDF starts near the reader toolbar: ' + JSON.stringify(geometry));
  assert.ok(geometry.reading.bottom <= geometry.modal.bottom + 1, 'Reading viewport remains inside the modal: ' + JSON.stringify(geometry));
  assert.ok(geometry.canvas.top >= geometry.reading.top - 1 && geometry.canvas.top < geometry.reading.bottom - 80, 'The first PDF page is visible without scrolling the modal: ' + JSON.stringify(geometry));
  if (f.width < 800) assert.ok(geometry.toolbarHeight <= 56, 'Phone reading controls fit in one row with 44px touch targets: ' + JSON.stringify(geometry));
  assert.equal(geometry.modalBodyScroll, 0, 'The reader toolbar and document must open without modal scrolling.');
  measurements.push({ viewport: `${f.width}x${f.height}`, language: f.language, theme: f.theme, ...geometry });
  return geometry;
}

async function tools(f) {
  const toggle = f.pane.locator('.reader-tools-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = f.pane.locator('.reader-tools');
  await expect(panel).toBeVisible();
  const id = await toggle.getAttribute('aria-controls');
  assert.ok(id, 'Tools toggle needs aria-controls.');
  assert.equal(await panel.getAttribute('id'), id);
  return panel;
}

async function closeTools(f) {
  const close = f.pane.locator('.reader-tools-close');
  const hasClose = await close.count() > 0;
  if (hasClose) await close.click();
  else await f.pane.locator('.reader-tools-toggle').click();
  await expect(f.pane.locator('.reader-tools')).toHaveCount(0);
  await expect(f.pane.locator('.reader-tools-toggle')).toHaveAttribute('aria-expanded', 'false');
  if (hasClose) await expect(f.pane.locator('.reader-tools-toggle')).toBeFocused();
}

async function run(name, callback) {
  if (process.env.READER_TEST_CASE && !name.includes(process.env.READER_TEST_CASE)) return;
  await callback();
  passed.push(name);
  console.log('PASS ' + name);
}

async function scrollPage(f, number, pane = f.pane, offset = 0) {
  await pane.locator('.reader-scroll').evaluate((node, { number, offset }) => {
    node.scrollTop = node.querySelector(`[data-pdf-page="${number}"]`).offsetTop + offset;
  }, { number, offset });
  await expect(pane.locator('.reader-page-number input')).toHaveValue(String(number));
  await rendered(f, number, pane);
}

try {
  await run('Continuous PDF scrolling, committed page jumps and grouped tools on desktop', async () => {
    const f = await fixture();
    try {
      await rendered(f);
      assert.ok(Date.now() - f.openedAt < 10000, 'The small PDF opens promptly.');
      await fits(f);
      await expect(f.pane.locator('.reader-page-prev,.reader-page-next')).toHaveCount(0);
      await expect(f.pane.locator('.reader-controls button')).toHaveCount(1);
      await expect(f.pane.locator('.reader-tools')).toHaveCount(0);
      await expect(f.pane.locator('.reader-notes')).toHaveCount(0);
      await expect(f.dialog.locator('.reader-document-actions')).toHaveCount(0);
      await scrollPage(f, 2);
      await scrollPage(f, 1);
      const pageInput = f.pane.locator('.reader-page-number input');
      await pageInput.fill('3');
      await expect(f.pane.locator('canvas[aria-label="Page 1"]')).toBeInViewport();
      await pageInput.press('Enter');
      await rendered(f, 3);
      const readingScroll = f.pane.locator('.reader-scroll');
      await scrollPage(f, 3, f.pane, 140);
      const scrollTop = await readingScroll.evaluate(node => node.scrollTop);
      for (const draft of ['3', '']) {
        await pageInput.fill(draft);
        await pageInput.press('Enter');
        await expect(pageInput).toHaveValue('3');
        assert.equal(await readingScroll.evaluate(node => node.scrollTop), scrollTop, 'Unchanged and empty page drafts preserve reading position.');
        await pageInput.fill(draft);
        await pageInput.press('Tab');
        await expect(pageInput).toHaveValue('3');
        assert.equal(await readingScroll.evaluate(node => node.scrollTop), scrollTop, 'Blurring an unchanged or empty draft preserves reading position.');
      }
      await pageInput.fill('99');
      await pageInput.press('Enter');
      await expect(pageInput).toHaveValue('3');
      await pageInput.fill('1');
      await pageInput.press('Enter');
      await rendered(f);
      const panel = await tools(f);
      await panel.getByRole('button', { name: 'Agrandir', exact: true }).click();
      await expect(panel.locator('.reader-zoom')).toHaveText('110%');
      await rendered(f);
      await panel.getByRole('button', { name: 'Réduire le zoom', exact: true }).click();
      await panel.getByRole('button', { name: 'Adapter à la largeur', exact: true }).click();
      await f.page.screenshot({ path: artifact('reader-workspace-desktop-1300-tools.png') });
      await closeTools(f);
      await fits(f);
      await f.page.screenshot({ path: artifact('reader-workspace-desktop-1300-dark-fr.png') });
      assert.deepEqual(f.errors, []);
    } catch (error) { await f.page.screenshot({ path: artifact('reader-workspace-browser-failure.png'), fullPage: true }).catch(() => {}); throw error; } finally { await f.context.close(); }
  });

  await run('PDF search, notes, compare, focus and document tools remain functional', async () => {
    const f = await fixture({ width: 1440, height: 900 });
    try {
      await rendered(f);
      const panel = await tools(f);
      const search = panel.getByRole('textbox', { name: 'Rechercher dans ce PDF', exact: true });
      await search.fill('Search beacon');
      await search.press('Enter');
      const result = panel.locator('.reader-search-result');
      await expect(result).toHaveCount(1);
      await expect(result).toContainText('p. 3');
      await result.click();
      await rendered(f, 3);
      await expect(f.pane.locator('.reader-page-number input')).toHaveValue('3');
      await chooseOption(panel.getByLabel('Couleurs', { exact: true }), 'sepia');
      await expect(f.pane.locator('.reader-scroll')).toHaveClass(/tone-sepia/);
      await panel.getByLabel('Luminosité du document', { exact: true }).focus();
      await f.page.keyboard.press('Home');
      await expect(panel.getByLabel('Luminosité du document', { exact: true })).toHaveValue('0.35');
      await panel.getByRole('button', { name: 'Couleurs originales', exact: true }).click();
      await expect(panel.getByLabel('Luminosité du document', { exact: true })).toHaveValue('1');
      await expect(f.pane.locator('.reader-scroll')).toHaveClass(/tone-normal/);
      await expect(panel.getByRole('button', { name: 'Enregistrer hors ligne', exact: true })).toBeEnabled();
      await expect(panel.getByRole('button', { name: 'Proposer ou réviser une version corrigée', exact: true })).toBeEnabled();
      await panel.locator('.reader-info-toggle').click();
      await expect(panel.locator('.reader-file-details')).toContainText('administration.pdf');
      await panel.locator('.supplemental-files summary').click();
      await expect(panel.locator('.supplemental-files')).toContainText('Aucun complément');
      await panel.locator('.reader-quality-report summary').click();
      await panel.getByLabel('Précisions pour la vérification', { exact: true }).fill('The mock page three has a missing example.');
      await panel.getByRole('button', { name: 'Transmettre le signalement', exact: true }).click();
      assert.equal(f.writes.find(write => write.path === '/api/reports').body.details, 'p. 3 · v1\nThe mock page three has a missing example.');
      await panel.locator('.reader-notes-toggle').click();
      const notePanel = f.pane.locator('.reader-notes');
      await expect(notePanel).toBeVisible();
      await expect(f.pane.locator('.reader-tools')).toHaveCount(0);
      await notePanel.getByRole('button', { name: 'Nouvelle note', exact: true }).click();
      await notePanel.getByLabel('Titre', { exact: true }).fill('Transaction recap');
      await notePanel.getByLabel('Votre note', { exact: true }).fill('Keep a transaction consistent with the source on page three.');
      await notePanel.getByRole('button', { name: 'Enregistrer la note privée', exact: true }).click();
      await expect(notePanel.locator('.reader-note')).toContainText('Transaction recap');
      assert.equal(f.notes[0].resourceId, 41);
      assert.equal(f.notes[0].page, 3);
      assert.equal(f.notes[0].version, 1);
      await notePanel.getByRole('button', { name: 'Voir dans le document', exact: true }).click();
      await notePanel.locator('.reader-notes-close').click();
      await expect(f.pane.locator('.reader-tools-toggle')).toBeFocused();
      await tools(f);
      await panel.locator('.reader-compare-toggle').click();
      await closeTools(f);
      await chooseOption(f.dialog.getByLabel('Comparer avec', { exact: true }), '42');
      await expect(f.dialog.locator('.reader-pane')).toHaveCount(2);
      await rendered(f, 1, f.dialog.locator('.reader-pane').nth(1));
      await chooseOption(f.dialog.getByLabel('Comparer avec', { exact: true }), '');
      await expect(f.dialog.locator('.reader-pane')).toHaveCount(1);
      await tools(f);
      await panel.getByRole('button', { name: 'Mode focus', exact: true }).click();
      await expect(f.dialog).toHaveClass(/reader-focus/);
      await rendered(f, 3);
      await panel.getByRole('button', { name: 'Quitter le focus', exact: true }).click();
      await expect(f.dialog).not.toHaveClass(/reader-focus/);
      assert.deepEqual(f.errors, []);
    } catch (error) { await f.page.screenshot({ path: artifact('reader-workspace-browser-failure.png'), fullPage: true }).catch(() => {}); throw error; } finally { await f.context.close(); }
  });

  await run('Desktop, 320px, 390px, landscape and RTL work in both themes', async () => {
    for (const theme of ['dark', 'light']) for (const options of [
      { width: 390, height: 844 }, { width: 320, height: 640 },
      { width: 844, height: 390 }, { width: 1440, height: 900 },
      { width: 390, height: 844, language: 'ar' }, { width: 320, height: 640, language: 'ar' },
    ]) {
      const f = await fixture({ ...options, theme });
      try {
        await rendered(f);
        await fits(f);
        if (f.language === 'ar') assert.equal(await f.dialog.evaluate(node => getComputedStyle(node).direction), 'rtl');
        await expect(f.pane.locator('.reader-page-prev,.reader-page-next')).toHaveCount(0);
        const toggle = f.pane.locator('.reader-tools-toggle');
        const dimensions = await toggle.boundingBox();
        assert.ok(dimensions.width >= 36 && dimensions.height >= 36, 'Tools touch target remains comfortable.');
        await scrollPage(f, 2);
        await scrollPage(f, 1);
        const panel = await tools(f);
        const names = f.language === 'ar'
          ? { info: 'معلومات الملف', focus: 'وضع التركيز', save: 'حفظ', download: 'تنزيل' }
          : { info: 'Informations du fichier', focus: 'Mode focus', save: 'Enregistrer', download: 'Télécharger' };
        for (const [selector, name] of Object.entries({ '.reader-info-toggle': names.info, '.reader-focus-toggle': names.focus, '.reader-save-toggle': names.save, '.reader-download': names.download })) await expect(panel.locator(selector)).toHaveAccessibleName(name);
        const searchName = f.language === 'ar' ? 'البحث في هذا الملف' : 'Rechercher dans ce PDF';
        await panel.getByRole('textbox', { name: searchName, exact: true }).fill('Search beacon');
        await panel.getByRole('textbox', { name: searchName, exact: true }).press('Enter');
        await expect(panel.locator('.reader-search-result')).toHaveCount(1);
        await expect(panel.locator('.reader-tools-close')).toBeInViewport();
        const colors = await panel.locator('.reader-tools-close').evaluate(node => {
          const style = getComputedStyle(node), surface = getComputedStyle(node, '::before');
          return { background: surface.content !== 'none' ? surface.backgroundColor : style.backgroundColor, color: style.color };
        });
        assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)', 'Close controls have a visible tinted background.');
        if (f.width === 390) await f.page.screenshot({ path: artifact(`reader-workspace-${f.width}x${f.height}-${f.theme}-${f.language}-tools.png`) });
        await panel.locator('.reader-notes-toggle').click();
        await expect(f.pane.locator('.reader-notes')).toBeVisible();
        await expect(f.pane.locator('.reader-notes-close')).toBeInViewport();
        await f.pane.locator('.reader-notes-close').click();
        await expect(toggle).toBeFocused();
        if (f.width < 800) {
          await scrollPage(f, 2);
          await tools(f);
          await panel.locator('.reader-compare-toggle').click();
          await closeTools(f);
          const compareName = f.language === 'ar' ? 'مقارنة مع' : 'Comparer avec';
          await chooseOption(f.dialog.getByLabel(compareName, { exact: true }), '42');
          const secondary = f.dialog.locator('.reader-pane').nth(1);
          await rendered(f, 1, secondary);
          await expect(f.pane).toBeHidden();
          await f.dialog.locator('.reader-mobile-switch button').first().click();
          await rendered(f, 2);
          await expect(f.pane.locator('.reader-page-number input')).toHaveValue('2');
          await expect(secondary).toBeHidden();
          await chooseOption(f.dialog.getByLabel(compareName, { exact: true }), '');
          await tools(f);
          await panel.locator('.reader-compare-toggle').click();
          await closeTools(f);
          await expect(f.dialog.locator('.reader-compare')).toBeHidden();
          await scrollPage(f, 1);
        }
        await fits(f);
        await f.page.screenshot({ path: artifact(`reader-workspace-${f.width}x${f.height}-${f.theme}-${f.language}.png`) });
        assert.deepEqual(f.errors, []);
      } catch (error) { await f.page.screenshot({ path: artifact('reader-workspace-browser-failure.png'), fullPage: true }).catch(() => {}); throw error; } finally { await f.context.close(); }
    }
  });

  await run('Scrolling preserves exact-page text highlights and region notes', async () => {
    const f = await fixture({ startPage: 2 });
    try {
      await rendered(f, 2);
      await f.pane.locator('[data-pdf-page="2"] .reader-text-layer span').first().evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        node.closest('.reader-scroll').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
      await expect(f.pane.locator('.reader-selection-summary')).toContainText('Workspace fixture - page 2');
      await f.pane.getByRole('button', { name: 'Surligner', exact: true }).click();
      await f.pane.getByLabel('Titre', { exact: true }).fill('Exact page two highlight');
      await f.pane.getByRole('button', { name: 'Enregistrer la note privée', exact: true }).click();
      assert.equal(f.notes[0].page, 2);
      assert.ok(f.notes[0].anchor.length > 0);
      assert.ok(f.notes[0].anchor.every(rect => rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0));
      await expect(f.pane.locator('[data-pdf-page="2"] .reader-highlight')).not.toHaveCount(0);
      await f.pane.locator('.reader-notes-close').click();
      await scrollPage(f, 3);
      await expect(f.pane.locator('.reader-selection-summary')).toHaveCount(0);
      assert.equal(await f.page.evaluate(() => window.getSelection().toString()), '');
      const panel = await tools(f);
      await panel.getByRole('button', { name: 'Sélectionner une zone', exact: true }).click();
      const region = f.pane.locator('[data-pdf-page="3"] .reader-region-select');
      await expect(region).toBeVisible();
      const bounds = await region.boundingBox();
      await f.page.mouse.move(bounds.x + 20, bounds.y + 20);
      await f.page.mouse.down();
      await f.page.mouse.move(bounds.x + 170, bounds.y + 95);
      await f.page.mouse.up();
      await f.pane.getByRole('button', { name: 'Garder dans le coffre', exact: true }).click();
      await f.pane.getByLabel('Titre', { exact: true }).fill('Exact page three crop');
      await f.pane.getByRole('button', { name: 'Enregistrer la note privée', exact: true }).click();
      const crop = f.notes.find(note => note.title === 'Exact page three crop');
      assert.equal(crop.page, 3);
      assert.equal(crop.version, 1);
      assert.match(crop.imageData, /^data:image\/jpeg;base64,/);
      assert.deepEqual(f.errors, []);
    } catch (error) { await f.page.screenshot({ path: artifact('reader-workspace-browser-failure.png'), fullPage: true }).catch(() => {}); throw error; } finally { await f.context.close(); }
  });

  await run('Long PDFs render nearby pages and restore the saved page and position', async () => {
    const f = await fixture({ pageCount: 60, startPage: null, savedPosition: { page: 35, zoom: 1, scrollRatio: .35, revision: 1, preferences: {} } });
    try {
      await rendered(f, 35);
      await expect(f.pane.locator('.reader-page-number input')).toHaveValue('35');
      const restored = await f.pane.locator('.reader-scroll').evaluate(node => {
        const slot = node.querySelector('[data-pdf-page="35"]');
        return (node.scrollTop - slot.offsetTop) / (slot.offsetHeight-node.clientHeight);
      });
      assert.ok(Math.abs(restored - .35) < .03, `Restores local page offset: ${restored}`);
      assert.ok(await f.pane.locator('canvas').count() < 8, 'Distant pages do not retain canvases.');
      await scrollPage(f, 58);
      await expect.poll(() => f.pane.locator('canvas').count()).toBeLessThan(8);
      assert.deepEqual(f.errors, []);
    } catch (error) { await f.page.screenshot({ path: artifact('reader-workspace-browser-failure.png'), fullPage: true }).catch(() => {}); throw error; } finally { await f.context.close(); }
  });

  await run('Temporary PDF and metadata failures retry in the same reader', async () => {
    for (const fail of ['file', 'metadata']) {
      const f = await fixture({ fail });
      try {
        await expect(f.pane.getByRole('heading', { name: 'Document indisponible', exact: true })).toBeVisible();
        await f.pane.getByRole('button', { name: 'Réessayer', exact: true }).click();
        await rendered(f);
        await fits(f);
        assert.ok(f.attempts[fail] >= 2, 'Retry fetches the failed source again.');
        await expect(f.pane.getByRole('heading', { name: 'Document indisponible', exact: true })).toHaveCount(0);
        assert.deepEqual(f.errors, []);
      } catch (error) { await f.page.screenshot({ path: artifact('reader-workspace-browser-failure.png'), fullPage: true }).catch(() => {}); throw error; } finally { await f.context.close(); }
    }
  });
  writeFileSync(artifact('reader-workspace-browser-report.json'), JSON.stringify({ passed, measurements }, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: artifact('reader-workspace-browser-failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(artifact('reader-workspace-browser-report.json'), JSON.stringify({ passed, measurements, error: error.message }, null, 2));
  throw error;
} finally { await browser.close(); }
