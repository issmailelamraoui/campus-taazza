import './env.js';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');
const identityTables = new Set(['users', 'modules', 'messages', 'resources', 'resource_versions', 'announcements', 'notifications', 'events', 'reports', 'contacts']);
const applicationTables = new Set([...identityTables, 'faculties', 'filieres', 'semesters', 'reactions', 'channels', 'chat_bans', 'saved', 'history', 'schema_migrations', 'legacy_imports', 'message_attachments', 'resource_folders', 'folder_items']);
const migrationDirectory = new URL('./migrations/', import.meta.url);
const connectionCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '53300']);
function connectionFailure(error) {
  return error?.code === 'DATABASE_UNAVAILABLE' || connectionCodes.has(error?.code) || /^08/.test(error?.code || '') ||
    /^(Query read timeout|Connection terminated(?: unexpectedly| due to connection timeout)?|timeout exceeded when trying to connect|timeout expired|Client has encountered a connection error and is not queryable)$/.test(error?.message || '');
}
function databaseError(error) {
  if (!connectionFailure(error) || error.code === 'DATABASE_UNAVAILABLE') return error;
  return Object.assign(new Error('La base de données est temporairement indisponible. Réessayez.', { cause: error }), { status: 503, code: 'DATABASE_UNAVAILABLE' });
}

// A remote PostgreSQL TLS peer can stop acknowledging a graceful disconnect.
// pg removes such a client from its pool before the socket actually closes, so
// pool.end() alone may leave the process alive indefinitely during shutdown.
export class ClosingPostgresClient extends pg.Client {
  constructor(config) {
    super(config);
    this.shutdownTimeoutMillis = config?.shutdownTimeoutMillis ?? 3000;
  }
  end(callback) {
    const connection = this.connection;
    if (!this._ending && !this._ended && connection?._connecting && !connection.stream.destroyed) {
      const timer = setTimeout(() => connection.stream.destroy(), this.shutdownTimeoutMillis);
      timer.unref();
      connection.once('end', () => clearTimeout(timer));
    }
    return super.end(callback);
  }
}
export function createPostgresPool(options) {
  return new pg.Pool({ ...options, Client: ClosingPostgresClient });
}

function number(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Database integer exceeds the supported range.');
  return result;
}

// Keep the existing small prepared-query API while changing its operations to
// asynchronous PostgreSQL queries. Values remain bound parameters throughout.
export function postgresSql(statement) {
  let sql = statement.trim().replace(/;\s*$/, '');
  sql = sql.replace(/([\w.]+)\s*=\s*\?\s+COLLATE\s+NOCASE\b/gi, 'lower($1)=lower(?)');
  const ignore = /^INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  sql = sql.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
  if (ignore && !/\bON\s+CONFLICT\b/i.test(sql)) sql += ' ON CONFLICT DO NOTHING';
  let placeholder = 0;
  let quote = null;
  let output = '';
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[i + 1] === quote) output += sql[++i];
        else quote = null;
      }
    } else if (char === "'" || char === '"') { quote = char; output += char; }
    else output += char === '?' ? `$${++placeholder}` : char;
  }
  return output;
}

function inSchema(sql, schema) {
  // Neon transaction pooling cannot accept search_path as a connection startup
  // option. Qualifying application tables also prevents fallback into public.
  return sql.replace(/\b(FROM|JOIN|UPDATE|INTO|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+([a-z_][a-z0-9_]*)\b(?!\s*\.)/gi,
    (match, keyword, table) => applicationTables.has(table.toLowerCase()) ? `${keyword} "${schema}"."${table}"` : match)
    .replace(/pg_get_serial_sequence\('([a-z_][a-z0-9_]*)'/gi,
      (match, table) => applicationTables.has(table) ? `pg_get_serial_sequence('${schema}.${table}'` : match);
}

export async function openDatabase({ connectionString = process.env.DATABASE_URL, schema = process.env.CAMPUS_DB_SCHEMA || 'campuslink', migrate = true, max = 8, queryTimeoutMillis = 10000, connectionTimeoutMillis = 10000 } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL persistence.');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid application database schema.');
  const pool = createPostgresPool({
    connectionString,
    max,
    connectionTimeoutMillis,
    // A silent TCP/TLS stall must release the borrowed client instead of
    // exhausting the pool and blocking every later login indefinitely.
    query_timeout: queryTimeoutMillis,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    maxLifetimeSeconds: 60,
    types: { getTypeParser: (oid, format) => oid === 20 && format !== 'binary' ? number : pg.types.getTypeParser(oid, format) },
  });
  // pg removes failed idle clients itself. Handle its background error event
  // so a dropped connection cannot terminate the API and all live chat streams.
  pool.on('error', () => console.error('[CampusLink database] Idle connection closed; the pool will reconnect.'));
  const context = new AsyncLocalStorage();
  let closed = false;
  const query = (sql, values = []) => {
    if (closed) throw new Error('The database connection is closed.');
    const transaction = context.getStore();
    if (!transaction) return pool.query(sql, values).catch(error => { throw databaseError(error); });
    // A transaction owns one client. Promise.all in the existing DTO builders
    // must queue its statements rather than execute concurrently on that client.
    const result = transaction.queue.then(() => {
      if (transaction.failure) throw transaction.failure;
      return transaction.client.query(sql, values);
    }).catch(error => {
      const failure = databaseError(error);
      // Once a transport is dead, skip the remaining queued statements rather
      // than spending another timeout on every member of a Promise.all batch.
      if (connectionFailure(failure)) transaction.failure ??= failure;
      throw failure;
    });
    transaction.queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const db = {
    schema,
    query,
    exec: sql => query(inSchema(sql, schema)),
    prepare(statement) {
      const sql = inSchema(postgresSql(statement), schema);
      return {
        async get(...values) { return (await query(sql, values)).rows[0]; },
        async all(...values) { return (await query(sql, values)).rows; },
        async run(...values) {
          const table = sql.match(/^INSERT\s+INTO\s+(?:(?:"?[\w]+"?)\.)?"?([\w]+)"?/i)?.[1];
          const returning = table && identityTables.has(table) && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING id` : sql;
          const result = await query(returning, values);
          return { lastInsertRowid: result.rows[0]?.id ?? null, changes: result.rowCount ?? 0, rows: result.rows };
        },
      };
    },
    async transaction(callback) {
      const parent = context.getStore();
      if (parent) {
        const savepoint = `campuslink_nested_${++parent.depth}`;
        await query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(db);
          await query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          if (!connectionFailure(error)) await query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          throw error;
        }
      }
      const client = await pool.connect().catch(error => { throw databaseError(error); });
      const state = { client, depth: 0, queue: Promise.resolve() };
      let discard = false;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        const result = await context.run(state, () => callback(db));
        await state.queue;
        if (state.failure) throw state.failure;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await state.queue;
        discard = connectionFailure(error);
        if (!discard) {
          try { await client.query('ROLLBACK'); }
          catch (rollbackError) { discard = true; throw databaseError(rollbackError); }
        }
        // A timed-out transaction cannot safely return its still-active client
        // to the pool. Destroy it; never retry an uncertain write or COMMIT.
        throw databaseError(error);
      } finally { client.release(discard); }
    },
    async close() { if (!closed) { closed = true; await pool.end(); } },
  };
  try {
    await query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    if (migrate) await migrateDatabase(db);
    return db;
  } catch (error) { await db.close(); throw error; }
}

export async function migrateDatabase(db) {
  const files = (await readdir(fileURLToPath(migrationDirectory))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  await db.transaction(async () => {
    // Serializes fresh starts and migration commands against the same schema.
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:migrations:${db.schema}`);
    await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const name of files) {
      const sql = await readFile(new URL(name, migrationDirectory), 'utf8');
      const checksum = digest(sql);
      const applied = await db.prepare('SELECT sha256 FROM schema_migrations WHERE name=?').get(name);
      if (applied) {
        if (applied.sha256 !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await db.exec(sql);
      await db.prepare('INSERT INTO schema_migrations (name,sha256,applied_at) VALUES (?,?,?)').run(name, checksum, new Date().toISOString());
    }
  });
  return files;
}
