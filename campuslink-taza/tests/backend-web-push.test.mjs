import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createTestEnvironment } from './backend-helpers.mjs';
import { createApp } from '../server/app.js';
import { createWebPushService } from '../server/push.js';

// Persistence uses a disposable campuslink_test_* schema. All transports are
// injected in-memory functions: these tests never contact a Push provider.
function keypair() {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  return { publicKey: curve.getPublicKey().toString('base64url'), privateKey: curve.getPrivateKey().toString('base64url') };
}
const configuration = { ...keypair(), subject: 'mailto:isolated-push-tests@example.invalid' };
const subscription = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + randomBytes(80).toString('base64url'), expirationTime: null, keys: { p256dh: keypair().publicKey, auth: randomBytes(16).toString('base64url') } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let env, clock, calls, users;
const loadUser = id => env.db.prepare('SELECT * FROM users WHERE id=?').get(id);
const pushSql = sql => env.db.prepare(sql.replace(/\b(push_outbox|push_subscriptions)\b/g, table => `"${env.schema}"."${table}"`));
function service({ transport = async (target, payload, options) => { calls.push({ target, payload: typeof payload === 'string' ? JSON.parse(payload) : payload, options }); return { statusCode: 201 }; }, canDeliver = async () => true } = {}) {
  return createWebPushService({ db: env.db, configuration, transport, loadUser, canDeliver, clock: () => clock });
}
async function subscribe(push, owner = users.get(3), deviceId = randomUUID(), target = subscription()) {
  const result = await push.subscribe(owner, { deviceId, subscription: target });
  assert.equal(result.ok, true);
  assert.match(result.bindingId, uuid);
  return { deviceId, bindingId: result.bindingId, subscription: target };
}
async function notice({ user = 3, faculty = 'flaa', eligible = true, title = 'Isolated Push ' + randomUUID(), path = '/app', read = 0 } = {}) {
  return env.db.prepare('INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at,read,push_eligible) VALUES(?,?,?,?,?,?,?,?,?) RETURNING *')
    .get(user, faculty, 'resources', title, 'Disposable notification', path, new Date(clock).toISOString(), read, eligible);
}
async function active(push, owner, binding) {
  return push.status(owner, { deviceId: binding.deviceId, bindingId: binding.bindingId, subscription: binding.subscription });
}
async function harmlessForeignOperation(operation) {
  try { return await operation(); }
  catch (error) { assert.ok([400, 403, 404, 409].includes(error.status), 'Foreign references may be rejected without mutating their owner'); }
}

before(async () => {
  env = await createTestEnvironment();
  users = new Map((await env.db.prepare('SELECT * FROM users WHERE id=ANY(?)').all([2, 3, 4])).map(user => [user.id, user]));
});
beforeEach(async () => {
  await pushSql('DELETE FROM push_outbox').run();
  await pushSql('DELETE FROM push_subscriptions').run();
  await env.db.prepare('DELETE FROM notifications').run();
  for (const user of users.values()) await env.db.prepare('UPDATE users SET disabled=?,account_status=?,session_version=?,faculty_id=?,filiere_id=?,preferences=? WHERE id=?')
    .run(user.disabled, user.account_status, user.session_version, user.faculty_id, user.filiere_id, user.preferences, user.id);
  clock = Date.now() + 60000;
  calls = [];
});
after(async () => { await env?.close(); });

test('device bindings are idempotent, account-owned and independently revocable', async () => {
  const push = service(), owner = users.get(3), other = users.get(4);
  assert.equal(push.configured, true);
  const first = await subscribe(push);
  assert.notEqual(first.bindingId, first.deviceId, 'The server binding is separate from the browser device identifier');
  const repeated = await push.subscribe(owner, { deviceId: first.deviceId, subscription: first.subscription });
  assert.equal(repeated.bindingId, first.bindingId, 'Repeating the same subscription does not create another binding');
  const second = await subscribe(push);
  assert.notEqual(second.bindingId, first.bindingId);
  assert.equal((await active(push, owner, first)).active, true);
  assert.equal((await active(push, owner, second)).active, true);
  const foreignStatus = await harmlessForeignOperation(() => active(push, other, first));
  if (foreignStatus) {
    assert.equal(foreignStatus.active, false);
    assert.equal(foreignStatus.bindingId, null);
  }
  await harmlessForeignOperation(() => push.unsubscribe(other, { deviceId: first.deviceId, bindingId: first.bindingId }));
  await harmlessForeignOperation(() => push.unsubscribe(owner, { deviceId: second.deviceId, bindingId: first.bindingId }));
  assert.equal((await active(push, owner, first)).active, true, 'Stolen or mismatched identifiers cannot unsubscribe the owner');
  assert.equal((await active(push, owner, second)).active, true);
  await assert.rejects(push.subscribe(other, { deviceId: first.deviceId, subscription: first.subscription }), error => error.status === 409);
  await assert.rejects(push.subscribe(owner, { expectedUserId: other.id, deviceId: randomUUID(), subscription: subscription() }), error => error.status === 409);
  assert.equal((await active(push, owner, first)).active, true, 'Another account cannot take over an existing browser endpoint');
  await push.unsubscribe(owner, { deviceId: first.deviceId, bindingId: first.bindingId });
  assert.equal((await active(push, owner, first)).active, false);
  assert.equal((await active(push, owner, second)).active, true);
  await push.revokeDevice(owner.id, second.deviceId, randomUUID());
  assert.equal((await active(push, owner, second)).active, true, 'A stale binding cannot revoke a replacement on the same browser');
  await push.revokeDevice(owner.id, second.deviceId, second.bindingId);
  assert.equal((await active(push, owner, second)).active, false);
  const third = await subscribe(push);
  await push.revokeUser(owner.id);
  assert.equal((await active(push, owner, third)).active, false);
});

test('notification insertion queues only current devices atomically, without replaying inbox history', async () => {
  const push = service();
  await notice({ title: 'History before browser opt-in' });
  const first = await subscribe(push), second = await subscribe(push);
  await subscribe(push, users.get(4));
  assert.equal((await pushSql('SELECT COUNT(*) AS n FROM push_outbox').get()).n, 0, 'Opt-in never sends old inbox history');
  await assert.rejects(env.db.transaction(async () => {
    await notice({ title: 'Rolled-back publication' });
    throw new Error('Isolated publication rollback');
  }), /Isolated publication rollback/);
  assert.equal((await pushSql('SELECT COUNT(*) AS n FROM push_outbox').get()).n, 0);
  const delivered = await env.db.transaction(() => notice());
  await notice({ eligible: false });
  await push.subscribe(users.get(3), { deviceId: first.deviceId, subscription: first.subscription });
  assert.equal((await pushSql('SELECT COUNT(*) AS n FROM push_outbox WHERE notification_id=?').get(delivered.id)).n, 2);
  assert.equal((await pushSql('SELECT COUNT(*) AS n FROM push_outbox').get()).n, 2, 'Ineligible inserts and repeated opt-in create no extra deliveries');
  await push.dispatch();
  assert.equal(calls.length, 2, 'One event produces one send per active matching browser');
  assert.deepEqual(new Set(calls.map(call => call.payload.bindingId)), new Set([first.bindingId, second.bindingId]));
  for (const call of calls) {
    assert.equal(Number(call.payload.notificationId), delivered.id);
    assert.equal(call.payload.title, delivered.title);
    assert.equal(call.payload.path, '/app');
  }
  await push.dispatch();
  assert.equal(calls.length, 2, 'Completed outbox rows do not send again');
});

test('independent dispatchers reach different devices while another device delivery is still in flight', async () => {
  let releaseFirst, enteredFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
  const transport = async (target, payload) => {
    calls.push({ target, payload: typeof payload === 'string' ? JSON.parse(payload) : payload });
    if (calls.length === 1) { enteredFirst(); await gate; }
    return { statusCode: 201 };
  };
  const first = service({ transport }), second = service({ transport });
  const one = await subscribe(first), two = await subscribe(first);
  const event = await notice();
  const running = first.dispatch({ limit: 1, budgetMs: 8000 });
  let timer;
  try {
    await Promise.race([firstEntered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The first fake delivery did not start')), 10000); })]);
    clearTimeout(timer);
    await Promise.race([second.dispatch({ limit: 1, budgetMs: 8000 }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A second worker waited for the first delivery instead of claiming another event')), 10000); })]);
    assert.equal(calls.length, 2);
  } finally {
    clearTimeout(timer);
    releaseFirst();
    await running;
  }
  assert.deepEqual(new Set(calls.map(call => call.payload.bindingId)), new Set([one.bindingId, two.bindingId]));
  assert.ok(calls.every(call => Number(call.payload.notificationId) === event.id));
  await second.dispatch();
  assert.equal(calls.length, 2);
});

test('dispatch rechecks fresh account state, session version, notification preferences and destination access', async () => {
  const owner = users.get(3);
  const cases = [
    { name: 'disabled account', mutate: () => env.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(owner.id) },
    { name: 'pending account', mutate: () => env.db.prepare("UPDATE users SET account_status='pending' WHERE id=?").run(owner.id) },
    { name: 'revoked session', mutate: () => env.db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(owner.id) },
    { name: 'changed faculty', mutate: () => env.db.prepare("UPDATE users SET faculty_id='feg',filiere_id='economics' WHERE id=?").run(owner.id) },
    { name: 'muted category', mutate: () => env.db.prepare('UPDATE users SET preferences=? WHERE id=?').run('{"resources":false}', owner.id) },
    { name: 'unavailable target', canDeliver: async () => false },
    { name: 'already read', mutate: row => env.db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(row.id) },
  ];
  for (const scenario of cases) {
    await env.db.prepare('UPDATE users SET disabled=?,account_status=?,session_version=?,faculty_id=?,filiere_id=?,preferences=? WHERE id=?')
      .run(owner.disabled, owner.account_status, owner.session_version, owner.faculty_id, owner.filiere_id, owner.preferences, owner.id);
    const push = service({ canDeliver: scenario.canDeliver });
    await subscribe(push);
    const row = await notice();
    if (scenario.mutate) await scenario.mutate(row);
    await push.dispatch();
    assert.equal(calls.length, 0, scenario.name + ' must not reach the transport');
    const queued = await pushSql('SELECT state FROM push_outbox WHERE notification_id=?').all(row.id);
    assert.ok(queued.every(item => item.state === 'skipped'), scenario.name + ' cannot remain retryable');
    await push.revokeUser(owner.id);
  }
});

test('device revocation after enqueue cancels that device without dropping another account device', async () => {
  const push = service(), first = await subscribe(push), second = await subscribe(push);
  await notice();
  await push.revokeDevice(users.get(3).id, first.deviceId, first.bindingId);
  await push.dispatch();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.bindingId, second.bindingId);
});

test('a provider 410 removes a dead subscription and prevents later deliveries to it', async () => {
  let attempts = 0;
  const push = service({ transport: async () => { attempts++; throw Object.assign(new Error('Isolated expired browser subscription'), { statusCode: 410 }); } });
  const binding = await subscribe(push);
  await notice();
  await notice();
  await push.dispatch();
  assert.equal(attempts, 1);
  assert.equal((await active(push, users.get(3), binding)).active, false);
  await push.dispatch();
  assert.equal(attempts, 1);
});

test('transient provider failure retries later and eventually reaches a bounded terminal state', async () => {
  let attempts = 0;
  const push = service({ transport: async () => { attempts++; throw Object.assign(new Error('Isolated temporary provider failure'), { statusCode: 503 }); } });
  await subscribe(push);
  const row = await notice();
  await push.dispatch();
  assert.equal(attempts, 1);
  await push.dispatch();
  assert.equal(attempts, 1, 'Transient errors are not retried in a tight request loop');
  for (let retry = 0; retry < 12; retry++) {
    const pending = await pushSql("SELECT available_at FROM push_outbox WHERE notification_id=? AND state='pending'").get(row.id);
    if (!pending) break;
    clock = new Date(pending.available_at).getTime() + 1;
    await push.dispatch();
  }
  const final = await pushSql('SELECT state,attempts FROM push_outbox WHERE notification_id=?').get(row.id);
  assert.equal(final.state, 'failed');
  assert.ok(attempts > 1 && attempts < 12, 'Provider retries have a finite bounded budget');
  assert.equal(final.attempts, attempts);
  clock += 24 * 60 * 60 * 1000;
  await push.dispatch();
  assert.equal(final.attempts, attempts, 'A terminal failure cannot become a fresh send');
});

test('transport timeout retries within a finite budget without revoking a valid browser binding', async () => {
  let attempts = 0;
  const push = createWebPushService({
    db: env.db, configuration, loadUser, canDeliver: async () => true, clock: () => clock, timeoutMs: 20, maxAttempts: 2,
    transport: () => { attempts++; return new Promise(() => {}); },
  });
  const binding = await subscribe(push), row = await notice();
  await push.dispatch();
  const pending = await pushSql('SELECT state,available_at,last_error FROM push_outbox WHERE notification_id=?').get(row.id);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.last_error, 'timeout');
  assert.equal(attempts, 1);
  clock = new Date(pending.available_at).getTime() + 1;
  await push.dispatch();
  const terminal = await pushSql('SELECT state,attempts FROM push_outbox WHERE notification_id=?').get(row.id);
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.attempts, 2);
  assert.equal(attempts, 2);
  assert.equal((await active(push, users.get(3), binding)).active, true, 'A stalled request is not evidence of a dead subscription');
});

test('a throwing access checker is retried and can recover without sending before authorization succeeds', async () => {
  let checks = 0, notification;
  const push = service({ canDeliver: async (fresh, row) => {
    checks++;
    assert.equal(fresh.id, users.get(3).id);
    assert.equal(row.id, notification.id, 'The access checker receives the notification ID rather than a device binding');
    if (checks === 1) throw new Error('Isolated temporary access lookup failure');
    return true;
  } });
  await subscribe(push);
  notification = await notice();
  await push.dispatch();
  assert.equal(calls.length, 0);
  const pending = await pushSql('SELECT state,available_at FROM push_outbox WHERE notification_id=?').get(notification.id);
  assert.equal(pending.state, 'pending');
  clock = new Date(pending.available_at).getTime() + 1;
  await push.dispatch();
  assert.equal(checks, 2);
  assert.equal(calls.length, 1);
  assert.equal((await pushSql('SELECT state FROM push_outbox WHERE notification_id=?').get(notification.id)).state, 'sent');
});

test('dispatch removes old terminal delivery receipts while preserving recent jobs and unread inbox history', async () => {
  const push = service();
  await subscribe(push);
  const old = await notice(), recent = await notice(), pending = await notice();
  await pushSql("UPDATE push_outbox SET state='sent',completed_at=? WHERE notification_id=?").run(new Date(clock - 8 * 86400000).toISOString(), old.id);
  await pushSql("UPDATE push_outbox SET state='failed',completed_at=? WHERE notification_id=?").run(new Date(clock - 6 * 86400000).toISOString(), recent.id);
  await push.dispatch();
  assert.equal(await pushSql('SELECT id FROM push_outbox WHERE notification_id=?').get(old.id), undefined);
  assert.equal((await pushSql('SELECT state FROM push_outbox WHERE notification_id=?').get(recent.id)).state, 'failed');
  assert.equal((await pushSql('SELECT state FROM push_outbox WHERE notification_id=?').get(pending.id)).state, 'sent');
  assert.equal(calls.length, 1);
  assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(old.id)).read, 0, 'Delivery housekeeping never deletes unread inbox history');
});

test('forum publication respects programme preferences and notice ownership while answer acceptance is idempotent', async t => {
  // The real application runs only against this test schema and injected auth
  // and storage. Explicitly disabling Push prevents ambient keys from ever
  // contacting a provider while the real notification routes are exercised.
  const app = await createApp({ db: env.db, auth: env.auth, storage: env.storage, webPush: { configuration: { enabled: false } } });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    app.locals.endStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.locals.close();
  });
  await once(server, 'listening');
  assert.equal(app.locals.push.configured, false);
  const origin = 'http://127.0.0.1:' + server.address().port, cookies = {};
  async function request(path, { actor, method = 'GET', body } = {}) {
    const response = await fetch(origin + '/api' + path, {
      method, headers: { ...(cookies[actor] ? { cookie: cookies[actor] } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session='))?.split(';')[0] };
  }
  for (const actor of ['yassine', 'sara', 'nour', 'hamza']) {
    const result = await request('/login', { method: 'POST', body: { username: actor, password: 'Campus2026!' } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    cookies[actor] = result.cookie;
  }
  await env.db.prepare('UPDATE users SET preferences=? WHERE id=5').run('{"questions":false}');
  await env.db.prepare('UPDATE users SET current_semester=5 WHERE id=4').run();
  const created = await request('/campus/forum', { actor: 'yassine', method: 'POST', body: { title: 'Isolated programme question ' + randomUUID(), body: 'A scoped academic question for this disposable fixture.', module: 'Methodology' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const question = created.data.question, path = `/app/campus?tab=forum&question=${question.id}`;
  const questionNotices = await env.db.prepare("SELECT n.*,u.filiere_id AS recipient_filiere FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.type='questions' AND n.path=? ORDER BY n.user_id").all(path);
  assert.ok(questionNotices.some(row => row.user_id === 4), 'A programme question reaches a subscribed-category student in another academic year');
  assert.ok(questionNotices.every(row => row.faculty_id === 'flaa' && row.recipient_filiere === 'french_studies'));
  assert.ok(questionNotices.every(row => ![3, 5, 8, 9].includes(row.user_id)), 'Exclude the author, muted category, other programme and other faculty');
  for (const row of questionNotices) assert.deepEqual(row.push_context, { kind: 'forum-question', questionId: question.id, actorId: 3 });
  const owned = questionNotices.find(row => row.user_id === 4);
  const ownGet = await request('/notifications/' + owned.id, { actor: 'sara' });
  assert.equal(ownGet.status, 200, JSON.stringify(ownGet.data));
  assert.equal(ownGet.data.notification.id, owned.id);
  assert.equal(ownGet.data.notification.target_available, true);
  assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(owned.id)).read, 0, 'Fetching a Push destination does not itself read the notice');
  for (const actor of ['yassine', 'nour', 'hamza']) assert.equal((await request('/notifications/' + owned.id, { actor })).status, 404);
  assert.equal((await request('/notifications/' + owned.id)).status, 401);

  const answered = await request(`/campus/forum/${question.id}/answers`, { actor: 'sara', method: 'POST', body: { body: 'A scoped academic response.' } });
  assert.equal(answered.status, 201, JSON.stringify(answered.data));
  const answer = answered.data.answer;
  const answerNotices = await env.db.prepare("SELECT * FROM notifications WHERE push_context->>'kind'='forum-answer' AND push_context->>'questionId'=?").all(String(question.id));
  assert.equal(answerNotices.length, 1);
  assert.equal(answerNotices[0].user_id, 3);
  assert.deepEqual(answerNotices[0].push_context, { kind: 'forum-answer', questionId: question.id, answerId: answer.id, actorId: 4 });
  for (let repetition = 0; repetition < 2; repetition++) {
    const accepted = await request(`/campus/forum/${question.id}/accept`, { actor: 'yassine', method: 'POST', body: { answer_id: answer.id } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  }
  const acceptanceNotices = await env.db.prepare("SELECT * FROM notifications WHERE push_context->>'kind'='forum-accepted' AND push_context->>'questionId'=?").all(String(question.id));
  assert.equal(acceptanceNotices.length, 1, 'Repeating the unchanged accepted answer does not duplicate its notice');
  assert.equal(acceptanceNotices[0].user_id, 4);
  assert.deepEqual(acceptanceNotices[0].push_context, { kind: 'forum-accepted', questionId: question.id, answerId: answer.id, actorId: 3 });
  assert.equal((await pushSql('SELECT COUNT(*) AS n FROM push_outbox').get()).n, 0, 'The application integration creates no provider delivery without device subscriptions');
});
