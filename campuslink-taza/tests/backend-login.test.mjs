import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import {createTestEnvironment} from './backend-helpers.mjs';
import {randomUUID} from 'node:crypto';
const integration=process.env.CAMPUS_TEST_DATABASE_URL?test:test.skip;

// Exercise the real HTTP login route without touching provider identities.
async function loginFixture(t) {
  const env=await createTestEnvironment({demo:false});
  t.after(()=>env.close());
  const profile=await env.db.prepare("INSERT INTO users(username,name,email,auth_user_id,role,account_status,preferences,language) VALUES('login-fixture','Test student','student@example.test',?,'student','approved','{}','fr') RETURNING *").get(randomUUID());
  const state = { databaseFailure: false, providerFailure: false, invalidPassword: false, signIns: 0 };
  const unavailable = () => Object.assign(new Error('La base de données est temporairement indisponible. Réessayez.'), { status: 503, code: 'DATABASE_UNAVAILABLE' });
  const db = {
    ...env.db,
    prepare(sql) {
      const query=env.db.prepare(sql);
      if(!sql.includes('LOWER(username)'))return query;
      return {...query,async get(...values){if(state.databaseFailure)throw unavailable();return query.get(...values);}};
    },
  };
  const auth = {
    async authenticate() { return null; },
    async signIn() {
      state.signIns++;
      if (state.providerFailure) throw Object.assign(new Error('Le service de connexion est indisponible. Réessayez.'), { status: 503 });
      if (state.invalidPassword) throw Object.assign(new Error('Nom d’utilisateur ou mot de passe incorrect.'), { status: 401 });
      return { user: profile };
    },
  };
  const app = await createApp({ db, auth, storage: { close() {} }, seed: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));await app.locals.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function login() {
    const response = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: profile.username, password: 'Fixture-password-2026' }) });
    return { status: response.status, data: await response.json() };
  }
  return { state, login };
}

integration('database outages do not exhaust login attempts and login recovers afterwards', async t => {
  const { state, login } = await loginFixture(t);
  state.databaseFailure = true;
  for (let attempt = 0; attempt < 14; attempt++) {
    const result = await login();
    assert.equal(result.status, 503);
    assert.match(result.data.error, /base de données.*indisponible/);
  }
  assert.equal(state.signIns, 0, 'An unavailable profile query must never reach the identity provider.');
  state.databaseFailure = false;
  const recovered = await login();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.user.username, 'login-fixture');
  assert.deepEqual(recovered.data.user.preferences, {});
});

integration('identity-provider outages do not lock a valid account out of login', async t => {
  const { state, login } = await loginFixture(t);
  state.providerFailure = true;
  for (let attempt = 0; attempt < 14; attempt++) assert.equal((await login()).status, 503);
  state.providerFailure = false;
  assert.equal((await login()).status, 200);
});

integration('incorrect credentials still reach the existing login attempt limit', async t => {
  const { state, login } = await loginFixture(t);
  state.invalidPassword = true;
  for (let attempt = 0; attempt < 12; attempt++) assert.equal((await login()).status, 401);
  assert.equal((await login()).status, 429);
  assert.equal(state.signIns, 12, 'A rate-limited request must not call the identity provider again.');
});
