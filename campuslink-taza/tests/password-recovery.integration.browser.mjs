import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createTestEnvironment } from './backend-helpers.mjs';
import { createApp } from '../server/app.js';

// Run after npm run build, with CAMPUS_TEST_DATABASE_URL explicitly supplied
// by a launcher using the independent .env.oauth-test.local configuration.
// Browser requests reach the real Express API and a disposable PostgreSQL
// schema. Only the identity provider is doubled; no mail or remote identity
// mutations are performed. No Playwright request routes are mocked.
if (!process.env.CAMPUS_TEST_DATABASE_URL) throw new Error('An explicit isolated test database is required.');
const configured = new URL(process.env.CAMPUS_TEST_DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(configured.protocol));
if (process.env.DATABASE_URL) {
  const application = new URL(process.env.DATABASE_URL);
  assert.ok(configured.hostname !== application.hostname || configured.port !== application.port || configured.pathname !== application.pathname, 'The test database must differ from the application database.');
}
const origin = 'http://127.0.0.1:5186';
const original = 'Campus2026!', chosen = '87654321', otp = '123456', email = 'sara@usmba.ac.ma';
const failure = () => Object.assign(new Error('Synthetic code rejection'), { status: 400, code: 'PASSWORD_RECOVERY_INVALID' });
const env = await createTestEnvironment();
let app, server, browser;
try {
  const sara = await env.db.prepare("SELECT * FROM users WHERE username='sara'").get();
  assert.ok(sara && sara.account_status === 'approved' && sara.role === 'student');
  const authId = await env.auth.bindUser(sara.id, { email, password: original });
  const provider = { sent: [], checked: [], completed: [], codes: new Map() };
  env.auth.requestPasswordRecovery = async (_req, { email: address }) => {
    provider.sent.push(address); provider.codes.set(address, otp); return { success: true };
  };
  env.auth.checkPasswordRecoveryCode = async (_req, { email: address, code }) => {
    provider.checked.push({ email: address, code });
    if (provider.codes.get(address) !== code) throw failure();
    return { success: true };
  };
  env.auth.completePasswordRecovery = async (_req, { email: address, code, newPassword }) => {
    if (provider.codes.get(address) !== code) throw failure();
    const identity = env.auth.identities.get(authId);
    assert.equal(identity?.email, address);
    provider.completed.push({ email: address, code, newPassword });
    identity.password = newPassword; provider.codes.delete(address);
    // Leave provider sessions in memory intentionally. The real application's
    // durable cutoff must independently refuse the old opaque cookie.
    return { success: true };
  };
  env.auth.clearCookie = (_req, res) => res.clearCookie('campus_neon_test_session', { httpOnly: true, sameSite: 'lax', path: '/' });
  app = await createApp({ db: env.db, auth: env.auth, storage: env.storage, appOrigin: origin, googleOAuth: { enabled: false, domains: ['usmba.ac.ma'] } });
  server = app.listen(5186, '127.0.0.1'); await once(server, 'listening');
  async function request(path, { cookie, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(origin + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session='))?.split(';')[0] };
  }
  const login = password => request('/login', { body: { username: 'sara', password } });
  const old = await login(original); assert.equal(old.status, 200); assert.ok(old.cookie);
  const before = await env.db.prepare('SELECT * FROM users WHERE id=?').get(sara.id);
  const counts = await env.db.prepare('SELECT (SELECT count(*) FROM resources) AS resources,(SELECT count(*) FROM messages) AS messages').get();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', '"dark"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/login');
  await page.getByRole('button', { name: 'Mot de passe oublié ?', exact: true }).click();
  await expect(page).toHaveURL(origin + '/forgot-password');
  await page.locator('[name="recoveryEmail"]').fill(email);
  await page.locator('.password-recovery-form').getByRole('button', { name: 'Recevoir le code', exact: true }).click();
  await expect(page.locator('[name="recoveryCode"]')).toBeVisible(); assert.deepEqual(provider.sent, [email]);
  await mkdir('test-results/password-recovery', { recursive: true });
  await page.screenshot({ path: 'test-results/password-recovery/real-api-390-code.png', fullPage: true });
  async function enter(code) {
    await page.locator('[name="recoveryCode"]').fill(code);
    await page.locator('[name="newPassword"]').fill(chosen);
    await page.locator('[name="confirmation"]').fill(chosen);
  }
  await enter('654321');
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/password-recovery/complete' && response.request().method() === 'POST');
  await page.locator('.password-recovery-form').getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click();
  assert.equal((await rejected).status(), 400); await expect(page.locator('.password-recovery-form').getByRole('alert')).toContainText('incorrect ou a expiré');
  const afterInvalid = await env.db.prepare('SELECT * FROM users WHERE id=?').get(sara.id);
  assert.equal(afterInvalid.auth_revoked_at, before.auth_revoked_at); assert.equal(afterInvalid.session_version, before.session_version);
  assert.equal(provider.completed.length, 0); assert.equal(Number((await env.db.prepare('SELECT count(*) AS n FROM password_reset_operations').get()).n), 0);
  assert.equal((await request('/session', { cookie: old.cookie })).data.user.id, sara.id);
  console.log('PASS real API rejects incorrect OTP without changing password, cutoff or reset operations');
  await enter(otp);
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/password-recovery/complete' && response.request().method() === 'POST');
  await page.locator('.password-recovery-form').getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click();
  assert.equal((await completed).status(), 200); await expect(page.locator('.password-recovery-done')).toBeVisible();
  assert.deepEqual(provider.completed, [{ email, code: otp, newPassword: chosen }]); assert.equal(provider.checked.length, 2);
  const after = await env.db.prepare('SELECT * FROM users WHERE id=?').get(sara.id);
  for (const field of ['id', 'name', 'username', 'email', 'role', 'account_status', 'faculty_id', 'filiere_id', 'current_semester', 'preferences', 'auth_user_id']) assert.deepEqual(after[field], before[field], `Preserve ${field}`);
  assert.equal(after.password_change_required, false); assert.equal(after.password_reset_operation_id, null); assert.equal(after.session_version, before.session_version + 1); assert.ok(after.auth_revoked_at);
  const operations = await env.db.prepare('SELECT * FROM password_reset_operations WHERE target_user_id=?').all(sara.id);
  assert.equal(operations.length, 1); assert.equal(operations[0].status, 'completed');
  assert.equal(JSON.stringify(operations).includes(chosen), false); assert.equal(JSON.stringify(operations).includes(otp), false);
  assert.deepEqual(await env.db.prepare('SELECT (SELECT count(*) FROM resources) AS resources,(SELECT count(*) FROM messages) AS messages').get(), counts);
  assert.equal((await request('/session', { cookie: old.cookie })).data.user, null); assert.equal((await request('/bootstrap', { cookie: old.cookie })).status, 401);
  assert.equal((await login(original)).status, 401); assert.equal((await login(chosen)).status, 200);
  await page.screenshot({ path: 'test-results/password-recovery/real-api-390-success.png', fullPage: true });
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const secret of [email, otp, chosen]) assert.equal(storage.includes(secret), false);
  console.log('PASS real API completes eight-digit reset, records completion, preserves account/content and refuses old sessions/password');
  await page.locator('.password-recovery-done a').click(); await expect(page).toHaveURL(origin + '/login');
  await page.locator('#login-username').fill('sara'); await page.locator('#login-password').fill(chosen);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click(); await expect(page).toHaveURL(origin + '/app');
  assert.deepEqual(errors, []); console.log('PASS browser signs in through the real API with the new password and reaches campus');
} finally {
  await browser?.close();
  if (server) { app?.locals.endStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await app?.locals.close(); await env.close();
}
