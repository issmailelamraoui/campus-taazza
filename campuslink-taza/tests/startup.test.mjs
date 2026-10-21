import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeWithRetry } from '../server/startup.js';
import { schemaReadinessDiagnostic } from '../server/schema-readiness.js';

const unavailable = () => Object.assign(new Error('private provider diagnostics'), { code: 'DATABASE_UNAVAILABLE' });

test('a healthy startup returns immediately without waiting or logging', async () => {
  const app = {};
  assert.equal(await initializeWithRetry(async () => app, {
    wait: () => assert.fail('Healthy startup must not wait'),
    log: () => assert.fail('Healthy startup must not log a retry'),
  }), app);
});

test('temporary database failures recover with bounded waits and sanitized logs', async () => {
  let attempts = 0;
  const waits = [], logs = [], app = {};
  const result = await initializeWithRetry(async () => {
    if (++attempts < 3) throw unavailable();
    return app;
  }, { wait: async delay => waits.push(delay), log: message => logs.push(message) });
  assert.equal(result, app);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /2\/3/);
  assert.match(logs[1], /3\/3/);
  assert.ok(logs.every(message => !message.includes('private')));
});

test('persistent database failures stop after three attempts and preserve the failure', async () => {
  let attempts = 0;
  const error = unavailable(), waits = [];
  await assert.rejects(initializeWithRetry(async () => {
    attempts++;
    throw error;
  }, { wait: async delay => waits.push(delay), log() {} }), failure => failure === error);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
  const diagnostic = schemaReadinessDiagnostic(error);
  assert.match(diagnostic, /PostgreSQL connection.*unavailable/);
  assert.ok(!diagnostic.includes(error.message));
});

test('configuration, schema and unexpected errors fail immediately without retrying', async () => {
  for (const code of ['AUTH_CONFIGURATION', 'SCHEMA_MIGRATIONS_PENDING', 'MIGRATION_CHECKSUM_MISMATCH', 'DATABASE_SCHEMA_INCOMPLETE', undefined]) {
    let attempts = 0;
    const error = Object.assign(new Error('private configuration value'), { code });
    await assert.rejects(initializeWithRetry(async () => { attempts++; throw error; }, {
      wait: () => assert.fail('Permanent failure must not wait'),
      log: () => assert.fail('Permanent failure must not retry'),
    }), failure => failure === error);
    assert.equal(attempts, 1);
    assert.ok(!schemaReadinessDiagnostic(error).includes(error.message));
  }
  assert.match(schemaReadinessDiagnostic({ code: 'AUTH_CONFIGURATION' }), /NEON_AUTH_BASE_URL.*NEON_AUTH_JWKS_URL/);
});
