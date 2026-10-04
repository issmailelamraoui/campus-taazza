import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { createClientId } from '../src/client-id.js';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('client identifiers use the native UUID method with its crypto receiver', () => {
  const expected = '12345678-1234-4234-8234-123456789abc';
  const random = {
    randomUUID() { assert.equal(this, random); return expected; },
    getRandomValues() { throw new Error('Native UUID should take precedence.'); },
  };
  assert.equal(createClientId(random), expected);
});

test('LAN fallback produces independent UUID v4 keys accepted by the message contract', () => {
  const random = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
  const ids = Array.from({ length: 1000 }, () => createClientId(random));
  for (const id of ids) assert.match(id, uuidV4);
  assert.equal(new Set(ids).size, ids.length);
});

test('UUID version, variant and zero-padding remain valid for zero-valued entropy bytes', () => {
  const random = { getRandomValues: bytes => bytes.fill(0) };
  assert.equal(createClientId(random), '00000000-0000-4000-8000-000000000000');
});
