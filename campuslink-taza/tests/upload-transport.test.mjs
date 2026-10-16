import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkUploadFile, uploadInChunks } from '../src/lib/upload-transport.js';
import { UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_THRESHOLD } from '../shared/upload-transport.js';

const abortError = () => new DOMException('Fixture upload cancelled.', 'AbortError');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function uploadBody(size = UPLOAD_CHUNK_THRESHOLD + 17) {
  const file = new File([new Uint8Array(size)], 'Cours — probabilités.pdf', { type: 'application/pdf' });
  const body = new FormData(); body.set('file', file);
  body.set('module', 'Probabilités et Statistiques'); body.set('relative_path', 'S1/Éléments/' + file.name);
  return { file, body };
}
function transportOptions(controller = new AbortController(), generation = 1) {
  return { signal: controller.signal, headers: new Headers({ 'X-Upload-Trace': 'private-fixture' }), generation };
}

// Model the transport protocol only. The companion backend suite uses real
// protected API handlers, PostgreSQL and a 4.5 MB gateway with injected storage.
function mockUploadServer({ partFailure, loseCompleteResponse = false, terminalFailure = false, blockParts } = {}) {
  const calls = [], sessions = new Map();
  let active = 0, maximum = 0, nextId = 1, completions = 0;
  const attempts = new Map();
  const snapshot = session => ({ id: session.id, state: session.state, chunk_bytes: UPLOAD_CHUNK_BYTES, parts: [...session.parts.keys()],
    ...(session.response_status ? { response_status: session.response_status, response: session.response } : {}) });
  const fetch = async (url, options = {}) => {
    if (options.signal?.aborted) throw abortError();
    const method = options.method || 'GET'; calls.push({ url, method, options });
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers.get('X-Upload-Trace'), 'private-fixture');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === '/api/upload-sessions' && method === 'POST') {
      assert.equal(options.headers.get('Content-Type'), 'application/json');
      const metadata = JSON.parse(options.body), id = `session-${nextId++}`;
      const session = { id, state: 'uploading', metadata, parts: new Map() }; sessions.set(id, session);
      return Response.json(snapshot(session), { status: 201 });
    }
    const match = /^\/api\/upload-sessions\/([^/]+)(?:\/parts\/(\d+)|(\/complete))?$/.exec(url);
    assert.ok(match, 'Unexpected transport URL: ' + url);
    const session = sessions.get(match[1]); assert.ok(session, 'The session must be created before pieces are sent.');
    if (match[2] && method === 'PUT') {
      assert.equal(options.headers.get('Content-Type'), 'application/octet-stream');
      assert.ok(options.body instanceof Blob); assert.ok(options.body.size <= UPLOAD_CHUNK_BYTES);
      const part = Number(match[2]), attemptKey = `${session.id}:${part}`, attempt = (attempts.get(attemptKey) || 0) + 1;
      attempts.set(attemptKey, attempt); active++; maximum = Math.max(maximum, active);
      try {
        await tick();
        if (blockParts) await blockParts({ part, signal: options.signal });
        const status = partFailure?.({ part, attempt, session });
        if (status) return Response.json({ error: 'Synthetic interrupted piece.' }, { status });
        session.parts.set(part, options.body.size);
        return Response.json({ ok: true });
      } finally { active--; }
    }
    if (match[3] && method === 'POST') {
      completions++;
      assert.equal(session.parts.size, Math.ceil(session.metadata.file.size / UPLOAD_CHUNK_BYTES));
      const failed = terminalFailure && completions === 1;
      session.state = failed ? 'failed' : 'complete'; session.response_status = failed ? 502 : 201;
      session.response = failed ? { error: 'Temporary destination storage failure.' } : { resource: { id: 42, filename: session.metadata.file.name } };
      if (loseCompleteResponse && completions === 1) throw new TypeError('Synthetic lost response after publication.');
      return Response.json(session.response, { status: session.response_status });
    }
    assert.equal(method, 'GET');
    return Response.json(snapshot(session));
  };
  return { fetch, calls, sessions, attempts, get maximum() { return maximum; }, get active() { return active; }, get completions() { return completions; } };
}
async function withFetch(server, action) {
  const original = globalThis.fetch; globalThis.fetch = server.fetch;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test('only supported large multipart file uploads use the chunk transport', () => {
  const small = uploadBody(UPLOAD_CHUNK_THRESHOLD), large = uploadBody(UPLOAD_CHUNK_THRESHOLD + 1);
  assert.equal(chunkUploadFile('/uploads', small.body, 'POST'), null);
  assert.equal(chunkUploadFile('/uploads', large.body, 'POST'), large.body.get('file'));
  assert.equal(chunkUploadFile('/profile', large.body, 'POST'), null);
  assert.equal(chunkUploadFile('/uploads', large.body, 'PATCH'), null);
  assert.equal(chunkUploadFile('/uploads', { file: large.file }, 'POST'), null);
  large.body.append('another_file', large.file);
  assert.equal(chunkUploadFile('/uploads', large.body, 'POST'), null);
});

test('files use exact 2 MiB pieces, at most two concurrent requests, original metadata and same-origin authorization', async () => {
  const { file, body } = uploadBody(UPLOAD_CHUNK_BYTES * 4 + 113), server = mockUploadServer();
  await withFetch(server, async () => {
    const result = await uploadInChunks('/uploads', body, transportOptions());
    assert.equal(result.status, 201); assert.equal((await result.json()).resource.filename, file.name);
    assert.equal(server.maximum, 2); assert.equal(server.active, 0);
    const parts = server.calls.filter(call => call.method === 'PUT');
    assert.deepEqual(parts.map(call => call.options.body.size), [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 113]);
    const session = [...server.sessions.values()][0];
    assert.deepEqual(session.metadata.file, { name: file.name, type: file.type, size: file.size });
    assert.deepEqual(session.metadata.fields, [['module', 'Probabilités et Statistiques'], ['relative_path', 'S1/Éléments/' + file.name]]);
  });
});

test('a transient failed piece retries in place without restarting the file or duplicating publication', async () => {
  const { body } = uploadBody(), server = mockUploadServer({ partFailure: ({ part, attempt }) => part === 1 && attempt === 1 ? 503 : null });
  await withFetch(server, async () => {
    assert.equal((await uploadInChunks('/uploads', body, transportOptions())).status, 201);
    assert.equal(server.sessions.size, 1); assert.equal(server.completions, 1);
    assert.equal(server.attempts.get('session-1:1'), 2); assert.equal(server.attempts.get('session-1:2'), 1);
    assert.ok(server.maximum <= 2);
  });
});

test('a lost final response consults the durable receipt and a successful same-file retry never republishes', async () => {
  const { body } = uploadBody(), server = mockUploadServer({ loseCompleteResponse: true });
  await withFetch(server, async () => {
    const options = transportOptions(), first = await uploadInChunks('/uploads', body, options);
    assert.equal(first.status, 201); assert.equal((await first.json()).resource.id, 42);
    const creates = server.sessions.size, puts = server.calls.filter(call => call.method === 'PUT').length;
    assert.equal((await uploadInChunks('/uploads', body, options)).status, 201);
    assert.equal(server.sessions.size, creates); assert.equal(server.calls.filter(call => call.method === 'PUT').length, puts);
    assert.equal(server.completions, 1);
    assert.ok(server.calls.some(call => call.url === '/api/upload-sessions/session-1' && call.method === 'GET'));
  });
});

test('an explicit same-file retry resumes only missing pieces after an interrupted upload', async () => {
  let interrupted = false;
  const { body } = uploadBody(), server = mockUploadServer({ partFailure: ({ part }) => {
    if (part === 2 && !interrupted) { interrupted = true; return 400; }
    return null;
  } });
  await withFetch(server, async () => {
    const options = transportOptions();
    assert.equal((await uploadInChunks('/uploads', body, options)).status, 400);
    const interruptedSession = [...server.sessions.values()][0];
    assert.deepEqual([...interruptedSession.parts.keys()], [1]);
    assert.equal(server.completions, 0);
    assert.equal((await uploadInChunks('/uploads', body, options)).status, 201);
    assert.equal(server.sessions.size, 1); assert.equal(server.attempts.get('session-1:1'), 1);
    assert.equal(server.attempts.get('session-1:2'), 2); assert.equal(server.completions, 1);
  });
});

test('a terminal failed receipt permits a fresh explicit retry while completed receipts remain reusable', async () => {
  const { body } = uploadBody(), server = mockUploadServer({ terminalFailure: true });
  await withFetch(server, async () => {
    const options = transportOptions();
    const failed = await uploadInChunks('/uploads', body, options);
    assert.equal(failed.status, 502); assert.match((await failed.json()).error, /storage failure/);
    assert.equal(server.sessions.size, 1);
    const success = await uploadInChunks('/uploads', body, options);
    assert.equal(success.status, 201); assert.equal(server.sessions.size, 2); assert.equal(server.completions, 2);
    assert.equal((await uploadInChunks('/uploads', body, options)).status, 201);
    assert.equal(server.sessions.size, 2); assert.equal(server.completions, 2);
  });
});

test('session generation changes isolate a reused File from receipts belonging to a previous signed-in session', async () => {
  const { body } = uploadBody(), server = mockUploadServer();
  await withFetch(server, async () => {
    assert.equal((await uploadInChunks('/uploads', body, transportOptions(undefined, 1))).status, 201);
    assert.equal((await uploadInChunks('/uploads', body, transportOptions(undefined, 2))).status, 201);
    assert.equal(server.sessions.size, 2); assert.equal(server.completions, 2);
  });
});

test('AbortSignal cancels in-flight pieces without finalizing or starting more requests', async () => {
  const { body } = uploadBody(UPLOAD_CHUNK_BYTES * 3 + 19), controller = new AbortController();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const server = mockUploadServer({ blockParts: ({ signal }) => new Promise((resolve, reject) => {
    entered();
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  }) });
  await withFetch(server, async () => {
    const delivery = uploadInChunks('/uploads', body, transportOptions(controller));
    const cancelled = assert.rejects(delivery, error => error.name === 'AbortError');
    await started; controller.abort(); await cancelled; await tick();
    assert.equal(server.completions, 0); assert.equal(server.active, 0);
    assert.ok(server.calls.filter(call => call.method === 'PUT').length <= 2);
    assert.equal(server.sessions.size, 1);
  });
});

test('an already-aborted signal prevents creating a new upload session', async () => {
  const { body } = uploadBody(), controller = new AbortController(), server = mockUploadServer(); controller.abort();
  await withFetch(server, async () => {
    await assert.rejects(uploadInChunks('/uploads', body, transportOptions(controller)), error => error.name === 'AbortError');
    assert.equal(server.sessions.size, 0); assert.equal(server.completions, 0);
  });
});
