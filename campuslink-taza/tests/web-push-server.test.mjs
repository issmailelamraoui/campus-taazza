import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { installWebPush, validatePushSubscription, webPushConfiguration } from '../server/push.js';

function keypair() {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  return { publicKey: curve.getPublicKey().toString('base64url'), privateKey: Buffer.concat([Buffer.alloc(32), curve.getPrivateKey()]).subarray(-32).toString('base64url') };
}
const vapid = keypair();
const subscription = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + 'isolated-test-token-'.repeat(8), expirationTime: null, keys: { p256dh: keypair().publicKey, auth: randomBytes(16).toString('base64url') } });

test('Web Push configuration requires a complete valid keypair and subject without reading ambient configuration', () => {
  assert.equal(webPushConfiguration({ publicKey: '', privateKey: '', subject: '' }).enabled, false);
  assert.equal(webPushConfiguration({ publicKey: vapid.publicKey, privateKey: '', subject: '' }).enabled, false);
  const configured = webPushConfiguration({ ...vapid, subject: 'mailto:push-test@example.invalid' });
  assert.equal(configured.enabled, true);
  assert.equal(configured.publicKey, vapid.publicKey);
  assert.equal(configured.privateKey, vapid.privateKey);
  assert.equal(configured.subject, 'mailto:push-test@example.invalid');
  assert.equal(webPushConfiguration({ publicKey: vapid.publicKey, privateKey: keypair().privateKey, subject: 'mailto:push-test@example.invalid' }).enabled, false, 'An unrelated private key cannot enable delivery');
  assert.equal(webPushConfiguration({ ...vapid, subject: 'javascript:invalid' }).enabled, false);
});

test('a normal browser subscription with a valid P-256 public key is accepted', () => {
  const value = subscription(), validated = validatePushSubscription(value);
  assert.equal(validated.endpoint, value.endpoint);
  assert.deepEqual(validated.keys, value.keys);
});

test('Firefox and Apple endpoints are accepted without allowing arbitrary provider subdomains', () => {
  const value = subscription();
  for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/isolated-browser-token', 'https://web.push.apple.com/isolated.browser-token']) {
    assert.equal(validatePushSubscription({ ...value, endpoint }).endpoint, endpoint);
  }
  for (const endpoint of ['https://arbitrary.push.services.mozilla.com/wpush/v2/token', 'https://other.web.push.apple.com/token']) {
    assert.throws(() => validatePushSubscription({ ...value, endpoint }));
  }
});

test('subscription endpoints cannot target local services, arbitrary origins or disguised provider hosts', () => {
  const valid = subscription();
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/token',
    'https://127.0.0.1/fcm/send/token',
    'https://[::1]/fcm/send/token',
    'https://localhost/fcm/send/token',
    'https://169.254.169.254/latest/meta-data',
    'https://example.invalid/fcm/send/token',
    'https://fcm.googleapis.com.example.invalid/fcm/send/token',
    'https://fcm.googleapis.com@evil.invalid/fcm/send/token',
    'https://user:password@fcm.googleapis.com/fcm/send/token',
    'https://fcm.googleapis.com:8443/fcm/send/token',
    'https://fcm.googleapis.com/fcm/send/token#fragment',
    'file:///etc/passwd',
  ]) assert.throws(() => validatePushSubscription({ ...valid, endpoint }), undefined, endpoint);
});

test('malformed subscriptions and encryption keys fail validation before any delivery', () => {
  const valid = subscription();
  for (const value of [null, undefined, '', [], {}, { ...valid, endpoint: '' }, { ...valid, keys: null },
    { ...valid, keys: { ...valid.keys, p256dh: randomBytes(64).toString('base64url') } },
    { ...valid, keys: { ...valid.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') } },
    { ...valid, keys: { ...valid.keys, p256dh: 'invalid/key+characters' } },
    { ...valid, keys: { ...valid.keys, auth: randomBytes(15).toString('base64url') } },
    { ...valid, keys: { ...valid.keys, auth: randomBytes(17).toString('base64url') } },
    { ...valid, keys: { ...valid.keys, auth: { value: valid.keys.auth } } },
  ]) assert.throws(() => validatePushSubscription(value));
});

test('installed Push routes require authentication and an expected account while exposing only public configuration', async t => {
  let databaseTouches = 0;
  const app = express();
  app.use(express.json());
  installWebPush(app, {
    db: { schema: 'campuslink_push_unit', prepare() { databaseTouches++; throw new Error('Route authorization must finish before database access'); } },
    configuration: { ...vapid, subject: 'mailto:push-test@example.invalid' },
    requireFaculty(req, res, next) {
      if (req.get('x-isolated-account') !== '3') return res.status(401).json({ error: 'Test authentication required' });
      req.user = { id: 3, faculty_id: 'flaa', account_status: 'approved', session_version: 1 };
      next();
    },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const body = { expectedUserId: 3, deviceId: randomUUID(), bindingId: randomUUID(), subscription: subscription() };
  const routes = [['POST', '/api/push/subscriptions'], ['POST', '/api/push/subscriptions/status'], ['DELETE', '/api/push/subscriptions']];
  assert.equal((await fetch(origin + '/api/push/config')).status, 401);
  for (const [method, path] of routes) {
    const anonymous = await fetch(origin + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(anonymous.status, 401, method + ' ' + path);
    const headers = { 'content-type': 'application/json', 'x-isolated-account': '3' };
    const missingAccount = await fetch(origin + path, { method, headers, body: JSON.stringify({ ...body, expectedUserId: undefined }) });
    assert.equal(missingAccount.status, 400);
    const staleAccount = await fetch(origin + path, { method, headers, body: JSON.stringify({ ...body, expectedUserId: 4 }) });
    assert.equal(staleAccount.status, 409, 'A request captured before account switching cannot act on the new account');
  }
  const response = await fetch(origin + '/api/push/config', { headers: { 'x-isolated-account': '3' } });
  assert.equal(response.status, 200);
  const publicConfiguration = await response.json();
  assert.deepEqual(publicConfiguration, { enabled: true, publicKey: vapid.publicKey });
  assert.ok(!JSON.stringify(publicConfiguration).includes(vapid.privateKey));
  assert.equal(databaseTouches, 0);
});
