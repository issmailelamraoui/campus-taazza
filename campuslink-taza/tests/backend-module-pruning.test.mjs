import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';
import { resolveModule, lockResourceModule, pruneRemovedResourceModule } from '../server/modules.js';

// Only a disposable test schema, injected identity and in-memory file storage
// are modified. No cleanup is run against the user's application schema.
let env, server, origin, cookie;
const scope = { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 };
const label = () => `Module cleanup ${randomUUID()}`;
async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function insertResource(db, module, context, { visible = 1, removed = 0, name = module.name } = {}) {
  const id = randomUUID();
  return db.prepare(`INSERT INTO resources(faculty_id,filiere_id,semester,module_id,module,title,filename,
    object_key,sha256,category,part_number,author_id,created_at,size,mime,library_visible,removed)
    VALUES(?,?,?,?,?,?,?,?,?,'courses','complete',3,'2026-10-26T09:00:00Z',7,'text/plain',?,?) RETURNING *`)
    .get(context.facultyId, context.filiereId, context.semester, module.id, name, `Document ${id}`,
      `file-${id}.txt`, `test-module-cleanup/${id}`, id, visible, removed);
}
async function resource(name, options = {}, context = scope) {
  return env.db.transaction(async db => {
    const module = await resolveModule(db, { ...context, name });
    return insertResource(db, module, context, options);
  });
}
const moduleRow = id => env.db.prepare('SELECT * FROM modules WHERE id=?').get(id);
const resourceRow = id => env.db.prepare('SELECT * FROM resources WHERE id=?').get(id);
function retainedMetadata(row) { const { module_id, removed, ...retained } = row; return retained; }
async function remove(id) {
  const result = await request(`/admin/resources/${id}`, { method: 'DELETE' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

before(async () => {
  env = await createTestApp();
  server = env.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin2026!' }) });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session=')).split(';')[0];
});
after(async () => {
  env?.app.locals.endStreams();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await env?.close();
});

test('last resource removal permanently prunes its module while retaining file and version history', async () => {
  const name = label(), first = await resource(name), last = await resource(name.toUpperCase());
  assert.equal(first.module_id, last.module_id);
  await env.storage.put(first.object_key, Buffer.from('original'), 'text/plain');
  await env.storage.put(last.object_key, Buffer.from('current'), 'text/plain');
  await env.db.prepare(`INSERT INTO resource_versions(resource_id,version,filename,object_key,sha256,size,mime,updated_at)
    VALUES(?,1,'old.txt','test-module-cleanup/old-version','old-version',7,'text/plain','2026-10-25')`).run(last.id);
  const versions = await env.db.prepare('SELECT * FROM resource_versions WHERE resource_id=?').all(last.id);
  const objects = [...env.storage.objects.keys()];
  await remove(first.id);
  assert.ok(await moduleRow(first.module_id), 'The remaining file keeps its module.');
  await remove(last.id);
  assert.equal(await moduleRow(first.module_id), undefined);
  for (const original of [first, last]) {
    const removed = await resourceRow(original.id);
    assert.equal(removed.removed, 1);
    assert.equal(removed.module_id, null);
    assert.deepEqual(retainedMetadata(removed), retainedMetadata(original));
  }
  assert.deepEqual(await env.db.prepare('SELECT * FROM resource_versions WHERE resource_id=?').all(last.id), versions);
  assert.deepEqual([...env.storage.objects.keys()], objects, 'Module cleanup does not delete stored bytes.');
  const catalog = await request('/modules?semester=1');
  assert.equal(catalog.status, 200);
  assert.ok(!catalog.data.modules.some(item => item.id === first.module_id));
  const reuploaded = await resource(name);
  assert.notEqual(reuploaded.module_id, first.module_id, 'A later real upload creates a fresh valid module.');
  assert.ok(await moduleRow(reuploaded.module_id));
  assert.equal((await resourceRow(last.id)).module_id, null, 'Historical rows are not rebound to the new module.');
});

test('active chat-only and legacy text-only references protect a module until the final file is removed', async () => {
  const name = label(), library = await resource(name), chat = await resource(name, { visible: 0 });
  const legacy = await resource(name, { name: `  ${name.toUpperCase()}  ` });
  await env.db.prepare('UPDATE resources SET module_id=NULL WHERE id=?').run(legacy.id);
  await remove(library.id);
  assert.ok(await moduleRow(library.module_id));
  await remove(chat.id);
  assert.ok(await moduleRow(library.module_id), 'Canonical legacy text without a FK also counts.');
  await remove(legacy.id);
  assert.equal(await moduleRow(library.module_id), undefined);
});

test('pruning is confined to the exact faculty, program and semester', async () => {
  const name = label(), target = await resource(name);
  const others = [await resource(name, {}, { ...scope, semester: 2 }),
    await resource(name, {}, { ...scope, filiereId: 'arabic_studies' }),
    await resource(name, {}, { facultyId: 'feg', filiereId: 'economics', semester: 1 })];
  await remove(target.id);
  assert.equal(await moduleRow(target.module_id), undefined);
  for (const other of others) {
    assert.ok(await moduleRow(other.module_id));
    assert.deepEqual(await resourceRow(other.id), other);
  }
});

test('report moderation uses the same cleanup and preserves the resolved report evidence', async () => {
  const target = await resource(label());
  const report = await env.db.prepare(`INSERT INTO reports(faculty_id,reporter_id,target_type,target_id,reason,details,created_at)
    VALUES('flaa',3,'resource',?,'inappropriate','Original moderation evidence','2026-10-26') RETURNING *`).get(target.id);
  const result = await request(`/admin/reports/${report.id}/remove-target`, { method: 'POST', body: { note: 'Reviewed fixture' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(await moduleRow(target.module_id), undefined);
  assert.equal((await resourceRow(target.id)).module, target.module);
  const resolved = await env.db.prepare('SELECT * FROM reports WHERE id=?').get(report.id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.target_id, target.id);
  assert.equal(resolved.details, report.details);
});

test('catalog GET hides historical orphans without writing, while retaining never-used and active chat modules', async () => {
  const historic = await resource(label());
  await env.db.prepare('UPDATE resources SET removed=1,module_id=NULL WHERE id=?').run(historic.id);
  const neverUsed = await resolveModule(env.db, { ...scope, name: label() });
  const chat = await resource(label(), { visible: 0 });
  const before = await resourceRow(historic.id);
  const result = await request('/modules?semester=1');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const ids = result.data.modules.map(item => item.id);
  assert.ok(!ids.includes(historic.module_id));
  assert.ok(ids.includes(neverUsed.id));
  assert.ok(ids.includes(chat.module_id));
  assert.deepEqual(await resourceRow(historic.id), before);
  assert.ok(await moduleRow(historic.module_id), 'A read does not run historical database cleanup.');
});

test('an enclosing removal failure rolls back both soft deletion and module cleanup', async () => {
  const target = await resource(label());
  await assert.rejects(env.db.transaction(async db => {
    await lockResourceModule(db, target);
    await db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(target.id);
    assert.equal(await pruneRemovedResourceModule(db, target), true);
    throw new Error('Intentional later removal failure');
  }), /Intentional later removal failure/);
  assert.deepEqual(await resourceRow(target.id), target);
  assert.ok(await moduleRow(target.module_id));
});

test('concurrent upload resolution and last-file removal serialize without a dangling FK or lost new file', async () => {
  const target = await resource(label()), uploadReady = deferred(), resumeUpload = deferred(), removalStarted = deferred();
  let removalPid;
  const upload = env.db.transaction(async db => {
    const module = await resolveModule(db, { ...scope, name: target.module.toUpperCase() });
    uploadReady.resolve();
    await resumeUpload.promise;
    return insertResource(db, module, scope);
  });
  await uploadReady.promise;
  const removal = env.db.transaction(async db => {
    removalPid = (await db.prepare('SELECT pg_backend_pid() AS pid').get()).pid;
    removalStarted.resolve();
    await lockResourceModule(db, target);
    await db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(target.id);
    return pruneRemovedResourceModule(db, target);
  });
  try {
    await removalStarted.promise;
    let waiting = false;
    for (let attempt = 0; attempt < 30 && !waiting; attempt++) {
      waiting = Boolean((await env.db.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [removalPid])).rows.length);
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(waiting, 'Removal waits on the same canonical module lock as the upload.');
  } finally { resumeUpload.resolve(); }
  const [added, pruned] = await Promise.all([upload, removal]);
  assert.equal(pruned, false);
  assert.equal(added.module_id, target.module_id);
  assert.ok(await moduleRow(added.module_id));
  assert.equal((await resourceRow(added.id)).removed, 0);
});
