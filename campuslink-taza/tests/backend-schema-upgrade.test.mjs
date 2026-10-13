import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createPostgresPool, digest, migrateDatabase, openDatabase } from '../server/db.js';
import { assertSchemaReady, inspectSchemaReadiness } from '../server/schema-readiness.js';

const testDatabaseUrl = process.env.CAMPUS_TEST_DATABASE_URL;
const isolated = { skip: !testDatabaseUrl && 'Set CAMPUS_TEST_DATABASE_URL to an isolated PostgreSQL database.' };
const migrationsDirectory = new URL('../server/migrations/', import.meta.url);
const repositoryDirectory = fileURLToPath(new URL('../', import.meta.url));
const executeFile = promisify(execFile);

async function temporaryDatabase(t) {
  assert.ok(testDatabaseUrl, 'These tests never fall back to the application DATABASE_URL.');
  const schema = `campuslink_test_${randomUUID().replaceAll('-', '')}`;
  const db = await openDatabase({ connectionString: testDatabaseUrl, schema, migrate: false });
  t.after(async () => {
    await db.close();
    assert.match(schema, /^campuslink_test_[a-f0-9]{32}$/);
    const cleanup = createPostgresPool({ connectionString: testDatabaseUrl, max: 1 });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  return db;
}

async function initializeLegacySchema(db) {
  const files = (await readdir(migrationsDirectory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name) && Number(name.split('_')[0]) <= 15).sort();
  await db.transaction(async () => {
    await db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for (const name of files) {
      const sql = await readFile(new URL(name, migrationsDirectory), 'utf8');
      await db.exec(sql);
      await db.prepare('INSERT INTO schema_migrations(name,sha256,applied_at) VALUES (?,?,?)').run(name, digest(sql), '2026-09-01T12:00:00.000Z');
    }
  });
  return files;
}

async function populateLegacyData(db) {
  const date = '2026-09-15T10:30:00.000Z';
  await db.prepare('INSERT INTO faculties(id,code,name,arabic,description,icon,color) VALUES (?,?,?,?,?,?,?)').run('fsa', 'FSA', 'Original faculty name', 'كلية قديمة', 'Preserved description', 'atom', 'green');
  await db.prepare('INSERT INTO filieres(id,faculty_id,name) VALUES (?,?,?)').run('data_science', 'fsa', 'Original programme name');
  await db.prepare('INSERT INTO semesters(id,name) VALUES (?,?)').run(1, 'Original semester name');
  const addUser = db.prepare('INSERT INTO users(id,auth_user_id,email,username,name,role,faculty_id,filiere_id,current_semester,current_academic_year,session_version,avatar_object_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  await addUser.run(417, 'legacy-owner-neon-id', 'owner@example.invalid', 'preserved_owner', 'Original owner', 'global_admin', 'fsa', 'data_science', 1, '2026/2027', 4, 'campuslink-prj/avatars/owner-original.jpg');
  await addUser.run(503, 'legacy-student-neon-id', 'student@example.invalid', 'preserved_student', 'Original student', 'student', 'fsa', 'data_science', 1, '2026/2027', 7, 'campuslink-prj/avatars/student-original.jpg');
  await addUser.run(519, 'legacy-reviewer-neon-id', 'reviewer@example.invalid', 'preserved_reviewer', 'Original reviewer', 'faculty_admin', 'fsa', 'data_science', 1, '2026/2027', 2, null);
  await db.prepare('INSERT INTO platform_owner(user_id,established_at) VALUES (?,?)').run(417, date);
  await db.prepare('INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,filiere_id,capabilities,created_at) VALUES (?,?,?,?,?,?)').run(519, 417, 'fsa', 'data_science', '["resource.manage","feedback.manage"]', date);
  const moduleId = (await db.prepare('INSERT INTO modules(faculty_id,filiere_id,semester,name) VALUES (?,?,?,?)').run('fsa', 'data_science', 1, 'Legacy mathematics')).lastInsertRowid;
  const addResource = db.prepare('INSERT INTO resources(title,filename,faculty_id,filiere_id,semester,module_id,module,author_id,created_at,object_key,sha256,size,mime,category,resource_type,part_number,version,academic_year,academic_years) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const courseId = (await addResource.run('Preserved course', 'original-course.pdf', 'fsa', 'data_science', 1, moduleId, 'Legacy mathematics', 503, date, 'campuslink-prj/resources/legacy/current-v2.pdf', digest('Original current file bytes'), 8192, 'application/pdf', 'courses', 'courses', 'complete', 2, '2025/2026', '["2025/2026","2026/2027"]')).lastInsertRowid;
  const exerciseId = (await addResource.run('Preserved exercise', 'original-exercise.pdf', 'fsa', 'data_science', 1, moduleId, 'Legacy mathematics', 519, date, 'campuslink-prj/resources/legacy/exercise.pdf', digest('Original exercise bytes'), 4096, 'application/pdf', 'td', 'td', '1', 1, '2026/2027', '["2026/2027"]')).lastInsertRowid;
  await db.prepare('INSERT INTO resource_versions(resource_id,version,filename,object_key,sha256,size,mime,updated_at,editor_id) VALUES (?,?,?,?,?,?,?,?,?)').run(courseId, 1, 'first-course.pdf', 'campuslink-prj/resources/legacy/original-v1.pdf', digest('Original first file bytes'), 2048, 'application/pdf', date, 503);
  const messageId = (await db.prepare('INSERT INTO messages(faculty_id,channel,content,author_id,created_at,resource_id,client_id) VALUES (?,?,?,?,?,?,?)').run('fsa', 'general', 'Original course discussion', 503, date, courseId, randomUUID())).lastInsertRowid;
  await db.prepare('INSERT INTO saved(user_id,type,target_id) VALUES (?,?,?)').run(503, 'resource', courseId);
  await db.prepare('INSERT INTO history(user_id,resource_id,opened_at) VALUES (?,?,?)').run(503, exerciseId, date);
  const contactId = (await db.prepare('INSERT INTO contacts(faculty_id,user_id,name,email,subject,message,created_at,category,status) VALUES (?,?,?,?,?,?,?,?,?)').run('fsa', 503, 'Original student', 'student@example.invalid', 'Private legacy request', 'Original private ticket body', date, 'technical', 'open')).lastInsertRowid;
  await db.prepare('INSERT INTO contact_replies(contact_id,author_id,content,administrative,created_at) VALUES (?,?,?,?,?)').run(contactId, 519, 'Original private reply', 1, date);
  await db.prepare('INSERT INTO labs_sessions(id,user_id,language,source,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('legacy-lab-session', 503, 'javascript', 'const original = 1;', date, date);
  await db.prepare('INSERT INTO administrative_audit(actor_id,action,target_type,target_id,details,created_at) VALUES (?,?,?,?,?,?)').run(417, 'appointment.create', 'user', '519', '{"preserve":"original audit"}', date);
  return { courseId, exerciseId, contactId, messageId };
}

async function legacySnapshots(db) {
  const statements = {
    users: 'SELECT * FROM users ORDER BY id',
    faculties: 'SELECT * FROM faculties ORDER BY id',
    filieres: 'SELECT * FROM filieres ORDER BY id',
    semesters: 'SELECT * FROM semesters ORDER BY id',
    modules: 'SELECT * FROM modules ORDER BY id',
    resources: 'SELECT * FROM resources ORDER BY id',
    resource_versions: 'SELECT * FROM resource_versions ORDER BY id',
    messages: 'SELECT * FROM messages ORDER BY id',
    saved: 'SELECT * FROM saved ORDER BY user_id,type,target_id',
    history: 'SELECT * FROM history ORDER BY user_id,resource_id',
    contacts: 'SELECT * FROM contacts ORDER BY id',
    contact_replies: 'SELECT * FROM contact_replies ORDER BY id',
    platform_owner: 'SELECT * FROM platform_owner ORDER BY user_id',
    scoped_appointments: 'SELECT * FROM scoped_appointments ORDER BY id',
    labs_sessions: 'SELECT * FROM labs_sessions ORDER BY id',
    administrative_audit: 'SELECT * FROM administrative_audit ORDER BY id',
    schema_migrations: "SELECT * FROM schema_migrations WHERE name<'016_' ORDER BY name",
  };
  return Object.fromEntries(await Promise.all(Object.entries(statements).map(async ([table, sql]) => [table, await db.prepare(sql).all()])));
}

function compareOriginalRows(before, after) {
  for (const [table, rows] of Object.entries(before)) {
    assert.equal(after[table].length, rows.length, `${table}: original row count survives`);
    const originalColumns = Object.keys(rows[0] || {});
    assert.deepEqual(after[table].map(row => Object.fromEntries(originalColumns.map(column => [column, row[column]]))), rows, `${table}: every original value survives`);
  }
}

test('the actual schema015 upgrades through027 without changing legacy identities, authority, private object keys or records', isolated, async t => {
  const db = await temporaryDatabase(t);
  const initialFiles = await initializeLegacySchema(db);
  assert.equal(initialFiles.at(-1), '015_labs_practice.sql');
  const ids = await populateLegacyData(db);
  const before = await legacySnapshots(db);
  const oldChecksum = (await db.prepare('SELECT sha256 FROM schema_migrations WHERE name=?').get('012_core_permissions_years.sql')).sha256;
  assert.equal(oldChecksum, digest(await readFile(new URL('012_core_permissions_years.sql', migrationsDirectory), 'utf8')));
  assert.equal((await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', [db.schema, 'contacts', 'filiere_id'])).rows.length, 0);
  assert.equal((await db.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [db.schema, 'contact_attachments'])).rows.length, 0);
  const oldReadiness = await inspectSchemaReadiness(db);
  assert.equal(oldReadiness.ready, false);
  assert.ok(oldReadiness.pendingMigrations.includes('027_feedback_attachments_scope.sql'));
  assert.deepEqual(oldReadiness.changedMigrations, []);

  const appliedFiles = await migrateDatabase(db);
  assert.ok(appliedFiles.includes('027_feedback_attachments_scope.sql'));
  await assertSchemaReady(db);
  compareOriginalRows(before, await legacySnapshots(db));
  assert.equal((await db.prepare('SELECT sha256 FROM schema_migrations WHERE name=?').get('012_core_permissions_years.sql')).sha256, oldChecksum, 'Historical migration checksums are never rewritten.');
  assert.equal((await db.prepare('SELECT filiere_id FROM contacts WHERE id=?').get(ids.contactId)).filiere_id, null, 'Adding the field does not invent a programme for an older private ticket.');
  const attachmentId = (await db.prepare('INSERT INTO contact_attachments(contact_id,author_id,filename,object_key,sha256,size,mime,created_at) VALUES (?,?,?,?,?,?,?,?)').run(ids.contactId, 503, 'new-private-attachment.pdf', 'campuslink-prj/feedback/new-private-object.pdf', digest('new private attachment'), 128, 'application/pdf', '2026-10-12T10:00:00.000Z')).lastInsertRowid;
  assert.equal((await db.prepare('SELECT contact_id FROM contact_attachments WHERE id=?').get(attachmentId)).contact_id, ids.contactId);
  await db.prepare('UPDATE contacts SET filiere_id=? WHERE id=?').run('data_science', ids.contactId);
  const migratedLedger = await db.prepare('SELECT * FROM schema_migrations ORDER BY name').all();
  await migrateDatabase(db);
  assert.deepEqual(await db.prepare('SELECT * FROM schema_migrations ORDER BY name').all(), migratedLedger, 'A second migration run does not alter ledger timestamps or historical checksums.');
});

async function runMigrationCommand(db, argumentsList = []) {
  const { stdout, stderr } = await executeFile(process.execPath, ['server/migrate.js', ...argumentsList], {
    cwd: repositoryDirectory,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, CAMPUS_DB_SCHEMA: db.schema, CAMPUS_DB_SEED: 'true', CAMPUS_DB_MIGRATE: 'false' },
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, '');
  return JSON.parse(stdout.trim());
}

async function referenceRows(db) {
  return {
    faculties: await db.prepare('SELECT * FROM faculties ORDER BY id').all(),
    filieres: await db.prepare('SELECT * FROM filieres ORDER BY id').all(),
    semesters: await db.prepare('SELECT * FROM semesters ORDER BY id').all(),
    channels: await db.prepare('SELECT * FROM channels ORDER BY faculty_id,id').all(),
  };
}

test('the migration CLI creates an empty schema without implicitly seeding references or demo data', isolated, async t => {
  const db = await temporaryDatabase(t);
  const result = await runMigrationCommand(db);
  assert.equal(result.ok, true);
  assert.equal(result.schema, db.schema);
  assert.equal(result.referenceDataSeeded, false, 'Only --seed opts in, even when CAMPUS_DB_SEED=true is present.');
  assert.ok(result.migrations.includes('027_feedback_attachments_scope.sql'));
  await assertSchemaReady(db);
  assert.deepEqual(await referenceRows(db), { faculties: [], filieres: [], semesters: [], channels: [] });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n, 0);
});

test('the migration CLI preserves custom reference content and seeds references only with explicit --seed', isolated, async t => {
  const db = await temporaryDatabase(t);
  await migrateDatabase(db);
  await db.prepare('INSERT INTO faculties(id,code,name,arabic,description,icon,color) VALUES (?,?,?,?,?,?,?)').run('fsa', 'CUSTOM', 'Custom faculty label', 'اسم محفوظ', 'Custom description', 'custom', 'custom');
  await db.prepare('INSERT INTO filieres(id,faculty_id,name) VALUES (?,?,?)').run('data_science', 'fsa', 'Custom programme label');
  await db.prepare('INSERT INTO semesters(id,name) VALUES (?,?)').run(1, 'Custom semester label');
  await db.prepare('INSERT INTO channels(id,faculty_id,name,description) VALUES (?,?,?,?)').run('general', 'fsa', 'Custom discussion label', 'Custom discussion description');
  const before = await referenceRows(db);
  const migrated = await runMigrationCommand(db);
  assert.equal(migrated.referenceDataSeeded, false);
  assert.deepEqual(await referenceRows(db), before);
  const seeded = await runMigrationCommand(db, ['--seed']);
  assert.equal(seeded.referenceDataSeeded, true);
  const after = await referenceRows(db);
  assert.ok(after.faculties.length > before.faculties.length);
  assert.ok(after.semesters.length > before.semesters.length);
  assert.deepEqual(after.faculties.find(row => row.id === 'fsa'), before.faculties[0]);
  assert.deepEqual(after.filieres.find(row => row.id === 'data_science'), before.filieres[0]);
  assert.deepEqual(after.semesters.find(row => row.id === 1), before.semesters[0]);
  assert.deepEqual(after.channels.find(row => row.id === 'general' && row.faculty_id === 'fsa'), before.channels[0]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0, 'Reference seeding creates no demo identities.');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n, 0, 'Reference seeding creates no stored-file metadata.');
});
