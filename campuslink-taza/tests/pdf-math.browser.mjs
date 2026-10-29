import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';

// Synthetic PDFs and intercepted APIs only. PDF.js paints and extracts actual
// embedded fonts; clipboard events are captured locally without OS permission.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/pdf-math/chromium';
const expect = browserExpect.configure({ timeout: 20000 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(output, { recursive: true });
const report = { passed: [], errors: [], layouts: [], screenshots: [], copies: [] };
const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd]/u;
const words = {
 fr: { save: 'Garder dans le coffre', title: 'Titre', content: 'Votre note', submit: 'Enregistrer la note privée', copy: 'Copier la référence', create: 'Créer une flashcard', front: 'Question / recto', back: 'Réponse / verso', saveTool: 'Enregistrer', reveal: 'Afficher la réponse', source: 'Voir dans le document' },
 en: { save: 'Save in vault', title: 'Title', content: 'Your note', submit: 'Save private note', copy: 'Copy reference', create: 'Create flashcard', front: 'Question / front', back: 'Answer / back', saveTool: 'Save', reveal: 'Reveal answer', source: 'View in document' },
 ar: { save: 'حفظ في الخزنة', title: 'العنوان', content: 'ملاحظتك', submit: 'حفظ الملاحظة الخاصة', copy: 'نسخ المرجع', create: 'إنشاء بطاقة', front: 'السؤال / الوجه', back: 'الجواب / الظهر', saveTool: 'حفظ', reveal: 'عرض الجواب', source: 'عرض في المستند' },
};

async function fixture({ unreliable = false, width = 1440, height = 960, language = 'fr', theme = 'dark', legacy = false, startStudy = false } = {}) {
 const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1100, serviceWorkers: 'block', reducedMotion: 'reduce' });
 await context.addInitScript(({ language, theme }) => {
  window.EventSource = undefined;
  localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language)); localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme)); localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  window.__referenceCopies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__referenceCopies.push(text); } } });
 }, { language, theme });
 const pdf = await readFile(new URL(`./fixtures/math-${unreliable ? 'unreliable-map' : 'unicode'}.pdf`, import.meta.url));
 const user = { id: 183, name: 'PDF mathematics fixture', username: 'pdf-math-fixture', role: 'student', account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5, current_academic_year: '2026/2027', language, preferences: {} };
 const resource = { id: 41, title: 'Probabilités et statistiques', filename: 'probabilites-mathematiques.pdf', mime: 'application/pdf', version: 1, currentVersion: 1, size: pdf.length, faculty_id: 'fsa', filiere_id: 'data_science', semester: 5, module: 'Probabilités et statistiques', category: 'courses', resource_type: 'courses', part_number: 'complete', academic_year: '2026/2027', academic_years: ['2026/2027'], library_visible: true, author: user, created_at: '2026-10-16T00:00:00Z' };
 const legacyText = 'Legacy probability \u0001\ue012 \u2208 \u211d';
 const notes = legacy ? [{ id: 'cba7d79b-0ea4-48c1-89eb-609944565198', resourceId: 41, version: 1, page: 1, kind: 'excerpt', title: 'Legacy mathematical note', selectedText: legacyText, content: 'Original personal explanation remains untouched. '+legacyText, anchor: [{ x: .1, y: .15, width: .7, height: .05 }], color: 'yellow', tags: [], revision: 1, sourceAvailable: true, source: { title: resource.title, module: resource.module }, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' }] : [];
 const tools = [], writes = [], errors = [], requests = [];
 let revision = 0;
 await context.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(); requests.push({ path, method });
  const send = (json, status = 200) => route.fulfill({ status, json });
  if (method === 'GET' && path === '/api/modules') return send({ modules: [] });
  if (method === 'POST' && path === '/api/history') return send({ ok: true });
  if (method === 'GET' && path === '/api/session') return send({ user });
  if (method === 'GET' && ['/api/bootstrap', '/api/live'].includes(path)) return send({ user, faculty: { id: 'fsa', code: 'FSA', name: 'Mathematical PDF fixture faculty' }, resources: [resource], messages: [], announcements: [], notifications: [], saved: [], history: [], channels: [], members: [] });
  if (method === 'GET' && ['/api/reading/41/file', '/api/files/41'].includes(path)) return route.fulfill({ contentType: 'application/pdf', body: pdf });
  if (method === 'GET' && path === '/api/reading/41') return send({ document: { ...resource, url: '/api/reading/41/file?version=1' }, position: null, previousPositions: [], recovery: [] });
  if (path === '/api/reading/41/position' && ['POST', 'PATCH', 'PUT'].includes(method)) { const body = request.postDataJSON(); writes.push({ path, body }); return send({ position: { ...body, revision: ++revision } }); }
  if (path === '/api/reading' && method === 'GET') return send({ positions: [] });
  if (path === '/api/knowledge' && method === 'GET') return send({ items: notes.filter(note => !url.searchParams.has('resourceId') || Number(note.resourceId) === Number(url.searchParams.get('resourceId'))) });
  if (path === '/api/knowledge' && method === 'POST' || /^\/api\/knowledge\/[\w-]+$/.test(path) && method === 'PATCH') {
   const body = request.postDataJSON(), index = notes.findIndex(note => note.id === body.id);
   const item = { ...body, source: { title: resource.title, module: resource.module, author: body.citationAuthor || '', year: body.citationYear || '' }, sourceAvailable: true, revision: (index >= 0 ? notes[index].revision : 0) + 1, createdAt: '2026-10-16T12:00:00Z', updatedAt: '2026-10-16T12:00:00Z' };
   if (index >= 0) notes[index] = item; else notes.push(item); writes.push({ path, body }); return send({ item }, method === 'POST' ? 201 : 200);
  }
  if (path === '/api/study-tools' && method === 'GET') return send({ items: tools });
  if (path === '/api/study-tools' && method === 'POST') {
   const body = request.postDataJSON(); let source = body.data?.source;
   if (source?.knowledgeId) { const note = notes.find(note => note.id === source.knowledgeId); assert.ok(note, 'Only this fixture’s actual note may be the canonical flashcard source'); source = { knowledgeId: note.id, imageData: note.imageData || '', selectedText: note.selectedText || '', resourceId: note.resourceId, page: note.page, version: note.version }; }
   const item = { ...body, data: { ...body.data, ...(source ? { source } : {}) }, revision: 1, createdAt: '2026-10-16T12:00:00Z', updatedAt: '2026-10-16T12:00:00Z' }; tools.push(item); writes.push({ path, body }); return send({ item }, 201);
  }
  if (method === 'GET' && path.startsWith('/api/resource-supplements/')) return send({ mainResourceId: 41, items: [], canManage: false, policy: { perMain: 20 } });
  if (method === 'GET' && path.startsWith('/api/document-relations/')) return send({ resourceId: 41, version: 1, state: 'suggestions', canVerify: false, suggestions: [], mappings: [], limited: false });
  if (method === 'GET' && path.startsWith('/api/document-repairs/')) return send({ currentVersion: 1, canReview: false, proposals: [] });
  errors.push(`Unexpected isolated PDF API: ${method} ${path}`); return send({ error: 'Unexpected isolated PDF API' }, 500);
 });
 const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
 await page.goto(origin + (startStudy ? '/app/study?tab=knowledge' : '/app/library?mode=study&document=41&page=1&version=1'), { waitUntil: 'domcontentloaded' });
 return { context, page, notes, tools, writes, errors, requests, resource, legacyText, width, height, language, theme, words: words[language] };
}
async function rendered(f) {
 await expect(f.page.locator('.study-reader-modal')).toBeVisible(); const canvas = f.page.locator('canvas[aria-label="Page 1"]'); await expect(canvas).toBeVisible();
 await expect.poll(() => f.page.locator('.reader-text-layer span').count()).toBeGreaterThan(0);
 await expect.poll(() => canvas.evaluate(node => {
  const data = node.getContext('2d').getImageData(0, 0, node.width, node.height).data; let dark = 0;
  for (let i = 0; i < data.length; i += 16) if (data[i + 3] > 200 && data[i] < 160 && data[i + 1] < 160 && data[i + 2] < 160) dark++;
  return dark;
 })).toBeGreaterThan(100);
 return canvas.evaluate(async node => { const data = node.getContext('2d').getImageData(0, 0, node.width, node.height).data; const hash = await crypto.subtle.digest('SHA-256', data); return { width: node.width, height: node.height, hash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') }; });
}
async function select(f, unreliable = false) {
 const raw = await f.page.locator('.reader-text-layer').first().evaluate((layer, unreliable) => {
  const spans = [...layer.querySelectorAll('span')], bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ue000-\uf8ff\ufffd]/u;
  const target = spans.find(span => unreliable ? bad.test(span.textContent) : /[αβθλμσΩℝℕℤℚ∈∩]/u.test(span.textContent));
  if (!target) throw new Error(`Missing ${unreliable ? 'unreliable' : 'mathematical Unicode'} text span; extracted: ${spans.map(span => span.textContent).join(' | ')}`);
  const range = document.createRange(); range.selectNodeContents(target); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
 }, unreliable);
 await f.page.locator('.reader-scroll').dispatchEvent('pointerup'); await expect(f.page.locator('.reader-selection-tools')).toBeVisible();
 return raw.trim();
}
async function copiedSelection(f) {
 return f.page.locator('.reader-scroll').evaluate(node => {
  const clipboard = new DataTransfer(), event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard }); node.dispatchEvent(event);
  return { plain: clipboard.getData('text/plain'), html: clipboard.getData('text/html'), prevented: event.defaultPrevented };
 });
}
async function saveSelection(f, title, content = '') {
 await f.page.getByRole('button', { name: f.words.save, exact: true }).click(); const editor = f.page.locator('.study-note-editor'); await expect(editor).toBeVisible();
 await editor.getByLabel(f.words.title, { exact: true }).fill(title); await editor.getByLabel(f.words.content, { exact: true }).fill(content);
 await editor.getByRole('button', { name: f.words.submit, exact: true }).click(); await expect(editor).toHaveCount(0);
 const note = f.notes.find(note => note.title === title); assert.ok(note, 'The note must be acknowledged by the isolated API'); return note;
}
async function imagePixels(f, data) {
 return f.page.evaluate(async source => { const image = new Image(); image.src = source; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const values = context.getImageData(0, 0, canvas.width, canvas.height).data; let dark = 0; for (let i = 0; i < values.length; i += 4) if (values[i] < 160 && values[i + 1] < 160 && values[i + 2] < 160) dark++; return { width: canvas.width, height: canvas.height, dark }; }, data);
}
async function fit(f) {
 const layout = await f.page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, reader: document.querySelector('.study-reader-modal')?.getBoundingClientRect().toJSON(), imageWidths: [...document.querySelectorAll('.pdf-saved-excerpt img')].map(image => ({ width: image.getBoundingClientRect().width, max: image.parentElement.getBoundingClientRect().width })) }));
 assert.ok(layout.scrollWidth <= layout.width + 1, 'Mathematical excerpts do not cause page overflow'); for (const image of layout.imageWidths) assert.ok(image.width <= image.max + 1); report.layouts.push({ label: `${f.width}-${f.language}-${f.theme}`, ...layout });
}
async function screenshot(f, name) { const path = `${output}/${name}.png`; await f.page.screenshot({ path }); report.screenshots.push(path); }
async function scenario(label, options, action) {
 const f = await fixture(options);
 try { await action(f); assert.deepEqual(f.errors, []); report.passed.push(label); }
 catch (error) { report.failedLayout=await f.page.evaluate(()=>[...document.querySelectorAll('.study-reader-modal,.modal-body,.reader-pane,.reader-workspace,.reader-notes,.reader-sidebar-header,.study-note-editor,.study-editor-actions,.reader-scroll')].map(node=>({class:node.className,rect:node.getBoundingClientRect().toJSON(),scrollTop:node.scrollTop,scrollHeight:node.scrollHeight,display:getComputedStyle(node).display,flex:getComputedStyle(node).flex,minHeight:getComputedStyle(node).minHeight})));await screenshot(f, `${f.width}-${f.language}-failure`).catch(() => {}); throw error; }
 finally { report.errors.push(...f.errors); await f.context.close(); }
}

let reliableCanvas;
try {
 await scenario('Real embedded-font mathematics keeps exact Unicode selection, a visual crop, and a source-linked private note', {}, async f => {
  reliableCanvas = await rendered(f); const raw = await select(f); assert.match(raw, /[αβθλμσΩℝℕℤℚ∈∩]/u); assert.doesNotMatch(raw, unsafe);
  const mathFont=await f.page.evaluate(async()=>{const loaded=await document.fonts.load('16px "Campus Math"','α ∫ ℝ 𝔼');return loaded.length;});assert.equal(mathFont,1,'Mathematical glyph fallback is self-hosted and loadable on the device');
  const copy = await copiedSelection(f); assert.equal(copy.prevented, true); assert.equal(copy.plain, raw); assert.match(copy.html, /<img[^>]+src="data:image\/(?:png|jpeg);base64,/); assert.match(copy.html, /document=41/); report.copies.push({ reliable: true, text: copy.plain });
  const note = await saveSelection(f, 'Unicode probability excerpt', 'P(A ∩ B) ≤ P(A), α + β and ℝ.'); assert.equal(note.selectedText, raw); assert.match(note.imageData, /^data:image\/(png|jpeg);base64,/); assert.equal(note.page, 1); assert.equal(note.version, 1); assert.ok(note.anchor.length > 0);
  const pixels = await imagePixels(f, note.imageData); assert.ok(pixels.dark > 10, 'The saved crop contains actual original glyph strokes');
  const article = f.page.locator('.reader-note').filter({ has: f.page.getByRole('heading', { name: note.title, exact: true }) }); await expect(article.locator('.pdf-saved-excerpt img')).toBeVisible();
  await article.getByRole('button', { name: f.words.copy, exact: true }).click(); await expect.poll(() => f.page.evaluate(() => window.__referenceCopies.length)).toBe(1); const reference = await f.page.evaluate(() => window.__referenceCopies.at(-1)); assert.ok(reference.includes(raw)); assert.match(reference, /document=41&page=1&version=1/); assert.doesNotMatch(reference, unsafe);
  await f.page.locator('.reader-text-layer').first().evaluate(layer=>{const range=document.createRange();range.selectNodeContents(layer);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
  await f.page.locator('.reader-scroll').dispatchEvent('pointerup');const structured=await copiedSelection(f);assert.match(structured.plain,/document=41/,'Fractions and positioned indices use the original image/source in plain-text-only destinations');assert.match(structured.html,/<img/);report.copies.push({structural:true,text:structured.plain});
  await fit(f); await screenshot(f, 'desktop-unicode-note');
 });
 await scenario('Unreliable ToUnicode maps preserve the original painted PDF and save/copy a visual source instead of corrupted text', { unreliable: true }, async f => {
  const canvas = await rendered(f); assert.deepEqual(canvas, reliableCanvas, 'Changing only the text mapping must not change the original glyph painting');
  const raw = await select(f, true); assert.match(raw, unsafe); const copy = await copiedSelection(f); assert.equal(copy.prevented, true); assert.doesNotMatch(copy.plain, unsafe); assert.match(copy.plain, /document=41/); assert.match(copy.html, /<img[^>]+src="data:image\/(?:png|jpeg);base64,/); assert.ok(!copy.html.includes(raw)); report.copies.push({ reliable: false, text: copy.plain });
  const note = await saveSelection(f, 'Visual probability formula'); assert.equal(note.selectedText, ''); assert.equal(note.content, ''); assert.match(note.imageData, /^data:image\/(png|jpeg);base64,/); assert.ok((await imagePixels(f, note.imageData)).dark > 10);
  await f.page.goto(origin + '/app/study?tab=knowledge'); const article = f.page.locator('.study-knowledge-card').filter({ has: f.page.getByRole('heading', { name: note.title, exact: true }) }); await expect(article.locator('.pdf-saved-excerpt img')).toBeVisible();
  await article.getByRole('button', { name: f.words.create, exact: true }).click(); const editor = f.page.getByRole('dialog'); await expect(editor.locator('.pdf-saved-excerpt img')).toBeVisible(); await editor.getByLabel(f.words.front, { exact: true }).fill('Quelle est la formule de probabilité ?'); await expect(editor.getByLabel(f.words.back, { exact: true })).toHaveValue(''); await editor.getByRole('button', { name: f.words.saveTool, exact: true }).click(); await expect(editor).toHaveCount(0);
  assert.equal(f.tools.length, 1); assert.equal(f.tools[0].data.back, ''); assert.equal(f.tools[0].data.source.imageData, note.imageData); assert.equal(f.tools[0].data.source.knowledgeId, note.id); assert.equal(f.tools[0].data.source.selectedText, '');
  await f.page.getByRole('tab', { name: 'Flashcards', exact: true }).click(); const card = f.page.locator('.study-flashcard'); await card.getByRole('button', { name: f.words.reveal, exact: true }).click(); await expect(card.locator('.study-card-face .pdf-saved-excerpt img')).toBeVisible(); await expect(card.getByRole('link', { name: 'Voir la source', exact: true })).toHaveAttribute('href', /document=41&page=1&version=1/); await fit(f); await screenshot(f, 'desktop-image-only-flashcard');
 });
 await scenario('Legacy unreliable notes remain unchanged, visibly labelled, and copy only safe references', { legacy: true, startStudy: true, width: 768, height: 1024, language: 'en', theme: 'light' }, async f => {
  const original = JSON.stringify(f.notes[0]), article = f.page.locator('.study-knowledge-card'); await expect(article.locator('.pdf-excerpt-warning')).toHaveCount(2);for(const saved of await article.locator('.pdf-math-text').all())await expect(saved).toBeHidden();
  await article.getByText('Show saved text', { exact: true }).first().click(); await expect(article.locator('.pdf-math-text').first()).toHaveText(f.legacyText);await article.getByText('Show saved text', { exact: true }).nth(1).click();await expect(article.locator('.pdf-math-text').nth(1)).toHaveText(f.notes[0].content); await article.getByRole('button', { name: f.words.copy, exact: true }).click(); const reference = await f.page.evaluate(() => window.__referenceCopies.at(-1)); assert.doesNotMatch(reference, unsafe); assert.match(reference, /document=41&page=1&version=1/); assert.equal(JSON.stringify(f.notes[0]), original); assert.equal(f.writes.filter(write => /knowledge|study-tools/.test(write.path)).length, 0); await fit(f); await screenshot(f, 'tablet-legacy-warning-preserved');
 });
 await scenario('Arabic phone preserves visual mathematical selection and notes without overflowing the existing reader', { unreliable: true, width: 390, height: 844, language: 'ar', theme: 'light' }, async f => {
  await rendered(f); await select(f, true); const copy = await copiedSelection(f); assert.doesNotMatch(copy.plain, unsafe); assert.match(copy.html, /data:image\/png;base64,/); const note = await saveSelection(f, 'صيغة الاحتمالات الأصلية', ''); assert.equal(note.selectedText, ''); assert.ok(note.imageData); await fit(f); await screenshot(f, 'phone-arabic-visual-note');
 });
 console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
