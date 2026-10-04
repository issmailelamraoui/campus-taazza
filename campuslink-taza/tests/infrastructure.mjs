import '../server/env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createAuthService } from '../server/auth.js';
import { createStorage } from '../server/storage.js';
import { createApp } from '../server/app.js';
import { getChatSemester } from '../shared/studies.js';

// Explicit live check: harmless provider accounts, one tiny private R2 file,
// and a unique disposable application schema. Never seed the real app here.
const schema = `campuslink_test_${randomUUID().replaceAll('-', '')}`;
const suffix = randomUUID().slice(0, 8);
const password = `BoundedTest-${randomUUID()}!`;
const createdUsers = [], objectKeys = new Set();
const rawStorage = createStorage();
const storage = {
  ...rawStorage,
  async put(key, bytes, mime) { objectKeys.add(key); await rawStorage.put(key, bytes, mime); },
  async delete(key) { await rawStorage.delete(key); objectKeys.delete(key); },
  close() {},
};
let db, app, server, origin, auth;
const requestOrigin = process.env.APP_ORIGIN || 'http://localhost:5173';
async function request(path, { cookie, method = 'GET', body, form } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method, headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, cookie: response.headers.getSetCookie().find(value => value.startsWith('campus_neon_session='))?.split(';')[0], headers: response.headers };
}
async function login(username) {
  const result = await request('/login', { method: 'POST', body: { username, password } });
  assert.equal(result.status, 200, 'Live Neon Auth login');
  assert.ok(/HttpOnly/.test(result.headers.get('set-cookie')), 'Provider cookie is HttpOnly');
  return result.cookie;
}
async function register(values, cookie) {
  for(let attempt=0;attempt<3;attempt++) {
    const result=await request('/admin/users',{cookie,method:'POST',body:values});
    if(result.status!==429)return result;
    const seconds=Number(result.headers.get('retry-after'))||60;
    if(attempt===2||seconds>90)throw new Error('Live registration is temporarily rate limited; retry the bounded check later.');
    console.log('Neon Auth rate limit: respecting the provider retry interval.');
    await new Promise(resolve=>setTimeout(resolve,seconds*1000));
  }
}
async function listen() {
  app = await createApp({ db, auth, storage, appOrigin: requestOrigin });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
}
try {
  db = await openDatabase({ schema }); await seedDatabase(db);
  const tables = (await db.prepare('SELECT table_name FROM information_schema.tables WHERE table_schema=?').all(schema)).map(row => row.table_name);
  for (const table of ['users', 'faculties', 'filieres', 'semesters', 'modules', 'resources', 'messages']) assert.ok(tables.includes(table));
  const provider = createAuthService({ db });
  auth = { ...provider, async createUser(req, values) { const created = await provider.createUser(req, values); createdUsers.push(created); return created; } };
  const operator = await auth.createUser({ headers: { origin: requestOrigin } }, { email: `campuslink-operator-${suffix}@example.com`, password, name: 'Temporary infrastructure operator' });
  await db.prepare('INSERT INTO users (username,name,email,auth_user_id,role,faculty_id) VALUES (?,?,?,?,?,?)').run(`operator.${suffix}`, operator.name, operator.email, operator.id, 'global_admin', 'fsa');
  await listen();
  const operatorCookie = await login(`operator.${suffix}`);
  const cookies = {};
  for (const [kind, faculty] of [['student', null], ['other', 'fsa'], ['foreign', 'feg']]) {
    const response = await register({ username: `${kind}.${suffix}`, email: `campuslink-${kind}-${suffix}@example.com`, name: `Temporary ${kind}`, password, faculty_id: faculty },operatorCookie);
    assert.equal(response.status, 201, 'Admin registration through Neon Auth');
    cookies[kind] = await login(`${kind}.${suffix}`);
  }
  assert.equal((await request('/faculty', { cookie: cookies.student, method: 'POST', body: { faculty_id: 'fsa', confirmed: true } })).status, 200);
  assert.equal((await request('/studies', { cookie: cookies.student, method: 'POST', body: { filiere_id: 'data_science', current_semester: 5 } })).status, 200);
  assert.equal((await request('/studies', { cookie: cookies.other, method: 'POST', body: { filiere_id: 'physics', current_semester: 1 } })).status, 200);
  const content = Buffer.from('CampusLink live integration resource.\n');
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: 'Temporary integration resource', filiere_id: 'data_science', semester: '5', module: 'Infrastructure test module', resource_type: 'document', category: 'general', channel: 'filiere', chat_semester: '5' })) form.set(key, value);
  form.set('file', new Blob([content], { type: 'text/plain' }), 'integration-check.txt');
  const upload = await request('/uploads', { cookie: cookies.student, method: 'POST', form });
  assert.equal(upload.status, 201, 'Private R2 upload through real app');
  const id = upload.data.resource.id;
  const metadata = await db.prepare('SELECT * FROM resources WHERE id=?').get(id);
  assert.equal(metadata.filiere_id, 'data_science'); assert.equal(metadata.semester, 5); assert.ok(metadata.module_id);
  assert.ok(!('object_key' in upload.data.resource));
  assert.equal((await rawStorage.head(metadata.object_key)).contentLength, content.length);
  const modules = await request('/modules?filiere_id=data_science&semester=5', { cookie: cookies.student });
  assert.ok(modules.data.modules.some(module => module.id === metadata.module_id));
  const file = await request(`/files/${id}`, { cookie: cookies.student });
  assert.equal(file.status, 200); assert.deepEqual(file.data, content); assert.match(file.headers.get('cache-control'), /private/);
  assert.equal((await request(`/files/${id}`)).status, 401);
  assert.equal((await request(`/files/${id}`, { cookie: cookies.foreign })).status, 403);
  const messages = [];
  for (let semester = 1; semester <= 6; semester++) {
    const posted = await request('/messages', { cookie: cookies.student, method: 'POST', body: { channel: 'filiere', semester, content: `Temporary separate S${semester} message` } });
    assert.equal(posted.status, 201); assert.equal(posted.data.message.semester, getChatSemester(semester)); messages.push(posted.data.message.id);
    const chat = await request(`/messages?channel=filiere&semester=${semester}`, { cookie: cookies.student });
    assert.ok(chat.data.messages.every(message => message.semester === getChatSemester(semester)));
  }
  assert.equal((await request(`/messages/${messages[0]}`, { cookie: cookies.other })).status, 403);
  assert.equal((await request('/messages?channel=filiere&semester=1&filiere_id=data_science', { cookie: cookies.other })).status, 403);
  console.log('Live checks passed: Neon migrations, registration/login, academic selections, modules, metadata, R2 upload/private retrieval, three study-year chats and authorization.');
  app.locals.endStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null;
  await db.close(); db = await openDatabase({ schema });
  auth = createAuthService({ db }); await listen();
  const session = await request('/session', { cookie: cookies.student });
  assert.equal(session.data.user.faculty_id, 'fsa'); assert.equal(session.data.user.filiere_id, 'data_science'); assert.equal(session.data.user.current_semester, 5);
  assert.deepEqual((await request(`/files/${id}`, { cookie: cookies.student })).data, content);
  assert.ok((await request('/messages?channel=filiere&semester=6', { cookie: cookies.student })).data.messages.some(message => message.id === messages[5]));
  console.log('Live checks passed: a new app and PostgreSQL connection retained provider session, student selections, file bytes and messages.');
} finally {
  if (app) app.locals.endStreams();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const cleanupFailures = [];
  for (const key of objectKeys) {
    try { await rawStorage.delete(key); await assert.rejects(rawStorage.head(key), error => error.status === 404); }
    catch { cleanupFailures.push('R2 temporary object'); }
  }
  if (db) {
    await db.close();
    db = await openDatabase({ schema, migrate: false });
    try {
      await db.query(`TRUNCATE "${schema}"."users" CASCADE`);
    } catch { cleanupFailures.push('test profile records'); }
    // Self-delete is disabled on this managed branch. Delete only fresh
    // subjects created above, after confirming no app profile remains linked.
    for (const created of createdUsers) {
      try {
        const linked = await db.prepare('SELECT id FROM users WHERE auth_user_id=?').get(created.id);
        assert.equal(linked, undefined);
        const result = await db.prepare('DELETE FROM neon_auth."user" WHERE id=? AND lower(email)=? AND "createdAt">?').run(created.id, created.email, new Date(Date.now() - 600000).toISOString());
        assert.equal(result.changes, 1);
      } catch { cleanupFailures.push('fresh provider fixture'); }
    }
    await db.close();
  }
  rawStorage.close();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
  if (cleanupFailures.length) throw new Error(`Integration cleanup requires review: ${cleanupFailures.join(', ')}.`);
  console.log('All temporary live objects, provider accounts and PostgreSQL schema were removed.');
}
