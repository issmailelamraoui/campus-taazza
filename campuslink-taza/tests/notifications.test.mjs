import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPath, normalizeBootstrap } from '../src/lib/backend.js';

test('registration destinations preserve the exact account through legacy tab normalization', () => {
  const path = '/app/admin?tab=registrations&registration=57#registration-57';
  assert.equal(clientPath(path), '/app/admin?tab=accounts&registration=57#registration-57');
  const data = normalizeBootstrap({ user: { id: 2, role: 'global_admin', faculty_id: 'flaa' }, notifications: [
    { id: 41, type: 'admin', path, registration_user_id: 57, read: false, popup_eligible: true, target_available: true },
  ], unread_count: 12, discussion_unread_count: 7, admin_unread_count: 5 });
  assert.equal(data.notifications[0].href, '/app/admin?tab=accounts&registration=57#registration-57');
  assert.equal(data.notifications[0].serverPath, path, 'Visit authorization retains the exact original backend path');
  assert.equal(data.notifications[0].popup_eligible, true);
  assert.equal(data.notifications[0].popupEligible, true);
  assert.equal(data.unreadCount, 12);
  assert.equal(data.discussionUnreadCount, 7, 'The discussion badge uses the complete inbox count rather than the visible page');
  assert.equal(data.adminUnreadCount, 5);
});

test('discussion counts fall back to accessible unread message notices on an older server', () => {
  const data = normalizeBootstrap({ user: { id: 3, role: 'student', faculty_id: 'flaa' }, notifications: [
    { id: 1, type: 'important', path: '/app/chat/general#message-3', read: false, target_available: true },
    { id: 2, type: 'mentions', path: '/app/chat/general#message-4', read: false, target_available: true },
    { id: 3, type: 'important', path: '/app/chat/general#message-5', read: true, target_available: true },
    { id: 4, type: 'mentions', path: '/app/chat/general#message-6', read: false, target_available: false },
    { id: 5, type: 'admin', path: '/app', read: false, target_available: true },
  ] });
  assert.equal(data.discussionUnreadCount, 2);
});

test('read history preserves its first-read timestamp independently of its creation date and destination availability', () => {
  const createdAt = '2026-09-01T09:00:00.000Z';
  const readAt = '2026-10-27T12:34:56.789Z';
  const data = normalizeBootstrap({ user: { id: 2, role: 'global_admin', faculty_id: 'flaa' }, notifications: [
    { id: 41, type: 'admin', path: '/app/admin?tab=registrations&registration=57#registration-57', created_at: createdAt, read_at: readAt, read: true, registration_user_id: 57, target_available: false, popup_eligible: false },
    { id: 42, type: 'admin', path: '/app', created_at: createdAt, read_at: null, read: false },
  ] });
  const [history, unread] = data.notifications;
  assert.equal(history.read, true);
  assert.equal(history.date, createdAt, 'The displayed creation date is not replaced by the first-read time');
  assert.equal(history.read_at, readAt);
  assert.equal(history.readAt, readAt);
  assert.equal(history.registration_user_id, 57);
  assert.equal(history.target_available, false);
  assert.equal(history.popupEligible, false);
  assert.equal(unread.read, false);
  assert.equal(unread.readAt, null);
});

test('legacy document links retain the reader target, source page and version after normalization', () => {
  for (const path of ['/app/resources#resource-42', '/app/resources/courses/s1/algorithms#resource-42']) {
    assert.equal(clientPath(path), '/app/library?document=42#resource-42');
  }
  const result = new URL(clientPath('/app/resources/courses/s1/algorithms?page=7&version=2#resource-42', [{ id: '42', semester: 1, category: 'courses', module: 'Algorithms' }]), 'https://notification.test');
  assert.equal(result.pathname, '/app/library');
  assert.equal(result.searchParams.get('document'), '42');
  assert.equal(result.searchParams.get('page'), '7');
  assert.equal(result.searchParams.get('version'), '2');
  assert.equal(result.searchParams.get('module'), 'Algorithms');
  assert.equal(result.hash, '#resource-42');
});

test('popups require server eligibility, an administrator and an available destination', () => {
  const raw = { id: 1, type: 'admin', path: '/app/admin?tab=reports&report=4#report-4', popup_eligible: true, target_available: true };
  const normalized = (user, item) => normalizeBootstrap({ user, notifications: [item] }).notifications[0];
  assert.equal(normalized({ id: 2, role: 'global_admin' }, raw).popupEligible, true);
  assert.equal(normalized({ id: 3, role: 'student' }, raw).popupEligible, false);
  assert.equal(normalized({ id: 2, role: 'global_admin' }, { ...raw, target_available: false }).popupEligible, false);
  assert.equal(normalized({ id: 2, role: 'global_admin' }, { ...raw, popup_eligible: false }).popupEligible, false);
  assert.equal(normalized({ id: 2, role: 'global_admin' }, { ...raw, type: 'mentions' }).popupEligible, false);
  for (const path of ['https://example.test/app/admin', '//example.test/app/admin', '/application', 'javascript:alert(1)']) assert.equal(clientPath(path), '/app');
});
