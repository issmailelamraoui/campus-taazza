import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createVercelHandler } from '../server/vercel-handler.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function listen(t, handler, beforeRequest = () => {}) {
  const server = createServer((req, res) => {
    beforeRequest(req);
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function inspectBackend() {
  const backend = express();
  backend.use(express.json());
  backend.use((req, res) => res.json({
    method: req.method,
    url: req.url,
    path: req.path,
    query: req.query,
    body: req.body,
  }));
  return backend;
}

test('initialization is lazy and a successful backend is cached', async t => {
  let calls = 0;
  const backend = inspectBackend();
  const handler = createVercelHandler(() => { calls++; return backend; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(handler.get('trust proxy'), 1);

  const origin = await listen(t, handler);
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).path, '/api/health');
  }
  assert.equal(calls, 1);
  assert.equal(backend.get('trust proxy'), 1);
});

test('concurrent requests share one pending initialization', async t => {
  const release = deferred();
  const allReceived = deferred();
  let calls = 0;
  let received = 0;
  const handler = createVercelHandler(async () => {
    calls++;
    await release.promise;
    return inspectBackend();
  });
  const origin = await listen(t, handler, () => {
    if (++received === 6) allReceived.resolve();
  });
  const requests = Array.from({ length: 6 }, () => fetch(`${origin}/api/backend?__path=health`));
  await allReceived.promise;
  assert.equal(calls, 1);
  release.resolve();
  const responses = await Promise.all(requests);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).path, '/api/health');
  }
  assert.equal(calls, 1);
});

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'asynchronous' : 'synchronous'} startup failures return sanitized JSON and retry`, async t => {
    let calls = 0;
    const handler = createVercelHandler(() => {
      if (++calls === 1) {
        const error = new Error('Private startup diagnostics must remain private.');
        if (asynchronous) return Promise.reject(error);
        throw error;
      }
      return inspectBackend();
    });
    const origin = await listen(t, handler);
    const failed = await fetch(`${origin}/api/backend?__path=health`);
    assert.equal(failed.status, 503);
    assert.match(failed.headers.get('content-type'), /^application\/json/);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await failed.json(), {
      error: 'Le service est temporairement indisponible. Réessayez.',
    });

    for (let index = 0; index < 2; index++) {
      const response = await fetch(`${origin}/api/backend?__path=health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).path, '/api/health');
    }
    assert.equal(calls, 2);
  });
}

test('forwarded HTTPS reaches the backend origin check and secure cookie', async t => {
  const backend = express();
  backend.set('trust proxy', false);
  backend.post('/api/session', (req, res) => {
    if (req.get('origin') !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'Origin rejected.' });
    }
    res.cookie('session', 'test-session', { httpOnly: true, secure: req.secure });
    return res.json({ secure: req.secure, protocol: req.protocol });
  });
  const handler = createVercelHandler(() => backend);
  const origin = await listen(t, handler);
  const response = await fetch(`${origin}/api/backend?__path=session`, {
    method: 'POST',
    headers: {
      origin: origin.replace(/^http:/, 'https:'),
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { secure: true, protocol: 'https' });
  assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/);
  assert.equal(handler.get('trust proxy'), 1);
  assert.equal(backend.get('trust proxy'), 1);
});

test('rewrite preserves POST body, raw query encoding, order, and repeated values', async t => {
  const origin = await listen(t, createVercelHandler(inspectBackend));
  const query = 'tag=one&empty=&tag=two&space=a%20b&plus=a+b&encoded=%2f%2B&flag&nested%5Bkey%5D=value';
  const body = { message: 'Hello', values: [1, 2] };
  const response = await fetch(`${origin}/api/backend?tag=one&__path=inspect%2Fitem&${query.slice('tag=one&'.length)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: 'POST',
    url: `/api/inspect/item?${query}`,
    path: '/api/inspect/item',
    query: {
      tag: ['one', 'two'],
      empty: '',
      space: 'a b',
      plus: 'a b',
      encoded: '/+',
      flag: '',
      'nested[key]': 'value',
    },
    body,
  });
});

test('Vercel cached query helpers yield to the reconstructed Express query', async t => {
  const origin = await listen(t, createVercelHandler(inspectBackend), req => {
    const originalQuery = { __path: 'inspect/item', tag: ['one', 'two'] };
    Object.defineProperty(req, 'query', { configurable: true, get: () => originalQuery });
  });
  const response = await fetch(`${origin}/api/backend?__path=inspect%2Fitem&tag=one&tag=two`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.url, '/api/inspect/item?tag=one&tag=two');
  assert.deepEqual(payload.query, { tag: ['one', 'two'] });
});

test('requests without the rewrite parameter retain their URL', async t => {
  const origin = await listen(t, createVercelHandler(inspectBackend));
  const url = '/api/inspect/item?tag=one&tag=two&space=a%20b&__path_extra=keep';
  const response = await fetch(`${origin}${url}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.url, url);
  assert.equal(payload.path, '/api/inspect/item');
  assert.deepEqual(payload.query, { tag: ['one', 'two'], space: 'a b', __path_extra: 'keep' });
});
