import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';

// Every write is confined to createTestApp's disposable PostgreSQL schema.
// Storage and identity/session handling use explicit in-memory test doubles.
let env, server, origin;
const cookies = {};
const stamp = () => new Date().toISOString();
async function request(path, { cookie, method = 'GET', body, form } = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, cookie: response.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session='))?.split(';')[0] };
}
async function login(username) {
  const result = await request('/login', { method: 'POST', body: { username, password: username === 'admin' ? 'Admin2026!' : 'Campus2026!' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.cookie;
}
async function message({ faculty = 'flaa', author = 3, channel = 'general', content = 'Admin moderation fixture' } = {}) {
  return env.db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at) VALUES (?,?,?,?,?) RETURNING *').get(faculty, channel, content, author, stamp());
}
async function resource({ faculty = 'flaa', author = 3, library = false } = {}) {
  const label = `Admin resource ${randomUUID()}`, bytes = Buffer.from(label), key = `test-admin-actions/${randomUUID()}`;
  await env.storage.put(key, bytes, 'text/plain');
  return env.db.prepare('INSERT INTO resources (faculty_id,title,filename,object_key,sha256,category,semester,module,author_id,created_at,size,mime,library_visible,filiere_id,part_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *').get(faculty, label, 'admin-fixture.txt', key, createHash('sha256').update(bytes).digest('hex'), 'courses', 1, label, author, stamp(), bytes.length, 'text/plain', library ? 1 : 0, faculty === 'flaa' ? 'french_studies' : 'economics', 'complete');
}
async function announcement({ faculty = 'flaa', author = 2, channel = 'important', parent = null } = {}) {
  return env.db.prepare('INSERT INTO announcements (faculty_id,content,channel,author_id,created_at,title,message_id,pinned) VALUES (?,?,?,?,?,?,?,?) RETURNING *').get(faculty, 'Administration announcement fixture', channel, author, stamp(), 'Admin fixture', parent, parent ? 1 : 0);
}
async function report(type, target, { faculty = target.faculty_id, reporter = faculty === 'flaa' ? 3 : 9, status = 'open' } = {}) {
  return env.db.prepare('INSERT INTO reports (faculty_id,reporter_id,target_type,target_id,reason,details,status,created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING *').get(faculty, reporter, type, target.id, 'inappropriate', 'Regression fixture', status, stamp());
}
async function remove(targetReport, cookie, note = 'Reviewed and removed') {
  return request(`/admin/reports/${targetReport.id}/remove-target`, { cookie, method: 'POST', body: { note } });
}
async function attach(parent, files) {
  await env.db.transaction(async () => {
    for (let index = 0; index < files.length; index++) {
      await env.db.prepare('INSERT INTO message_attachments (message_id,resource_id,position) VALUES (?,?,?)').run(parent.id, files[index].id, index);
      await env.db.prepare('UPDATE resources SET message_id=? WHERE id=?').run(parent.id, files[index].id);
    }
    await env.db.prepare('UPDATE messages SET resource_id=? WHERE id=?').run(files[0].id, parent.id);
  });
}
async function remember(type, id, user = 3) {
  await env.db.prepare('INSERT INTO saved (user_id,type,target_id) VALUES (?,?,?)').run(user, type, id);
  if (type === 'resource') await env.db.prepare('INSERT INTO history (user_id,resource_id,opened_at) VALUES (?,?,?)').run(user, id, stamp());
}

before(async () => {
  env = await createTestApp();
  server = env.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const username of ['yassine', 'nour', 'professeure', 'amina', 'admin']) cookies[username] = await login(username);
});
after(async () => {
  env?.app.locals.endStreams();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await env?.close();
});

test('reported message removal enforces student, moderator, faculty and global scopes', async () => {
  const own = await message(), foreign = await message({ faculty: 'feg', author: 9 });
  const ownReport = await report('message', own), foreignReport = await report('message', foreign);
  assert.equal((await remove(ownReport, cookies.yassine)).status, 403);
  assert.equal((await remove(foreignReport, cookies.amina)).status, 403);
  assert.equal((await remove(foreignReport, cookies.professeure)).status, 403);
  assert.equal((await remove(ownReport, cookies.amina)).status, 200);
  assert.equal((await env.db.prepare('SELECT removed FROM messages WHERE id=?').get(own.id)).removed, 1);
  assert.equal((await remove(foreignReport, cookies.admin)).status, 200);
  assert.equal((await env.db.prepare('SELECT removed FROM messages WHERE id=?').get(foreign.id)).removed, 1);
  const mismatched = await message({ faculty: 'feg', author: 9 });
  const badReport = await report('message', mismatched, { faculty: 'flaa' });
  assert.equal((await remove(badReport, cookies.admin)).status, 403, 'Report and target faculty must agree even for global admins');
  assert.equal((await env.db.prepare('SELECT removed FROM messages WHERE id=?').get(mismatched.id)).removed, 0);
});

test('resource and announcement removal allows faculty administration while restricting moderators and foreign faculties', async () => {
  for (const [type, make] of [['resource', resource], ['announcement', announcement]]) {
    const own = await make(), foreign = await make({ faculty: 'feg', author: 9 });
    const ownReport = await report(type, own), foreignReport = await report(type, foreign);
    assert.equal((await remove(ownReport, cookies.amina)).status, 403, `${type}: moderators cannot remove files or announcements`);
    assert.equal((await remove(foreignReport, cookies.professeure)).status, 403);
    assert.equal((await remove(ownReport, cookies.professeure)).status, 200);
    assert.equal((await remove(foreignReport, cookies.admin)).status, 200);
    const row = await env.db.prepare(`SELECT * FROM ${type === 'resource' ? 'resources' : 'announcements'} WHERE id=?`).get(own.id);
    assert.equal(type === 'resource' ? row.removed : row, type === 'resource' ? 1 : undefined);
  }
});

test('target removal resolves every active duplicate report and keeps resolved and dismissed reports in the archive', async () => {
  const target = await message();
  const reports = await Promise.all(['open', 'reviewed', 'dismissed'].map(status => report('message', target, { status })));
  const concurrent = await Promise.all([remove(reports[0], cookies.professeure, 'Duplicate target removed'), remove(reports[1], cookies.admin, 'Duplicate target removed')]);
  assert.deepEqual(concurrent.map(result => result.status), [200, 200], 'Concurrent administrators resolve duplicate reports without deadlocking');
  const rows = await env.db.prepare('SELECT id,status,note FROM reports WHERE target_type=? AND target_id=? ORDER BY id').all('message', target.id);
  assert.deepEqual(rows.map(item => item.status), ['resolved', 'resolved', 'dismissed']);
  assert.ok(rows.slice(0, 2).every(item => item.note === 'Duplicate target removed'));
  const active = await request('/admin', { cookie: cookies.admin });
  assert.equal(active.status, 200);
  assert.ok(reports.every(item => !active.data.reports.some(row => row.id === item.id)));
  const archive = await request('/admin?status=all', { cookie: cookies.admin });
  assert.equal(archive.status, 200);
  assert.ok(reports.every(item => archive.data.reports.some(row => row.id === item.id)));
  assert.equal((await remove(reports[0], cookies.amina)).status, 200, 'Retrying removal of an already removed target is safe');
});

test('removing a reported attachment preserves message text and its other file', async () => {
  const parent = await message({ content: 'Keep this explanation and the second attachment.' });
  const removedFile = await resource(), retainedFile = await resource();
  await attach(parent, [removedFile, retainedFile]);
  await remember('resource', removedFile.id);
  const targetReport = await report('resource', removedFile);
  assert.equal((await remove(targetReport, cookies.professeure)).status, 200);
  const read = await request(`/messages/${parent.id}`, { cookie: cookies.yassine });
  assert.equal(read.status, 200);
  assert.equal(read.data.message.content, parent.content);
  assert.deepEqual(read.data.message.attachments.map(item => item.id), [retainedFile.id]);
  assert.equal((await env.db.prepare('SELECT removed,resource_id FROM messages WHERE id=?').get(parent.id)).removed, 0);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM saved WHERE type=? AND target_id=?').get('resource', removedFile.id)).n, 0);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM history WHERE resource_id=?').get(removedFile.id)).n, 0);
  assert.equal((await request(`/files/${removedFile.id}`, { cookie: cookies.admin })).status, 404);
  assert.equal((await request(`/files/${retainedFile.id}`, { cookie: cookies.yassine })).status, 200);
});

test('removing the last file removes its empty parent, pin, active reports, bookmarks and history', async () => {
  const parent = await message({ content: '' }), file = await resource();
  await attach(parent, [file]);
  await env.db.prepare('UPDATE messages SET pinned=1 WHERE id=?').run(parent.id);
  const pin = await announcement({ parent: parent.id, channel: 'general' });
  const reports = await Promise.all([report('resource', file), report('message', parent), report('announcement', pin)]);
  await Promise.all([remember('resource', file.id), remember('message', parent.id), remember('announcement', pin.id)]);
  assert.equal((await remove(reports[0], cookies.professeure)).status, 200);
  const removedParent = await env.db.prepare('SELECT removed,pinned,resource_id FROM messages WHERE id=?').get(parent.id);
  assert.deepEqual(removedParent, { removed: 1, pinned: 0, resource_id: null });
  assert.equal(await env.db.prepare('SELECT id FROM announcements WHERE id=?').get(pin.id), undefined);
  assert.equal((await request(`/messages/${parent.id}`, { cookie: cookies.yassine })).status, 404);
  for (const item of reports) assert.equal((await env.db.prepare('SELECT status FROM reports WHERE id=?').get(item.id)).status, 'resolved');
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM saved WHERE (type=? AND target_id=?) OR (type=? AND target_id=?) OR (type=? AND target_id=?)').get('resource', file.id, 'message', parent.id, 'announcement', pin.id)).n, 0);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM history WHERE resource_id=?').get(file.id)).n, 0);
  const inbox = await request('/admin', { cookie: cookies.admin });
  assert.ok(reports.every(item => !inbox.data.reports.some(row => row.id === item.id)));
});

test('retired help and life channels stay inaccessible through direct and administrative endpoints even for global admins', async () => {
  for (const channel of ['help', 'life']) {
    const hiddenMessage = await message({ channel }), hiddenAnnouncement = await announcement({ channel });
    const hiddenReport = await report('message', hiddenMessage);
    assert.equal((await request(`/messages?channel=${channel}`, { cookie: cookies.admin })).status, 400);
    assert.equal((await request(`/messages/${hiddenMessage.id}`, { cookie: cookies.admin })).status, 404);
    assert.equal((await request(`/messages/${hiddenMessage.id}/pin`, { cookie: cookies.admin, method: 'POST', body: { pinned: true } })).status, 404);
    assert.equal((await request(`/admin/messages/${hiddenMessage.id}/remove`, { cookie: cookies.admin, method: 'POST' })).status, 404);
    assert.equal((await request(`/admin/channels/${channel}`, { cookie: cookies.admin, method: 'PATCH', body: { name: 'Reopen hidden channel' } })).status, 400);
    assert.equal((await request('/messages', { cookie: cookies.admin, method: 'POST', body: { channel, content: 'Hidden post' } })).status, 400);
    assert.equal((await request(`/admin/announcements/${hiddenAnnouncement.id}`, { cookie: cookies.admin, method: 'PATCH', body: { title: 'Hidden edit' } })).status, 404);
    assert.equal((await request(`/admin/announcements/${hiddenAnnouncement.id}`, { cookie: cookies.admin, method: 'DELETE' })).status, 404);
    assert.equal((await remove(hiddenReport, cookies.admin)).status, 404);
    const boot = await request('/bootstrap', { cookie: cookies.admin });
    assert.equal(boot.status, 200);
    assert.ok(!boot.data.channels.some(item => item.id === channel));
    assert.ok(!boot.data.messages.some(item => item.id === hiddenMessage.id));
    assert.ok(!boot.data.announcements.some(item => item.id === hiddenAnnouncement.id));
    const inbox = await request('/admin?status=all', { cookie: cookies.admin });
    assert.ok(!inbox.data.reports.some(item => item.id === hiddenReport.id));
  }
});

test('only global administrators can appoint a student in that student’s own faculty and revoke old sessions', async () => {
  const student = await env.db.prepare('SELECT * FROM users WHERE username=?').get('nour');
  assert.equal((await request(`/admin/users/${student.id}`, { cookie: cookies.professeure, method: 'PATCH', body: { role: 'faculty_admin' } })).status, 403);
  assert.equal((await request(`/admin/users/${student.id}`, { cookie: cookies.admin, method: 'PATCH', body: { role: 'faculty_admin', faculty_id: 'feg' } })).status, 400);
  const appointed = await request(`/admin/users/${student.id}`, { cookie: cookies.admin, method: 'PATCH', body: { role: 'faculty_admin' } });
  assert.equal(appointed.status, 200, JSON.stringify(appointed.data));
  assert.equal(appointed.data.user.role, 'faculty_admin');
  assert.equal(appointed.data.user.faculty_id, student.faculty_id);
  assert.equal(appointed.data.user.filiere_id, student.filiere_id);
  assert.ok((await env.db.prepare('SELECT session_version FROM users WHERE id=?').get(student.id)).session_version > student.session_version);
  assert.equal((await request('/bootstrap', { cookie: cookies.nour })).status, 401);
  const fresh = await login('nour');
  assert.equal((await request('/admin', { cookie: fresh })).status, 200);
});

test('a lost upload COMMIT acknowledgement preserves the stored object and never retries the write', async () => {
  const title = `Lost commit acknowledgement ${randomUUID()}`;
  const form = new FormData();
  for (const [key, value] of Object.entries({ title, category: 'courses', filiere_id: 'french_studies', semester: '1', module: title, resource_type: 'courses', part_number: 'complete', teacher_name: '', channel: 'general', library_visible: 'true', publish_message: 'false' })) form.set(key, value);
  form.set('file', new Blob([title], { type: 'text/plain' }), 'lost-commit.txt');
  const originalTransaction = env.db.transaction;
  const putsBefore = env.storage.putCount, deletesBefore = env.storage.deleteCount;
  let transactions = 0;
  env.db.transaction = async (...args) => {
    transactions++;
    await originalTransaction(...args);
    throw Object.assign(new Error('Simulated lost COMMIT acknowledgement.'), { status: 503, code: 'DATABASE_UNAVAILABLE' });
  };
  let result;
  try {
    result = await request('/uploads', { cookie: cookies.professeure, method: 'POST', form });
  } finally {
    env.db.transaction = originalTransaction;
  }
  assert.equal(result.status, 503);
  assert.equal(transactions, 1, 'The uncertain write must not be retried automatically');
  assert.equal(env.storage.putCount, putsBefore + 1);
  assert.equal(env.storage.deleteCount, deletesBefore, 'Lost acknowledgement must not delete a possibly committed file');
  const rows = await env.db.prepare('SELECT id,object_key FROM resources WHERE title=?').all(title);
  assert.equal(rows.length, 1);
  assert.ok(env.storage.objects.has(rows[0].object_key));
  const file = await request(`/files/${rows[0].id}`, { cookie: cookies.professeure });
  assert.equal(file.status, 200);
  assert.equal(file.data.toString(), title);
});

test('global student deletion revokes access and personal data while retaining authored messages and academic files', async () => {
  const student = await env.db.prepare('SELECT * FROM users WHERE username=?').get('yassine');
  const parent = await message({ author: student.id }), file = await resource({ author: student.id, library: true });
  assert.equal((await request(`/admin/users/${student.id}`, { cookie: cookies.professeure, method: 'DELETE' })).status, 403);
  assert.equal((await request('/admin/users/2', { cookie: cookies.admin, method: 'DELETE' })).status, 403);
  const removed = await request(`/admin/users/${student.id}`, { cookie: cookies.admin, method: 'DELETE' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await request('/bootstrap', { cookie: cookies.yassine })).status, 401);
  const tombstone = await env.db.prepare('SELECT * FROM users WHERE id=?').get(student.id);
  assert.equal(tombstone.account_status, 'deleted');
  assert.equal(tombstone.disabled, 1);
  assert.equal(tombstone.email, null);
  assert.equal(tombstone.auth_user_id, null);
  assert.equal(tombstone.faculty_id, null);
  assert.ok(tombstone.session_version > student.session_version);
  const readMessage = await request(`/messages/${parent.id}`, { cookie: cookies.professeure });
  assert.equal(readMessage.status, 200);
  assert.equal(readMessage.data.message.content, parent.content);
  assert.equal(readMessage.data.message.author.name, 'Étudiant supprimé');
  assert.equal((await request(`/files/${file.id}`, { cookie: cookies.professeure })).status, 200);
  assert.equal((await env.db.prepare('SELECT author_id,removed FROM resources WHERE id=?').get(file.id)).author_id, student.id);
  assert.equal((await env.db.prepare('SELECT author_id,removed FROM messages WHERE id=?').get(parent.id)).removed, 0);
  const inbox = await request('/admin', { cookie: cookies.admin });
  assert.ok(!inbox.data.users.some(item => item.id === student.id));
});
