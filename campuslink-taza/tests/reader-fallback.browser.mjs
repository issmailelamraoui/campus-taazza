import { chromium, firefox, expect as playwrightExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Isolated API fixture: position writes, indexing and all file reads stay here.
// Faults are injected only into the browser's copy of PDF.js, never app source.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserName = process.env.CAMPUSLINK_READER_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await (browserName === 'firefox' ? firefox : chromium).launch({
  headless: true,
  ...(browserName === 'chromium' ? {
    ...(existsSync(executablePath) ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  } : {}),
});
const expect = playwrightExpect.configure({ timeout: 12000 });
const artifact = name => `test-results/${browserName === 'firefox' ? 'firefox-' : ''}reader-fallback-${name}`;
const passed = [], measurements = [];
let activePage;
mkdirSync('test-results', { recursive: true });

function pdfFixture({ scanned = false } = {}) {
  const streams = Array.from({ length: 3 }, (_, index) => scanned
    // A visible, vector-only page has no text objects, like a scanned PDF.
    ? `q 0.16 0.24 0.36 rg 48 680 490 98 re f 0.75 0.8 0.85 rg 48 500 490 130 re f 0.1 0.1 0.1 RG 3 w 48 ${420 - index * 20} m 538 ${420 - index * 20} l S Q`
    : `BT /F1 20 Tf 48 780 Td (Fallback fixture page ${index + 1}) Tj /F1 13 Tf 0 -38 Td (Visible document despite optional text failures.) Tj 0 -32 Td (Search beacon page ${index + 1}.) Tj ET`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.flatMap((stream, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ]),
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

async function fixture({ width = 390, height = 844, language = 'fr', theme = 'light', scanned = false, fault = '', indexStatus = 'ready' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(browserName === 'chromium' ? { isMobile: width < 800 } : {}), hasTouch: width < 800, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const user = { id: 3, name: 'Reader fallback fixture', username: 'reader-fallback', role: 'student', account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5, current_academic_year: '2026/2027', language };
  const pdf = pdfFixture({ scanned });
  const resource = { id: 41, title: 'Probabilités et statistiques', filename: 'probabilites.pdf', mime: 'application/pdf', version: 1, currentVersion: 1, size: pdf.length, faculty_id: 'fsa', filiere_id: 'data_science', semester: 5, module: 'Probabilités et statistiques', category: 'courses', resource_type: 'courses', part_number: '5', academic_year: '2026/2027', academic_years: ['2026/2027'], library_visible: true, author: user, created_at: '2026-10-16T00:00:00Z' };
  const writes = [], errors = [];
  let revision = 0;
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  if (fault) await context.route(/\/(?:pdfjs-dist_build_pdf__mjs\.js|pdfjs-dist\/build\/pdf\.mjs)(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.text();
    assert.match(body, /(?:class|var|const) PDFPageProxy\b/, 'Fault injection must target the real PDF.js module.');
    const patch = `
globalThis.__readerFaultHits = { text: 0, layer: 0, page: 0 };
${fault === 'text' ? `PDFPageProxy.prototype.getTextContent = function () { globalThis.__readerFaultHits.text++; return Promise.reject(new Error('Fixture text extraction unavailable')); };` : ''}
${fault === 'partialtext' ? `const fixtureOriginalText = PDFPageProxy.prototype.getTextContent; PDFPageProxy.prototype.getTextContent = function (...args) { if (this.pageNumber === 2) { globalThis.__readerFaultHits.text++; return Promise.reject(new Error('Fixture second page text unavailable')); } return fixtureOriginalText.apply(this, args); };` : ''}
${fault === 'layer' ? `TextLayer.prototype.render = function () { globalThis.__readerFaultHits.layer++; return Promise.reject(new Error('Fixture text layer unavailable')); };` : ''}
${fault === 'page' ? `const fixtureOriginalRender = PDFPageProxy.prototype.render; PDFPageProxy.prototype.render = function (...args) { if (this.pageNumber === 2 && !globalThis.__readerFaultHits.page++) return { promise: Promise.reject(new Error('Fixture second page rendering failure')), cancel() {} }; return fixtureOriginalRender.apply(this, args); };` : ''}
${fault === 'delayedpage' ? `const fixtureOriginalRender = PDFPageProxy.prototype.render; let fixtureReleased = false; const fixtureResumes = []; globalThis.__releaseReaderPage = () => { fixtureReleased = true; fixtureResumes.splice(0).forEach(resume => resume()); }; PDFPageProxy.prototype.render = function (...args) { if (this.pageNumber !== 3 || fixtureReleased) return fixtureOriginalRender.apply(this, args); globalThis.__readerFaultHits.page++; let task, canceled = false; const proxy = this; const promise = new Promise((resolve, reject) => fixtureResumes.push(() => { if (canceled) { reject(Object.assign(new Error('Canceled fixture render'), { name: 'RenderingCancelledException' })); return; } task = fixtureOriginalRender.apply(proxy, args); task.promise.then(resolve, reject); })); return { promise, cancel() { canceled = true; task?.cancel(); } }; };` : ''}
`;
    await route.fulfill({ response, contentType: 'text/javascript', body: body + '\n' + patch });
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'fsa', name: 'Faculty fixture' }, resources: [resource], messages: [], announcements: [], notifications: [], saved: [], history: [], channels: [], members: [] } });
    if (path === '/api/reading/41/file' || path === '/api/files/41') return route.fulfill({ contentType: 'application/pdf', body: pdf });
    if (path === '/api/reading/41') return route.fulfill({ json: { document: { ...resource, url: '/api/reading/41/file?version=1' }, position: null, previousPositions: [], recovery: [] } });
    if (path === '/api/reading/41/position') {
      const body = request.postDataJSON();
      writes.push({ path, body });
      return route.fulfill({ json: { position: { ...body, revision: ++revision } } });
    }
    if (path === '/api/reading') return route.fulfill({ json: { positions: [] } });
    if (path === '/api/knowledge') return route.fulfill({ json: { items: [] } });
    if (path === '/api/document-index/41') {
      writes.push({ path });
      return indexStatus === 'error'
        ? route.fulfill({ status: 503, json: { error: 'Fixture text indexing temporarily unavailable' } })
        : route.fulfill({ status: 201, json: { index: { resourceId: 41, version: 1, status: indexStatus, pageCount: 3, searchable: indexStatus !== 'no_text' } } });
    }
    if (path.startsWith('/api/resource-supplements/')) return route.fulfill({ json: { mainResourceId: 41, items: [], canManage: false, policy: { perMain: 20 } } });
    if (path.startsWith('/api/document-relations/')) return route.fulfill({ json: { resourceId: 41, version: 1, state: 'suggestions', canVerify: false, suggestions: [], mappings: [], limited: false } });
    if (path.startsWith('/api/document-repairs/')) return route.fulfill({ json: { currentVersion: 1, canReview: false, proposals: [] } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/library?mode=study&document=41&page=1&version=1');
  const dialog = page.locator('.study-reader-modal');
  await expect(dialog).toBeVisible();
  const pane = dialog.locator('.reader-pane').first();
  return { context, page, dialog, pane, errors, writes, width, height, language, theme };
}

async function painted(f, number = 1) {
  const canvas = f.pane.locator(`canvas[aria-label="Page ${number}"]`);
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(node => {
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, Math.min(node.height, Math.ceil(node.height / 2))).data;
    let opaque = 0, ink = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      if (pixels[index + 3] > 240) opaque++;
      if (pixels[index + 3] > 240 && pixels[index] < 150 && pixels[index + 1] < 150 && pixels[index + 2] < 150) ink++;
    }
    return opaque > 100 && ink > 5;
  }), { message: `Page ${number} must actually paint visible content, independent of its text layer.` }).toBe(true);
  await expect(f.pane.locator('.reader-sync')).not.toContainText(/Lecture indisponible|Reading unavailable|القراءة غير متاحة|Chargement du document/);
  await expect(f.pane.getByRole('heading', { name: /Document indisponible|Document unavailable|المستند غير متاح/ })).toHaveCount(0);
}

async function bottomControls(f) {
  const geometry = await f.pane.evaluate(pane => {
    const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
    const workspace = pane.querySelector('.reader-workspace'), controls = pane.querySelector('.reader-controls'), scroll = pane.querySelector('.reader-scroll');
    return { workspace: box(workspace), controls: box(controls), scroll: box(scroll), pane: box(pane), viewport: { width: innerWidth, height: innerHeight }, controlCount: pane.querySelectorAll('.reader-controls').length, followsWorkspace: !!(workspace.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING), rootWidth: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth };
  });
  assert.equal(geometry.controlCount, 1, 'One page strip per reader.');
  assert.equal(geometry.followsWorkspace, true, 'Page controls follow the document workspace in DOM and keyboard order.');
  assert.ok(geometry.controls.top >= geometry.workspace.bottom - 1, 'Page navigation is below the document, not above it: ' + JSON.stringify(geometry));
  assert.ok(geometry.controls.bottom <= geometry.viewport.height + 1, 'Bottom controls remain visible: ' + JSON.stringify(geometry));
  assert.ok(geometry.controls.left >= -1 && geometry.controls.right <= geometry.viewport.width + 1, 'Controls fit the viewport: ' + JSON.stringify(geometry));
  assert.ok(geometry.documentWidth <= geometry.rootWidth + 1, 'Reader does not create horizontal overflow.');
  assert.ok(geometry.scroll.height >= f.height * .5, 'Document keeps at least half the viewport on phone and desktop.');
  await expect(f.pane.locator('.reader-page-number input')).toBeInViewport();
  await expect(f.pane.locator('.reader-tools-toggle')).toBeInViewport();
  measurements.push({ size: `${f.width}x${f.height}`, language: f.language, theme: f.theme, ...geometry });
}

async function jump(f, number) {
  const input = f.pane.locator('.reader-page-number input');
  await input.fill(String(number));
  await input.press('Enter');
  await expect(input).toHaveValue(String(number));
  await painted(f, number);
}

async function tools(f) {
  const toggle = f.pane.locator('.reader-tools-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return f.pane.locator('.reader-tools');
}

async function run(name, callback) {
  if (process.env.READER_TEST_CASE && !name.includes(process.env.READER_TEST_CASE)) return;
  await callback();
  passed.push(name);
  console.log('PASS ' + name);
}

async function scenario(options, callback) {
  const f = await fixture(options);
  try { await callback(f); assert.deepEqual(f.errors, [], 'No unhandled browser errors.'); }
  catch (error) { await f.page.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await f.context.close(); }
}

try {
  await run('Image-only PDF opens normally with bottom page controls on desktop, phone and Arabic RTL', async () => {
    for (const options of [{ width: 1440, height: 900, theme: 'dark' }, { width: 390, height: 844 }, { width: 320, height: 640, language: 'ar', theme: 'dark' }]) {
      await scenario({ ...options, scanned: true }, async f => {
        await painted(f);
        await bottomControls(f);
        await jump(f, 3);
        await bottomControls(f);
        await f.pane.locator('.reader-scroll').evaluate(node => { node.scrollTop = node.querySelector('[data-pdf-page="2"]').offsetTop; });
        await expect(f.pane.locator('.reader-page-number input')).toHaveValue('2');
        await painted(f, 2);
        const panel = await tools(f);
        await expect(panel.getByRole('button', { name: /Sélectionner une zone|Select region|تحديد منطقة/, exact: true })).toBeEnabled();
        await f.pane.locator('.reader-tools-close').click();
        await bottomControls(f);
        await f.page.screenshot({ path: artifact(`${f.width}-${f.language}-${f.theme}.png`) });
      });
    }
  });

  await run('Rejected PDF text extraction keeps canvas pages, page navigation and reading ready', async () => {
    await scenario({ fault: 'text' }, async f => {
      await painted(f);
      await expect.poll(() => f.page.evaluate(() => globalThis.__readerFaultHits?.text || 0)).toBeGreaterThan(0);
      await bottomControls(f);
      await jump(f, 3);
      const panel = await tools(f);
      await expect(panel.locator('.reader-text-notice')).toContainText('reste lisible en image');
      const search = panel.getByRole('textbox', { name: 'Rechercher dans ce PDF', exact: true });
      await search.fill('Search beacon');
      await search.press('Enter');
      await expect(panel.getByRole('button', { name: 'Arrêter', exact: true })).toHaveCount(0);
      await expect(panel.locator('.reader-search-result')).toHaveCount(0);
      await expect(panel.locator('.reader-search-notice')).toContainText('3 page(s)');
      await expect(f.pane.locator('canvas[aria-label="Page 3"]')).toBeVisible();
      await f.pane.locator('.reader-tools-close').click();
      await painted(f, 3);
    });
  });

  await run('Rejected PDF text layer keeps visual reading and region tools in Arabic RTL', async () => {
    await scenario({ width: 320, height: 640, language: 'ar', theme: 'dark', fault: 'layer' }, async f => {
      await painted(f);
      await expect.poll(() => f.page.evaluate(() => globalThis.__readerFaultHits?.layer || 0)).toBeGreaterThan(0);
      await bottomControls(f);
      await jump(f, 2);
      const panel = await tools(f);
      await panel.getByRole('button', { name: 'تحديد منطقة', exact: true }).click();
      await expect(f.pane.locator('.reader-region-select')).toBeVisible();
      await expect(f.pane.locator('.reader-selection-tools')).toContainText('لا يوجد نص قابل للاستخراج');
      await bottomControls(f);
    });
  });

  await run('Search retains healthy-page matches when one page has unreadable text', async () => {
    await scenario({ width: 1440, height: 900, fault: 'partialtext' }, async f => {
      await painted(f);
      const panel = await tools(f);
      const search = panel.getByRole('textbox', { name: 'Rechercher dans ce PDF', exact: true });
      await search.fill('Search beacon');
      await search.press('Enter');
      await expect(panel.locator('.reader-search-result')).toHaveCount(2);
      await expect(panel.locator('.reader-search-result').first()).toContainText('p. 1');
      await expect(panel.locator('.reader-search-result').last()).toContainText('p. 3');
      await expect(panel.locator('.reader-search-notice')).toContainText('1 page(s)');
      await expect.poll(() => f.page.evaluate(() => globalThis.__readerFaultHits?.text || 0)).toBeGreaterThan(0);
      await panel.locator('.reader-search-result').last().click();
      await f.pane.locator('.reader-tools-close').click();
      await painted(f, 3);
      await bottomControls(f);
    });
  });

  await run('Text index failure and no-text index never replace the open document', async () => {
    for (const indexStatus of ['error', 'no_text']) await scenario({ width: 1440, height: 900, indexStatus, scanned: indexStatus === 'no_text' }, async f => {
      await painted(f);
      const panel = await tools(f);
      await panel.getByRole('button', { name: 'Préparer la recherche de ce PDF', exact: true }).click();
      await expect(panel.locator('.pdf-index-reading-note')).toContainText('continuer à lire');
      if (indexStatus === 'error') await expect(panel.locator('.pdf-index-control [role="alert"]')).toContainText('Fixture text indexing');
      else await expect(panel.locator('.pdf-index-control')).toContainText('aucun texte extractible');
      assert.equal(f.writes.filter(write => write.path === '/api/document-index/41').length, 1);
      await f.pane.locator('.reader-tools-close').click();
      await painted(f);
      await jump(f, 3);
      await bottomControls(f);
    });
  });

  await run('A single failed PDF page leaves other pages readable and retries locally', async () => {
    await scenario({ width: 390, height: 844, fault: 'page' }, async f => {
      await painted(f);
      await expect.poll(() => f.page.evaluate(() => globalThis.__readerFaultHits?.page || 0)).toBeGreaterThan(0);
      await jump(f, 3);
      const input = f.pane.locator('.reader-page-number input');
      await input.fill('2');
      await input.press('Enter');
      const failed = f.pane.locator('[data-pdf-page="2"] .reader-page-error');
      await expect(failed).toBeVisible();
      await expect(failed.getByRole('link')).toHaveAttribute('href', /\/api\/reading\/41\/file\?version=1/);
      await failed.getByRole('button', { name: /Réessayer cette page|Retry this page/, exact: true }).click();
      await painted(f, 2);
      await expect(failed).toHaveCount(0);
      await bottomControls(f);
    });
  });

  await run('An unpainted destination page cannot inherit the previous page reading status', async () => {
    await scenario({ width: 390, height: 844, fault: 'delayedpage' }, async f => {
      await painted(f);
      const input = f.pane.locator('.reader-page-number input');
      await input.fill('3');
      await input.press('Enter');
      await expect(input).toHaveValue('3');
      await expect.poll(() => f.page.evaluate(() => globalThis.__readerFaultHits?.page || 0)).toBeGreaterThan(0);
      await expect(f.pane.locator('.reader-sync')).toContainText('Chargement du document');
      await f.page.evaluate(() => globalThis.__releaseReaderPage());
      await painted(f, 3);
      await bottomControls(f);
    });
  });

  writeFileSync(artifact('report.json'), JSON.stringify({ passed, measurements }, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(artifact('report.json'), JSON.stringify({ passed, measurements, error: error.message }, null, 2));
  throw error;
} finally { await browser.close(); }
