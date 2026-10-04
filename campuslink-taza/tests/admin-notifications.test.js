import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminNotificationFeed } from '../src/admin-notifications.js';

const admin = { id: 2, role: 'global_admin', faculty_id: 'fsa', account_status: 'approved' };
const notice = (id, extra = {}) => ({ id, type: 'admin', path: '/app/admin?tab=reports', read: false, ...extra });

test('administrative popups only announce new inbox arrivals and remain silent for old or repeated snapshots', () => {
  const feed = new AdminNotificationFeed();
  assert.deepEqual(feed.capture(admin, [notice(1)]), []);
  assert.deepEqual(feed.capture(admin, [notice(1), notice(2), notice(3, { type: 'important', path: '/app/chat/important' }), notice(4, { read: true }), notice(5, { path: '/app/notifications' })]).map(item => item.id), [2]);
  assert.deepEqual(feed.capture(admin, [notice(1), notice(2)]), []);
  assert.deepEqual(feed.capture(admin, [notice(2, { read: true }), notice(6, { path: '/app/admin?tab=contacts' }), notice(7, { path: '/app/admin?tab=registrations' })]).map(item => item.id), [6, 7]);
});

test('student, pending and account switches cannot expose another account administrative popups', () => {
  const feed = new AdminNotificationFeed();
  for (const user of [{ ...admin, role: 'student' }, { ...admin, account_status: 'pending' }]) {
    assert.deepEqual(feed.capture(user, []), []);
    assert.deepEqual(feed.capture(user, [notice(1)]), []);
  }
  assert.deepEqual(feed.capture(admin, [notice(1)]), []);
  assert.deepEqual(feed.capture({ ...admin, id: 3 }, [notice(1), notice(2)]), []);
  assert.deepEqual(feed.capture({ ...admin, id: 3 }, [notice(3, { path: 'https://foreign.invalid/app/admin' }), notice(4, { path: '/app/administrative' }), notice(5)]).map(item => item.id), [5]);
  assert.deepEqual(feed.capture({ ...admin, id: 3, faculty_id: 'flaa' }, [notice(6)]), []);
});
