import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { moduleSharingEnvironment } from './module-sharing.helpers.mjs';
import { moduleShareResourceId } from '../server/module-sharing.js';

const integration = process.env.CAMPUS_TEST_DATABASE_URL ? test : test.skip;
let env;
before(async () => { if (process.env.CAMPUS_TEST_DATABASE_URL) env = await moduleSharingEnvironment(); });
after(async () => { await env?.close(); });
const share = (resource, extra = {}, options = {}) => env.request('/messages', { method: 'POST', body: {
  content: 'J’ai ajouté ce module PDF aujourd’hui.', channel: 'general', client_id: randomUUID(), module_resource_id: resource.id, ...extra,
}, ...options });

test('module anchors reject malformed IDs and preserve absent optional references', () => {
  assert.equal(moduleShareResourceId(undefined), null); assert.equal(moduleShareResourceId(null), null);
  assert.equal(moduleShareResourceId('42'), 42);
  for (const value of ['', true, false, 0, -1, 1.5, {}, [], 'incorrect', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => moduleShareResourceId(value), { status: 400 });
});

integration('sharing an existing module persists its canonical reference and personal message without copying or publishing any files', async () => {
  const resource = await env.addResource({ module: 'Probabilités et Statistiques' });
  const before = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(resource.id), puts = env.storage.putCount;
  const result = await share(resource, { module: 'forged', faculty_id: 'feg', filiere_id: 'economics', semester: 6 });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const message = result.data.message;
  assert.equal(message.content, 'J’ai ajouté ce module PDF aujourd’hui.');
  assert.deepEqual(message.shared_module, { resource_id: resource.id, faculty_id: 'fsa', filiere_id: 'mathematics', semester: 1, module: resource.module, accessible: true });
  assert.deepEqual(message.attachments, []);
  assert.deepEqual(await env.db.prepare('SELECT * FROM resources WHERE id=?').get(resource.id), before);
  assert.equal(env.storage.putCount, puts);
  const reloaded = await env.request('/messages/' + message.id, { user: 'share.peer' });
  assert.deepEqual(reloaded.data.message.shared_module, message.shared_module);
  assert.ok((await env.request('/bootstrap', { user: 'share.peer' })).data.messages.some(row => row.id === message.id && row.shared_module.module === resource.module));
});

integration('general-chat recipients keep a recognizable reference without acquiring unrelated programme or faculty library access', async () => {
  const resource = await env.addResource({ module: 'Confidential access scoped example' });
  const posted = await share(resource), id = posted.data.message.id;
  const other = await env.request('/messages/' + id, { user: 'share.program' });
  assert.equal(other.status, 200);
  assert.equal(other.data.message.shared_module.module, resource.module);
  assert.equal(other.data.message.shared_module.accessible, false);
  assert.equal((await env.request('/files/' + resource.id, { user: 'share.program' })).status, 403);
  assert.ok(!(await env.request('/bootstrap', { user: 'share.program' })).data.resources.some(row => row.id === resource.id));
  assert.equal((await env.request('/messages/' + id, { user: 'share.faculty' })).status, 403);
  assert.equal('object_key' in other.data.message.shared_module, false);
  assert.equal('filename' in other.data.message.shared_module, false);
});

integration('scope comes only from an accessible visible library document and rejected references leave no ghost message', async () => {
  const otherProgram = await env.addResource({ user: 'share.program' });
  const otherFaculty = await env.addResource({ user: 'share.faculty' });
  const hidden = await env.addResource({ visible: false });
  const removed = await env.addResource();
  await env.db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(removed.id);
  const count = (await env.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n;
  for (const resource of [otherProgram, otherFaculty, hidden, removed, { id: 987654321 }]) {
    const result = await share(resource);
    assert.equal(result.status, 403, JSON.stringify(result.data));
  }
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n, count);
});

integration('module references retain exact library semester in any allowed year chat and obey channel read-only and chat bans', async () => {
  const resource = await env.addResource({ semester: 4 });
  const posted = await share(resource, { channel: 'filiere', semester: 6, content: '' });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(posted.data.message.semester, 5);
  assert.equal(posted.data.message.shared_module.semester, 4);
  assert.ok((await env.request('/messages?channel=filiere&semester=5', { user: 'share.peer' })).data.messages.some(row => row.id === posted.data.message.id));
  assert.ok(!(await env.request('/messages?channel=filiere&semester=1', { user: 'share.peer' })).data.messages.some(row => row.id === posted.data.message.id));
  await env.db.prepare("UPDATE channels SET read_only=1 WHERE faculty_id='fsa' AND id='important'").run();
  try { assert.equal((await share(resource, { channel: 'important' })).status, 403); }
  finally { await env.db.prepare("UPDATE channels SET read_only=0 WHERE faculty_id='fsa' AND id='important'").run(); }
  await env.db.prepare("INSERT INTO chat_bans(user_id,faculty_id,blocked_by,created_at) VALUES (?,'fsa',?,?)").run(env.users['share.sender'].id, env.users['share.peer'].id, new Date().toISOString());
  try { assert.equal((await share(resource)).status, 403); }
  finally { await env.db.prepare("DELETE FROM chat_bans WHERE user_id=? AND faculty_id='fsa'").run(env.users['share.sender'].id); }
});

integration('concurrent retries create one module reference and changing it under the same client key conflicts', async () => {
  const resource = await env.addResource(), other = await env.addResource({ module: 'Analyse' });
  const client_id = randomUUID(), results = await Promise.all([share(resource, { client_id }), share(resource, { client_id })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  const id = results[0].data.message.id;
  assert.equal(results[1].data.message.id, id);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM message_module_shares WHERE message_id=?').get(id)).n, 1);
  assert.equal((await share(other, { client_id })).status, 409);
  assert.equal((await share(resource, { client_id, module_resource_id: null })).status, 409);
});

integration('a shared module remains available while any correctly scoped document exists and becomes an unavailable snapshot after removal', async () => {
  const first = await env.addResource({ module: 'Dossier durable' });
  const second = await env.addResource({ module: 'DOSSIER DURABLE' });
  const posted = await share(first), path = '/messages/' + posted.data.message.id;
  await env.db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(first.id);
  assert.equal((await env.request(path)).data.message.shared_module.accessible, true);
  await env.db.prepare("UPDATE resources SET filiere_id='physics' WHERE id=?").run(second.id);
  const snapshot = (await env.request(path)).data.message.shared_module;
  assert.equal(snapshot.accessible, false); assert.equal(snapshot.module, first.module);
  assert.equal((await env.request(path)).data.message.content, posted.data.message.content);
});
