// Add a real WASM memory ceiling before instantiation. A Worker deadline alone
// cannot stop memory.grow from exhausting a phone's available memory.
const read = (bytes, cursor) => {
  let value = 0, shift = 0, next;
  do {
    if (cursor.pos >= bytes.length || shift > 28) throw new Error('Invalid WebAssembly integer.');
    next = bytes[cursor.pos++]; value += (next & 127) * 2 ** shift; shift += 7;
  } while (next & 128);
  return value;
};
const encode = value => {
  const bytes = [];
  do { let next = value % 128; value = Math.floor(value / 128); if (value) next |= 128; bytes.push(next); } while (value);
  return bytes;
};
export function boundWasmMemory(input, maximumMb = 128) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maximum = maximumMb * 16;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109) throw new Error('Invalid WebAssembly module.');
  const chunks = [bytes.subarray(0, 8)];
  const cursor = { pos: 8 };
  let hasMemory = false;
  while (cursor.pos < bytes.length) {
    const id = bytes[cursor.pos++], size = read(bytes, cursor), start = cursor.pos, end = start + size;
    if (end > bytes.length) throw new Error('Invalid WebAssembly section.');
    if (id === 5) {
      const count = read(bytes, cursor), content = [...encode(count)];
      for (let index = 0; index < count; index++) {
        const flags = read(bytes, cursor);
        if (flags > 1) throw new Error('Shared or 64-bit memory is unavailable in Campus Labs.');
        const initial = read(bytes, cursor), previousMax = flags & 1 ? read(bytes, cursor) : maximum;
        if (initial > maximum) throw new Error(`This program needs more than ${maximumMb} MB of memory.`);
        content.push(1, ...encode(initial), ...encode(Math.min(previousMax, maximum)));
      }
      if (cursor.pos !== end) throw new Error('Invalid WebAssembly memory section.');
      chunks.push(Uint8Array.from([id, ...encode(content.length), ...content])); hasMemory = count > 0;
    } else chunks.push(Uint8Array.from([id, ...encode(size)]), bytes.subarray(start, end));
    cursor.pos = end;
  }
  if (!hasMemory) throw new Error('An isolated program memory is required.');
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
