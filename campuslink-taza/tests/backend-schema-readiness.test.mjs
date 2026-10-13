import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createTestEnvironment } from './backend-helpers.mjs';
import { createApp } from '../server/app.js';
import { assertSchemaReady, createSchemaReadinessCheck, inspectSchemaReadiness, schemaReadinessDiagnostic } from '../server/schema-readiness.js';

const hasIsolatedDatabase = Boolean(process.env.CAMPUS_TEST_DATABASE_URL);
let environment;
before(async () => { if (hasIsolatedDatabase) environment = await createTestEnvironment({ demo: false }); });
after(async () => { await environment?.close(); });
const isolated = { skip: !hasIsolatedDatabase && 'Set CAMPUS_TEST_DATABASE_URL to an isolated PostgreSQL database.' };

async function rollback(callback) {
  const marker = new Error('Rollback readiness fixture');
  await assert.rejects(environment.db.transaction(async () => { await callback(); throw marker; }), error => error === marker);
}

test('an absent schema is rejected without attempting migrations or reading an absent ledger', async () => {
  const operations = [];
  const db = { schema: 'absent_fixture', async query(sql, values) { operations.push({ sql, values }); return { rows: [] }; }, prepare() { throw new Error('An absent ledger must not be queried.'); } };
  const report = await inspectSchemaReadiness(db);
  assert.equal(report.ready, false);
  assert.ok(report.pendingMigrations.includes('025_forum_attachments.sql'));
  assert.ok(report.missingTables.includes('reading_positions'));
  assert.equal(operations.length, 1);
  assert.match(operations[0].sql, /^SELECT /);
  assert.deepEqual(operations[0].values, ['absent_fixture']);
  await assert.rejects(assertSchemaReady(db), error => {
    assert.equal(error.status, 503); assert.equal(error.code, 'SCHEMA_MIGRATIONS_PENDING');
    assert.match(schemaReadinessDiagnostic(error), /npm run db:migrate/);
    return true;
  });
});

test('public readiness and unexpected startup failures never reveal provider details', async () => {
  const secret = 'postgres://private-user:private-password@private-host/private-database';
  const failure = Object.assign(new Error(secret), { code: 'ECONNREFUSED', query: 'private SQL', cause: new Error(secret) });
  let calls = 0;
  const db = { schema: 'fixture', async query() { calls++; throw failure; } };
  const check = createSchemaReadinessCheck(db);
  assert.deepEqual(await check(), { ok: false, code: 'DATABASE_UNAVAILABLE' });
  assert.deepEqual(await check(), { ok: false, code: 'DATABASE_UNAVAILABLE' });
  assert.equal(calls, 2, 'Failures are checked again rather than cached as healthy.');
  assert.ok(!schemaReadinessDiagnostic(failure).includes(secret));
  assert.ok(!schemaReadinessDiagnostic(failure).includes('private SQL'));
});

test('a fully migrated schema is ready while additional imported legacy migrations remain permitted', isolated, async () => {
  await rollback(async () => {
    await environment.db.prepare('INSERT INTO schema_migrations(name,sha256,applied_at) VALUES (?,?,?)').run('008_resource_folder_collections.sql', 'legacy-checksum', new Date().toISOString());
    assert.deepEqual(await assertSchemaReady(environment.db), { ready: true, pendingMigrations: [], changedMigrations: [], missingTables: [], missingColumns: [] });
  });
});

test('a pending feature migration is rejected even when its tables already exist', isolated, async () => {
  await rollback(async () => {
    await environment.db.prepare('DELETE FROM schema_migrations WHERE name=?').run('025_forum_attachments.sql');
    const report = await inspectSchemaReadiness(environment.db);
    assert.deepEqual(report.pendingMigrations, ['025_forum_attachments.sql']);
    assert.deepEqual(report.missingTables, []);
    assert.equal(report.ready, false);
    await assert.rejects(assertSchemaReady(environment.db), { code: 'SCHEMA_MIGRATIONS_PENDING' });
    assert.deepEqual(await createSchemaReadinessCheck(environment.db)(), { ok: false, code: 'SCHEMA_NOT_READY' });
  });
});

test('a complete ledger does not hide a missing API table', isolated, async () => {
  await rollback(async () => {
    await environment.db.exec('ALTER TABLE forum_attachments RENAME TO forum_attachments_readiness_fixture');
    const report = await inspectSchemaReadiness(environment.db);
    assert.deepEqual(report.pendingMigrations, []);
    assert.deepEqual(report.missingTables, ['forum_attachments']);
    await assert.rejects(assertSchemaReady(environment.db), error => {
      assert.equal(error.code, 'DATABASE_SCHEMA_INCOMPLETE');
      assert.match(schemaReadinessDiagnostic(error), /forum_attachments/);
      return true;
    });
  });
});

test('a complete ledger does not hide a missing column used by a newer API', isolated, async () => {
  await rollback(async () => {
    await environment.db.exec('ALTER TABLE close_requests DROP COLUMN source_anchor');
    const report = await inspectSchemaReadiness(environment.db);
    assert.deepEqual(report.missingTables, []);
    assert.deepEqual(report.missingColumns, ['close_requests.source_anchor']);
    await assert.rejects(assertSchemaReady(environment.db), { code: 'DATABASE_SCHEMA_INCOMPLETE' });
  });
});

test('changed applied migration checksums stop readiness without modifying their ledger', isolated, async () => {
  await rollback(async () => {
    await environment.db.prepare('UPDATE schema_migrations SET sha256=? WHERE name=?').run('0'.repeat(64), '025_forum_attachments.sql');
    await assert.rejects(assertSchemaReady(environment.db), error => {
      assert.equal(error.code, 'MIGRATION_CHECKSUM_MISMATCH');
      assert.deepEqual(error.readiness.changedMigrations, ['025_forum_attachments.sql']);
      assert.match(schemaReadinessDiagnostic(error), /Restore the matching migration files/);
      assert.ok(!schemaReadinessDiagnostic(error).includes('npm run db:migrate'), 'Repeating migrations cannot fix altered historical files.');
      return true;
    });
    assert.equal((await environment.db.prepare('SELECT sha256 FROM schema_migrations WHERE name=?').get('025_forum_attachments.sql')).sha256, '0'.repeat(64));
  });
});

test('health probes briefly cache success, detect later outages, and recover without caching failure', isolated, async () => {
  let now = 1000, queryCount = 0, disconnected = false;
  const db = {
    schema: environment.db.schema, prepare: statement => environment.db.prepare(statement),
    async query(...args) { queryCount++; if (disconnected) throw new Error('private transport failure'); return environment.db.query(...args); },
  };
  const check = createSchemaReadinessCheck(db, { cacheMillis: 5000, clock: () => now });
  assert.deepEqual(await check(), { ok: true });
  now += 4999; assert.deepEqual(await check(), { ok: true });
  assert.equal(queryCount, 1);
  disconnected = true; now += 1;
  assert.deepEqual(await check(), { ok: false, code: 'DATABASE_UNAVAILABLE' });
  assert.deepEqual(await check(), { ok: false, code: 'DATABASE_UNAVAILABLE' });
  assert.equal(queryCount, 3);
  disconnected = false;
  assert.deepEqual(await check(), { ok: true });
  assert.equal(queryCount, 4);
});

test('concurrent health probes share the same database readiness check', isolated, async () => {
  let release, entered, queryCount = 0;
  const available = new Promise(resolve => { release = resolve; });
  const firstQuery = new Promise(resolve => { entered = resolve; });
  const db = {
    schema: environment.db.schema, prepare: statement => environment.db.prepare(statement),
    async query(...args) { queryCount++; entered(); await available; return environment.db.query(...args); },
  };
  const check = createSchemaReadinessCheck(db);
  const probes = Array.from({ length: 12 }, () => check());
  await firstQuery;
  assert.equal(queryCount, 1);
  release();
  assert.deepEqual(await Promise.all(probes), Array.from({ length: 12 }, () => ({ ok: true })));
  assert.equal(queryCount, 1);
});

test('application startup rejects pending migrations before binding an owner and leaves a supplied database open', isolated, async () => {
  await rollback(async () => {
    await environment.db.prepare('INSERT INTO users(username,name,role) VALUES (?,?,?)').run('readiness_owner_candidate', 'Readiness owner candidate', 'global_admin');
    const before = (await environment.db.prepare('SELECT COUNT(*) AS n FROM platform_owner').get()).n;
    assert.equal(before, 0, 'The fixture has a candidate but no bound owner.');
    await environment.db.prepare('DELETE FROM schema_migrations WHERE name=?').run('025_forum_attachments.sql');
    await assert.rejects(createApp({ db: environment.db, auth: environment.auth, storage: environment.storage, seed: false }), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'SCHEMA_MIGRATIONS_PENDING');
      return true;
    });
    assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM platform_owner').get()).n, before, 'Permission initialization never binds the candidate in an incomplete database.');
    assert.equal((await environment.db.prepare('SELECT 1 AS still_open').get()).still_open, 1, 'The caller retains ownership of a supplied database after rejected startup.');
  });
});

test('the actual unauthenticated health endpoint reports a safe 503 for an outage and recovers immediately', isolated, async t => {
  const env = await createTestEnvironment({ demo: false });
  let unavailable = false, app, server;
  t.after(async () => {
    app?.locals.endStreams();
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await app?.locals.close();
    await env.close();
  });
  const db = {
    ...env.db,
    async query(...args) {
      if (unavailable) throw Object.assign(new Error('postgres://private-user:private-password@private-host/private-database'), { code: 'ECONNREFUSED' });
      return env.db.query(...args);
    },
  };
  app = await createApp({ db, auth: env.auth, storage: env.storage, seed: false });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}/api/health`;
  unavailable = true;
  const failed = await fetch(address);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { ok: false, code: 'DATABASE_UNAVAILABLE' });
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  unavailable = false;
  const recovered = await fetch(address);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { ok: true });
});
