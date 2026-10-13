import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';
import { makePdf } from '../server/seed.js';
import { lexicalPage, relatedPageEvidence, DOCUMENT_RELATION_POLICY } from '../server/document-relations.js';

const integration = process.env.CAMPUS_TEST_DATABASE_URL ? test : test.skip;
let env, server, origin;
const cookies = {};
async function request(path, { method = 'GET', body, form, cookie = cookies.yassine } = {}) {
  const response = await fetch(origin + '/api' + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(form || body !== undefined ? { body: form || JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session='))?.split(';')[0] };
}
async function upload({ module = 'Related module ' + randomUUID(), category = 'courses', content = 'birefringence anisotropy polarization', semester = 1, filiere = 'french_studies', cookie = cookies.yassine, part = 'complete', bytes } = {}) {
  const form = new FormData(); for (const [key, value] of Object.entries({ title: module, module, category, resource_type: category, channel: 'general', filiere_id: filiere, semester: String(semester), part_number: part, academic_year: '2026/2027', library_visible: 'true', publish_message: 'false' })) form.set(key, value);
  form.set('file', new Blob([bytes || makePdf('Text fixture ' + randomUUID(), [content])]), 'lesson.pdf');
  const result = await request('/uploads', { method: 'POST', form, cookie }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.resource;
}
async function index(resource) { const result = await request('/document-index/' + resource.id, { method: 'POST', body: {} }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.index; }
async function fixture(content = 'birefringence anisotropy polarization') {
  const module = 'Related module ' + randomUUID(), exercise = await upload({ module, category: 'td', content }), course = await upload({ module, content }); await index(exercise); await index(course); return { module, exercise, course };
}
const propose = ({ exercise, course }, body = {}, cookie) => request('/document-relations/' + exercise.id, { method: 'POST', body: { course_resource_id: course.id, exercise_page: 1, course_page: 1, reason: 'Same technical vocabulary on these exact pages.', ...body }, ...(cookie ? { cookie } : {}) });
const review = (exercise, mapping, body, cookie = cookies.admin) => request(`/document-relations/${exercise.id}/${mapping.id}`, { method: 'PATCH', body: { revision: mapping.revision, ...body }, cookie });
before(async () => {
  if (!process.env.CAMPUS_TEST_DATABASE_URL) return;
  env = await createTestApp(); server = env.app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  for (const username of ['yassine', 'sara', 'nour', 'hamza', 'admin']) { const result = await request('/login', { method: 'POST', body: { username, password: username === 'admin' ? 'Admin2026!' : 'Campus2026!' }, cookie: null }); assert.equal(result.status, 200); cookies[username] = result.cookie; }
});
after(async () => { if (!env) return; env.app.locals.endStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await env.close(); });

test('generic French, English and Arabic vocabulary and exercise numbering do not create strong evidence', () => {
  for (const text of ['fonction valeur equation exercice partie 2', 'function value example question chapter 2', 'دالة قيمة معادلة تمرين جزء مثال']) {
    const page = lexicalPage(text); assert.equal(page.counts.size, 0); assert.equal(relatedPageEvidence(page, page, new Map(), 1), null);
  }
  const single = lexicalPage('birefringence fonction'); assert.equal(relatedPageEvidence(single, single, new Map([['birefringence', 1]]), 1), null);
});
test('real rare terminology and consecutive phrases produce evidence with a ranking score, not correctness', () => {
  const target = lexicalPage('Électromagnétisme birefringence anisotropy polarization'), course = lexicalPage('Electromagnetisme birefringence anisotropy polarization'), frequency = new Map([...course.counts.keys()].map(term => [term, 1]));
  const evidence = relatedPageEvidence(target, course, frequency, 4); assert.equal(evidence.sharedTerms, 4); assert.ok(evidence.lexicalScore > 0); assert.ok(evidence.terms.every(term => term.locallyRare)); assert.ok(evidence.phrases.includes('birefringence anisotropy polarization')); assert.equal('confidence' in evidence, false);
  const commonFrequency = new Map([...course.counts.keys()].map(term => [term, 10])); assert.equal(relatedPageEvidence(target, course, commonFrequency, 10), null);
});
test('lexical work is bounded and phrase evidence never joins words across intervening generic words', () => {
  const target = lexicalPage('birefringence avec anisotropy avec polarization'); assert.equal(target.phrases.size, 0);
  assert.equal(lexicalPage('birefringence '.repeat(2000)).limited, true); assert.ok(lexicalPage('birefringence '.repeat(2000)).counts.size <= DOCUMENT_RELATION_POLICY.pageTokens);
});

integration('suggestions use actual indexed source pages and never assume TD Part 1 means Course Part 1', async () => {
  const module = 'Evidence module ' + randomUUID(), exercise = await upload({ module, category: 'td', part: '1' }), relevant = await upload({ module, part: '2' }), unrelated = await upload({ module, part: '1', content: 'photosynthesis chloroplast stomata' });
  for (const resource of [exercise, relevant, unrelated]) await index(resource);
  const result = await request('/document-relations/' + exercise.id); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.state, 'suggestions'); assert.equal(result.data.automaticVerification, false);
  assert.equal(result.data.suggestions.length, 1); const suggestion = result.data.suggestions[0]; assert.equal(suggestion.status, 'suggested'); assert.equal(suggestion.exercise.part, '1'); assert.equal(suggestion.course.part, '2'); assert.equal(suggestion.course.resourceId, relevant.id); assert.equal(suggestion.course.page, 1);
  assert.ok(suggestion.evidence.terms.some(item => item.term === 'birefringence')); assert.match(suggestion.course.href, new RegExp(`document=${relevant.id}&page=1&version=1`)); assert.deepEqual(result.data.mappings, []);
  const generic = await fixture('fonction valeur equation exercice'); assert.equal((await request('/document-relations/' + generic.exercise.id)).data.state, 'unknown');
});
integration('suggestions and proposals remain confined to authorized exact module/semester/filiere/faculty', async () => {
  const item = await fixture('scopelexicon anisotropic polarized');
  const otherModule = await upload({ content: 'scopelexicon anisotropic polarized' }), otherSemester = await upload({ module: item.module, semester: 3, content: 'scopelexicon anisotropic polarized', cookie: cookies.admin }), otherFiliere = await upload({ module: item.module, filiere: 'arabic_studies', content: 'scopelexicon anisotropic polarized', cookie: cookies.admin });
  for (const course of [otherModule, otherSemester, otherFiliere]) { const result = await request('/document-index/' + course.id, { method: 'POST', body: {}, cookie: cookies.admin }); assert.equal(result.status, 201); }
  const result = await request('/document-relations/' + item.exercise.id); assert.deepEqual(result.data.suggestions.map(row => row.course.resourceId), [item.course.id]);
  for (const course of [otherModule, otherSemester, otherFiliere]) assert.equal((await propose({ ...item, course })).status, 403);
  for (const name of ['nour', 'hamza']) { assert.equal((await request('/document-relations/' + item.exercise.id, { cookie: cookies[name] })).status, 403); assert.equal((await propose(item, {}, cookies[name])).status, 403); }
  assert.equal((await request('/document-relations/' + item.exercise.id, { cookie: null })).status, 401);
});
integration('manual proposals verify real pages, remain proposed despite client status, and may be corrected by their author', async () => {
  const item = await fixture('manualbirefringence manualpolarization manualanisotropy');
  assert.equal((await propose(item, { exercise_page: 2 })).status, 400); assert.equal((await propose(item, { course_page: 2 })).status, 400); assert.equal((await propose(item, { reason: 'tiny' })).status, 400);
  const first = await propose(item, { status: 'verified', reviewer_id: 2 }); assert.equal(first.status, 201); assert.equal(first.data.mapping.status, 'proposed'); assert.equal(first.data.mapping.reviewerId, null);
  const mapping = first.data.mapping; assert.equal((await review(item.exercise, mapping, { status: 'verified' }, cookies.yassine)).status, 403);
  assert.equal((await review(item.exercise, mapping, { reason: 'Another student cannot rewrite this proposal.' }, cookies.sara)).status, 403);
  const edited = await review(item.exercise, mapping, { reason: 'Clarified technical reference to these two exact pages.' }, cookies.yassine); assert.equal(edited.status, 200); assert.equal(edited.data.mapping.status, 'proposed'); assert.equal(edited.data.mapping.revision, 2);
  assert.equal((await review(item.exercise, mapping, { reason: 'Stale editor cannot overwrite a newer reason.' }, cookies.yassine)).status, 409);
  const retry = await propose(item, { reason: 'A retry must not change the existing proposal.' }); assert.equal(retry.status, 200); assert.equal(retry.data.mapping.id, mapping.id); assert.equal(retry.data.mapping.reason, edited.data.mapping.reason);
  assert.equal((await request('/document-relations/' + item.exercise.id)).data.mappings[0].status, 'proposed');
});
integration('scoped resource managers verify or reject with CAS and audit while ordinary students cannot relabel verification', async () => {
  const item = await fixture('verifiedsoliton verifiedphonon verifiedmagnon'), first = await propose(item), mapping = first.data.mapping;
  const verified = await review(item.exercise, mapping, { status: 'verified' }); assert.equal(verified.status, 200, JSON.stringify(verified.data)); assert.equal(verified.data.mapping.status, 'verified'); assert.equal(verified.data.mapping.reviewerId, 2);
  assert.equal((await review(item.exercise, verified.data.mapping, { reason: 'Student cannot change a verified mapping.' }, cookies.yassine)).status, 403);
  assert.equal((await review(item.exercise, mapping, { status: 'rejected' })).status, 409);
  const reused = await propose(item); assert.equal(reused.data.mapping.status, 'verified');
  const rejected = await review(item.exercise, verified.data.mapping, { status: 'rejected' }); assert.equal(rejected.status, 200); assert.equal(rejected.data.mapping.status, 'rejected');
  const audit = await env.db.prepare("SELECT action,actor_id FROM administrative_audit WHERE target_type='document_relation' AND target_id=? ORDER BY id").all(String(mapping.id)); assert.deepEqual(audit, [{ action: 'document_relation.verified', actor_id: 2 }, { action: 'document_relation.rejected', actor_id: 2 }]);
});
integration('version replacement, deletion and permission revocation hide cached mappings and stale suggestions', async () => {
  const item = await fixture('versionexciton versionmeson versionplasmon'), first = await propose(item), mapping = first.data.mapping;
  await env.db.prepare('UPDATE resources SET version=version+1 WHERE id=?').run(item.course.id);
  const changed = await request('/document-relations/' + item.exercise.id); assert.deepEqual(changed.data.mappings, []); assert.deepEqual(changed.data.suggestions, []); assert.equal((await review(item.exercise, mapping, { status: 'verified' })).status, 409);
  await index(item.course); const newMapping = await propose(item); assert.equal(newMapping.status, 201); assert.equal(newMapping.data.mapping.course.version, 2);
  await env.db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(item.course.id); assert.deepEqual((await request('/document-relations/' + item.exercise.id)).data.mappings, []);
  await env.db.prepare("UPDATE users SET filiere_id='arabic_studies' WHERE id=3").run();
  try { assert.equal((await request('/document-relations/' + item.exercise.id)).status, 403); }
  finally { await env.db.prepare("UPDATE users SET filiere_id='french_studies' WHERE id=3").run(); }
  await env.db.prepare('UPDATE resources SET version=version+1 WHERE id=?').run(item.exercise.id); assert.equal((await request('/document-relations/' + item.exercise.id)).data.state, 'not_indexed');
});
integration('scanned pages return unknown and allow honest manual page mappings after explicit page-count indexing', async () => {
  const pdf = makePdf('Image-only scan ' + randomUUID(), []), blank = Buffer.from(pdf.toString('latin1').replace(/stream\n([\s\S]*?)\nendstream/, (_, content) => 'stream\n' + ' '.repeat(content.length) + '\nendstream'), 'latin1');
  const module = 'Scanned module ' + randomUUID(), exercise = await upload({ module, category: 'td', bytes: blank }), course = await upload({ module });
  assert.equal((await propose({ exercise, course })).status, 409); await index(exercise); await index(course);
  const result = await request('/document-relations/' + exercise.id); assert.equal(result.data.state, 'unknown'); assert.deepEqual(result.data.suggestions, []); assert.match(result.data.message, /OCR/);
  const proposal = await propose({ exercise, course }, { reason: 'Manually checked the photographed page against this source.' }); assert.equal(proposal.status, 201); assert.equal(proposal.data.mapping.status, 'proposed');
  assert.equal((await request('/document-relations/' + exercise.id + '?exercise_page=2')).status, 400);
});
integration('viewed source versions and authoritative reviewer capabilities are enforced; Unicode module normalization stays aligned', async () => {
  const item = await fixture('unicodebirefringence unicodepolarization unicodeanisotropy');
  assert.equal((await request('/document-relations/' + item.exercise.id)).data.canVerify, false);
  assert.equal((await request('/document-relations/' + item.exercise.id, { cookie: cookies.admin })).data.canVerify, true);
  assert.equal((await propose(item, { exercise_version: 2, course_version: 1 })).status, 409);
  assert.equal((await propose(item, { exercise_version: 1, course_version: 2 })).status, 409);
  const course = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(item.course.id), fullWidthModule = course.module.replace(/[a-zA-Z0-9]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 0xfee0));
  await env.db.prepare('UPDATE resources SET module=? WHERE id=?').run(fullWidthModule, course.id);
  const result = await request('/document-relations/' + item.exercise.id); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.suggestions[0].course.resourceId, course.id);
});
integration('final response rechecks hide course replacements and reject account revocation during the page query', async () => {
  const item = await fixture('racebirefringence racepolarization raceanisotropy'); assert.equal((await propose(item)).status, 201);
  const prepare = env.db.prepare.bind(env.db); let changed = false;
  env.db.prepare = statement => {
    const prepared = prepare(statement);
    if (!statement.startsWith('SELECT page,text FROM document_text_pages')) return prepared;
    return { ...prepared, all: async (...args) => { const rows = await prepared.all(...args); if (!changed && args[0] === item.exercise.id) { changed = true; await prepare('UPDATE resources SET version=version+1 WHERE id=?').run(item.course.id); } return rows; } };
  };
  try { const result = await request('/document-relations/' + item.exercise.id); assert.equal(result.status, 200); assert.deepEqual(result.data.mappings, []); assert.deepEqual(result.data.suggestions, []); }
  finally { env.db.prepare = prepare; }
  const second = await fixture('disabledexciton disabledphonon disabledmagnon'); let revoked = false;
  env.db.prepare = statement => {
    const prepared = prepare(statement);
    if (!statement.startsWith('SELECT page,text FROM document_text_pages')) return prepared;
    return { ...prepared, all: async (...args) => { const rows = await prepared.all(...args); if (!revoked && args[0] === second.exercise.id) { revoked = true; await prepare('UPDATE users SET disabled=1 WHERE id=3').run(); } return rows; } };
  };
  try { assert.equal((await request('/document-relations/' + second.exercise.id)).status, 403); }
  finally { env.db.prepare = prepare; await prepare('UPDATE users SET disabled=0 WHERE id=3').run(); }
});
integration('proposal daily caps and scope rechecks protect persistence without granting XP for links', async () => {
  const item = await fixture('capbirefringence cappolarization capanisotropy'), at = new Date().toISOString();
  const course = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(item.course.id), exercise = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(item.exercise.id);
  for (let i = 100; i < 100 + DOCUMENT_RELATION_POLICY.proposalsPerDay; i++) await env.db.prepare('INSERT INTO document_relations(exercise_resource_id,exercise_version,exercise_sha256,exercise_page,course_resource_id,course_version,course_sha256,course_page,reason,proposer_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(exercise.id, i, exercise.sha256, 1, course.id, 1, course.sha256, 1, 'Previously proposed historical version mapping.', 3, at, at);
  assert.equal((await propose(item)).status, 429);
  assert.equal((await env.db.prepare("SELECT COUNT(*)::integer AS count FROM xp_events WHERE event_key LIKE 'document_relation:%'").get()).count, 0);
});
