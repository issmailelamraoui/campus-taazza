import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import pg from 'pg';
import { openDatabase, ClosingPostgresClient } from '../server/db.js';

const unavailableMessage = 'La base de données est temporairement indisponible. Réessayez.';
const result = { rows: [], rowCount: 0 };
function assertUnavailable(error) {
  assert.equal(error.status, 503);
  assert.equal(error.code, 'DATABASE_UNAVAILABLE');
  assert.equal(error.message, unavailableMessage);
  return true;
}

// Speak the small PostgreSQL wire-protocol subset used by these unparameterized
// queries. The real pg.Client/query timeout and pg.Pool release paths still run;
// only the remote transport is controlled, and no external database is touched.
async function postgresTransport() {
  const sockets = new Set(), statements = [];
  let connections = 0;
  const frame = (type, payload) => {
    const length = Buffer.alloc(4); length.writeInt32BE(payload.length + 4);
    return Buffer.concat([Buffer.from(type), length, payload]);
  };
  const ready = () => frame('Z', Buffer.from('I'));
  const server = createServer(socket => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0), started = false;
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (!started) {
        if (pending.length < 4 || pending.length < pending.readInt32BE(0)) return;
        pending = pending.subarray(pending.readInt32BE(0)); started = true;
        socket.write(Buffer.concat([frame('R', Buffer.alloc(4)), ready()]));
      }
      while (pending.length >= 5 && pending.length >= pending.readInt32BE(1) + 1) {
        const type = String.fromCharCode(pending[0]), length = pending.readInt32BE(1);
        const payload = pending.subarray(5, length + 1); pending = pending.subarray(length + 1);
        if (type === 'X') { socket.end(); continue; }
        if (type !== 'Q') continue;
        const sql = payload.toString().replace(/\0$/, ''); statements.push(sql);
        if (sql.includes('stall_read')) continue;
        if (sql.includes('AS alive')) {
          const description = Buffer.alloc(2); description.writeInt16BE(1, 0);
          // One int4 field: name + table oid + column + type oid + size + modifier + format.
          const field = Buffer.alloc(18); field.writeInt32BE(23, 6); field.writeInt16BE(4, 10); field.writeInt32BE(-1, 12);
          const row = Buffer.alloc(7); row.writeInt16BE(1); row.writeInt32BE(1, 2); row.write('1', 6);
          socket.write(Buffer.concat([frame('T', Buffer.concat([description, Buffer.from('alive\0'), field])), frame('D', row), frame('C', Buffer.from('SELECT 1\0')), ready()]));
        } else socket.write(Buffer.concat([frame('C', Buffer.from('CREATE SCHEMA\0')), ready()]));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    connectionString: `postgres://fixture:fixture@127.0.0.1:${server.address().port}/fixture?sslmode=disable`,
    statements, get connections() { return connections; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function withFixtureDatabase({ query, connect, options = {} }, callback) {
  const originalPool = pg.Pool;
  let pool, db;
  class FixturePool extends EventEmitter {
    constructor(config) { super(); this.options = config; this.queries = []; this.connections = 0; pool = this; }
    async query(sql, values) { this.queries.push(sql); return query ? query(sql, values, this) : result; }
    async connect() { this.connections++; return connect(this); }
    async end() { this.closed = true; }
  }
  pg.Pool = FixturePool;
  try {
    db = await openDatabase({ connectionString: 'postgres://fixture.invalid/test', migrate: false, ...options });
    return await callback(db, pool);
  } finally { await db?.close(); pg.Pool = originalPool; }
}

test('a stalled PostgreSQL disconnect closes its transport within the shutdown deadline', async () => {
  const client = new ClosingPostgresClient({ shutdownTimeoutMillis: 30 });
  const connection = new EventEmitter();
  let requested = 0;
  const stream = { destroyed: false, destroy() { this.destroyed = true; connection.emit('end'); } };
  Object.assign(connection, { _connecting: true, stream, end() { requested++; } });
  client.connection = connection;
  // Keep this fixture alive as a real TLS transport would until it closes.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await client.end();
    assert.equal(requested, 1, 'A graceful disconnect is attempted first.');
    assert.equal(stream.destroyed, true, 'A stalled transport is forcibly closed.');
  } finally { clearInterval(keepAlive); }
});

test('a normal PostgreSQL disconnect completes without forced transport destruction', async () => {
  const client = new ClosingPostgresClient({ shutdownTimeoutMillis: 30 });
  const connection = new EventEmitter();
  let forced = 0;
  Object.assign(connection, { _connecting: true, stream: { destroyed: false, destroy() { forced++; } }, end() { queueMicrotask(() => connection.emit('end')); } });
  client.connection = connection;
  await client.end();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(forced, 0, 'The deadline is canceled when the peer closes normally.');
});

test('an idle pool error cannot crash the API or expose connection credentials', async () => {
  const originalPool=pg.Pool,originalError=console.error,logs=[];
  let pool,db;
  class FixturePool extends EventEmitter {
    constructor(){super();pool=this;}
    async query(sql){return {rows:sql.includes('AS alive')?[{alive:1}]:[],rowCount:0};}
    async end(){this.closed=true;}
  }
  pg.Pool=FixturePool;
  console.error=(...parts)=>logs.push(parts.join(' '));
  try {
    db=await openDatabase({connectionString:'postgres://fixture.invalid/test',migrate:false});
    assert.doesNotThrow(()=>pool.emit('error',new Error('Simulated disconnect with private connection details.')));
    assert.equal(logs.length,1);
    assert.ok(!logs[0].includes('private connection details'));
    assert.equal((await db.prepare('SELECT 1 AS alive').get()).alive,1,'The application can continue making database requests.');
  } finally {
    await db?.close();pg.Pool=originalPool;console.error=originalError;
  }
  assert.equal(pool.closed,true);
});

test('a silent PostgreSQL query times out, frees a full pool, and lets the next request reconnect', { timeout: 5000 }, async () => {
  const transport = await postgresTransport();
  let db;
  try {
    db = await openDatabase({ connectionString: transport.connectionString, migrate: false, max: 1, queryTimeoutMillis: 80, connectionTimeoutMillis: 1000 });
    const started = performance.now();
    const timedOut = assert.rejects(db.query('SELECT stall_read'), assertUnavailable);
    // This request must wait for the one borrowed client to be discarded. It
    // would hit the checkout deadline if a timed-out query stranded that client.
    const queued = db.prepare('SELECT 1 AS alive').get();
    await timedOut;
    assert.ok(performance.now() - started < 1000, 'The query deadline precedes the pool checkout deadline.');
    assert.equal((await queued).alive, 1);
    assert.equal(transport.connections, 2, 'The stalled transport is replaced with a fresh connection.');
    assert.equal(transport.statements.filter(sql => sql === 'SELECT stall_read').length, 1, 'The failed statement is never replayed.');
  } finally { await db?.close(); await transport.close(); }
});

test('transient database failures return a safe 503 and never retry uncertain writes', async () => {
  const failures = [
    ...['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', '08006', '57P01', '57P02', '57P03', '53300'].map(code => Object.assign(new Error('Private connection details must remain internal.'), { code })),
    ...['Query read timeout', 'Connection terminated', 'Connection terminated unexpectedly', 'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect', 'timeout expired', 'Client has encountered a connection error and is not queryable'].map(message => new Error(message)),
  ];
  await withFixtureDatabase({ query(sql) { if (sql.startsWith('INSERT')) throw failures.shift(); return result; } }, async (db, pool) => {
    const count = failures.length;
    for (let index = 0; index < count; index++) {
      const cause = failures[0];
      await assert.rejects(db.query('INSERT INTO operation_log VALUES (1)'), error => {
        assertUnavailable(error); assert.equal(error.cause, cause);
        assert.ok(!JSON.stringify(error).includes('Private connection details'));
        return true;
      });
    }
    assert.equal(pool.queries.filter(sql => sql.startsWith('INSERT')).length, count, 'Each write is attempted exactly once.');
    assert.equal((await db.query('SELECT 1')).rowCount, 0, 'Later requests can still use the pool.');
  });
});

test('SQL and unexpected programming errors keep their original identity', async () => {
  const failures = ['23505', '42P01', '42703', '57014'].map(code => Object.assign(new Error('SQL fixture failure'), { code }));
  failures.push(new Error('Unexpected fixture programming error'));
  await withFixtureDatabase({ query(sql) { if (sql === 'SELECT failing') throw failures.shift(); return result; } }, async db => {
    while (failures.length) {
      const expected = failures[0];
      await assert.rejects(db.query('SELECT failing'), error => error === expected);
    }
  });
});

test('pool checkout failures reject transactions before any callback or write runs', async () => {
  let callbacks = 0;
  await withFixtureDatabase({ connect() { throw new Error('timeout exceeded when trying to connect'); } }, async (db, pool) => {
    await assert.rejects(db.transaction(() => { callbacks++; }), assertUnavailable);
    assert.equal(callbacks, 0);
    assert.equal(pool.connections, 1, 'Pool checkout is not automatically retried.');
    assert.equal(pool.queries.length, 1, 'Only the initial schema availability query has run.');
  });
});

test('fatal BEGIN, setup, write, and COMMIT failures discard their clients without rollback or replay', async () => {
  for (const phase of ['BEGIN', 'SET LOCAL', 'INSERT', 'COMMIT']) {
    const clients = [];
    let callbacks = 0;
    await withFixtureDatabase({ connect() {
      const client = { statements: [], releases: [], async query(sql) {
        this.statements.push(sql);
        if (clients.length === 1 && sql.startsWith(phase)) throw Object.assign(new Error('Simulated transport loss'), { code: 'ECONNRESET' });
        return result;
      }, release(discard) { this.releases.push(discard); } };
      clients.push(client); return client;
    } }, async db => {
      const operation = () => db.transaction(async () => { callbacks++; await db.query('INSERT INTO operation_log VALUES (1)'); return 'written'; });
      await assert.rejects(operation(), assertUnavailable);
      assert.deepEqual(clients[0].releases, [true], `${phase}: failed client is discarded exactly once.`);
      assert.ok(!clients[0].statements.includes('ROLLBACK'), `${phase}: dead transport receives no further query.`);
      assert.equal(callbacks, ['BEGIN', 'SET LOCAL'].includes(phase) ? 0 : 1, `${phase}: callback is never replayed.`);
      assert.equal(clients[0].statements.filter(sql => sql.startsWith(phase)).length, 1);
      assert.equal(await operation(), 'written', `${phase}: a later transaction can proceed on a new client.`);
      assert.deepEqual(clients[1].releases, [false]);
    });
  }
});

test('a fatal query stops the remaining Promise.all transaction statements from reaching the dead client', async () => {
  const statements = [], releases = [];
  await withFixtureDatabase({ connect() { return {
    async query(sql) { statements.push(sql); if (sql.startsWith('INSERT')) throw new Error('Query read timeout'); return result; },
    release(discard) { releases.push(discard); },
  }; } }, async db => {
    await assert.rejects(db.transaction(() => Promise.all([
      db.query('INSERT INTO operation_log VALUES (1)'),
      db.query('INSERT INTO operation_log VALUES (2)'),
      db.query('INSERT INTO operation_log VALUES (3)'),
    ])), assertUnavailable);
    assert.deepEqual(statements.filter(sql => sql.startsWith('INSERT')), ['INSERT INTO operation_log VALUES (1)']);
    assert.ok(!statements.includes('ROLLBACK')); assert.ok(!statements.includes('COMMIT'));
    assert.deepEqual(releases, [true]);
  });
});

test('a caught fatal query still aborts the transaction and prevents COMMIT', async () => {
  const statements = [], releases = [];
  await withFixtureDatabase({ connect() { return {
    async query(sql) { statements.push(sql); if (sql.startsWith('INSERT')) throw Object.assign(new Error('Connection lost'), { code: '08006' }); return result; },
    release(discard) { releases.push(discard); },
  }; } }, async db => {
    await assert.rejects(db.transaction(async () => {
      try { await db.query('INSERT INTO operation_log VALUES (1)'); } catch (error) { assertUnavailable(error); }
      return 'cannot commit';
    }), assertUnavailable);
    assert.ok(!statements.includes('COMMIT')); assert.ok(!statements.includes('ROLLBACK'));
    assert.deepEqual(releases, [true]);
  });
});

test('ordinary transaction SQL failures roll back and preserve the original error', async () => {
  const expected = Object.assign(new Error('Unique constraint fixture'), { code: '23505' });
  const statements = [], releases = [];
  await withFixtureDatabase({ connect() { return {
    async query(sql) { statements.push(sql); if (sql.startsWith('INSERT')) throw expected; return result; },
    release(discard) { releases.push(discard); },
  }; } }, async db => {
    await assert.rejects(db.transaction(() => db.query('INSERT INTO operation_log VALUES (1)')), error => error === expected);
    assert.equal(statements.at(-1), 'ROLLBACK'); assert.ok(!statements.includes('COMMIT'));
    assert.deepEqual(releases, [false]);
  });
});

test('a failed rollback discards the client and returns the safe transport error', async () => {
  const statements = [], releases = [];
  await withFixtureDatabase({ connect() { return {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('INSERT')) throw Object.assign(new Error('SQL fixture failure'), { code: '23505' });
      if (sql === 'ROLLBACK') throw new Error('Connection terminated unexpectedly');
      return result;
    }, release(discard) { releases.push(discard); },
  }; } }, async db => {
    await assert.rejects(db.transaction(() => db.query('INSERT INTO operation_log VALUES (1)')), assertUnavailable);
    assert.equal(statements.filter(sql => sql === 'ROLLBACK').length, 1);
    assert.deepEqual(releases, [true]);
  });
});
