import './env.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, digest } from './db.js';
import { seedDatabase } from './seed.js';
import { createStorage, resourceObjectKey } from './storage.js';
import { applyStudentCommunityProfiles } from './community-profiles.js';

const tables = ['faculties', 'users', 'messages', 'resources', 'resource_versions', 'reactions', 'announcements', 'notifications', 'events', 'channels', 'saved', 'history', 'reports', 'contacts'];
const identityTables = ['users', 'messages', 'resources', 'resource_versions', 'announcements', 'notifications', 'events', 'reports', 'contacts'];
const fileExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.txt']);

function snapshot(path) {
  // The old database and its files remain an untouched, recoverable source.
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    sqlite.exec('BEGIN');
    const present = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const rows = Object.fromEntries(tables.map(table => [table, present.has(table) ? sqlite.prepare(`SELECT * FROM "${table}"`).all() : []]));
    sqlite.exec('COMMIT');
    return rows;
  } finally { sqlite.close(); }
}

export async function importLocal({ dataDir = resolve('data'), db, storage, schema = process.env.CAMPUS_DB_SCHEMA || 'campuslink' } = {}) {
  const source = snapshot(join(dataDir, 'campuslink.sqlite'));
  const sourceHash = digest(JSON.stringify(source));
  const ownDatabase = !db;
  const ownStorage = !storage;
  db ||= await openDatabase({ schema });
  const uploaded = [];
  try {
    await seedDatabase(db);
    const imported = await db.prepare('SELECT row_counts FROM legacy_imports WHERE source_sha256=?').get(sourceHash);
    if (imported) return { ok: true, alreadyImported: true, counts: imported.row_counts };
    for (const table of ['users', 'messages', 'resources']) {
      if ((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n) throw new Error('Import requires an empty application database to preserve existing IDs safely.');
    }
    storage ||= createStorage();
    const keys = new Map();
    const avatars = new Map();
    const modules = new Map();
    const resourceById = new Map(source.resources.map(row => [row.id, row]));
    // Validate every source file before uploading any object.
    const files = [];
    for (const [kind, rows] of [['resources', source.resources], ['resource-versions', source.resource_versions]]) for (const row of rows) {
      if (!row.stored_name || basename(row.stored_name) !== row.stored_name) throw new Error('Legacy resource file identifier is invalid.');
      if (keys.has(row.stored_name)) continue;
      const buffer = await readFile(join(dataDir, 'files', row.stored_name));
      if (row.sha256 && digest(buffer) !== row.sha256) throw new Error('A legacy resource file failed its integrity check.');
      const extension = extname(row.filename || row.stored_name).toLowerCase();
      if (!fileExtensions.has(extension)) throw new Error('Legacy resource file type is not supported.');
      files.push({ kind, row, buffer, extension });
      keys.set(row.stored_name, null);
    }
    for (const row of source.users) if (row.avatar?.startsWith('data:')) {
      const match = row.avatar.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error('Legacy embedded avatar type is not supported.');
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error('Legacy embedded avatar size is invalid.');
      avatars.set(row.id, { buffer, mime: match[1], key: `avatars/${row.id}/${randomUUID()}.${match[1].split('/')[1].replace('jpeg', 'jpg')}` });
    }
    await db.transaction(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:legacy-import:${db.schema}`);
      const already = await db.prepare('SELECT row_counts FROM legacy_imports WHERE source_sha256=?').get(sourceHash);
      if (already) throw new Error('This source was imported by another process; rerun to verify the completed import.');
      // Source faculty labels and channel settings take precedence over the
      // identical reference defaults without changing student selections.
      for (const faculty of source.faculties) {
        const columns = Object.keys(faculty);
        await db.prepare(`INSERT INTO faculties (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns.filter(key => key !== 'id').map(key => `${key}=excluded.${key}`).join(',')}`).run(...columns.map(key => faculty[key]));
      }
      for (const row of source.resources) if (row.module?.trim()) {
        const moduleKey = JSON.stringify([row.faculty_id, row.filiere_id || null, row.semester || null, row.module]);
        if (!modules.has(moduleKey)) modules.set(moduleKey, (await db.prepare('INSERT INTO modules (faculty_id,filiere_id,semester,name) VALUES (?,?,?,?) ON CONFLICT(faculty_id,filiere_id,semester,name) DO UPDATE SET name=excluded.name RETURNING id').run(row.faculty_id, row.filiere_id || null, row.semester || null, row.module)).lastInsertRowid);
        row.module_id = modules.get(moduleKey);
      }
      for (const { kind, row, buffer, extension } of files) {
        const resource = kind === 'resources' ? row : resourceById.get(row.resource_id);
        const key = resource?.filiere_id && resource.semester && resource.module_id
          ? resourceObjectKey({ filiereId: resource.filiere_id, semester: resource.semester, moduleId: resource.module_id, filename: row.filename, prefix: kind })
          : `legacy/${kind}/${row.id}/${randomUUID()}${extension}`;
        uploaded.push(key);
        await storage.put(key, buffer, row.mime || 'application/octet-stream');
        keys.set(row.stored_name, key);
      }
      for (const avatar of avatars.values()) { uploaded.push(avatar.key); await storage.put(avatar.key, avatar.buffer, avatar.mime); }
      const metadata = new Map();
      for (const table of tables) metadata.set(table, new Set((await db.prepare('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?').all(db.schema, table)).map(row => row.column_name)));
      for (const table of tables.filter(name => name !== 'faculties')) for (const original of source[table]) {
        const row = { ...original };
        if (table === 'users') {
          row.legacy_password_hash = row.password_hash || null;
          delete row.password_hash;
          // A legacy username does not prove ownership of a Neon identity.
          row.auth_user_id = null;
          if (avatars.has(row.id)) { row.avatar_object_key = avatars.get(row.id).key; row.avatar = `/api/avatars/${row.id}`; }
        }
        if (table === 'resources' || table === 'resource_versions') row.object_key = keys.get(row.stored_name);
        const columns = Object.keys(row).filter(key => metadata.get(table).has(key));
        const conflict = table === 'channels' ? ' ON CONFLICT(id,faculty_id) DO UPDATE SET name=excluded.name,description=excluded.description,read_only=excluded.read_only' : '';
        await db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})${conflict}`).run(...columns.map(key => row[key]));
      }
      for (const table of [...identityTables, 'modules']) {
        await db.prepare(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}),1), EXISTS(SELECT 1 FROM ${table}))`).get();
      }
      await applyStudentCommunityProfiles(db);
      const counts = Object.fromEntries(tables.map(table => [table, source[table].length]));
      await db.prepare('INSERT INTO legacy_imports (source_sha256,row_counts,imported_at) VALUES (?,?,?)').run(sourceHash, JSON.stringify(counts), new Date().toISOString());
    });
    return { ok: true, alreadyImported: false, counts: Object.fromEntries(tables.map(table => [table, source[table].length])), uploadedObjects: uploaded.length };
  } catch (error) {
    if (storage) {
      const cleanup = await Promise.allSettled(uploaded.map(key => storage.delete(key)));
      const failures = cleanup.filter(result => result.status === 'rejected').length;
      if (failures) console.error(`[CampusLink import] ${failures} temporary object cleanup operations failed.`);
    }
    throw error;
  } finally {
    if (ownDatabase) await db.close();
    if (ownStorage) storage?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  importLocal({ dataDir: process.env.CAMPUS_DATA_DIR || resolve('data') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'IMPORT_FAILED', reason: error.code ? undefined : error.message })); process.exitCode = 1; });
}
