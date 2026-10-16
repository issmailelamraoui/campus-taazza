import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';
import { makePdf } from '../server/seed.js';
import { UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_THRESHOLD, UPLOAD_MAX_BYTES, chunkUploadTarget } from '../shared/upload-transport.js';
import { api, invalidateAPISession, subscribeAPIActivity } from '../src/api.js';

const integration = process.env.CAMPUS_TEST_DATABASE_URL ? test : test.skip;
let env, server, proxy, origin;
const cookies = {}, bodies = [], megabyte = 1024 * 1024, proxyLimit = 4.5 * megabyte;

// Execute the production browser API transport against the real HTTP gateway;
// only relative URL resolution and the browser's same-origin cookie are supplied.
async function browserAPI(callback, intercept) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input, origin);
    const headers = new Headers(options.headers); headers.set('cookie', cookies.yassine);
    const forward = () => nativeFetch(url, { ...options, headers });
    return intercept ? intercept(url.pathname, options, forward) : forward();
  };
  invalidateAPISession();
  try { return await callback(); }
  finally { globalThis.fetch = nativeFetch; invalidateAPISession(); }
}
function browserUpload(bytes) {
  const filename = 'Cours — إحصاء.pdf';
  const file = new File([bytes], filename, { type: 'application/pdf' }), body = new FormData();
  body.append('file', file);
  for (const [key, value] of metadata({ relative_path: 'S1/Éléments/' + filename })) body.append(key, value);
  return { file, body };
}

before(async () => {
  if (!process.env.CAMPUS_TEST_DATABASE_URL) return;
  env = await createTestApp();
  server = env.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  // Reproduce a hosting gateway with a smaller body cap than the file limit.
  // Every actual HTTP request is measured while streamed to the real API.
  proxy = createServer((req, res) => {
    const record = { path: req.url, method: req.method, bytes: 0 }; bodies.push(record);
    if (Number(req.headers['content-length']) > proxyLimit) { res.writeHead(413); res.end('Gateway body limit exceeded'); return; }
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
    });
    forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Test gateway upstream error'); });
    req.on('data', bytes => {
      record.bytes += bytes.length;
      if (record.bytes > proxyLimit) { forwarded.destroy(); if (!res.headersSent) res.writeHead(413); res.end('Gateway body limit exceeded'); }
    });
    req.pipe(forwarded);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  origin = `http://127.0.0.1:${proxy.address().port}`;
  for (const username of ['yassine', 'sara', 'nour', 'admin']) {
    const result = await request('/login', { user: username, method: 'POST', body: { username, password: username === 'admin' ? 'Admin2026!' : 'Campus2026!' } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    cookies[username] = result.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session=')).split(';')[0];
  }
});
after(async () => {
  if (!env) return;
  env.app.locals.endStreams(); proxy.closeAllConnections(); server.closeAllConnections();
  await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => server.close(resolve))]); await env.close();
});

async function request(path, { user = 'yassine', method = 'GET', body, bytes } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method, headers: { ...(cookies[user] ? { cookie: cookies[user] } : {}), ...(bytes ? { 'Content-Type': 'application/octet-stream' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(bytes ? { body: bytes } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text(), headers: response.headers };
}
function pdfBytes(size, title = randomUUID()) {
  const bytes = Buffer.alloc(size, 32);
  makePdf(title, ['A private synthetic upload used only by this regression test.']).copy(bytes);
  Buffer.from('\n%%EOF\n').copy(bytes, size - 7);
  return bytes;
}
function metadata(extra = {}) {
  return Object.entries({ title: 'Grand document ' + randomUUID(), module: 'Transport ' + randomUUID(), category: 'courses', resource_type: 'courses', filiere_id: 'french_studies', semester: '1', part_number: 'complete', teacher_name: 'Professeur — Élodie', channel: 'general', publish_message: 'false', ...extra });
}
const start = (size, { path = '/uploads', filename = 'grand-cours.pdf', fields = metadata(), user = 'yassine', clientId } = {}) => request('/upload-sessions', { user, method: 'POST', body: { path, file: { name: filename, type: 'application/pdf', size }, fields, ...(clientId ? { client_id: clientId } : {}) } });
const put = (id, part, bytes, user) => request(`/upload-sessions/${id}/parts/${part}`, { user, method: 'PUT', bytes });
const complete = (id, user) => request(`/upload-sessions/${id}/complete`, { user, method: 'POST', body: {} });
const cancel = (id, user) => request(`/upload-sessions/${id}`, { user, method: 'DELETE' });
async function uploadParts(session, bytes, { user = 'yassine', from = 1 } = {}) {
  assert.equal(session.chunk_bytes, UPLOAD_CHUNK_BYTES);
  for (let part = from; part <= Math.ceil(bytes.length / session.chunk_bytes); part++) {
    const result = await put(session.id, part, bytes.subarray((part - 1) * session.chunk_bytes, part * session.chunk_bytes), user);
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
}
const resourceCount = async () => (await env.db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n;

test('chunk transport is restricted to existing file routes and preserves the public 20 MB limit', () => {
  assert.equal(UPLOAD_CHUNK_BYTES, 2 * megabyte); assert.equal(UPLOAD_CHUNK_THRESHOLD, 3 * megabyte); assert.equal(UPLOAD_MAX_BYTES, 20 * megabyte);
  for (const path of ['/uploads', '/admin/resources/1/replace', '/feedback/2/attachments', '/document-repairs/3', '/campus/forum/4/attachments', '/resource-supplements/5/upload']) {
    assert.equal(chunkUploadTarget(path), true); assert.equal(chunkUploadTarget(path, 'DELETE'), false);
  }
  for (const path of ['/profile', '/api/uploads', '/uploads?faculty_id=feg', '/uploads/../admin', 'https://example.test/uploads', '/admin/resources/0/replace', '/uploads/']) assert.equal(chunkUploadTarget(path), false);
});

integration('3–20 MB PDFs upload through a 4.5 MB gateway, including the exact maximum, with every chunk below the gateway cap', async () => {
  for (const size of [3 * megabyte + 1, 7 * megabyte + 41, UPLOAD_MAX_BYTES]) {
    const bytes = pdfBytes(size), started = await start(size);
    assert.equal(started.status, 201, JSON.stringify(started.data));
    await uploadParts(started.data, bytes);
    const result = await complete(started.data.id);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.resource.size, size);
    const stored = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(result.data.resource.id);
    assert.ok(env.storage.objects.get(stored.object_key).buffer.equals(bytes), 'The final object is byte-for-byte identical.');
    assert.equal((await request('/upload-sessions/' + started.data.id)).data.state, 'complete');
    const raw = await env.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(started.data.id);
    assert.equal(raw.cleanup_pending, 0);
    assert.ok(![...env.storage.objects.keys()].some(key => key.startsWith(raw.object_prefix + '/')), 'Temporary pieces are deleted after the durable receipt.');
  }
  assert.equal((await start(UPLOAD_MAX_BYTES + 1)).status, 400);
  assert.ok(bodies.filter(row => row.method === 'PUT').length >= 16);
  assert.ok(bodies.every(row => row.bytes < proxyLimit), 'No request approaches the gateway limit.');
  assert.ok(bodies.filter(row => row.method === 'PUT').every(row => row.bytes <= UPLOAD_CHUNK_BYTES));
});

integration('a partial upload survives failed pieces and exact retries do not create duplicate stored chunks', async () => {
  const bytes = pdfBytes(3 * megabyte + 7), session = (await start(bytes.length)).data, first = bytes.subarray(0, session.chunk_bytes);
  env.storage.failNextPut = true;
  assert.equal((await put(session.id, 1, first)).status, 502);
  assert.deepEqual((await request('/upload-sessions/' + session.id)).data.parts, []);
  assert.equal((await put(session.id, 1, first)).status, 200);
  const count = env.storage.objects.size;
  assert.equal((await put(session.id, 1, first)).status, 200);
  assert.equal(env.storage.objects.size, count);
  assert.deepEqual((await request('/upload-sessions/' + session.id)).data.parts, [1]);
  assert.equal((await put(session.id, 2, Buffer.alloc(7))).status, 400);
  assert.equal((await put(session.id, 0, first)).status, 400);
  await uploadParts(session, bytes, { from: 2 });
  assert.equal((await complete(session.id)).status, 201);
});

integration('only the owner can inspect, write, finish or cancel a session and context changes revoke access', async () => {
  const bytes = pdfBytes(3 * megabyte + 17), session = (await start(bytes.length)).data;
  for (const user of ['sara', 'nour']) {
    assert.equal((await request('/upload-sessions/' + session.id, { user })).status, 404);
    assert.equal((await put(session.id, 1, bytes.subarray(0, session.chunk_bytes), user)).status, 404);
    assert.equal((await complete(session.id, user)).status, 404);
    assert.equal((await cancel(session.id, user)).status, 404);
  }
  await env.db.prepare("UPDATE users SET faculty_id='feg',filiere_id='economics' WHERE id=3").run();
  try { assert.equal((await request('/upload-sessions/' + session.id)).status, 403); }
  finally { await env.db.prepare("UPDATE users SET faculty_id='flaa',filiere_id='french_studies' WHERE id=3").run(); }
  assert.equal((await cancel(session.id)).status, 200);
});

integration('incomplete and corrupt objects never publish a resource; replacing a corrupt piece restores a resumable upload', async () => {
  const bytes = pdfBytes(3 * megabyte + 19), session = (await start(bytes.length)).data, before = await resourceCount();
  await put(session.id, 1, bytes.subarray(0, session.chunk_bytes));
  assert.equal((await complete(session.id)).status, 400);
  assert.equal(await resourceCount(), before);
  await uploadParts(session, bytes, { from: 2 });
  const raw = await env.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(session.id), key = raw.object_prefix + '/1';
  const original = env.storage.objects.get(key), corrupted = Buffer.from(original.buffer); corrupted[100] ^= 1;
  env.storage.objects.set(key, { ...original, buffer: corrupted });
  assert.equal((await complete(session.id)).status, 400);
  assert.equal(await resourceCount(), before);
  assert.equal((await request('/upload-sessions/' + session.id)).data.state, 'uploading');
  assert.equal((await put(session.id, 1, bytes.subarray(0, session.chunk_bytes))).status, 200);
  const result = await complete(session.id);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(await resourceCount(), before + 1);
});

integration('durable completion receipts replay the original response without publishing twice, preserving Unicode names and metadata', async () => {
  const filename = 'Cours — probabilités إحصاء.pdf', title = 'Probabilités — إحصاء', module = 'Statistiques ' + randomUUID();
  const bytes = pdfBytes(3 * megabyte + 23), session = (await start(bytes.length, { filename, fields: metadata({ title, module, relative_path: 'S1/Éléments/' + filename, academic_year: '2026/2027' }) })).data;
  await uploadParts(session, bytes);
  const before = await resourceCount(), first = await complete(session.id);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.resource.filename, filename); assert.equal(first.data.resource.title, title);
  assert.equal(first.data.resource.relative_path, 'S1/Éléments/' + filename);
  assert.equal(first.data.resource.module, module); assert.equal(first.data.resource.teacher_name, 'Professeur — Élodie');
  assert.equal(first.data.resource.academic_year, '2026/2027');
  const writes = env.storage.putCount, replay = await complete(session.id);
  assert.equal(replay.status, first.status); assert.deepEqual(replay.data, first.data);
  assert.equal(env.storage.putCount, writes); assert.equal(await resourceCount(), before + 1);
  const status = await request('/upload-sessions/' + session.id);
  assert.equal(status.data.response_status, 201); assert.deepEqual(status.data.response, first.data);
});

integration('the original endpoint still validates file signatures and current channel or upload permissions when finalizing', async () => {
  const bytes = pdfBytes(3 * megabyte + 29);
  const readOnly = (await start(bytes.length, { fields: metadata({ channel: 'important', publish_message: 'true' }) })).data;
  await uploadParts(readOnly, bytes);
  const before = await resourceCount();
  await env.db.prepare("UPDATE channels SET read_only=1 WHERE faculty_id='flaa' AND id='important'").run();
  try { assert.equal((await complete(readOnly.id)).status, 403); }
  finally { await env.db.prepare("UPDATE channels SET read_only=0 WHERE faculty_id='flaa' AND id='important'").run(); }
  assert.equal(await resourceCount(), before);
  const changedYear = (await start(bytes.length)).data; await uploadParts(changedYear, bytes);
  await env.db.prepare('UPDATE users SET current_semester=5 WHERE id=3').run();
  try { assert.equal((await complete(changedYear.id)).status, 403); }
  finally { await env.db.prepare('UPDATE users SET current_semester=1 WHERE id=3').run(); }
  assert.equal(await resourceCount(), before);
  const invalid = Buffer.alloc(3 * megabyte + 31, 32), invalidSession = (await start(invalid.length)).data;
  await uploadParts(invalidSession, invalid);
  assert.equal((await complete(invalidSession.id)).status, 400);
  assert.equal(await resourceCount(), before);
});

integration('large forum attachments reuse the original protected route without turning them into library resources', async () => {
  const question = await env.db.prepare("INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,created_at) VALUES('flaa','french_studies',3,'Chunked attachment question','A private synthetic question body.',?) RETURNING *").get(new Date().toISOString());
  const bytes = pdfBytes(4 * megabyte + 37), path = `/campus/forum/${question.id}/attachments`;
  const session = (await start(bytes.length, { path, filename: 'Méthode.pdf', fields: [['client_id', randomUUID()]] })).data;
  await uploadParts(session, bytes);
  const before = await resourceCount(), first = await complete(session.id);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.attachment.filename, 'Méthode.pdf'); assert.equal(first.data.attachment.size, bytes.length);
  assert.equal(await resourceCount(), before);
  const peer = await request(`/campus/forum/${question.id}/attachments`, { user: 'sara' });
  assert.equal(peer.data.attachments[0].id, first.data.attachment.id);
  assert.equal((await request(`/campus/forum/${question.id}/attachments`, { user: 'nour' })).status, 404);
  const replay = await complete(session.id); assert.deepEqual(replay.data, first.data);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM forum_attachments WHERE question_id=?').get(question.id)).n, 1);
  const forbidden = (await start(bytes.length, { user: 'sara', path, fields: [] })).data;
  await uploadParts(forbidden, bytes, { user: 'sara' });
  assert.equal((await complete(forbidden.id, 'sara')).status, 403);
});

integration('replacement sessions recheck an appointed reviewer’s current permission and preserve the original resource after revocation', async () => {
  const resource = await env.db.prepare("SELECT * FROM resources WHERE faculty_id='flaa' AND filiere_id='french_studies' AND library_visible=1 AND removed=0 ORDER BY id DESC LIMIT 1").get();
  const appointment = await env.db.prepare("INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,filiere_id,capabilities,created_at) VALUES(4,2,'flaa','french_studies','[\"resource.manage\"]',?) RETURNING id").get(new Date().toISOString());
  const bytes = pdfBytes(3 * megabyte + 43), path = `/admin/resources/${resource.id}/replace`;
  try {
    const staged = await start(bytes.length, { user: 'sara', path, fields: [] });
    assert.equal(staged.status, 201, JSON.stringify(staged.data));
    await uploadParts(staged.data, bytes, { user: 'sara' });
    await env.db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE id=?').run(new Date().toISOString(), appointment.id);
    const denied = await complete(staged.data.id, 'sara');
    assert.equal(denied.status, 403, JSON.stringify(denied.data));
    const unchanged = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(resource.id);
    assert.equal(unchanged.object_key, resource.object_key); assert.equal(unchanged.version, resource.version);
    await env.db.prepare('UPDATE scoped_appointments SET revoked_at=NULL WHERE id=?').run(appointment.id);
    const allowed = (await start(bytes.length, { user: 'sara', path, filename: 'Version corrigée.pdf', fields: [] })).data;
    await uploadParts(allowed, bytes, { user: 'sara' });
    const updated = await complete(allowed.id, 'sara');
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.resource.id, resource.id); assert.equal(updated.data.resource.version, resource.version + 1);
    assert.equal(updated.data.resource.filename, 'Version corrigée.pdf');
  } finally { await env.db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE id=?').run(new Date().toISOString(), appointment.id); }
});

integration('staging rejects invalid destinations or unsafe fields and bounds active sessions, cancelled objects and expired pieces', async () => {
  for (const change of [{ path: '/profile' }, { filename: '../cours.pdf' }, { filename: 'cours.exe' }, { fields: [['__proto__', 'invalid']] }, { fields: [['faculty_id', 'feg']] }]) {
    assert.ok([400, 403].includes((await start(3 * megabyte + 47, change)).status), JSON.stringify(change));
  }
  const sessions = [];
  try {
    for (let i = 0; i < 4; i++) {
      const result = await start(3 * megabyte + 47);
      assert.equal(result.status, 201, JSON.stringify(result.data)); sessions.push(result.data);
    }
    assert.equal((await start(3 * megabyte + 47)).status, 429);
    const bytes = pdfBytes(3 * megabyte + 47), [expired, cancelled] = sessions;
    assert.equal((await put(expired.id, 1, bytes.subarray(0, expired.chunk_bytes))).status, 200);
    assert.equal((await put(cancelled.id, 1, bytes.subarray(0, cancelled.chunk_bytes))).status, 200);
    const expiredRow = await env.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(expired.id);
    const cancelledRow = await env.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(cancelled.id);
    assert.equal((await cancel(cancelled.id)).status, 200);
    assert.ok(!env.storage.objects.has(cancelledRow.object_prefix + '/1'));
    await env.db.prepare('UPDATE upload_sessions SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expired.id);
    assert.equal((await request('/upload-sessions/' + expired.id)).status, 410);
    const fresh = await start(3 * megabyte + 47); assert.equal(fresh.status, 201, JSON.stringify(fresh.data)); sessions.push(fresh.data);
    assert.ok(!env.storage.objects.has(expiredRow.object_prefix + '/1'));
    assert.equal(await env.db.prepare('SELECT 1 FROM upload_sessions WHERE id=?').get(expired.id), undefined);
  } finally { for (const session of sessions) await cancel(session.id); }
});

integration('a transient receipt-save failure keeps publication atomic and allows safe retry without duplicates', async () => {
  const bytes = pdfBytes(3 * megabyte + 53), session = (await start(bytes.length)).data;
  await uploadParts(session, bytes);
  const prepare = env.db.prepare.bind(env.db), before = await resourceCount();
  let injected = false;
  env.db.prepare = statement => {
    const prepared = prepare(statement);
    if (!statement.startsWith('UPDATE upload_sessions SET state=?,response_status=')) return prepared;
    return { ...prepared, async run(...values) {
      if (!injected) {
        injected = true;
        throw Object.assign(new Error('Isolated transient receipt persistence failure.'), { status: 503, code: 'DATABASE_UNAVAILABLE' });
      }
      return prepared.run(...values);
    } };
  };
  try {
    let first = await complete(session.id);
    assert.equal(injected, true);
    if (first.status >= 400) {
      assert.ok(first.status >= 500, JSON.stringify(first.data));
      assert.equal(await resourceCount(), before, 'Publication must roll back together with a failed receipt.');
      const interrupted = await request('/upload-sessions/' + session.id);
      assert.equal(interrupted.data.state, 'uploading', 'The same file can be resumed after a failed atomic publication.');
      assert.equal(interrupted.data.response_status, undefined);
      first = await complete(session.id);
    }
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const status = await request('/upload-sessions/' + session.id);
    assert.equal(status.data.state, 'complete', 'A successful publication always has its durable completion receipt.');
    assert.equal(status.data.response_status, 201);
    assert.deepEqual((await complete(session.id)).data, first.data);
    assert.equal(await resourceCount(), before + 1);
  } finally { env.db.prepare = prepare; }
});

integration('a chat ban applied while chunks are assembled prevents publication using fresh account permissions', async () => {
  const bytes = pdfBytes(3 * megabyte + 59);
  const session = (await start(bytes.length, { fields: metadata({ publish_message: 'true' }) })).data;
  await uploadParts(session, bytes);
  const row = await env.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(session.id);
  const get = env.storage.get.bind(env.storage), before = await resourceCount();
  const beforeMessages = (await env.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n;
  let changed = false;
  env.storage.get = async (...args) => {
    const result = await get(...args);
    if (!changed && args[0].startsWith(row.object_prefix + '/')) {
      changed = true;
      await env.db.prepare("INSERT INTO chat_bans(user_id,faculty_id,blocked_by,created_at) VALUES(3,'flaa',2,?)").run(new Date().toISOString());
    }
    return result;
  };
  try {
    const result = await complete(session.id);
    assert.equal(changed, true); assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.equal(await resourceCount(), before);
    assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n, beforeMessages);
  } finally {
    env.storage.get = get;
    await env.db.prepare("DELETE FROM chat_bans WHERE user_id=3 AND faculty_id='flaa'").run();
  }
});

integration('the production api() transport publishes an exact 20 MiB file through the capped HTTP gateway', async () => {
  const bytes = pdfBytes(UPLOAD_MAX_BYTES), { body } = browserUpload(bytes);
  const firstRequest = bodies.length, before = await resourceCount(), activity = [];
  const unsubscribe = subscribeAPIActivity(value => activity.push({ ...value }));
  try {
    await browserAPI(async () => {
      const result = await api('/uploads', { method: 'POST', body });
      assert.equal(result.resource.size, UPLOAD_MAX_BYTES);
      assert.equal(result.resource.filename, 'Cours — إحصاء.pdf');
      assert.equal(result.resource.relative_path, 'S1/Éléments/Cours — إحصاء.pdf');
      const stored = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(result.resource.id);
      assert.ok(env.storage.objects.get(stored.object_key).buffer.equals(bytes));
    });
    const requests = bodies.slice(firstRequest), pieces = requests.filter(row => row.method === 'PUT');
    assert.equal(pieces.length, 10);
    assert.ok(pieces.every(row => row.bytes === UPLOAD_CHUNK_BYTES));
    assert.ok(requests.every(row => row.bytes < proxyLimit));
    assert.ok(requests.every(row => row.path.startsWith('/api/upload-sessions')));
    assert.equal(await resourceCount(), before + 1);
    assert.deepEqual(activity, [{ reads: 0, writes: 0 }, { reads: 0, writes: 1 }, { reads: 0, writes: 0 }]);
  } finally { unsubscribe(); }
});

integration('api() recovers lost piece and completion responses from real durable receipts without duplicate publication', async () => {
  const { file, body } = browserUpload(pdfBytes(7 * megabyte + 67)), before = await resourceCount();
  let lostPiece = false, lostCompletion = false, creations = 0, completions = 0;
  await browserAPI(async () => {
    const first = await api('/uploads', { method: 'POST', body });
    const puts = env.storage.putCount;
    // Upload dialogs construct a new FormData for each explicit retry while
    // retaining the selected File and the entered classification fields.
    const retryBody = new FormData();
    for (const [key, value] of body) if (key !== 'file') retryBody.append(key, value);
    retryBody.append('file', file);
    const replay = await api('/uploads', { method: 'POST', body: retryBody });
    assert.deepEqual(replay, first);
    assert.equal(env.storage.putCount, puts, 'A successful same-file retry reuses its receipt.');
    assert.equal(creations, 1); assert.equal(completions, 1);
    assert.equal(lostPiece, true); assert.equal(lostCompletion, true);
    assert.equal(await resourceCount(), before + 1);
  }, async (path, options, forward) => {
    if (path === '/api/upload-sessions' && options.method === 'POST') creations++;
    const response = await forward();
    if (/\/parts\/1$/.test(path) && !lostPiece) {
      assert.equal(response.status, 200); await response.arrayBuffer(); lostPiece = true;
      throw new TypeError('Simulated connection lost after a private piece was stored.');
    }
    if (path.endsWith('/complete')) {
      completions++;
      if (!lostCompletion) {
        assert.equal(response.status, 201); await response.arrayBuffer(); lostCompletion = true;
        throw new TypeError('Simulated connection lost after atomic publication committed.');
      }
    }
    return response;
  });
});

integration('api() resumes the invalidated piece after a corrupt private object and preserves all valid chunks', async () => {
  const { body } = browserUpload(pdfBytes(5 * megabyte + 71)), before = await resourceCount();
  let corrupted = false, sessionId; const pieceRequests = [];
  await browserAPI(async () => {
    await assert.rejects(api('/uploads', { method: 'POST', body }), error => error.status === 400);
    assert.equal(await resourceCount(), before);
    assert.deepEqual((await request('/upload-sessions/' + sessionId)).data.parts, [2, 3]);
    const result = await api('/uploads', { method: 'POST', body });
    assert.equal(result.resource.size, 5 * megabyte + 71);
    assert.equal(await resourceCount(), before + 1);
    assert.deepEqual(pieceRequests, [1, 2, 3, 1]);
  }, async (path, options, forward) => {
    const match = path.match(/\/upload-sessions\/([^/]+)\/parts\/(\d+)$/);
    if (match) { sessionId = match[1]; pieceRequests.push(Number(match[2])); }
    if (path.endsWith('/complete') && !corrupted) {
      const row = await env.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(sessionId);
      const piece = env.storage.objects.get(row.object_prefix + '/1');
      piece.buffer[113] ^= 1; corrupted = true;
    }
    return forward();
  });
});

integration('simultaneous completion requests publish once and return an identical durable response', async () => {
  const bytes = pdfBytes(3 * megabyte + 73), session = (await start(bytes.length)).data;
  await uploadParts(session, bytes);
  const before = await resourceCount(), writes = env.storage.putCount;
  const responses = await Promise.all([complete(session.id), complete(session.id), complete(session.id)]);
  assert.ok(responses.every(result => result.status === 201), JSON.stringify(responses));
  assert.deepEqual(responses[1].data, responses[0].data); assert.deepEqual(responses[2].data, responses[0].data);
  assert.equal(await resourceCount(), before + 1);
  assert.equal(env.storage.putCount, writes + 1);
});

integration('a lost COMMIT acknowledgement recovers the published receipt and never removes its live object', async () => {
  const bytes = pdfBytes(3 * megabyte + 79), session = (await start(bytes.length)).data;
  await uploadParts(session, bytes);
  const transaction = env.db.transaction.bind(env.db), before = await resourceCount();
  let depth = 0, interrupted = false;
  env.db.transaction = async callback => {
    depth++;
    try {
      const result = await transaction(callback);
      if (depth === 1 && !interrupted && result?.status === 201) {
        interrupted = true;
        throw Object.assign(new Error('Simulated lost acknowledgement after COMMIT.'), { status: 503, code: 'DATABASE_UNAVAILABLE' });
      }
      return result;
    } finally { depth--; }
  };
  try {
    const result = await complete(session.id);
    assert.equal(interrupted, true); assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(await resourceCount(), before + 1);
    const stored = await env.db.prepare('SELECT * FROM resources WHERE id=?').get(result.data.resource.id);
    assert.ok(env.storage.objects.get(stored.object_key)?.buffer.equals(bytes));
    assert.deepEqual((await complete(session.id)).data, result.data);
  } finally { env.db.transaction = transaction; }
});

integration('api() recovers a lost session-creation response with one stable client operation and one staged row', async () => {
  const { body } = browserUpload(pdfBytes(3 * megabyte + 83)), before = await resourceCount();
  const rows = (await env.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions').get()).n;
  const operations = []; let lost = false;
  await browserAPI(async () => {
    const result = await api('/uploads', { method: 'POST', body });
    assert.equal(result.resource.size, 3 * megabyte + 83);
    assert.equal(lost, true); assert.equal(operations.length, 2);
    assert.match(operations[0], /^[0-9a-f-]{36}$/i);
    assert.equal(operations[0], operations[1]);
    assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions').get()).n, rows + 1);
    assert.equal(await resourceCount(), before + 1);
  }, async (path, options, forward) => {
    if (path === '/api/upload-sessions' && options.method === 'POST') {
      operations.push(JSON.parse(options.body).client_id);
      const response = await forward();
      if (!lost) {
        assert.equal(response.status, 201); await response.arrayBuffer(); lost = true;
        throw new TypeError('Simulated lost response after the resumable session was created.');
      }
      return response;
    }
    return forward();
  });
});

integration('session creation operation IDs replay only identical owner metadata and cannot cross account context', async () => {
  const size = 3 * megabyte + 89, fields = metadata(), clientId = randomUUID(), owned = [];
  try {
    const first = await start(size, { fields, clientId });
    assert.equal(first.status, 201, JSON.stringify(first.data)); owned.push(first.data.id);
    const replay = await start(size, { fields, clientId });
    assert.ok([200, 201].includes(replay.status), JSON.stringify(replay.data)); assert.equal(replay.data.id, first.data.id);
    assert.equal((await start(size + 1, { fields, clientId })).status, 409);
    assert.equal((await start(size, { fields, clientId, filename: 'autre.pdf' })).status, 409);
    assert.equal((await start(size, { fields: metadata(), clientId })).status, 409);
    assert.equal((await start(size, { fields, clientId: [randomUUID()] })).status, 400);
    const peer = await start(size, { fields, clientId, user: 'sara' });
    assert.equal(peer.status, 409, JSON.stringify(peer.data));
    assert.equal(peer.data.id, undefined); assert.equal(peer.data.response, undefined);
    assert.equal((await request('/upload-sessions/' + first.data.id, { user: 'sara' })).status, 404);
    await env.db.prepare("UPDATE users SET faculty_id='feg',filiere_id='economics' WHERE id=3").run();
    try { assert.ok([403, 409].includes((await start(size, { fields, clientId })).status)); }
    finally { await env.db.prepare("UPDATE users SET faculty_id='flaa',filiere_id='french_studies' WHERE id=3").run(); }
  } finally {
    if (owned[0]) await cancel(owned[0]);
    if (owned[1]) await cancel(owned[1], 'sara');
  }
});

integration('upload update events reach peers only after the atomic publication and receipt commit', async () => {
  const bytes = pdfBytes(3 * megabyte + 97), session = (await start(bytes.length)).data;
  await uploadParts(session, bytes);
  const controller = new AbortController(), stream = await fetch(origin + '/api/events/stream', { headers: { cookie: cookies.sara }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(); await reader.read();
  let sawUpdate = false, eventTimeout, release, entered;
  const gate = new Promise(resolve => { release = resolve; }), receiptEntered = new Promise(resolve => { entered = resolve; });
  const received = (async () => {
    let text = '';
    while (true) {
      const value = await reader.read(); if (value.done) throw new Error('The update stream ended before the upload event.');
      text += new TextDecoder().decode(value.value);
      if (text.includes('event: update')) { sawUpdate = true; return; }
    }
  })();
  // The rejection is consumed even if an assertion fails before awaiting it.
  received.catch(() => {});
  const prepare = env.db.prepare.bind(env.db);
  env.db.prepare = statement => {
    const prepared = prepare(statement);
    if (!statement.startsWith('UPDATE upload_sessions SET state=?,response_status=')) return prepared;
    return { ...prepared, async run(...values) { entered(); await gate; return prepared.run(...values); } };
  };
  let completion;
  try {
    completion = complete(session.id);
    await Promise.race([receiptEntered, new Promise((_, reject) => { eventTimeout = setTimeout(() => reject(new Error('Receipt gate was never reached.')), 5000); })]);
    clearTimeout(eventTimeout);
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(sawUpdate, false, 'Peers must not reload while the published object is still uncommitted.');
    release();
    const result = await completion; assert.equal(result.status, 201, JSON.stringify(result.data));
    await Promise.race([received, new Promise((_, reject) => { eventTimeout = setTimeout(() => reject(new Error('No committed upload event was received.')), 5000); })]);
    clearTimeout(eventTimeout);
    const durable = await request('/upload-sessions/' + session.id);
    assert.equal(durable.data.state, 'complete'); assert.equal(durable.data.response_status, 201);
  } finally {
    clearTimeout(eventTimeout); release(); controller.abort();
    if (completion) await completion.catch(() => {});
    env.db.prepare = prepare;
    await reader.cancel().catch(() => {});
  }
});
