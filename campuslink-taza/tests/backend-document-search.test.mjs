import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { makePdf } from '../server/seed.js';
import { extractPdfText, documentSearchTerms, verifiedIndexedPageCount, DOCUMENT_INDEX_POLICY } from '../server/document-search.js';
import { createTestApp } from './backend-helpers.mjs';

const integration = process.env.CAMPUS_TEST_DATABASE_URL ? test : test.skip;
let env, server, origin;
const cookies = {};
function boundedFixturePdf(pageCount, text) {
  const stream = `BT /F1 10 Tf 10 780 Td (${text}) Tj ET`, fontId = pageCount + 3, streamId = fontId + 1;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`, ...Array.from({ length: pageCount }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(pdf);
}
async function request(path, { cookie = cookies.yassine, method = 'GET', body, form } = {}) {
  const response = await fetch(origin + '/api' + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(form || body !== undefined ? { body: form || JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session='))?.split(';')[0], headers: response.headers };
}
async function upload({ content = makePdf('Keyword extraction ' + randomUUID(), ['birefringence anisotropy polarization']), filename = 'lesson.pdf', year = '2026/2027', visible = true } = {}) {
  const module = 'PDF extraction ' + randomUUID(), form = new FormData();
  for (const [key, value] of Object.entries({ title: module, category: 'courses', channel: 'general', filiere_id: 'french_studies', semester: '1', module, resource_type: 'courses', part_number: 'complete', academic_year: year, library_visible: String(visible), publish_message: 'false' })) form.set(key, value);
  form.set('file', new Blob([content]), filename);
  const result = await request('/uploads', { method: 'POST', form }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.resource;
}
const index = (resource, cookie) => request('/document-index/' + resource.id, { method: 'POST', body: { pageCount: 999999, text: 'invented client text' }, ...(cookie ? { cookie } : {}) });
const search = (query, cookie, resource) => request('/document-search?' + new URLSearchParams({ q: query, ...(resource ? { resourceId: String(resource.id) } : {}) }), cookie ? { cookie } : {});
before(async () => {
  // No live DATABASE_URL fallback: these tests create only disposable schemas.
  if (!process.env.CAMPUS_TEST_DATABASE_URL) return;
  env = await createTestApp(); server = env.app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['yassine', 'sara', 'nour', 'admin', 'hamza']) { const result = await request('/login', { method: 'POST', body: { username: name, password: name === 'admin' ? 'Admin2026!' : 'Campus2026!' }, cookie: null }); assert.equal(result.status, 200); cookies[name] = result.cookie; }
});
after(async () => { if (!env) return; env.app.locals.endStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await env.close(); });

test('real isolated PDF text extraction returns verified page count and never evaluates source text', async () => {
  const extracted = await extractPdfText(makePdf('Text is inert', ['globalThis.documentIndexExecuted=true; <script>danger()</script>', 'birefringence anisotropy polarization']));
  assert.equal(extracted.pageCount, 1); assert.equal(extracted.status, 'ready'); assert.match(extracted.pages[0].text, /birefringence anisotropy polarization/);
  assert.match(extracted.pages[0].text, /<script>/); assert.equal(globalThis.documentIndexExecuted, undefined);
});
test('image-only PDF is honestly marked no_text; corrupt, oversized and timed-out extractions reject', async () => {
  const ordinary = makePdf('No text', []), blank = Buffer.from(ordinary.toString('latin1').replace(/stream\n([\s\S]*?)\nendstream/, (_, content) => 'stream\n' + ' '.repeat(content.length) + '\nendstream'), 'latin1');
  const extracted = await extractPdfText(blank); assert.equal(extracted.pageCount, 1); assert.equal(extracted.status, 'no_text'); assert.deepEqual(extracted.pages, []);
  await assert.rejects(extractPdfText(Buffer.from('%PDF-1.4\ninvalid')), error => error.status === 422);
  await assert.rejects(extractPdfText(Buffer.alloc(DOCUMENT_INDEX_POLICY.maxFileBytes + 1)), error => error.status === 413);
  await assert.rejects(extractPdfText(boundedFixturePdf(501, 'bounded text')), error => error.status === 413);
  await assert.rejects(extractPdfText(boundedFixturePdf(1, 'x'.repeat(50001))), error => error.status === 413);
  await assert.rejects(extractPdfText(ordinary, { timeoutMs: 1 }), error => error.status === 504 && error.code === 'INDEX_TIMEOUT');
});
test('keyword terms normalize accents and reject excessive or empty input without accepting query operators', () => {
  assert.deepEqual(documentSearchTerms('Économie économie 2026'), ['economie', '2026']);
  assert.deepEqual(documentSearchTerms('نظريات المعرفة'), ['نظريات', 'المعرفة']);
  assert.deepEqual(documentSearchTerms("alpha'); DROP TABLE users; --"), ['alpha', 'drop', 'table', 'users']);
  assert.throws(() => documentSearchTerms('a ?'), error => error.status === 400);
  assert.throws(() => documentSearchTerms('one two three four five six seven eight nine'), error => error.status === 400);
  assert.throws(() => documentSearchTerms('x'.repeat(161)), error => error.status === 400);
});

integration('index is explicit, bounded and idempotent; lexical matches include genuine page/version source links', async () => {
  const resource = await upload();
  assert.equal((await request('/document-index/' + resource.id)).data.index.status, 'not_indexed');
  assert.deepEqual((await search('birefringence anisotropy', undefined, resource)).data.matches, []);
  const first = await index(resource); assert.equal(first.status, 201, JSON.stringify(first.data)); assert.equal(first.data.index.pageCount, 1); assert.equal(first.data.index.status, 'ready'); assert.equal(first.data.index.reused, false);
  const get = env.storage.get.bind(env.storage); let reads = 0; env.storage.get = async (...args) => { reads++; return get(...args); };
  try { const retry = await index(resource); assert.equal(retry.status, 200); assert.equal(retry.data.index.reused, true); assert.equal(reads, 0); } finally { env.storage.get = get; }
  const found = await search('birefringence anisotropy', cookies.sara, resource); assert.equal(found.status, 200); assert.equal(found.data.matches.length, 1);
  const match = found.data.matches[0]; assert.equal(match.page, 1); assert.equal(match.version, resource.version); assert.match(match.excerpt, /birefringence anisotropy/); assert.match(match.href, new RegExp(`document=${resource.id}&page=1&version=1`));
  assert.equal(found.headers.get('cache-control'), 'private, no-store'); assert.deepEqual((await search('invented client text', undefined, resource)).data.matches, []);
  const raw = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(resource.id); assert.equal(await verifiedIndexedPageCount(env.db, raw), 1);
});
integration('faculty and filiere privacy apply to both indexing and search, including scope changes after indexing', async () => {
  const resource = await upload({ content: makePdf('Private scope fixture', ['scopebirefringence scopemagnetism']) }); assert.equal((await index(resource)).status, 201);
  for (const name of ['nour', 'hamza']) {
    assert.equal((await request('/document-index/' + resource.id, { cookie: cookies[name] })).status, 403);
    assert.equal((await index(resource, cookies[name])).status, 403);
    assert.equal((await search('scopebirefringence scopemagnetism', cookies[name], resource)).status, 403);
    assert.deepEqual((await search('scopebirefringence scopemagnetism', cookies[name])).data.matches, []);
  }
  await env.db.prepare("UPDATE users SET filiere_id='arabic_studies' WHERE id=4").run();
  try { assert.equal((await request('/document-index/' + resource.id, { cookie: cookies.sara })).status, 403); assert.deepEqual((await search('scopebirefringence scopemagnetism', cookies.sara)).data.matches, []); }
  finally { await env.db.prepare("UPDATE users SET filiere_id='french_studies' WHERE id=4").run(); }
  assert.equal((await request('/document-search?q=scopebirefringence', { cookie: null })).status, 401);
});
integration('private standalone attachments are excluded from library search and require author access for explicit search', async () => {
  const resource = await upload({ visible: false, content: makePdf('Personal attachment', ['privatesoliton privatephonon']) });
  assert.equal((await index(resource)).status, 201);
  assert.deepEqual((await search('privatesoliton privatephonon')).data.matches, []);
  assert.equal((await search('privatesoliton privatephonon', undefined, resource)).data.matches.length, 1);
  assert.equal((await index(resource, cookies.sara)).status, 403);
  assert.equal((await search('privatesoliton privatephonon', cookies.sara, resource)).status, 403);
});
integration('removed and replaced resources stop matching immediately and verified page counts cannot follow a stale hash', async () => {
  const resource = await upload({ content: makePdf('Removal fixture', ['deletionpolariton deletionphonon']) }); assert.equal((await index(resource)).status, 201);
  await env.db.prepare('UPDATE resources SET version=version+1 WHERE id=?').run(resource.id);
  assert.deepEqual((await search('deletionpolariton deletionphonon')).data.matches, []); assert.equal((await request('/document-index/' + resource.id)).data.index.status, 'not_indexed');
  const changed = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(resource.id); assert.equal(await verifiedIndexedPageCount(env.db, changed), null);
  assert.equal(await verifiedIndexedPageCount(env.db, { ...changed, version: 1 }), null, 'A stale caller snapshot cannot certify the replaced version');
  assert.equal((await index(resource)).status, 201); assert.equal((await search('deletionpolariton deletionphonon')).data.matches.length, 1);
  await env.db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(resource.id);
  assert.equal((await request('/document-index/' + resource.id)).status, 404); assert.deepEqual((await search('deletionpolariton deletionphonon')).data.matches, []);
  assert.equal(await verifiedIndexedPageCount(env.db, { ...changed, removed: 1 }), null);
});
integration('storage/source mismatch, extraction failure and concurrent indexing never persist invented metadata', async () => {
  const resource = await upload({ content: makePdf('Storage integrity fixture', ['integritymagnon integrityexciton']) });
  const raw = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(resource.id), stored = env.storage.objects.get(raw.object_key);
  env.storage.objects.set(raw.object_key, { ...stored, buffer: makePdf('Changed object', ['untrusted bytes']) });
  assert.equal((await index(resource)).status, 409); assert.equal(await verifiedIndexedPageCount(env.db, raw), null);
  env.storage.objects.set(raw.object_key, stored);
  const results = await Promise.all([index(resource), index(resource)]); assert.deepEqual(results.map(value => value.status).sort(), [201, 429]);
  assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS count FROM document_text_indexes WHERE resource_id=?').get(resource.id)).count, 1);
  const invalid = await upload({ content: Buffer.from('%PDF-1.4\nnot a real document') }); assert.equal((await index(invalid)).status, 422);
  assert.equal((await request('/document-index/' + invalid.id)).data.index.status, 'not_indexed');
});
integration('authorization and source classification are checked again after the stored PDF is read', async () => {
  const resource = await upload({ content: makePdf('Revocation fixture', ['revocationplasmon revocationmeson']) });
  const get = env.storage.get.bind(env.storage);
  env.storage.get = async (...args) => { const file = await get(...args); await env.db.prepare("UPDATE users SET filiere_id='arabic_studies' WHERE id=3").run(); return file; };
  try { assert.equal((await index(resource)).status, 403); assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS count FROM document_text_indexes WHERE resource_id=?').get(resource.id)).count, 0); }
  finally { env.storage.get = get; await env.db.prepare("UPDATE users SET filiere_id='french_studies' WHERE id=3").run(); }
});
integration('search stays plain text, treats words conjunctively, and sorts current academic year first', async () => {
  await env.db.prepare("UPDATE users SET current_academic_year='2026/2027' WHERE id=3").run();
  const current = await upload({ year: '2026/2027', content: makePdf('Current fixture', ['sortcoulomb sortdirac <script>danger()</script>']) });
  const older = await upload({ year: '2024/2025', content: makePdf('Past fixture', ['sortcoulomb sortdirac']) });
  const unknown = await upload({ year: 'unknown', content: makePdf('Unknown fixture', ['sortcoulomb sortdirac']) });
  for (const resource of [current, older, unknown]) assert.equal((await index(resource)).status, 201);
  const result = await search('sortcoulomb sortdirac'); assert.deepEqual(result.data.matches.map(match => match.resourceId), [current.id, older.id, unknown.id]);
  assert.match(result.data.matches[0].excerpt, /<script>danger\(\)<\/script>/); assert.deepEqual((await search('sortcoulomb nonexistentrareword')).data.matches, []);
  assert.equal((await search('a')).status, 400); assert.equal((await request('/document-search?q=sortcoulomb&resourceId=NaN')).status, 400);
  const nonPdf = await upload({ filename: 'code.py', content: 'print("plain lesson")' }); assert.equal((await index(nonPdf)).status, 415);
});
