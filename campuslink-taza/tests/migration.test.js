import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, digest } from '../server/db.js';
import { importLocal } from '../server/import-local.js';
import { makePdf } from '../server/seed.js';

function storage() {
  const objects = new Map();
  const removed = [];
  return { objects, removed, async put(key, value, mime) { objects.set(key, { value: Buffer.from(value), mime }); }, async delete(key) { objects.delete(key); removed.push(key); } };
}

async function fixture({ duplicateUsername = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'campuslink-legacy-import-'));
  await mkdir(join(directory, 'files'));
  const file = makePdf('Current resource', ['Existing academic document.']);
  const previous = makePdf('Previous resource', ['Existing academic document version.']);
  await writeFile(join(directory, 'files', 'current.pdf'), file);
  await writeFile(join(directory, 'files', 'previous.pdf'), previous);
  const sqlite = new DatabaseSync(join(directory, 'campuslink.sqlite'));
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, name TEXT, password_hash TEXT, role TEXT, faculty_id TEXT, filiere_id TEXT, current_semester INTEGER, avatar TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, faculty_id TEXT, channel TEXT, content TEXT, author_id INTEGER, created_at TEXT, resource_id INTEGER, reply_to INTEGER, pinned INTEGER, filiere_id TEXT, semester INTEGER);
    CREATE TABLE resources (id INTEGER PRIMARY KEY, faculty_id TEXT, title TEXT, filename TEXT, stored_name TEXT, sha256 TEXT, category TEXT, semester INTEGER, module TEXT, author_id INTEGER, created_at TEXT, size INTEGER, mime TEXT, message_id INTEGER, channel TEXT, version INTEGER, filiere_id TEXT, resource_type TEXT);
    CREATE TABLE resource_versions (id INTEGER PRIMARY KEY, resource_id INTEGER, version INTEGER, filename TEXT, stored_name TEXT, sha256 TEXT, size INTEGER, mime TEXT, updated_at TEXT, editor_id INTEGER);
    CREATE TABLE channels (id TEXT, faculty_id TEXT, name TEXT, description TEXT, read_only INTEGER);
    CREATE TABLE announcements (id INTEGER PRIMARY KEY, faculty_id TEXT, content TEXT, message_id INTEGER, channel TEXT, author_id INTEGER, created_at TEXT, resource_id INTEGER, pinned INTEGER);
    CREATE TABLE saved (user_id INTEGER, type TEXT, target_id INTEGER);
    CREATE TABLE history (user_id INTEGER, resource_id INTEGER, opened_at TEXT);
  `);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(7, 'legacy.admin', 'Existing administrator', 'inactive-legacy-hash', 'global_admin', 'fsa', 'data_science', 5, avatar);
  sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(9, duplicateUsername ? 'LEGACY.ADMIN' : 'legacy.student', 'Existing student', 'inactive-student-hash', 'student', 'fsa', 'physics', 6, '/avatars/sara.jpg');
  const date = '2026-10-03T08:00:00.000Z';
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(101, 'fsa', 'general', 'Existing faculty conversation', 7, date, null, null, 0, null, null);
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(102, 'fsa', 'filiere', 'Existing S2 message', 7, date, 501, null, 1, 'data_science', 2);
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(103, 'fsa', 'filiere', 'Existing S2 reply', 7, date, null, 102, 0, 'data_science', 2);
  sqlite.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(501, 'fsa', 'Existing resource title', 'current.pdf', 'current.pdf', digest(file), 'courses', 4, 'Actual existing module', 7, date, file.length, 'application/pdf', 102, 'filiere', 2, 'data_science', 'courses');
  sqlite.prepare('INSERT INTO resource_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(801, 501, 1, 'previous.pdf', 'previous.pdf', digest(previous), previous.length, 'application/pdf', date, 7);
  sqlite.prepare('INSERT INTO channels VALUES (?,?,?,?,?)').run('general', 'fsa', 'Existing channel title', 'Existing channel description', 1);
  sqlite.prepare('INSERT INTO announcements VALUES (?,?,?,?,?,?,?,?,?)').run(601, 'fsa', 'Existing pinned message', 102, 'filiere', 7, date, 501, 1);
  sqlite.prepare('INSERT INTO saved VALUES (?,?,?)').run(7, 'message', 102);
  sqlite.prepare('INSERT INTO history VALUES (?,?,?)').run(7, 501, date);
  sqlite.close();
  return directory;
}

async function withSchema(callback) {
  const schema = `campuslink_import_test_${randomUUID().replaceAll('-', '')}`;
  const db = await openDatabase({ schema });
  try { await callback(db); }
  finally { await db.exec(`DROP SCHEMA "${schema}" CASCADE`); await db.close(); }
}

test('read-only legacy import preserves profiles, private conversations, files and versions and can be rerun', { skip: !process.env.DATABASE_URL }, async () => {
  const directory = await fixture();
  const originalBytes = await readFile(join(directory, 'campuslink.sqlite'));
  const r2 = storage();
  try {
    await withSchema(async db => {
      const result = await importLocal({ dataDir: directory, db, storage: r2 });
      assert.equal(result.ok, true);
      assert.equal(result.uploadedObjects, 3);
      const administrator = await db.prepare('SELECT * FROM users WHERE id=?').get(7);
      assert.equal(administrator.role, 'global_admin');
      assert.equal(administrator.faculty_id, 'fsa');
      assert.equal(administrator.filiere_id, 'data_science');
      assert.equal(administrator.current_semester, 5);
      assert.equal(administrator.auth_user_id, null);
      assert.equal(administrator.email, null);
      assert.equal(administrator.legacy_password_hash, 'inactive-legacy-hash');
      assert.equal('password_hash' in administrator, false);
      assert.equal(administrator.avatar, '/api/avatars/7');
      assert.ok(r2.objects.has(administrator.avatar_object_key));
      const privateMessage = await db.prepare('SELECT * FROM messages WHERE id=?').get(102);
      assert.equal(privateMessage.semester, 2);
      assert.equal(privateMessage.filiere_id, 'data_science');
      assert.equal(privateMessage.resource_id, 501);
      assert.equal(privateMessage.pinned, 1);
      assert.equal((await db.prepare('SELECT reply_to FROM messages WHERE id=?').get(103)).reply_to, 102);
      assert.equal((await db.prepare('SELECT channel FROM messages WHERE id=?').get(101)).channel, 'general');
      const resource = await db.prepare('SELECT * FROM resources WHERE id=?').get(501);
      assert.equal(resource.semester, 4); // Classification is independent from the source chat.
      assert.equal(resource.message_id, 102);
      assert.equal(resource.filename, 'current.pdf');
      assert.equal(resource.stored_name, 'current.pdf');
      assert.equal(resource.version, 2);
      assert.ok(r2.objects.has(resource.object_key));
      assert.equal((await db.prepare('SELECT name FROM modules WHERE id=?').get(resource.module_id)).name, 'Actual existing module');
      const version = await db.prepare('SELECT * FROM resource_versions WHERE id=?').get(801);
      assert.equal(version.version, 1);
      assert.equal(version.stored_name, 'previous.pdf');
      assert.ok(r2.objects.has(version.object_key));
      assert.equal((await db.prepare('SELECT read_only FROM channels WHERE id=? AND faculty_id=?').get('general', 'fsa')).read_only, 1);
      assert.equal((await db.prepare('SELECT message_id FROM announcements WHERE id=?').get(601)).message_id, 102);
      const repeated = await importLocal({ dataDir: directory, db, storage: r2 });
      assert.equal(repeated.alreadyImported, true);
      assert.equal(r2.objects.size, 3);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 2);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM modules').get()).n, 1);
    });
    assert.deepEqual(await readFile(join(directory, 'campuslink.sqlite')), originalBytes);
    assert.equal(digest(await readFile(join(directory, 'files', 'current.pdf'))), digest(makePdf('Current resource', ['Existing academic document.'])));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a rejected import rolls back metadata and deletes only its newly uploaded objects', { skip: !process.env.DATABASE_URL }, async () => {
  const directory = await fixture({ duplicateUsername: true });
  const originalBytes = await readFile(join(directory, 'campuslink.sqlite'));
  const r2 = storage();
  r2.objects.set('existing-object', { value: Buffer.from('keep'), mime: 'text/plain' });
  try {
    await withSchema(async db => {
      await assert.rejects(importLocal({ dataDir: directory, db, storage: r2 }), error => error.code === '23505');
      assert.equal(r2.removed.length, 3);
      assert.deepEqual([...r2.objects.keys()], ['existing-object']);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM modules').get()).n, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM legacy_imports').get()).n, 0);
    });
    assert.deepEqual(await readFile(join(directory, 'campuslink.sqlite')), originalBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an ambiguous successful PUT is compensated when its response fails', { skip: !process.env.DATABASE_URL }, async () => {
  const directory = await fixture();
  const originalBytes = await readFile(join(directory, 'campuslink.sqlite'));
  const r2 = storage();
  r2.objects.set('existing-object', { value: Buffer.from('keep'), mime: 'text/plain' });
  const put = r2.put;
  r2.put = async (...args) => { await put(...args); throw Object.assign(new Error('Simulated transport failure after storing bytes.'), { status: 502 }); };
  try {
    await withSchema(async db => {
      await assert.rejects(importLocal({ dataDir: directory, db, storage: r2 }), error => error.status === 502);
      assert.equal(r2.removed.length, 1);
      assert.deepEqual([...r2.objects.keys()], ['existing-object']);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM modules').get()).n, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM legacy_imports').get()).n, 0);
    });
    assert.deepEqual(await readFile(join(directory, 'campuslink.sqlite')), originalBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
