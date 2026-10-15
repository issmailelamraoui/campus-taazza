import { pathToFileURL } from 'node:url';
import { openDatabase } from './db.js';
import { seedDatabase } from './seed.js';

export async function migrate({ schema = process.env.CAMPUS_DB_SCHEMA || 'campuslink', seedReferences = false } = {}) {
  const db = await openDatabase({ schema });
  try {
    if(seedReferences)await seedDatabase(db);
    const migrations = await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
    console.log(JSON.stringify({ ok: true, schema, migrations: migrations.map(row => row.name), referenceDataSeeded: seedReferences }));
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate({seedReferences:process.argv.includes('--seed')}).catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'MIGRATION_FAILED' })); process.exitCode = 1; });
}
