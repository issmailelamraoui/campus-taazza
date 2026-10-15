import { chromium, expect as playwrightExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chooseOption } from './ui.helpers.mjs';

// All API calls stay inside the browser fixture, including position and note
// writes. This suite never needs a database, a private file, or server seeding.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [], measurements = [];
const expect = playwrightExpect.configure({ timeout: 10000 });
let activePage;
mkdirSync('test-results', { recursive: true });

function multipagePDF() {
  const escape = value => value.replace(/[\\()]/g, '\\$&');
  const pages = [
    ['Workspace fixture - page 1', 'Database administration: read the actual document.', 'Page one verifies initial reading space.'],
    ['Workspace fixture - page 2', 'Transactions keep database changes consistent.', 'Page two verifies next and previous navigation.'],
    ['Workspace fixture - page 3', 'Search beacon: indexing helps locate a passage.', 'Page three verifies search and private note source.'],
  ];
  const streams = pages.map(lines => `BT /F1 19 Tf 48 790 Td (${escape(lines[0])}) Tj /F1 12 Tf ${lines.slice(1).map(line => `0 -32 Td (${escape(line)}) Tj`).join(' ')} ET`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
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

async function fixture({ width = 1300, height = 874, language = 'fr', theme = 'dark', fail = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 800, hasTouch: width < 800, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const user = { id: 3, name: 'Student fixture', username: 'reader-fixture', role: 'student', account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5, current_academic_year: '2026/2027', language };
  const pdf = multipagePDF();
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
      return route.fulfill({ json: { document: { ...resource, currentVersion: 1, url: `/api/reading/${resource.id}/file?version=1` }, position: null, previousPositions: [], recovery: [] } });
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
  await page.goto(origin + '/app/library?document=41&page=1&version=1');
  const dialog = page.locator('.study-reader-modal');
  await expect(dialog).toBeVisible();
  const pane = dialog.locator('.reader-pane').first();
  return { context, page, dialog, pane, main, errors, writes, requests, notes, attempts, openedAt, width, height, language, theme };
}

async function rendered(f, number = 1, pane = f.pane) {
  const canvas = pane.locator(`canvas[aria-label="Page ${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(pane.locator('.reader-text-layer')).toContainText(`Workspace fixture - page ${number}`);
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
  if (f.width < 800) assert.ok(geometry.toolbarHeight <= 48, 'Phone reading controls fit in one compact row: ' + JSON.stringify(geometry));
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

try {
  await run('Desktop 1300x874 opens a painted PDF above the fold and keeps navigation accessible', async () => {
    const f = await fixture();
    try {
      await rendered(f);
      assert.ok(Date.now() - f.openedAt < 10000, 'The small PDF opens promptly.');
      await fits(f);
      await expect(f.pane.locator('.reader-tools')).toHaveCount(0);
      await expect(f.pane.locator('.reader-notes')).toHaveCount(0);
      await expect(f.pane.locator('.reader-page-prev')).toBeDisabled();
      await expect(f.pane.locator('.reader-page-next')).toBeEnabled();
      await f.pane.locator('.reader-page-next').click();
      await rendered(f, 2);
      await f.pane.locator('.reader-page-prev').click();
      await rendered(f);
      const pageInput = f.pane.locator('.reader-page-number input');
      await pageInput.fill('3');
      await expect(f.pane.locator('canvas')).toHaveAttribute('aria-label', 'Page 1');
      await pageInput.press('Enter');
      await rendered(f, 3);
      const readingScroll = f.pane.locator('.reader-scroll');
      await readingScroll.evaluate(node => { node.scrollTop = 140; });
      for (const draft of ['3', '']) {
        await pageInput.fill(draft);
        await pageInput.press('Enter');
        await expect(pageInput).toHaveValue('3');
        await expect(f.pane.getByRole('button', { name: 'Agrandir', exact: true })).toBeEnabled();
        assert.equal(await readingScroll.evaluate(node => node.scrollTop), 140, 'Unchanged and empty page drafts preserve reading position.');
        await pageInput.fill(draft);
        await pageInput.press('Tab');
        await expect(pageInput).toHaveValue('3');
        assert.equal(await readingScroll.evaluate(node => node.scrollTop), 140, 'Blurring an unchanged or empty draft preserves reading position.');
      }
      await pageInput.fill('99');
      await pageInput.press('Enter');
      await expect(pageInput).toHaveValue('3');
      await rendered(f, 3);
      await pageInput.fill('1');
      await pageInput.press('Enter');
      await rendered(f);
      await f.pane.getByRole('button', { name: 'Agrandir', exact: true }).click();
      await expect(f.pane.locator('.reader-zoom')).toHaveText('110%');
      await rendered(f);
      await f.pane.getByRole('button', { name: 'Réduire le zoom', exact: true }).click();
      await rendered(f);
      const toggle = f.pane.locator('.reader-tools-toggle');
      await toggle.focus();
      await f.page.keyboard.press('Enter');
      await expect(f.pane.locator('.reader-tools')).toBeVisible();
      await f.page.screenshot({ path: 'test-results/reader-workspace-desktop-1300-tools.png' });
      await closeTools(f);
      await f.page.screenshot({ path: 'test-results/reader-workspace-desktop-1300-dark-fr.png' });
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await run('Desktop 1440x900 tools, PDF search, notes, compare and focus remain functional', async () => {
    const f = await fixture({ width: 1440, height: 900 });
    try {
      await rendered(f);
      await fits(f);
      const panel = await tools(f);
      const search = panel.getByRole('textbox', { name: 'Rechercher dans ce PDF', exact: true });
      await search.fill('Search beacon');
      await search.press('Enter');
      const result = panel.locator('.reader-search-result');
      await expect(result).toHaveCount(1);
      await expect(result).toContainText('p. 3');
      await result.click();
      await rendered(f, 3);
      await result.click();
      await expect(f.pane.getByRole('button', { name: 'Agrandir', exact: true })).toBeEnabled();
      await expect(f.pane.locator('.reader-page-next')).toBeDisabled();
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
      await panel.locator('.supplemental-files summary').click();
      await expect(panel.locator('.supplemental-files')).toContainText('Aucun complément');
      await panel.locator('.reader-quality-report summary').click();
      await panel.getByLabel('Précisions pour la vérification', { exact: true }).fill('The mock page three has a missing example.');
      await panel.getByRole('button', { name: 'Transmettre le signalement', exact: true }).click();
      assert.equal(f.writes.find(write => write.path === '/api/reports').body.details, 'p. 3 · v1\nThe mock page three has a missing example.');
      await closeTools(f);
      await f.pane.getByRole('button', { name: /^Notes \(/ }).click();
      await expect(f.pane.locator('.reader-notes')).toBeVisible();
      await expect(f.pane.locator('.reader-tools')).toHaveCount(0);
      const notePanel = f.pane.locator('.reader-notes');
      await notePanel.getByRole('button', { name: 'Nouvelle note', exact: true }).click();
      await notePanel.getByLabel('Titre', { exact: true }).fill('Transaction recap');
      await notePanel.getByLabel('Votre note', { exact: true }).fill('Keep a transaction consistent with the source on page three.');
      await notePanel.getByRole('button', { name: 'Enregistrer la note privée', exact: true }).click();
      await expect(notePanel.locator('.reader-note')).toContainText('Transaction recap');
      assert.equal(f.notes[0].resourceId, 41);
      assert.equal(f.notes[0].page, 3);
      assert.equal(f.notes[0].version, 1);
      await notePanel.getByRole('button', { name: 'Voir dans le document', exact: true }).click();
      await expect(f.pane.getByRole('button', { name: 'Agrandir', exact: true })).toBeEnabled();
      await f.pane.getByRole('button', { name: /^Notes \(/ }).click();
      await expect(f.pane.locator('.reader-notes')).toHaveCount(0);
      await f.dialog.locator('.reader-compare-toggle').click();
      await chooseOption(f.dialog.getByLabel('Comparer avec', { exact: true }), '42');
      await expect(f.dialog.locator('.reader-pane')).toHaveCount(2);
      await rendered(f, 1, f.dialog.locator('.reader-pane').nth(1));
      await expect(f.dialog.locator('.reader-pane').first().locator('canvas')).toBeVisible();
      await chooseOption(f.dialog.getByLabel('Comparer avec', { exact: true }), '');
      await expect(f.dialog.locator('.reader-pane')).toHaveCount(1);
      await f.dialog.getByRole('button', { name: 'Mode focus', exact: true }).click();
      await expect(f.dialog).toHaveClass(/reader-focus/);
      await rendered(f, 3);
      await f.dialog.getByRole('button', { name: 'Quitter le focus', exact: true }).click();
      await expect(f.dialog).not.toHaveClass(/reader-focus/);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await run('Phone, small phone, landscape and Arabic themes preserve reading space and reachable controls', async () => {
    for (const options of [
      { width: 390, height: 844 },
      { width: 320, height: 640 },
      { width: 844, height: 390 },
      { width: 1300, height: 874, language: 'ar' },
      { width: 390, height: 844, language: 'ar' },
      { width: 1440, height: 900, language: 'ar', theme: 'light' },
      { width: 320, height: 640, language: 'ar', theme: 'light' },
    ]) {
      const f = await fixture(options);
      try {
        await rendered(f);
        await fits(f);
        if (f.language === 'ar') assert.equal(await f.dialog.evaluate(node => getComputedStyle(node).direction), 'rtl');
        const names = f.language === 'ar'
          ? { info: 'معلومات الملف', focus: 'وضع التركيز', save: 'حفظ', download: 'تنزيل' }
          : { info: 'Informations du fichier', focus: 'Mode focus', save: 'Enregistrer', download: 'Télécharger' };
        await expect(f.dialog.locator('.reader-info-toggle')).toHaveAccessibleName(names.info);
        await expect(f.dialog.locator('.reader-focus-toggle')).toHaveAccessibleName(names.focus);
        await expect(f.dialog.locator('.reader-save-toggle')).toHaveAccessibleName(names.save);
        await expect(f.dialog.locator('.reader-download')).toHaveAccessibleName(names.download);
        await expect(f.pane.locator('.reader-notes-toggle')).toHaveAccessibleName(f.language === 'ar' ? /^الملاحظات/ : /^Notes/);
        for (const locator of [f.pane.locator('.reader-page-prev'), f.pane.locator('.reader-page-next'), f.pane.locator('.reader-tools-toggle')]) {
          const dimensions = await locator.boundingBox();
          if (f.width < 800) assert.ok(dimensions.width >= 36 && dimensions.height >= 36, 'Touch controls are at least 36 by 36 pixels: ' + JSON.stringify(dimensions));
          assert.ok((await locator.getAttribute('aria-label')) || (await locator.innerText()).trim(), 'Reader controls have accessible names.');
        }
        await f.pane.locator('.reader-page-next').click();
        await rendered(f, 2);
        await f.pane.locator('.reader-page-prev').click();
        await rendered(f);
        const panel = await tools(f);
        const searchName = f.language === 'ar' ? 'البحث في هذا الملف' : 'Rechercher dans ce PDF';
        await panel.getByRole('textbox', { name: searchName, exact: true }).fill('Search beacon');
        await panel.getByRole('textbox', { name: searchName, exact: true }).press('Enter');
        await expect(panel.locator('.reader-search-result')).toHaveCount(1);
        if (f.width === 390) await f.page.screenshot({ path: `test-results/reader-workspace-${f.width}x${f.height}-${f.theme}-${f.language}-tools.png` });
        await closeTools(f);
        await f.pane.locator('.reader-notes-toggle').click();
        await expect(f.pane.locator('.reader-notes')).toBeVisible();
        const noteClose = f.pane.locator('.reader-notes-close');
        await expect(noteClose).toBeInViewport();
        await noteClose.click();
        await expect(f.pane.locator('.reader-notes')).toHaveCount(0);
        await expect(f.pane.locator('.reader-notes-toggle')).toBeFocused();
        if (f.width < 800) {
          await f.dialog.locator('.reader-compare-toggle').click();
          const compareName = f.language === 'ar' ? 'مقارنة مع' : 'Comparer avec';
          await chooseOption(f.dialog.getByLabel(compareName, { exact: true }), '42');
          const secondary = f.dialog.locator('.reader-pane').nth(1);
          await rendered(f, 1, secondary);
          await expect(f.pane.locator('canvas')).toBeHidden();
          await f.dialog.locator('.reader-mobile-switch button').first().click();
          await rendered(f);
          await expect(secondary.locator('canvas')).toBeHidden();
          await chooseOption(f.dialog.getByLabel(compareName, { exact: true }), '');
          await f.dialog.locator('.reader-compare-toggle').click();
          await expect(f.dialog.locator('.reader-compare')).toBeHidden();
        }
        await fits(f);
        await f.page.screenshot({ path: `test-results/reader-workspace-${f.width}x${f.height}-${f.theme}-${f.language}.png` });
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
  });

  await run('Temporary PDF and metadata failures offer a retry that renders the document in the same reader', async () => {
    for (const fail of ['file', 'metadata']) {
      const f = await fixture({ fail });
      try {
        await expect(f.pane.getByRole('heading', { name: 'Document indisponible', exact: true })).toBeVisible();
        const retry = f.pane.getByRole('button', { name: 'Réessayer', exact: true });
        await expect(retry).toBeEnabled();
        await retry.click();
        await rendered(f);
        await fits(f);
        assert.ok(f.attempts[fail] >= 2, 'Retry fetches the failed source again.');
        await expect(f.pane.getByRole('heading', { name: 'Document indisponible', exact: true })).toHaveCount(0);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
  });
  writeFileSync('test-results/reader-workspace-browser-report.json', JSON.stringify({ passed, measurements }, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'test-results/reader-workspace-browser-failure.png', fullPage: true }).catch(() => {});
  writeFileSync('test-results/reader-workspace-browser-report.json', JSON.stringify({ passed, measurements, error: error.message }, null, 2));
  throw error;
} finally { await browser.close(); }
