import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';

// Each fixture lives in a disposable PostgreSQL schema. Identity and storage
// are injected doubles; these tests never touch deployed accounts or files.
let env, server, origin;
const cookies = {};
const timestamp = days => new Date(Date.now() - days * 86400000).toISOString();
async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().find(item => item.startsWith('campus_neon_test_session='))?.split(';')[0] };
}
async function signup() {
  const suffix = randomUUID().slice(0, 8);
  const result = await request('/register', { method: 'POST', body: {
    username: 'notice.' + suffix, name: 'Notification student ' + suffix,
    email: suffix + '@notification.test', password: 'PrivateNotification2026!',
    faculty_id: 'feg', filiere_id: 'economics', current_semester: 1,
  } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const notice = await env.db.prepare('SELECT * FROM notifications WHERE user_id=2 AND registration_user_id=?').get(result.data.user.id);
  assert.ok(notice, 'A cross-faculty signup reaches the platform owner');
  return { ...result, notice, id: result.data.user.id };
}
async function notice({ user = 3, faculty = 'flaa', type = 'admin', path = '/app', days = 0, read = 0, readAt = read ? timestamp(0) : null, deleted = 0 } = {}) {
  return env.db.prepare('INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at,read,read_at,target_deleted) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *').get(user, faculty, type, 'Notification regression', 'Private fixture', path, timestamp(days), read, readAt, deleted);
}
const iso = value => value === null ? null : new Date(value).toISOString();
async function message({ faculty = 'flaa', channel = 'general', author = 4, filiere = null, semester = null, days = 0, removed = 0 } = {}) {
  return env.db.prepare('INSERT INTO messages(faculty_id,channel,content,author_id,created_at,filiere_id,semester,removed) VALUES(?,?,?,?,?,?,?,?) RETURNING *').get(faculty, channel, 'Notification regression ' + randomUUID(), author, timestamp(days), filiere, semester, removed);
}

before(async () => {
  env = await createTestApp();
  server = env.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  for (const username of ['admin', 'yassine', 'professeure']) {
    const result = await request('/login', { method: 'POST', body: { username, password: username === 'admin' ? 'Admin2026!' : 'Campus2026!' } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    cookies[username] = result.cookie;
  }
});
beforeEach(async () => {
  await env.db.prepare('DELETE FROM notifications').run();
  await env.db.prepare("DELETE FROM messages WHERE content LIKE 'Notification regression %'").run();
  await env.db.prepare('DELETE FROM discussion_reads').run();
  // Seed examples are already read; new fixtures, including old unread messages, are independent of notification retention.
  await env.db.prepare("INSERT INTO discussion_reads(user_id,faculty_id,channel,filiere_id,semester,last_read_id,updated_at) SELECT 3,faculty_id,channel,CASE WHEN channel='filiere' THEN filiere_id ELSE '' END,CASE WHEN channel='filiere' THEN CASE WHEN semester IN(1,2) THEN 1 WHEN semester IN(3,4) THEN 3 ELSE 5 END ELSE 0 END,MAX(id),? FROM messages WHERE channel IN('general','important','filiere') GROUP BY faculty_id,channel,CASE WHEN channel='filiere' THEN filiere_id ELSE '' END,CASE WHEN channel='filiere' THEN CASE WHEN semester IN(1,2) THEN 1 WHEN semester IN(3,4) THEN 3 ELSE 5 END ELSE 0 END").run(new Date().toISOString());
});
after(async () => {
  env?.app.locals.endStreams();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await env?.close();
});

test('signup notifications point to the exact pending account and enforce ownership and destination authorization', async () => {
  const registered = await signup();
  const path = `/app/admin?tab=registrations&registration=${registered.id}#registration-${registered.id}`;
  assert.equal(registered.notice.path, path);
  assert.equal(registered.notice.faculty_id, 'flaa', 'The inbox uses its recipient faculty, including cross-faculty requests');
  const inbox = await request('/notifications', { cookie: cookies.admin });
  assert.equal(inbox.status, 200);
  const item = inbox.data.notifications.find(item => item.id === registered.notice.id);
  assert.equal(item.target_available, true);
  assert.equal(item.popup_eligible, true);
  assert.equal((await request(`/notifications/${item.id}/viewed`, { cookie: cookies.yassine, method: 'POST', body: { path } })).status, 404);
  assert.equal((await request(`/notifications/${item.id}/viewed`, { cookie: cookies.admin, method: 'POST', body: { path: '/app/admin?tab=registrations' } })).status, 400);
  const visit = await request(`/notifications/${item.id}/viewed`, { cookie: cookies.admin, method: 'POST', body: { path } });
  assert.equal(visit.status, 200);
  assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(item.id)).read, 0);
  assert.equal((await request(`/notifications/${item.id}/departed`, { cookie: cookies.yassine, method: 'POST', body: { visit_token: visit.data.visit_token } })).status, 404);
  const departed = await request(`/notifications/${item.id}/departed`, { cookie: cookies.admin, method: 'POST', body: { visit_token: visit.data.visit_token } });
  assert.equal(departed.status, 200);
  assert.ok(Number.isFinite(Date.parse(departed.data.read_at)), 'Completing a visit returns its first-read timestamp');
  const firstRead = await env.db.prepare('SELECT read,read_at FROM notifications WHERE id=?').get(item.id);
  assert.equal(firstRead.read, 1);
  assert.equal(iso(firstRead.read_at), departed.data.read_at);
  const repeated = await request(`/notifications/${item.id}/departed`, { cookie: cookies.admin, method: 'POST', body: { visit_token: visit.data.visit_token } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.read_at, departed.data.read_at, 'Repeating a completed visit cannot restart retention');
  const marked = await request(`/notifications/${item.id}/read`, { cookie: cookies.admin, method: 'POST', body: {} });
  assert.equal(marked.status, 200);
  assert.equal(iso(marked.data.notifications.find(row => row.id === item.id).read_at), departed.data.read_at);

  const unauthorized = await notice({ user: 7, path });
  const facultyInbox = await request('/notifications', { cookie: cookies.professeure });
  const forbidden = facultyInbox.data.notifications.find(item => item.id === unauthorized.id);
  assert.equal(forbidden.target_available, false);
  assert.equal(forbidden.popup_eligible, false);
  assert.equal((await request(`/notifications/${unauthorized.id}/viewed`, { cookie: cookies.professeure, method: 'POST', body: { path } })).status, 403);
});

test('retention follows the first read rather than creation time and never expires an unread notice', async () => {
  const registered = await signup();
  await env.db.prepare('UPDATE notifications SET created_at=?,read=1,read_at=? WHERE id=?').run(timestamp(8), timestamp(4), registered.notice.id);
  const staleUnread = await notice({ user: 2, days: 40 });
  const staleRead = await notice({ user: 2, read: 1, readAt: timestamp(4) });
  const recent = await notice({ user: 2, days: 2 });
  const recentlyRead = await notice({ user: 2, days: 40, read: 1, readAt: timestamp(1) });
  for (const path of ['/bootstrap', '/notifications?limit=1']) {
    const response = await request(path, { cookie: cookies.admin });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.ok(response.data.notifications.every(item => ![registered.notice.id, staleRead.id].includes(item.id)), path + ': expired read rows never reach the client');
    assert.equal(response.data.unread_count, 2);
  }
  const inbox = await request('/notifications?limit=100', { cookie: cookies.admin });
  assert.ok(!inbox.data.notifications.some(item => item.id === registered.notice.id), 'Pending admissions receive no exemption after being read');
  assert.ok(inbox.data.notifications.some(item => item.id === staleUnread.id), 'An old unread notice stays until read or resolved');
  assert.ok(inbox.data.notifications.some(item => item.id === recent.id));
  assert.ok(inbox.data.notifications.some(item => item.id === recentlyRead.id), 'An old notice gets a full retention period after its first read');
});

test('approval and rejection retain registration notices as read without extending an existing deadline', async () => {
  const keep = await signup();
  for (const status of ['approved', 'rejected']) {
    const registered = await signup();
    const alreadyReadAt = status === 'approved' ? timestamp(1) : null;
    await env.db.prepare('UPDATE notifications SET created_at=? WHERE id=?').run(timestamp(7), registered.notice.id);
    if (alreadyReadAt) await env.db.prepare('UPDATE notifications SET read=1,read_at=? WHERE id=?').run(alreadyReadAt, registered.notice.id);
    const beforeReview = Date.now();
    const reviewed = await request(`/admin/users/${registered.id}/admission`, { cookie: cookies.admin, method: 'PATCH', body: { status } });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    const resolved = await env.db.prepare('SELECT id,read,read_at FROM notifications WHERE registration_user_id=?').all(registered.id);
    assert.ok(resolved.length > 0, 'Resolving admission preserves the recipients’ history');
    assert.ok(resolved.every(row => row.read === 1 && row.read_at), 'All recipients move to Read atomically');
    const ownerNotice = resolved.find(row => row.id === registered.notice.id);
    if (alreadyReadAt) assert.equal(iso(ownerNotice.read_at), alreadyReadAt);
    else assert.ok(new Date(ownerNotice.read_at).getTime() >= beforeReview && new Date(ownerNotice.read_at).getTime() <= Date.now());
    const inbox = await request('/notifications', { cookie: cookies.admin });
    const item = inbox.data.notifications.find(item => item.id === registered.notice.id);
    assert.ok(item);
    assert.equal(item.read, true);
    assert.equal(item.target_available, false, 'Keeping history grants no access to a resolved registration');
    assert.equal(item.popup_eligible, false);
    assert.equal(iso(item.read_at), iso(ownerNotice.read_at));
    assert.ok(inbox.data.notifications.some(item => item.id === keep.notice.id));
    const repeated = await request(`/admin/users/${registered.id}/admission`, { cookie: cookies.admin, method: 'PATCH', body: { status } });
    assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
    assert.deepEqual((await env.db.prepare('SELECT id,read,read_at FROM notifications WHERE registration_user_id=? ORDER BY id').all(registered.id)), resolved.toSorted((a,b) => a.id-b.id), 'Duplicate reviews cannot extend retention');
    if (status === 'approved') {
      const studentInbox = await request('/notifications', { cookie: registered.cookie });
      assert.equal(studentInbox.status, 200);
      assert.ok(studentInbox.data.notifications.every(item => item.popup_eligible === false), 'Student administrative replies do not become admin popups');
    }
  }
});

test('hard account deletion still removes private registration history instead of retaining an orphaned notice', async () => {
  const keep = await signup();
  const registered = await signup();
  assert.equal((await request(`/admin/users/${registered.id}/admission`, { cookie: cookies.admin, method: 'PATCH', body: { status: 'approved' } })).status, 200);
  assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(registered.notice.id)).read, 1);
  const deleted = await request(`/admin/users/${registered.id}`, { cookie: cookies.admin, method: 'DELETE' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE registration_user_id=?').get(registered.id)).n, 0);
  const inbox = await request('/notifications', { cookie: cookies.admin });
  assert.ok(!inbox.data.notifications.some(item => item.id === registered.notice.id));
  assert.ok(inbox.data.notifications.some(item => item.id === keep.notice.id));
});

test('unread counters include visible unavailable notices but exclude expired and foreign notices', async () => {
  const target = await message(), path = `/app/chat/general#message-${target.id}`;
  const discussion = await notice({ type: 'mentions', path });
  const general = await notice();
  await notice({ type: 'important', path, read: 1 });
  await notice({ path, deleted: 1 });
  await notice({ path:'/app/resources/courses/s3#resource-99999999' });
  await notice({ type: 'important', path, read: 1, readAt: timestamp(4) });
  await notice({ user: 2 });
  await notice({ user: 3, faculty: 'feg' });
  const ids = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const result = await request('/notifications?limit=1' + cursor, { cookie: cookies.yassine });
    assert.equal(result.status, 200);
    assert.equal(result.data.unread_count, 3);
    assert.equal(result.data.discussion_unread_count, 1);
    assert.equal(result.data.admin_unread_count, 0);
    ids.push(...result.data.notifications.map(item => item.id));
    assert.ok(result.data.notifications.every(item => item.popup_eligible === false));
    if (!result.data.has_more) break;
    assert.ok(Number.isSafeInteger(result.data.next_before_id));
    cursor = '&before_id=' + result.data.next_before_id;
  }
  assert.equal(new Set(ids).size, ids.length, 'Cursor pages do not repeat rows');
  assert.ok(ids.includes(discussion.id) && ids.includes(general.id));
  const bootstrap = await request('/bootstrap', { cookie: cookies.yassine });
  assert.equal(bootstrap.data.unread_count, 3);
  assert.equal(bootstrap.data.discussion_unread_count, 1);
  assert.equal(bootstrap.data.admin_unread_count, 0);
  assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(discussion.id)).read, 0);
});

test('ordinary discussion badges count accessible nonself messages and reading cursors are scoped and monotonic', async () => {
  const first = await message(), second = await message();
  await message({ author: 3 });
  const oldUnread=await message({ days: 4 });
  await message({ removed: 1 });
  const otherFaculty = await message({ faculty: 'feg', author: 9 });
  const otherFiliere = await message({ channel: 'filiere', author: 8, filiere: 'arabic_studies', semester: 1 });
  const yearOne = await message({ channel: 'filiere', filiere: 'french_studies', semester: 2 });
  const yearThree = await message({ channel: 'filiere', filiere: 'french_studies', semester: 3 });
  const counts = () => request('/notifications', { cookie: cookies.yassine });
  const mark = (body, cookie = cookies.yassine) => request('/messages/read', { cookie, method: 'POST', body });
  const initial = await counts();
  assert.equal(initial.data.discussion_unread_count, 5, 'Accessible unread messages persist beyond notification retention');
  assert.equal(initial.data.unread_count, 0, 'Ordinary chat does not create notification inbox rows');
  for (const body of [
    { channel: 'general', through_id: otherFaculty.id },
    { channel: 'filiere', semester: 1, through_id: otherFiliere.id },
    { channel: 'important', through_id: second.id },
    { channel: 'filiere', semester: 3, through_id: yearOne.id },
  ]) assert.equal((await mark(body)).status, 403, 'Cross-scope message IDs cannot advance a cursor');
  assert.equal((await counts()).data.discussion_unread_count, 5);
  assert.equal((await mark({ channel: 'general', through_id: second.id })).data.discussion_unread_count, 3);
  assert.equal((await mark({ channel: 'general', through_id: first.id })).data.discussion_unread_count, 3, 'An older request cannot move a read cursor backwards');
  const cursor = await env.db.prepare("SELECT last_read_id FROM discussion_reads WHERE user_id=3 AND faculty_id='flaa' AND channel='general'").get();
  assert.equal(cursor.last_read_id, second.id);
  assert.equal((await mark({ channel: 'filiere', semester: 1, through_id: yearOne.id })).data.discussion_unread_count, 2, 'Paired semesters use one channel cursor');
  assert.equal((await mark({ channel: 'filiere', semester: 4, through_id: yearThree.id })).data.discussion_unread_count, 1);
  assert.equal((await mark({channel:'general',through_id:oldUnread.id})).data.discussion_unread_count,0,'Old unread messages clear only when read');
  const newcomer = await message();
  assert.equal((await counts()).data.discussion_unread_count, 1, 'New messages remain unread after a prior visit');
  assert.equal((await mark({ channel: 'general', through_id: newcomer.id })).data.discussion_unread_count, 0);
  const anotherStudent = await request('/notifications', { cookie: cookies.professeure });
  assert.ok(anotherStudent.data.discussion_unread_count > 0, 'Reading for one account cannot clear another account badge');
});

test('read synchronization reaches only the account devices and respects existing stream session versions', async () => {
  const target = await message();
  const item = await notice();
  const visit = await request(`/notifications/${item.id}/viewed`, { cookie: cookies.yassine, method: 'POST', body: { path: item.path } });
  assert.equal(visit.status, 200);
  async function stream(cookie) {
    const controller = new AbortController();
    const response = await fetch(origin + '/api/events/stream', { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = decoder.decode((await reader.read()).value);
    return {
      async next(timeout = 2000) {
        let timer;
        try {
          return await Promise.race([
            (async () => {
              while (true) {
                let boundary;
                while ((boundary = pending.indexOf('\n\n')) >= 0) {
                  const frame = pending.slice(0, boundary);
                  pending = pending.slice(boundary + 2);
                  if (frame.startsWith('event: update\n')) return JSON.parse(frame.split('\ndata: ')[1]);
                }
                const chunk = await reader.read();
                if (chunk.done) return null;
                pending += decoder.decode(chunk.value, { stream: true });
              }
            })(),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
          ]);
        } finally { clearTimeout(timer); }
      },
      async close() { controller.abort(); await reader.cancel().catch(() => {}); },
    };
  }
  const devices = await Promise.all([stream(cookies.yassine), stream(cookies.yassine), stream(cookies.professeure)]);
  try {
    const marked = await request('/messages/read', { cookie: cookies.yassine, method: 'POST', body: { channel: 'general', through_id: target.id } });
    assert.equal(marked.status, 200);
    for (const device of devices.slice(0, 2)) assert.deepEqual(await device.next(), { discussionReads: true });
    const departed = await request(`/notifications/${item.id}/departed`, { cookie: cookies.yassine, method: 'POST', body: { visit_token: visit.data.visit_token } });
    assert.equal(departed.status, 200);
    for (const device of devices.slice(0, 2)) assert.deepEqual(await device.next(), { notifications: true }, 'Read state must not trigger an administration inbox reload');
    const user = await env.db.prepare('SELECT session_version FROM users WHERE id=3').get();
    try {
      await env.db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=3').run();
      assert.equal((await request('/messages/read', { cookie: cookies.yassine, method: 'POST', body: { channel: 'general', through_id: target.id } })).status, 200);
      assert.deepEqual(await Promise.all(devices.map(device => device.next(150))), [null, null, null], 'Other users and superseded sessions receive no read updates');
    } finally { await env.db.prepare('UPDATE users SET session_version=? WHERE id=3').run(user.session_version); }
  } finally { await Promise.all(devices.map(device => device.close())); }
});
