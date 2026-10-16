import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { createServer as createViteServer } from 'vite';
import config from '../vite.config.js';
import { configureApiProxy } from '../scripts/dev-api-proxy.js';

async function closeHttpServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

test('development proxy returns useful unavailable JSON and recovers without restarting or retrying writes', async t => {
  const reservation = createHttpServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await closeHttpServer(reservation);

  const vite = await createViteServer({
    ...config,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    server: {
      ...config.server,
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      watch: null,
      proxy: { '/api': { ...config.server.proxy['/api'], target: `http://127.0.0.1:${port}` } },
    },
  });
  t.after(() => vite.close());
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const login = { username: 'local-fixture', password: 'fixture-password' };
  const request = () => fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(login),
  });

  const unavailable = await request();
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.headers.get('content-type'), /^application\/json/);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unavailable.json(), {
    error: 'Le serveur est temporairement indisponible. Réessayez dans quelques instants.',
    code: 'API_UNAVAILABLE',
  });

  let calls = 0;
  const upstream = createHttpServer(async (req, res) => {
    calls++;
    if (req.url.startsWith('/api/error/')) {
      res.writeHead(Number(req.url.split('/').at(-1)), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Original backend error', code: 'FIXTURE_ERROR' }));
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'fixture-session=test; HttpOnly; SameSite=Lax',
    });
    res.end(JSON.stringify({ method: req.method, url: req.url, origin: req.headers.origin,
      host: req.headers.host, body: JSON.parse(body) }));
  });
  upstream.listen(port, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => closeHttpServer(upstream));

  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.match(recovered.headers.get('set-cookie'), /^fixture-session=test;/);
  assert.deepEqual(await recovered.json(), {
    method: 'POST', url: '/api/login', origin, host: new URL(origin).host, body: login,
  });
  assert.equal(calls, 1, 'the failed login is not retried automatically');

  for (const status of [401, 403, 500]) {
    const response = await fetch(`${origin}/api/error/${status}`);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: 'Original backend error', code: 'FIXTURE_ERROR' });
  }
  assert.equal(calls, 4);
});

test('proxy error handling leaves WebSocket sockets and started or closed HTTP responses alone', () => {
  const proxy = new EventEmitter();
  configureApiProxy(proxy);
  let writes = 0;
  const write = () => { writes++; };
  for (const response of [
    { end: write },
    { writeHead: write, end: write, headersSent: true },
    { writeHead: write, end: write, writableEnded: true },
    { writeHead: write, end: write, destroyed: true },
  ]) proxy.emit('error', new Error('Fixture connection error'), {}, response);
  assert.equal(writes, 0);
});
