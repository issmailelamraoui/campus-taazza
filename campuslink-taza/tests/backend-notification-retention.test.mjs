import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestEnvironment } from './backend-helpers.mjs';
import { createNotificationStore, NOTIFICATION_RETENTION_MS } from '../server/notifications.js';

// Only disposable campuslink_test_* schemas are created. An injected clock
// exercises the exact expiry boundary without sleeping or changing DB time.
const hour = 60 * 60 * 1000;
const baseline = Date.parse('2030-04-06T12:00:00.123Z');
const user = { id: 3, faculty_id: 'flaa' };
let env, store, clock;
const iso = value => value === null ? null : new Date(value).toISOString();
const at = offset => new Date(clock + offset).toISOString();
async function notice({ owner = 3, faculty = 'flaa', createdAt = at(0), readAt = null, read = readAt === null ? 0 : 1, registration = null, path = '/app' } = {}) {
  return env.db.prepare('INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at,read,read_at,registration_user_id) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *')
    .get(owner, faculty, 'admin', 'Isolated retention test', 'No real user data', path, createdAt, read, readAt, registration);
}

before(async () => { env = await createTestEnvironment(); });
beforeEach(async () => {
  await env.db.prepare('DELETE FROM notifications').run();
  clock = baseline;
  store = createNotificationStore({
    db: env.db,
    clock: () => clock,
    decorate: async (_user, rows) => rows.map(row => ({ ...row, target_available: row.path === '/app', popup_eligible: false })),
  });
  // Force later queries through the logical expiry predicate while physical
  // cleanup is throttled, as happens during an ordinary application request.
  await store.prune();
});
after(async () => { await env?.close(); });

test('all inbox access paths agree at exactly 72 hours and physical expiry removes linked visits permanently', async () => {
  assert.equal(NOTIFICATION_RETENTION_MS, 72 * hour);
  const oldUnread = await notice({ createdAt: at(-365 * 24 * hour) });
  const oldRecentlyRead = await notice({ createdAt: at(-365 * 24 * hour), readAt: at(-hour) });
  const boundary = await notice({ readAt: at(-72 * hour + 1) });
  const expired = await notice({ readAt: at(-72 * hour) });
  await env.db.prepare("UPDATE users SET account_status='pending' WHERE id=9").run();
  const pendingExpired = await notice({ readAt: at(-72 * hour), registration: 9 });
  const unavailable = await notice({ path: '/app/resources#resource-99999999' });
  await notice({ owner: 2 });
  await notice({ faculty: 'feg' });
  const token = randomUUID();
  await env.db.prepare('INSERT INTO notification_visits(token,notification_id,user_id,path,viewed_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(token, boundary.id, user.id, boundary.path, at(-hour), at(12 * hour));

  assert.ok(await store.find(user, boundary.id), 'A read notice remains visible until the last millisecond before its deadline');
  assert.equal(await store.find(user, expired.id), undefined);
  assert.equal(await store.find(user, pendingExpired.id), undefined, 'A still-pending registration has no read-retention exemption');
  assert.deepEqual((await store.rows(user)).map(row => row.id), [unavailable.id, boundary.id, oldRecentlyRead.id, oldUnread.id]);
  clock += 1;
  assert.equal(await store.find(user, boundary.id), undefined, 'The exact deadline is expired');
  const ids = [];
  let before = null;
  do {
    const page = await store.payload(user, { limit: 1, before });
    assert.equal(page.unread_count, 2, 'Counters cover all pages, including inaccessible destinations');
    assert.equal(page.admin_unread_count, 0);
    ids.push(...page.notifications.map(row => row.id));
    before = page.has_more ? page.next_before_id : null;
  } while (before !== null);
  assert.deepEqual(ids, [unavailable.id, oldRecentlyRead.id, oldUnread.id]);
  assert.deepEqual(await store.state(user), { total: 3, unread_count: 2, latest_id: unavailable.id });
  assert.equal(iso((await store.find(user, oldRecentlyRead.id)).read_at), at(-hour - 1));
  await store.markRead(user, boundary.id);
  assert.equal(iso((await env.db.prepare('SELECT read_at FROM notifications WHERE id=?').get(boundary.id)).read_at), new Date(baseline - 72 * hour + 1).toISOString(), 'Reading an expired ID cannot resurrect it');
  assert.ok(await env.db.prepare('SELECT id FROM notifications WHERE id=?').get(boundary.id), 'The visibility assertion ran before the throttled physical cleanup');
  clock += 60000;
  await store.prune();
  for (const row of [boundary, expired, pendingExpired]) assert.equal(await env.db.prepare('SELECT id FROM notifications WHERE id=?').get(row.id), undefined);
  assert.equal(await env.db.prepare('SELECT token FROM notification_visits WHERE token=?').get(token), undefined, 'Permanent expiry cascades to visit receipts');
  assert.ok(await store.find(user, oldUnread.id));
  assert.ok(await store.find(user, oldRecentlyRead.id));
});

test('single and batch read actions retain the first timestamp and cannot read another inbox', async () => {
  const first = await notice({ createdAt: at(-120 * 24 * hour) });
  const second = await notice({ createdAt: at(-90 * 24 * hour) });
  const foreign = await notice({ owner: 2 });
  const otherFaculty = await notice({ faculty: 'feg' });
  await store.markRead(user, first.id);
  assert.equal(iso((await store.find(user, first.id)).read_at), at(0), 'An old unread notice starts a full period when read');
  clock += hour;
  await store.markRead(user, first.id);
  await store.markRead(user, foreign.id);
  await store.markRead(user, otherFaculty.id);
  await store.markRead(user);
  assert.equal(iso((await store.find(user, first.id)).read_at), new Date(baseline).toISOString());
  assert.equal(iso((await store.find(user, second.id)).read_at), at(0));
  assert.equal((await env.db.prepare('SELECT read,read_at FROM notifications WHERE id=?').get(foreign.id)).read, 0);
  assert.equal((await env.db.prepare('SELECT read,read_at FROM notifications WHERE id=?').get(otherFaculty.id)).read_at, null);
  assert.equal((await store.state(user)).unread_count, 0);
  clock = baseline + 72 * hour;
  assert.equal(await store.find(user, first.id), undefined);
  assert.ok(await store.find(user, second.id), 'A later first-read has its own deadline');
});

test('registration resolution reads every recipient once and remains atomic in the enclosing transaction', async () => {
  const first = await notice({ registration: 9, createdAt: at(-100 * 24 * hour) });
  const anotherRecipient = await notice({ owner: 2, registration: 9, createdAt: at(-100 * 24 * hour) });
  const alreadyRead = await notice({ owner: 10, faculty: 'feg', registration: 9, readAt: at(-hour) });
  const differentRegistration = await notice({ registration: 4 });
  await assert.rejects(env.db.transaction(async () => {
    await store.resolveRegistration(9);
    throw new Error('Isolated review rollback');
  }), /Isolated review rollback/);
  assert.equal((await env.db.prepare('SELECT read,read_at FROM notifications WHERE id=?').get(first.id)).read, 0);
  await env.db.transaction(() => store.resolveRegistration(9));
  const select = () => env.db.prepare('SELECT id,read,read_at FROM notifications WHERE registration_user_id=9 ORDER BY id').all();
  const resolved = await select();
  assert.equal(resolved.length, 3);
  for (const row of resolved) {
    assert.equal(row.read, 1);
    assert.equal(iso(row.read_at), row.id === alreadyRead.id ? at(-hour) : at(0));
  }
  assert.ok(resolved.some(row => row.id === anotherRecipient.id), 'Cross-recipient resolution is not restricted to the acting administrator’s faculty');
  assert.equal((await store.find(user, differentRegistration.id)).read, 0);
  clock += 2 * hour;
  await store.resolveRegistration(9);
  assert.deepEqual(await select(), resolved, 'A duplicate review cannot move any first-read timestamp');
});

test('rolling-deployment writers that set only read receive a timestamp which later writes cannot extend', async () => {
  const unread = await notice();
  const beforeWrite = Date.now();
  await env.db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(unread.id);
  const first = await env.db.prepare('SELECT read,read_at FROM notifications WHERE id=?').get(unread.id);
  assert.equal(first.read, 1);
  assert.ok(new Date(first.read_at).getTime() >= beforeWrite && new Date(first.read_at).getTime() <= Date.now());
  await env.db.prepare('UPDATE notifications SET read=1,read_at=? WHERE id=?').run(at(24 * hour), unread.id);
  assert.equal(iso((await env.db.prepare('SELECT read_at FROM notifications WHERE id=?').get(unread.id)).read_at), iso(first.read_at));
  await env.db.prepare('UPDATE notifications SET read_at=NULL WHERE id=?').run(unread.id);
  assert.equal(iso((await env.db.prepare('SELECT read_at FROM notifications WHERE id=?').get(unread.id)).read_at), iso(first.read_at));
  const inserted = await notice({ read: 1 });
  assert.ok(inserted.read_at, 'An old writer inserting an already-read notice also gets its first-read stamp');
});
