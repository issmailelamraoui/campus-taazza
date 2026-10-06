import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTestApp } from './helpers.mjs';
import { makePdf } from '../server/seed.js';

let environment, server, base, student, foreign, admin;
async function request(path, { cookie, method = 'GET', body, form } = {}) {
  const response = await fetch(base + '/api' + path, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function login(username, password = 'Campus2026!') {
  const result = await request('/login', { method: 'POST', body: { username, password } });
  assert.equal(result.status, 200); return result.cookie;
}
function uploadForm({ path, filename = path?.split('/').at(-1) || 'course.pdf', title = 'Folder document', buffer = makePdf(title, ['Private folder upload verification.']), ...fields } = {}) {
  const form = new FormData();
  form.set('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  for (const [key, value] of Object.entries({ title, category: 'courses', filiere_id: 'data_science', semester: '5', module: 'Folder upload module', resource_type: 'pdf', channel: 'general', ...fields })) form.set(key, value);
  if (path !== undefined) form.set('relative_path', path);
  return form;
}

before(async () => {
  environment = await createTestApp({ legacyCommunity: false });
  server = environment.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  student = await login('meryem'); foreign = await login('hamza'); admin = await login('admin', 'Admin2026!');
  assert.equal((await request('/studies', { cookie: student, method: 'POST', body: { filiere_id: 'data_science', current_semester: 5 } })).status, 200);
});
after(async () => {
  environment?.app.locals.endStreams(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve)); await environment?.close();
});

test('nested folder files retain hierarchy after refresh and keep private UUID storage keys', async () => {
  const paths = ['Année 3/Cours/notes.pdf', 'Année 3/TD/notes.pdf', 'Année 3/دروس/cours-économie-عربي.pdf'];
  const ids = [];
  for (const [index, path] of paths.entries()) {
    const result = await request('/uploads', { cookie: student, method: 'POST', form: uploadForm({ path, title: `Folder item ${index}`, channel: 'filiere', chat_semester: '6' }) });
    assert.equal(result.status, 201); const resource = result.data.resource; ids.push(resource.id);
    assert.equal(resource.relative_path, path); assert.equal(resource.filename, path.split('/').at(-1));
    assert.equal(resource.semester, 5); assert.equal(resource.chat_semester, 5); assert.equal(resource.filiere_id, 'data_science');
    assert.equal(resource.message_id, result.data.message.id); assert.equal(result.data.message.resource_id, resource.id);
    assert.equal('object_key' in resource, false); assert.equal('sha256' in resource, false);
    const stored = await environment.db.prepare('SELECT relative_path,filename,object_key FROM resources WHERE id=?').get(resource.id);
    assert.equal(stored.relative_path, path); assert.equal(stored.filename, resource.filename);
    assert.match(stored.object_key, /^resources\/data_science\/5\/\d+\/[0-9a-f-]{36}\.pdf$/); assert.ok(environment.storage.objects.has(stored.object_key));
    const file = await request(`/files/${resource.id}`, { cookie: student }); assert.equal(file.status, 200); assert.equal(file.data.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await request(`/files/${resource.id}`, { cookie: foreign })).status, 403);
    assert.equal((await request(`/files/${resource.id}`)).status, 401);
  }
  const bootstrap = (await request('/bootstrap', { cookie: student })).data;
  assert.deepEqual(ids.map(id => bootstrap.resources.find(resource => resource.id === id).relative_path), paths);
  const adminResources = (await request('/admin', { cookie: admin })).data.resources;
  assert.deepEqual(ids.map(id => adminResources.find(resource => resource.id === id).relative_path), paths);
  assert.ok((await request('/bootstrap', { cookie: foreign })).data.resources.every(resource => !ids.includes(resource.id)));
});

test('path validation fails before private storage and cannot bypass existing academic permissions or signatures', async () => {
  const before = { puts: environment.storage.putCount, resources: (await environment.db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n };
  for (const path of ['../course.pdf', '/Root/course.pdf', 'Root/../course.pdf', 'Root\\course.pdf', 'Root//course.pdf', 'Root/other.pdf', 'a'.repeat(256) + '/course.pdf']) {
    const result = await request('/uploads', { cookie: student, method: 'POST', form: uploadForm({ path, filename: 'course.pdf' }) });
    assert.equal(result.status, 400, path);
  }
  assert.equal((await request('/uploads', { cookie: student, method: 'POST', form: uploadForm({ path: 'Root/course.pdf', filiere_id: 'economics' }) })).status, 400);
  assert.equal((await request('/uploads', { cookie: student, method: 'POST', form: uploadForm({ path: 'Root/course.pdf', buffer: Buffer.from('Not a PDF') }) })).status, 400);
  assert.equal(environment.storage.putCount, before.puts);
  assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n, before.resources);
});

test('folder duplicates stay deduplicated and ordinary single-file uploads remain compatible', async () => {
  const buffer = makePdf('Folder dedupe example', ['One physical object regardless of directory name.']);
  const before = environment.storage.putCount;
  const first = await request('/uploads', { cookie: student, method: 'POST', form: uploadForm({ path: 'Root/A/course.pdf', buffer }) }); assert.equal(first.status, 201);
  const duplicate = await request('/uploads', { cookie: student, method: 'POST', form: uploadForm({ path: 'Root/B/course.pdf', buffer }) }); assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.resource.id, first.data.resource.id); assert.equal(duplicate.data.resource.relative_path, 'Root/A/course.pdf');
  assert.equal(environment.storage.putCount, before + 1);
  const legacy = await request('/uploads', { cookie: student, method: 'POST', form: uploadForm({ title: 'Legacy single-file remains supported' }) }); assert.equal(legacy.status, 201);
  assert.equal(legacy.data.resource.relative_path, '');
  const seeded = (await request('/bootstrap', { cookie: student })).data.resources.find(resource => !resource.title.startsWith('Folder') && resource.id !== legacy.data.resource.id);
  assert.equal(seeded.relative_path, '');
});
