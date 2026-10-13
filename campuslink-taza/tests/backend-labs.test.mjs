import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTestApp } from './backend-helpers.mjs';
const integration = process.env.CAMPUS_TEST_DATABASE_URL ? test : test.skip;
let env, server, origin;
const cookies = {};
const source = 'export function moyenne(valeurs) { let total = 0; for (const valeur of valeurs) { total += valeur; } return valeurs.length ? total / valeurs.length : 0; }';
async function request(path, body, cookie = cookies.yassine) {
  const response = await fetch(origin + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session='))?.split(';')[0] };
}
before(async () => {
  // Unlike historical helpers, this suite never falls back to a live DATABASE_URL.
  if (!process.env.CAMPUS_TEST_DATABASE_URL) return;
  env = await createTestApp(); server = env.app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['yassine', 'sara']) { const result = await request('/login', { username: name, password: 'Campus2026!' }, null); assert.equal(result.status, 200); cookies[name] = result.cookie; }
});
after(async () => { if (!env) return; env.app.locals.endStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await env.close(); });
const create = async voluntaryXp => { const result = await request('/labs', { language: 'javascript', voluntaryXp }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.session; };
const advance = session => env.db.prepare('UPDATE labs_sessions SET created_at=?,last_checked_at=NULL WHERE id=?').run(new Date(Date.now() - 100000).toISOString(), session.id);

integration('parser sessions are private and real syntax diagnostics persist without executing programs', async () => {
  const session = await create(false);
  assert.equal((await request('/labs/' + session.id, undefined, cookies.sara)).status, 404);
  assert.equal((await request('/labs/' + session.id + '/check', { source: 'const x = ;' }, cookies.sara)).status, 404);
  const checked = await request('/labs/' + session.id + '/check', { source: 'globalThis.labsExecuted=true; while(true){}' });
  assert.equal(checked.status, 200); assert.equal(checked.data.session.result.status, 'valid_syntax'); assert.equal(globalThis.labsExecuted, undefined);
  assert.equal((await request('/labs')).data.executionAvailable, false);
  const complete = await request('/labs/' + session.id + '/complete', {}); assert.equal(complete.data.session.rewardedPoints, 0);
});
integration('distinct syntax errors reduce only remaining potential; retry deduplicates penalties and final reward', async () => {
  await env.db.prepare("INSERT INTO xp_events(user_id,category,event_key,points,created_at) VALUES(3,'contribution','labs-prior-account-xp',25,?)").run(new Date().toISOString());
  const session = await create(true);
  const path = '/labs/' + session.id;
  const bad = await request(path + '/check', { source: 'const x = ;' }); assert.equal(bad.data.session.potential, 8);
  await advance(session);
  const repeated = await request(path + '/check', { source: 'const x = ;' }); assert.equal(repeated.data.session.potential, 8);
  assert.equal((await request(path + '/check', { source })).status, 429);
  await advance(session);
  const correct = await request(path + '/check', { source }); assert.equal(correct.data.session.result.status, 'valid_syntax'); assert.equal(correct.data.session.potential, 8);
  const saved = await request(path + '/complete', {}); assert.equal(saved.data.session.rewardedPoints, 8, JSON.stringify(saved.data));
  const retry = await request(path + '/complete', {}); assert.equal(retry.data.session.rewardedPoints, 8);
  assert.equal((await env.db.prepare("SELECT COUNT(*)::integer AS count FROM xp_events WHERE user_id=3 AND event_key=?").get('labs:' + session.id)).count, 1);
  assert.equal((await env.db.prepare("SELECT points FROM xp_events WHERE event_key='labs-prior-account-xp'").get()).points, 25);
  assert.equal((await request(path + '/check', { source })).status, 409);
});
integration('similar programs cannot be rewarded again and daily practice caps apply across sessions', async () => {
  const duplicate = await create(true); await advance(duplicate);
  await request('/labs/' + duplicate.id + '/check', { source: 'const x = ;' }); await advance(duplicate);
  await request('/labs/' + duplicate.id + '/check', { source: source.replaceAll('total', 'result').replaceAll('0', '10') });
  const completed = await request('/labs/' + duplicate.id + '/complete', {});
  assert.equal(completed.data.reason, 'similar_program_already_rewarded'); assert.equal(completed.data.session.rewardedPoints, 0);
  const newProgram = source.replace('total += valeur;', 'if (valeur > 0) { total += valeur * valeur; }');
  const limited = await create(true); await advance(limited);
  await request('/labs/' + limited.id + '/check', { source: 'const x = ;' }); await advance(limited);
  await request('/labs/' + limited.id + '/check', { source: newProgram });
  const reward = await request('/labs/' + limited.id + '/complete', {}); assert.equal(reward.data.session.rewardedPoints, 2);
  assert.equal((await env.db.prepare("SELECT SUM(points)::integer AS points FROM xp_events WHERE user_id=3 AND category='practice'").get()).points, 10);
});
integration('language tampering, browser XP totals and unsustained trivial sessions cannot earn rewards', async () => {
  assert.equal((await request('/labs', { language: 'ruby', voluntaryXp: true })).status, 400);
  const session = await create(true);
  await request('/labs/' + session.id + '/check', { source: 'let x = 1', points: 999999, potential: 999999 });
  const result = await request('/labs/' + session.id + '/complete', { points: 999999 }); assert.equal(result.data.session.rewardedPoints, 0);
});

integration('Python, C and C++ sessions validate with real parsers, persist privately and never enable execution or code XP', async () => {
  const available = await request('/labs');
  assert.equal(available.status, 200);
  assert.deepEqual(available.data.languages, ['javascript', 'json', 'python', 'c', 'cpp']);
  assert.equal(available.data.executionAvailable, false);
  const programs = {
    python: 'def moyenne(valeurs):\n    total = 0\n    for valeur in valeurs:\n        total += valeur\n    return total / len(valeurs) if valeurs else 0\n',
    c: '#include <stdio.h>\nint main(void) { int valeur = 42; printf("%d", valeur); return 0; }\n',
    cpp: '#include <vector>\nint main() { std::vector<int> valeurs{1, 2}; return valeurs[0]; }\n',
  };
  for (const [language, program] of Object.entries(programs)) {
    const created = await request('/labs', { language, voluntaryXp: true });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const session = created.data.session;
    assert.equal(session.voluntaryXp, false);
    assert.equal(session.potential, 0);
    assert.equal((await request('/labs/' + session.id, undefined, cookies.sara)).status, 404);
    const checked = await request('/labs/' + session.id + '/check', { source: program, points: 10000 });
    assert.equal(checked.status, 200, JSON.stringify(checked.data));
    assert.equal(checked.data.session.result.status, 'valid_syntax');
    assert.equal(checked.data.session.result.eligiblePractice, false);
    const persisted = await request('/labs/' + session.id);
    assert.equal(persisted.data.session.source, program);
    await advance(session);
    const badSource = language === 'python' ? 'valeur = 1\nif valeur > 0\n    print(valeur)\n' : 'int main() {\n int valeur = ;\n return valeur;\n}\n';
    const invalid = await request('/labs/' + session.id + '/check', { source: badSource });
    assert.equal(invalid.status, 200);
    assert.equal(invalid.data.session.result.status, 'syntax_error');
    assert.ok(invalid.data.session.result.diagnostics[0].line >= 2);
    assert.equal(invalid.data.session.potential, 0);
    const complete = await request('/labs/' + session.id + '/complete', { points: 10000 });
    assert.equal(complete.data.reason, 'practice_not_enabled');
    assert.equal(complete.data.session.rewardedPoints, 0);
    assert.equal((await request('/labs/' + session.id + '/check', { source: program })).status, 409);
    const xp = await env.db.prepare('SELECT COUNT(*)::integer AS count FROM xp_events WHERE event_key=?').get('labs:' + session.id);
    assert.equal(xp.count, 0);
  }
});
