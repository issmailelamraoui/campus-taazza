import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDatabase, createPostgresPool } from '../server/db.js';
import { inspectSchemaReadiness } from '../server/schema-readiness.js';

const connectionString = process.env.CAMPUS_TEST_DATABASE_URL || process.env.DATABASE_URL;

test('additive retention migration preserves old notices and starts a bounded window for unknown first-read times', async t => {
  const schema = `campuslink_test_${randomUUID().replaceAll('-', '')}`;
  const db = await openDatabase({ connectionString, schema, migrate: false });
  t.after(async () => {
    await db.close();
    assert.match(schema, /^campuslink_test_[a-f0-9]{32}$/);
    const pool = createPostgresPool({ connectionString, max: 1 });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end(); }
  });
  // Only the old notification table is needed to exercise this additive SQL.
  // No user rows, provider sessions or application schema are changed.
  await db.transaction(async () => {
    await db.exec(`CREATE TABLE notifications(id INTEGER PRIMARY KEY,read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,body TEXT NOT NULL,registration_user_id INTEGER)`);
    await db.exec('CREATE INDEX notifications_expiration ON notifications(created_at) WHERE registration_user_id IS NULL');
    await db.prepare(`INSERT INTO notifications(id,read,created_at,body,registration_user_id)
      VALUES(1,1,'2000-01-01T00:00:00Z','Read history',NULL),
      (2,0,'2000-01-01T00:00:00Z','Still unread',NULL),
      (3,1,'2000-01-01T00:00:00Z','Read pending request',42)`).run();
  });
  const before = await db.prepare('SELECT * FROM notifications ORDER BY id').all();
  const from = (await db.prepare('SELECT CURRENT_TIMESTAMP AS time').get()).time;
  const migration = await readFile(new URL('../server/migrations/037_notification_first_read_retention.sql', import.meta.url), 'utf8');
  await db.transaction(() => db.exec(migration));
  const through = (await db.prepare('SELECT CURRENT_TIMESTAMP AS time').get()).time;
  const after = await db.prepare('SELECT * FROM notifications ORDER BY id').all();
  assert.deepEqual(after.map(({ read_at, ...row }) => row), before);
  assert.equal(after[1].read_at, null, 'Old unread notices do not start a retention clock.');
  for (const row of [after[0], after[2]]) {
    assert.ok(row.read_at >= from && row.read_at <= through, 'Unknown legacy reads start at migration time.');
  }
  const indexes = await db.prepare('SELECT indexname FROM pg_indexes WHERE schemaname=?').all(schema);
  assert.ok(indexes.some(index => index.indexname === 'notifications_read_expiration'));
  assert.ok(!indexes.some(index => index.indexname === 'notifications_expiration'));
});

test('readiness requires the new first-read column and advertises the additive migration', async () => {
  const db = { schema: 'readiness_fixture', async query() {
    return { rows: ['id', 'target_deleted', 'registration_user_id'].map(column_name => ({ table_name: 'notifications', column_name })) };
  }, prepare() { throw new Error('An absent migration ledger must not be queried.'); } };
  const report = await inspectSchemaReadiness(db);
  assert.equal(report.ready, false);
  assert.ok(report.pendingMigrations.includes('037_notification_first_read_retention.sql'));
  assert.ok(report.missingColumns.includes('notifications.read_at'));
});
