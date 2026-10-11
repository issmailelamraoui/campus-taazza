import './env.js';
import { pathToFileURL } from 'node:url';
import { openDatabase, migrateDatabase, createPostgresPool } from './db.js';

const validSchema = value => /^[a-z][a-z0-9_]{0,62}$/.test(value || '');
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';

// Clone only PostgreSQL metadata. Identity links and private R2 references are
// retained; no provider account or storage object is created, updated or deleted.
// The target must be absent/empty, so rerunning cannot overwrite either app.
export async function cloneMetadata({ connectionString = process.env.DATABASE_URL, sourceSchema, targetSchema } = {}) {
  if (!connectionString || !validSchema(sourceSchema) || !validSchema(targetSchema) || sourceSchema === targetSchema) throw new Error('Supply distinct valid source and target schemas.');
  const pool = createPostgresPool({ connectionString, max: 1, connectionTimeoutMillis: 15000 });
  let client;
  const counts = {};
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`campuslink:clone:${targetSchema}`]);
    const source = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name", [sourceSchema]);
    if (!source.rows.some(row => row.table_name === 'users') || !source.rows.some(row => row.table_name === 'schema_migrations')) throw new Error('Source CampusLink schema is missing.');
    const existing = await client.query('SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1', [targetSchema]);
    if (Number(existing.rows[0].count)) throw new Error('Target schema is not empty; cloning would overwrite an existing application.');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(targetSchema)}`);
    const tables = source.rows.map(row => row.table_name);
    await client.query(`LOCK TABLE ${tables.map(name => `${quote(sourceSchema)}.${quote(name)}`).join(',')} IN ACCESS SHARE MODE`);
    for (const table of tables) {
      await client.query(`CREATE TABLE ${quote(targetSchema)}.${quote(table)} (LIKE ${quote(sourceSchema)}.${quote(table)} INCLUDING ALL)`);
    }
    for (const table of tables) {
      const columns = await client.query("SELECT column_name,is_identity FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_generated='NEVER' ORDER BY ordinal_position", [sourceSchema, table]);
      const names = columns.rows.map(row => quote(row.column_name)).join(',');
      const copied = await client.query(`INSERT INTO ${quote(targetSchema)}.${quote(table)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM ${quote(sourceSchema)}.${quote(table)}`);
      counts[table] = copied.rowCount;
      for (const column of columns.rows) {
        const original = await client.query('SELECT pg_get_serial_sequence($1,$2) AS sequence', [`${sourceSchema}.${table}`, column.column_name]);
        if (!original.rows[0].sequence) continue;
        if (column.is_identity !== 'YES') {
          // LIKE copies serial defaults literally; give serial columns an
          // independent target sequence instead of incrementing the source.
          const name = `${table}_${column.column_name}_seq`;
          await client.query(`CREATE SEQUENCE ${quote(targetSchema)}.${quote(name)}`);
          await client.query(`ALTER SEQUENCE ${quote(targetSchema)}.${quote(name)} OWNED BY ${quote(targetSchema)}.${quote(table)}.${quote(column.column_name)}`);
          await client.query(`ALTER TABLE ${quote(targetSchema)}.${quote(table)} ALTER COLUMN ${quote(column.column_name)} SET DEFAULT nextval('${quote(targetSchema)}.${quote(name)}'::regclass)`);
        }
        const seq = await client.query('SELECT pg_get_serial_sequence($1,$2) AS sequence', [`${targetSchema}.${table}`, column.column_name]);
        const maximum = await client.query(`SELECT max(${quote(column.column_name)}) AS maximum FROM ${quote(targetSchema)}.${quote(table)}`);
        await client.query('SELECT setval($1::regclass,$2,$3)', [seq.rows[0].sequence, maximum.rows[0].maximum || 1, maximum.rows[0].maximum !== null]);
      }
      const copiedCount = await client.query(`SELECT count(*) AS count FROM ${quote(targetSchema)}.${quote(table)}`);
      if (Number(copiedCount.rows[0].count) !== counts[table]) throw new Error('Metadata count verification failed.');
    }
    // LIKE includes indexes/check constraints, but excludes foreign keys.
    const constraints = await client.query("SELECT c.conname, t.relname AS table_name, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND c.contype='f' ORDER BY t.relname,c.conname", [sourceSchema]);
    for (const row of constraints.rows) {
      const definition = row.definition.replaceAll(`${quote(sourceSchema)}.`, `${quote(targetSchema)}.`).replaceAll(`${sourceSchema}.`, `${quote(targetSchema)}.`);
      await client.query(`ALTER TABLE ${quote(targetSchema)}.${quote(row.table_name)} ADD CONSTRAINT ${quote(row.conname)} ${definition}`);
    }
    const migrations = await client.query(`SELECT name FROM ${quote(targetSchema)}.schema_migrations ORDER BY name`);
    await client.query('COMMIT');
    return { sourceSchema, targetSchema, counts, copiedMigrations: migrations.rows.map(row => row.name) };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally { client?.release(); await pool.end(); }
}

async function command() {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--source-schema') || !args.includes('--target-schema')) throw new Error('Pass --source-schema and --target-schema explicitly.');
  const result = await cloneMetadata({ sourceSchema: value('--source-schema'), targetSchema: value('--target-schema') });
  const db = await openDatabase({ schema: result.targetSchema, migrate: false });
  try {
    const migrations = await migrateDatabase(db);
    console.log(JSON.stringify({ ok: true, ...result, targetMigrations: migrations, sourceUnchanged: true }));
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  command().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'CLONE_FAILED', message: error.code ? 'Metadata cloning failed.' : error.message })); process.exitCode = 1; });
}
