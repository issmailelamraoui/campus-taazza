import { chromium, expect as playwrightExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

// Every API read and write is intercepted. The suite needs only Vite's public
// assets and never connects to real accounts, files, object storage or a DB.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const expect = playwrightExpect.configure({ timeout: 15000 });
const passed = [], measurements = [], out = 'test-results/document-preview-routing';
const testCase = process.env.CAMPUS_PREVIEW_TEST_CASE || process.env.CAMPUS_PREVIEW_CASE;
const reportPath = `${out}/${testCase ? 'report-' + testCase.toLowerCase().replace(/\W+/g, '-') : 'report'}.json`;
mkdirSync(out, { recursive: true });
let activePage;

function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let page = 1; page <= 3; page++) {
    const stream = `BT /F1 20 Tf 48 780 Td (Preview routing fixture page ${page}) Tj /F1 13 Tf 0 -36 Td (The file remains readable inside CampusLink.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page * 2 + 3} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let bytes = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(bytes));
    bytes += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(bytes);
  bytes += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(bytes);
}

async function fixture({ width = 1440, height = 900, touch = width < 1000, theme = 'dark', language = 'fr', metadataFailureStatus = 0, previewDocument = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const user = { id: 3, name: 'Preview routing fixture', username: 'preview-routing', role: 'student', account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5, current_academic_year: '2026/2027', language };
  const pdf = pdfFixture(), text = 'Isolated text preview remains readable inside CampusLink.';
  const base = { faculty_id: 'fsa', filiere_id: 'data_science', semester: 5, module: 'Administration des bases de donnees', version: 1, currentVersion: 1, library_visible: true, author: user, academic_year: '2026/2027', academic_years: ['2026/2027'], category: 'courses', resource_type: 'courses', part_number: 'complete', created_at: '2026-10-21T00:00:00Z' };
  const resources = [
    { ...base, id: 41, title: 'Preview routing PDF', filename: 'preview-routing.pdf', mime: 'application/pdf', size: pdf.length },
    { ...base, id: 42, title: 'Preview routing text', filename: 'preview-routing.txt', mime: 'text/plain', size: Buffer.byteLength(text) },
  ];
  const messages = [{ id: 501, content: 'Isolated discussion attachment', author: user, faculty_id: 'fsa', filiere_id: 'data_science', channel: 'general', reactions: {}, attachments: [resources[1]], created_at: '2026-10-21T12:00:00Z' }];
  const errors = [], requests = [], assetRequests = [], writes = [], popups = [], downloads = [];
  context.on('request', request => assetRequests.push(request.url()));
  let revision = 0, metadataAllowed = !metadataFailureStatus;
  const payload = (id, version = 1) => ({ document: { ...resources.find(item => item.id === id), ...(id === 41 ? previewDocument?.metadata : {}), version, currentVersion: 1, url: `/api/reading/${id}/file?version=${version}` }, position: null, previousPositions: [], recovery: [] });
  await context.addInitScript(({ theme, language }) => {
    if (window.top !== window) return;
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { theme, language });
  // Vite serves the PDF worker as a separate module. Preserve that public
  // runtime in the fixture just as the production offline asset cache does;
  // private files still come exclusively from the owner-bound IndexedDB blob.
  const workerAssets = new Map();
  await context.route('**/*pdf.worker*', async route => {
    const url = route.request().url();
    let cached = workerAssets.get(url);
    if (!cached) {
      const response = await route.fetch();
      cached = { status: response.status(), contentType: response.headers()['content-type'] || 'text/javascript', body: await response.body() };
      workerAssets.set(url, cached);
    }
    return route.fulfill(cached);
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    requests.push({ path, search: url.search, method: request.method(), navigation: request.isNavigationRequest() });
    if (request.method() !== 'GET') writes.push({ path, method: request.method(), body: request.postDataJSON() });
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap' || path === '/api/live') return route.fulfill({ json: { user, faculty: { id: 'fsa', name: 'Faculty fixture' }, resources, messages, messages_complete: true, announcements: [], notifications: [], saved: [], history: [], channels: [{ id: 'general', read_only: false }], members: [] } });
    const file = /^\/api\/(?:files\/(\d+)|reading\/(\d+)\/file)$/.exec(path);
    if (file) {
      const id = Number(file[1] || file[2]);
      assert.ok(resources.some(item => item.id === id), 'File reads must stay inside the fixture.');
      // Canonical navigation is fulfilled with a visible marker instead of the
      // browser PDF extension: this tests routing without native-viewer timing.
      if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>External file fixture</title><h1>External file fixture</h1>' });
      return route.fulfill({ contentType: id === 41 ? previewDocument?.metadata?.mime || 'application/pdf' : 'text/plain', body: id === 41 ? previewDocument?.body ?? pdf : text });
    }
    const reading = /^\/api\/reading\/(\d+)$/.exec(path);
    if (reading) {
      if (Number(reading[1]) === 41 && !metadataAllowed) return route.fulfill({ status: metadataFailureStatus, json: { error: 'Isolated preview access denied' } });
      return route.fulfill({ json: payload(Number(reading[1]), Number(url.searchParams.get('version')) || 1) });
    }
    if (path.endsWith('/position')) return route.fulfill({ json: { position: { ...request.postDataJSON(), revision: ++revision } } });
    if (path === '/api/reading') return route.fulfill({ json: { positions: [] } });
    if (path === '/api/knowledge') return route.fulfill({ json: { items: [] } });
    if (path.startsWith('/api/resource-supplements/')) return route.fulfill({ json: { mainResourceId: Number(path.split('/').pop()), items: [], canManage: false, policy: { perMain: 20 } } });
    if (path.startsWith('/api/document-relations/')) return route.fulfill({ json: { resourceId: Number(path.split('/').pop()), version: 1, state: 'suggestions', canVerify: false, suggestions: [], mappings: [], limited: false } });
    if (path.startsWith('/api/document-repairs/')) return route.fulfill({ json: { currentVersion: 1, canReview: false, proposals: [] } });
    if (path.startsWith('/api/document-index/')) return route.fulfill({ status: 201, json: { index: { resourceId: Number(path.split('/').pop()), version: 1, status: 'ready', pageCount: 3, searchable: true } } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', error => errors.push(error.message));
  page.on('popup', popup => popups.push(popup));
  page.on('download', download => downloads.push(download.suggestedFilename()));
  const goto = async (query = '') => {
    await page.goto(origin + '/app/library?semester=5&module=Administration+des+bases+de+donnees' + query);
    await expect(page.locator('#resource-41 .document-main')).toBeVisible();
  };
  await goto();
  return { context, page, user, pdf, text, resources, payload, allowMetadata: () => { metadataAllowed = true; }, errors, requests, assetRequests, writes, popups, downloads, goto, width, height, theme, language };
}

async function scenario(name, options, callback) {
  if (testCase && !name.includes(testCase)) return;
  const f = await fixture(options);
  try {
    await callback(f);
    assert.deepEqual(f.errors, [], 'No unhandled browser errors.');
    assert.deepEqual(f.downloads, [], 'Preview must not trigger a download.');
    assert.ok(f.writes.every(request => /^\/api\/(?:history|messages\/read|reading\/\d+\/position|document-index\/\d+)$/.test(request.path)), 'The suite must never mutate accounts or business data: ' + JSON.stringify(f.writes));
    passed.push(name);
    console.log('PASS ' + name);
  } catch (error) {
    await f.page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await f.context.close();
  }
}

async function rendered(f, number = 1) {
  const dialog = f.page.locator('.study-reader-modal');
  await expect(dialog).toBeVisible();
  const canvas = dialog.locator(`canvas[aria-label="Page ${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(dialog.locator(`.reader-page-slot[data-pdf-page="${number}"] .reader-text-layer`)).toContainText(`Preview routing fixture page ${number}`);
  await expect.poll(() => canvas.evaluate(node => {
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, Math.min(node.height, 400)).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 16) if (pixels[index + 3] > 240 && pixels[index] < 150 && pixels[index + 1] < 150 && pixels[index + 2] < 150) ink++;
    return ink > 5;
  }), { message: 'The internal preview must paint actual PDF content.' }).toBe(true);
  const geometry = await dialog.evaluate(node => {
    const box = node.getBoundingClientRect(), root = document.documentElement;
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: root.clientWidth, scrollWidth: root.scrollWidth, bodyWidth: node.clientWidth, bodyScrollWidth: node.scrollWidth };
  });
  assert.ok(geometry.left >= -1 && geometry.right <= f.width + 1 && geometry.top >= -1 && geometry.bottom <= f.height + 1, 'Preview fits its viewport: ' + JSON.stringify(geometry));
  assert.ok(geometry.scrollWidth <= geometry.width + 1 && geometry.bodyScrollWidth <= geometry.bodyWidth + 1, 'Preview has no horizontal overflow.');
  measurements.push({ viewport: `${f.width}x${f.height}`, theme: f.theme, language: f.language, ...geometry });
  return dialog;
}

function noStudyRuntime(f) {
  assert.deepEqual(f.assetRequests.filter(url => /pdfjs[-/]dist|pdfjs-dist|pdf\.worker/.test(url)), [], 'The normal preview must not load the PDF.js study runtime.');
  assert.deepEqual(f.requests.filter(request => /^\/api\/(?:knowledge|document-index|document-relations|document-repairs|resource-supplements)(?:\/|$)|\/position$/.test(request.path)), [], 'The normal preview must not fetch study tools or write a study position.');
  assert.ok(f.requests.filter(request => /^\/api\/reading\/\d+$/.test(request.path)).every(request => request.method === 'GET'), 'File metadata access must remain read-only.');
}

async function nativePreview(f, expected = {}) {
  const dialog = f.page.locator('.native-document-preview'), frame = dialog.locator('iframe.native-document-frame');
  await expect(dialog).toBeVisible();
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('title', /\S/);
  await expect(f.page.locator('.study-reader-modal')).toHaveCount(0);
  await expect(dialog.locator('canvas, .reader-page-number, .reader-text-layer')).toHaveCount(0);
  if ((expected.id || 41) === 41) {
    await expect.poll(() => frame.getAttribute('src')).toMatch(/^\/api\/|^https?:/);
    canonical(await frame.getAttribute('src'), { version: 1, ...expected });
  }
  const geometry = await dialog.evaluate(node => {
    const box = node.getBoundingClientRect(), frame = node.querySelector('iframe').getBoundingClientRect(), root = document.documentElement;
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height, frameHeight: frame.height, frameLeft: frame.left, frameRight: frame.right, frameTop: frame.top, frameBottom: frame.bottom, width: root.clientWidth, scrollWidth: root.scrollWidth, bodyWidth: node.clientWidth, bodyScrollWidth: node.scrollWidth };
  });
  assert.ok(geometry.left >= -1 && geometry.right <= f.width + 1 && geometry.top >= -1 && geometry.bottom <= f.height + 1, 'Native preview fits its viewport: ' + JSON.stringify(geometry));
  assert.ok(geometry.scrollWidth <= geometry.width + 1 && geometry.bodyScrollWidth <= geometry.bodyWidth + 1, 'Native preview has no horizontal overflow.');
  assert.ok(geometry.frameLeft >= geometry.left && geometry.frameRight <= geometry.right + 1 && geometry.frameTop >= geometry.top && geometry.frameBottom <= geometry.bottom + 1, 'Browser frame remains inside the modal.');
  assert.ok(geometry.frameHeight >= geometry.height * .65, 'Browser preview retains most of the modal space: ' + JSON.stringify(geometry));
  measurements.push({ viewport: `${f.width}x${f.height}`, theme: f.theme, language: f.language, native: true, ...geometry });
  noStudyRuntime(f);
  return dialog;
}

function canonical(url, { id = 41, version, page } = {}) {
  const parsed = new URL(url, origin);
  assert.equal(parsed.origin, new URL(origin).origin, 'External file stays on the authenticated application origin.');
  assert.match(parsed.pathname, new RegExp(`^/api/(?:files/${id}|reading/${id}/file)$`));
  assert.equal(parsed.searchParams.has('download'), false, 'External preview is not a download.');
  assert.ok([...parsed.searchParams.keys()].every(key => key === 'version'), 'Do not accept provider or arbitrary query URLs.');
  if (version) assert.equal(parsed.searchParams.get('version'), String(version));
  if (page) assert.equal(parsed.hash, '#page=' + page);
}

async function externalClick(f, locator, expected = {}) {
  const popupPromise = f.page.waitForEvent('popup');
  await locator.click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'External file fixture' })).toBeVisible();
  canonical(popup.url(), expected);
  assert.equal(await popup.evaluate(() => window.opener === null), true, 'External tab cannot access the app opener.');
  return popup;
}

try {
  for (const options of [{ width: 1440, height: 900, touch: false, theme: 'dark' }, { width: 1440, height: 900, touch: false, theme: 'light' }, { width: 768, height: 1024, theme: 'light' }]) {
    await scenario(`Default PDF stays inside ${options.width}px ${options.theme}; external button opens one tab`, options, async f => {
      await f.page.locator('#resource-41 .document-main').click();
      const dialog = await nativePreview(f);
      assert.equal(f.popups.length, 0, 'Default desktop/tablet preview does not open a tab.');
      const link = dialog.locator('.reader-external-open');
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('target', '_blank');
      assert.match(await link.getAttribute('rel'), /noopener/);
      assert.equal(await link.getAttribute('download'), null);
      canonical(await link.getAttribute('href'));
      assert.equal(new URL(await link.getAttribute('href'), origin).href, new URL(await dialog.locator('.native-document-frame').getAttribute('src'), origin).href, 'Internal and external native previews use the same authenticated file URL.');
      await externalClick(f, link);
      assert.equal(f.popups.length, 1, 'One click opens exactly one file tab.');
      await expect(dialog).toBeVisible();
      await f.page.screenshot({ path: `${out}/preview-${options.width}-${options.theme}.png` });
      await dialog.locator('.modal-header button').focus();
      await f.page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      noStudyRuntime(f);
    });
  }

  await scenario('Default text stays inside desktop and opens canonically through the external button', { width: 1440, height: 900, touch: false }, async f => {
    await f.page.locator('#resource-42 .document-open-label').click();
    const dialog = await nativePreview(f, { id: 42 });
    const frame = dialog.locator('iframe.native-document-frame');
    await expect(frame).toHaveAttribute('src', /^blob:/);
    const content = await f.page.evaluate(async url => {
      const response = await fetch(url);
      return { type: response.headers.get('content-type'), text: await response.text() };
    }, await frame.getAttribute('src'));
    assert.match(content.type, /^text\/plain(?:;|$)/);
    assert.equal(content.text, f.text);
    await expect(f.page.frameLocator('iframe.native-document-frame').locator('body')).toHaveText(f.text);
    assert.equal(f.popups.length, 0);
    await expect(dialog.locator('.reader-external-open')).toBeVisible();
    await externalClick(f, dialog.locator('.reader-external-open'), { id: 42 });
    assert.equal(f.popups.length, 1);
    await expect(dialog).toBeVisible();
  });

  for (const options of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390, touch: true }]) {
    await scenario(`Phone ${options.width}x${options.height} automatically opens one external file tab`, options, async f => {
      await externalClick(f, f.page.locator('#resource-41 .document-main'));
      assert.equal(f.popups.length, 1, 'Phone opening is not duplicated by its card handler.');
      await expect(f.page.locator('.study-reader-modal, .native-document-preview')).toHaveCount(0);
      await expect(f.page.locator('#resource-41')).toBeVisible();
    });
  }

  await scenario('Phone text files automatically open externally using the canonical file endpoint', { width: 390, height: 844 }, async f => {
    await externalClick(f, f.page.locator('#resource-42 .document-open-label'), { id: 42 });
    assert.equal(f.popups.length, 1);
    await expect(f.page.locator('.study-reader-modal, .native-document-preview')).toHaveCount(0);
  });

  await scenario('Explicit study mode keeps the phone PDF reader inside the site', { width: 390, height: 844 }, async f => {
    await f.goto('&mode=study&document=41&page=2&version=1');
    await rendered(f, 2);
    assert.equal(f.popups.length, 0);
    await expect(f.page.locator('.reader-page-number input')).toHaveValue('2');
  });

  await scenario('Desktop deep links preserve the requested PDF version and page in both previews', { width: 1440, height: 900, touch: false }, async f => {
    await f.goto('&document=41&page=2&version=1');
    const dialog = await nativePreview(f, { version: 1, page: 2 });
    assert.equal(f.popups.length, 0);
    const link = dialog.locator('.reader-external-open');
    await expect(link).toBeVisible();
    canonical(await link.getAttribute('href'), { version: 1, page: 2 });
    await externalClick(f, link, { version: 1, page: 2 });
    await expect(dialog).toBeVisible();
  });

  await scenario('Saved phone PDF stays readable internally offline without opening an external tab', { width: 390, height: 844 }, async f => {
    // Warm the real reader module, then seed only this isolated browser's
    // private IndexedDB record with the same 24-hour owner-bound shape.
    await f.goto('&mode=study&document=41');
    await rendered(f);
    await f.page.evaluate(async ({ bytes, payload, userId }) => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('campuslink-private-files-v1', 1);
        open.onupgradeneeded = () => {
          const store = open.result.createObjectStore('documents', { keyPath: 'key' });
          store.createIndex('owner', 'userId');
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction('documents', 'readwrite'), blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
          tx.objectStore('documents').put({ key: `${userId}:41:1`, userId: String(userId), resourceId: 41, version: 1, bytes: blob.size, blob, payload, savedAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
    }, { bytes: [...f.pdf], payload: f.payload(41), userId: f.user.id });
    await f.page.keyboard.press('Escape');
    await expect(f.page.locator('.study-reader-modal')).toHaveCount(0);
    await f.context.setOffline(true);
    try {
      await f.page.locator('#resource-41 .document-main').click();
      await rendered(f);
      await expect(f.page.locator('.reader-status-bar')).toContainText('Hors ligne');
      assert.equal(f.popups.length, 0, 'Offline phone opening must use its private cached reader.');
    } finally {
      await f.context.setOffline(false);
    }
  });

  await scenario('Discussion attachment stays inside desktop and its external button opens the canonical source', { width: 1440, height: 900, touch: false }, async f => {
    await f.page.goto(origin + '/app/community?channel=general');
    await f.page.locator('[data-message-id="501"] .community-attachment-file').click();
    const dialog = f.page.locator('.community-device-preview');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('iframe.native-document-frame')).toHaveAttribute('src', /^blob:/);
    await expect(f.page.frameLocator('.community-device-preview iframe.native-document-frame').locator('body')).toHaveText(f.text);
    noStudyRuntime(f);
    assert.equal(f.popups.length, 0);
    await externalClick(f, dialog.locator('.community-device-external-open'), { id: 42 });
    assert.equal(f.popups.length, 1);
    await expect(dialog).toBeVisible();
  });

  await scenario('Discussion attachment opens externally on phone without consuming chat space', { width: 390, height: 844 }, async f => {
    await f.page.goto(origin + '/app/community?channel=general');
    await externalClick(f, f.page.locator('[data-message-id="501"] .community-attachment-file'), { id: 42 });
    assert.equal(f.popups.length, 1);
    await expect(f.page.locator('.community-device-preview')).toHaveCount(0);
  });

  for (const selected of [
    { name: 'selected-preview.html', type: 'text/html', source: '<!doctype html><script>globalThis.__previewScriptExecuted = true</script><p>Isolated HTML source preview</p>' },
    { name: 'selected-preview.svg', type: 'image/svg+xml', source: '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.__previewScriptExecuted = true"><text y="20">Isolated SVG source preview</text></svg>' },
  ]) {
    await scenario(`Local preview ${selected.name} opens as inert source in an external browser tab`, { width: 390, height: 844 }, async f => {
      const attachment = await f.page.evaluate(async selected => {
        const files = await import('/src/lib/files.js');
        const original = new File([selected.source], selected.name, { type: selected.type });
        const attachment = files.createSessionAttachment(original);
        const record = files.getSessionFile(attachment.id), response = await fetch(record.url);
        return { id: attachment.id, url: record.url, previewType: response.headers.get('content-type'), originalType: record.file.type, originalBytes: await record.file.text(), previewBytes: await response.text() };
      }, selected);
      assert.match(attachment.url, /^blob:/);
      assert.match(attachment.previewType, /^text\/plain(?:;|$)/, 'Active document extensions must be presented as text.');
      assert.equal(attachment.originalType, selected.type, 'Preview normalization must preserve original upload metadata.');
      assert.equal(attachment.originalBytes, selected.source, 'Preview normalization must preserve original upload bytes.');
      assert.equal(attachment.previewBytes, selected.source);
      const external = await f.context.newPage();
      try {
        await external.goto(attachment.url);
        await expect(external.locator('body')).toContainText(selected.source);
        assert.equal(await external.evaluate(() => globalThis.__previewScriptExecuted), undefined, 'Opening a selected source file must never execute its script.');
        assert.equal(await external.evaluate(() => window.opener === null), true);
        await expect(external.locator('script, svg')).toHaveCount(0);
      } finally {
        await external.close();
        await f.page.evaluate(async id => (await import('/src/lib/files.js')).releaseSessionAttachment(id), attachment.id);
      }
    });
  }

  await scenario('Local preview PDF MIME is determined by its extension while preserving the original selected file', { width: 390, height: 844 }, async f => {
    const result = await f.page.evaluate(async bytes => {
      const files = await import('/src/lib/files.js');
      const original = new File([new Uint8Array(bytes)], 'selected-preview.pdf', { type: 'text/html' });
      const attachment = files.createSessionAttachment(original), record = files.getSessionFile(attachment.id);
      try {
        const response = await fetch(record.url);
        return { previewType: response.headers.get('content-type'), originalType: record.file.type, originalBytes: [...new Uint8Array(await record.file.arrayBuffer())], previewBytes: [...new Uint8Array(await response.arrayBuffer())] };
      } finally {
        files.releaseSessionAttachment(attachment.id);
      }
    }, [...f.pdf]);
    assert.equal(result.previewType, 'application/pdf', 'A selected PDF must retain native PDF viewing despite an incorrect claimed MIME.');
    assert.equal(result.originalType, 'text/html', 'Original file metadata stays available for upload validation.');
    assert.deepEqual(result.originalBytes, [...f.pdf]);
    assert.deepEqual(result.previewBytes, [...f.pdf]);
  });

  await scenario('Native branch metadata denial prevents file loading and retry opens the browser preview', { width: 1440, height: 900, touch: false, metadataFailureStatus: 403 }, async f => {
    await f.page.locator('#resource-41 .document-main').click();
    const dialog = f.page.locator('.native-document-preview');
    await expect(dialog.getByRole('heading', { name: 'Aperçu indisponible', exact: true })).toBeVisible();
    await expect(dialog).toContainText('Isolated preview access denied');
    await expect(dialog.locator('iframe')).toHaveCount(0);
    assert.deepEqual(f.requests.filter(request => /^\/api\/(?:files\/41|reading\/41\/file)$/.test(request.path)), [], 'Denied metadata must prevent file reads.');
    const deniedAttempts = f.requests.filter(request => request.path === '/api/reading/41').length;
    f.allowMetadata();
    await dialog.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await nativePreview(f);
    await dialog.locator('.reader-external-open').focus();
    await f.page.keyboard.press('Tab');
    await expect.poll(() => f.page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    assert.equal(f.requests.filter(request => request.path === '/api/reading/41').length, deniedAttempts + 1, 'Retry must recheck metadata access.');
    await expect(dialog.getByRole('heading', { name: 'Aperçu indisponible', exact: true })).toHaveCount(0);
    assert.equal(f.popups.length, 0);
  });

  const historicalSource = '<!doctype html><script>globalThis.__historicalPreviewExecuted = true</script><p>Historical HTML source stays readable and inert.</p>';
  await scenario('Native branch historical HTML metadata uses an inert sandboxed source frame', { width: 1440, height: 900, touch: false, previewDocument: { metadata: { filename: 'historical-source.html', mime: 'text/plain', size: Buffer.byteLength(historicalSource) }, body: historicalSource } }, async f => {
    await f.goto('&document=41&version=1');
    const dialog = f.page.locator('.native-document-preview'), frame = dialog.locator('iframe.native-document-frame');
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('src', /^blob:/);
    await expect(frame).toHaveAttribute('sandbox', '');
    const content = await f.page.evaluate(async url => {
      const response = await fetch(url);
      return { type: response.headers.get('content-type'), text: await response.text() };
    }, await frame.getAttribute('src'));
    assert.match(content.type, /^text\/plain(?:;|$)/);
    assert.equal(content.text, historicalSource);
    const browserFrame = f.page.frameLocator('iframe.native-document-frame');
    await expect(browserFrame.locator('body')).toHaveText(historicalSource);
    await expect(browserFrame.locator('script, p')).toHaveCount(0);
    assert.equal(await browserFrame.locator('body').evaluate(() => globalThis.__historicalPreviewExecuted), undefined);
    canonical(await dialog.locator('.reader-external-open').getAttribute('href'), { version: 1 });
    assert.ok(f.requests.some(request => request.path === '/api/reading/41/file' && request.search === '?version=1'), 'Historical source must be fetched through its version endpoint.');
    assert.equal(f.popups.length, 0);
    noStudyRuntime(f);
  });

  await scenario('Native branch unsupported DOCX keeps manual open available without fetching or downloading the file', { width: 1440, height: 900, touch: false, previewDocument: { metadata: { filename: 'unsupported-preview.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } } }, async f => {
    await f.page.locator('#resource-41 .document-main').click();
    const dialog = f.page.locator('.native-document-preview');
    await expect(dialog.getByRole('heading', { name: 'unsupported-preview.docx', exact: true })).toBeVisible();
    await expect(dialog).toContainText('application compatible');
    await expect(dialog.locator('iframe')).toHaveCount(0);
    const external = dialog.locator('.reader-external-open');
    await expect(external).toBeVisible();
    canonical(await external.getAttribute('href'), { version: 1 });
    assert.deepEqual(f.requests.filter(request => /^\/api\/(?:files\/41|reading\/41\/file)$/.test(request.path)), [], 'Unsupported previews must not start a file read or download.');
    assert.equal(f.popups.length, 0);
    noStudyRuntime(f);
  });

  writeFileSync(reportPath, JSON.stringify({ passed, measurements }, null, 2));
  console.log(JSON.stringify({ passed: passed.length, scenarios: passed, artifact: reportPath }, null, 2));
} catch (error) {
  await activePage?.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
