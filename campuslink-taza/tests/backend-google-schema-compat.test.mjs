import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { assertSchemaReady, createSchemaReadinessCheck, inspectSchemaReadiness, schemaReadinessDiagnostic } from '../server/schema-readiness.js';
import { createTestEnvironment } from './backend-helpers.mjs';

const isolated = { skip: !process.env.CAMPUS_TEST_DATABASE_URL && 'Set CAMPUS_TEST_DATABASE_URL to an isolated PostgreSQL database.' };
const migration = '036_google_oauth_sessions.sql';
const tables = ['auth_session_cutover', 'auth_legacy_subjects', 'google_auth_links', 'auth_session_admissions', 'google_oauth_attempts'];
const compatibility = { allowUnmigratedGoogleOAuth: true };

async function fixture(t, { demo = false, keep = [], keepLedger = false } = {}) {
  assert.ok(process.env.CAMPUS_TEST_DATABASE_URL, 'Never fall back to the application database.');
  const env = await createTestEnvironment({ demo });
  t.after(() => env.close());
  for (const table of tables.filter(table => !keep.includes(table))) await env.db.exec(`DROP TABLE ${table}`);
  if (!keepLedger) await env.db.prepare('DELETE FROM schema_migrations WHERE name=?').run(migration);
  return env;
}

test('disabled Google preserves pre036 password login, logout and readiness without querying absent OAuth tables', isolated, async t => {
  const env = await fixture(t, { demo: true });
  await assert.rejects(assertSchemaReady(env.db), { code: 'SCHEMA_MIGRATIONS_PENDING' });
  const report = await assertSchemaReady(env.db, compatibility);
  assert.equal(report.ready, true);
  assert.deepEqual(report.pendingMigrations, [migration]);
  assert.deepEqual(report.deferredMigrations, [migration]);
  assert.deepEqual(new Set(report.missingTables), new Set(tables));
  assert.deepEqual(await createSchemaReadinessCheck(env.db, compatibility)(), { ok: true });
  const db = {
    ...env.db,
    prepare(sql) {
      assert.ok(!tables.some(table => new RegExp(`\\b${table}\\b`).test(sql)), `Old-schema runtime queried an absent OAuth table: ${sql}`);
      return env.db.prepare(sql);
    },
  };
  env.auth.useDatabase(db);
  const app = await createApp({ db, auth: env.auth, storage: env.storage, appOrigin: 'http://localhost:5173', googleOAuth: { enabled: false } });
  assert.equal(app.locals.sessionPolicy, null);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.locals.close();
  });
  const address = `http://127.0.0.1:${server.address().port}/api`;
  const request = (path, options = {}) => fetch(address + path, { ...options, headers: { origin: 'http://localhost:5173', ...options.headers } });
  assert.deepEqual(await (await request('/health')).json(), { ok: true });
  assert.deepEqual(await (await request('/auth/google/config')).json(), { enabled: false, domains: [] });
  assert.equal((await request('/auth/google/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  const login = await request('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'yassine', password: 'Campus2026!' }) });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const session = await request('/session', { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.username, 'yassine');
  assert.equal((await request('/logout', { method: 'POST', headers: { cookie } })).status, 200);
  assert.deepEqual(await (await request('/session', { headers: { cookie } })).json(), { user: null });
  assert.deepEqual((await env.db.prepare('SELECT name FROM schema_migrations WHERE name=?').all(migration)), [], 'Compatibility never applies a migration.');
});

test('requesting Google requires036 even if its domain configuration is invalid', isolated, async t => {
  const env = await fixture(t);
  for (const domains of [['usmba.ac.ma'], []]) {
    await assert.rejects(createApp({ db: env.db, auth: env.auth, storage: env.storage, googleOAuth: { enabled: true, domains } }), { code: 'SCHEMA_MIGRATIONS_PENDING' });
  }
});

test('disabled Google never defers a partially applied or damaged036 schema', isolated, async t => {
  for (const options of [{ keep: ['google_auth_links'] }, { keepLedger: true }]) {
    await t.test(JSON.stringify(options), async t => {
      const env = await fixture(t, options);
      const report = await inspectSchemaReadiness(env.db, compatibility);
      assert.equal(report.ready, false);
      assert.deepEqual(report.deferredMigrations, []);
      await assert.rejects(assertSchemaReady(env.db, compatibility), { code: options.keepLedger ? 'DATABASE_SCHEMA_INCOMPLETE' : 'SCHEMA_MIGRATIONS_PENDING' });
      assert.deepEqual(await createSchemaReadinessCheck(env.db, compatibility)(), { ok: false, code: 'SCHEMA_NOT_READY' });
    });
  }
});

test('deferring036 never hides another pending or changed migration', isolated, async t => {
  const env = await fixture(t);
  await env.db.prepare('DELETE FROM schema_migrations WHERE name=?').run('025_forum_attachments.sql');
  await assert.rejects(assertSchemaReady(env.db, compatibility), { code: 'SCHEMA_MIGRATIONS_PENDING' });
  await env.db.prepare('UPDATE schema_migrations SET sha256=? WHERE name=?').run('0'.repeat(64), '027_feedback_attachments_scope.sql');
  await assert.rejects(assertSchemaReady(env.db, compatibility), { code: 'MIGRATION_CHECKSUM_MISMATCH' });
});

test('deferring036 still diagnoses a damaged application table as incomplete', isolated, async t => {
  const env = await fixture(t);
  await env.db.exec('ALTER TABLE forum_attachments RENAME TO damaged_forum_attachments');
  await assert.rejects(assertSchemaReady(env.db, compatibility), error => {
    assert.equal(error.code, 'DATABASE_SCHEMA_INCOMPLETE');
    assert.match(schemaReadinessDiagnostic(error), /forum_attachments/);
    assert.ok(!schemaReadinessDiagnostic(error).includes(migration));
    assert.ok(!schemaReadinessDiagnostic(error).includes('google_auth_links'));
    return true;
  });
});

test('a migrated database retains the durable session policy when Google is disabled', isolated, async t => {
  assert.ok(process.env.CAMPUS_TEST_DATABASE_URL);
  const env = await createTestEnvironment({ demo: false });
  t.after(() => env.close());
  const app = await createApp({ db: env.db, auth: env.auth, storage: env.storage, googleOAuth: { enabled: false } });
  t.after(() => app.locals.close());
  assert.equal(typeof app.locals.sessionPolicy?.authorize, 'function');
  assert.deepEqual((await assertSchemaReady(env.db, compatibility)).deferredMigrations, []);
});
