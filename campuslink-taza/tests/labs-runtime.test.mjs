import test from 'node:test';
import assert from 'node:assert/strict';
import { boundWasmMemory } from '../src/lib/labs-wasm.js';

// A one-page WASM memory, exported as "memory", with no previous maximum.
const memoryModule = Uint8Array.from([0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0]);
test('WASM program memory has a hard ceiling enforced inside the engine', async () => {
  const { instance } = await WebAssembly.instantiate(boundWasmMemory(memoryModule, 1));
  assert.equal(instance.exports.memory.buffer.byteLength, 65536);
  assert.equal(instance.exports.memory.grow(15), 1);
  assert.throws(() => instance.exports.memory.grow(1), RangeError);
});
test('WASM memory limiter rejects malformed modules and unsupported memory types', () => {
  assert.throws(() => boundWasmMemory(new Uint8Array(1)));
  assert.throws(() => boundWasmMemory(Uint8Array.from([0,97,115,109,1,0,0,0,5,4,1,0,128,1]), 1), /more than/);
  assert.throws(() => boundWasmMemory(Uint8Array.from([0,97,115,109,1,0,0,0,5,4,1,3,1,2])), /Shared/);
  assert.throws(() => boundWasmMemory(Uint8Array.from([0,97,115,109,1,0,0,0])), /isolated/);
});
