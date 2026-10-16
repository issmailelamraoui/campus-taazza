import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { readUploadPart } from '../server/upload-sessions.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('A private verified upload piece.');
const part = { size: bytes.length, sha256: sha256(bytes) };

test('private upload pieces preserve their exact bytes and release a completed stream', async () => {
  const body = Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]);
  const storage = { async get(key) { assert.equal(key, 'private/piece'); return { body }; } };
  assert.ok((await readUploadPart({ storage, key: 'private/piece', part })).equals(bytes));
  assert.equal(body.destroyed, true);
});

test('truncated, oversized and corrupt private pieces cannot pass integrity verification', async () => {
  for (const invalid of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('extra')]), Buffer.alloc(bytes.length)]) {
    const body = Readable.from([invalid]);
    await assert.rejects(readUploadPart({ storage: { async get() { return { body }; } }, key: 'private/piece', part }), error => error.status === 400);
    assert.equal(body.destroyed, true);
  }
});

test('a stalled private storage stream times out and is destroyed so its transaction can end', async () => {
  const body = new Readable({ read() {} });
  await assert.rejects(readUploadPart({ storage: { async get() { return { body }; } }, key: 'private/piece', part, timeoutMs: 15 }), error => error.status === 504);
  assert.equal(body.destroyed, true);
});

test('a stalled storage handshake times out and destroys a stream that arrives after its deadline', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; }), body = new Readable({ read() {} });
  await assert.rejects(readUploadPart({ storage: { get() { return waiting; } }, key: 'private/piece', part, timeoutMs: 15 }), error => error.status === 504);
  release({ body });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(body.destroyed, true);
});
