import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { applyStudentCommunityProfiles } from '../server/community-profiles.js';

async function fixture(callback) {
  const schema = `campuslink_profiles_test_${randomUUID().replaceAll('-', '')}`;
  const db = await openDatabase({ schema });
  const objects = new Map();
  const storage = { async put(key, value) { objects.set(key, Buffer.from(value)); }, async delete(key) { objects.delete(key); } };
  try { await seedDatabase(db, { demo: true, storage }); await callback(db, objects); }
  finally { await db.exec(`DROP SCHEMA "${schema}" CASCADE`); await db.close(); }
}

test('fresh demo seed uses the owner student profile and retains professor academic files without professor conversations', { skip: !process.env.DATABASE_URL }, async () => {
  await fixture(async (db, objects) => {
    const owner = await db.prepare('SELECT * FROM users WHERE username=?').get('admin');
    assert.equal(owner.name, 'Issmail');
    assert.equal(owner.role, 'global_admin');
    assert.equal(owner.faculty_id, 'fsa');
    assert.equal(owner.filiere_id, 'data_science');
    assert.equal(owner.auth_user_id, null);
    const professor = await db.prepare('SELECT * FROM users WHERE username=?').get('professeure');
    assert.equal(professor.name, 'Ancien membre');
    assert.equal(professor.disabled, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id=? AND removed=0').get(professor.id)).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM announcements WHERE author_id=?').get(professor.id)).n, 0);
    assert.ok((await db.prepare('SELECT COUNT(*) AS n FROM resources WHERE author_id=? AND removed=0').get(professor.id)).n > 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n, 17);
    assert.equal(objects.size, 17);
    assert.equal((await db.prepare('SELECT disabled FROM users WHERE username=?').get('salma')).disabled, 0);
  });
});

test('profile upgrade preserves owner authentication, faculty administrators and academic resources and is idempotent', { skip: !process.env.DATABASE_URL }, async () => {
  await fixture(async (db, objects) => {
    await db.prepare("UPDATE users SET name='Administration',faculty_id='flaa',filiere_id='french_studies',auth_user_id=?,email=? WHERE username='admin'").run('existing-owner-identity', 'existing-owner@campuslink.test');
    await db.prepare("UPDATE users SET name='Pr. Nadia El Idrissi',disabled=0,session_version=4,auth_revoked_at=NULL WHERE username='professeure'").run();
    const resource = await db.prepare('SELECT * FROM resources WHERE author_id=7 ORDER BY id LIMIT 1').get();
    const date = new Date().toISOString();
    const messageId = (await db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at,resource_id,pinned) VALUES (?,?,?,?,?,?,?)').run('flaa', 'general', 'Old professor conversation', 7, date, resource.id, 1)).lastInsertRowid;
    await db.prepare('UPDATE resources SET message_id=? WHERE id=?').run(messageId, resource.id);
    const linkedAnnouncement = (await db.prepare('INSERT INTO announcements (faculty_id,content,message_id,author_id,created_at) VALUES (?,?,?,?,?)').run('flaa', 'Pinned old professor conversation', messageId, 2, date)).lastInsertRowid;
    const professorAnnouncement = (await db.prepare('INSERT INTO announcements (faculty_id,content,author_id,created_at) VALUES (?,?,?,?)').run('flaa', 'Standalone professor announcement', 7, date)).lastInsertRowid;
    const studentMessageId = (await db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at,pinned) VALUES (?,?,?,?,?,?)').run('flaa', 'general', 'Student conversation remains', 3, date, 1)).lastInsertRowid;
    const studentAnnouncement = (await db.prepare('INSERT INTO announcements (faculty_id,content,message_id,author_id,created_at) VALUES (?,?,?,?,?)').run('flaa', 'Student announcement remains', studentMessageId, 3, date)).lastInsertRowid;
    const before = {
      resources: (await db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n,
      messages: (await db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n,
      salma: await db.prepare('SELECT * FROM users WHERE username=?').get('salma'),
      key: resource.object_key,
      bytes: Buffer.from(objects.get(resource.object_key)),
    };
    await applyStudentCommunityProfiles(db);
    const owner = await db.prepare('SELECT * FROM users WHERE username=?').get('admin');
    assert.equal(owner.name, 'Issmail');
    assert.equal(owner.faculty_id, 'fsa');
    assert.equal(owner.filiere_id, 'data_science');
    assert.equal(owner.auth_user_id, 'existing-owner-identity');
    assert.equal(owner.email, 'existing-owner@campuslink.test');
    assert.equal(owner.role, 'global_admin');
    assert.equal(owner.current_semester, 1);
    const professor = await db.prepare('SELECT * FROM users WHERE username=?').get('professeure');
    assert.equal(professor.disabled, 1);
    assert.equal(professor.name, 'Ancien membre');
    assert.equal(professor.session_version, 5);
    assert.ok(Number.isFinite(Date.parse(professor.auth_revoked_at)));
    const hidden = await db.prepare('SELECT removed,pinned FROM messages WHERE id=?').get(messageId);
    assert.equal(hidden.removed, 1);
    assert.equal(hidden.pinned, 0);
    assert.equal(await db.prepare('SELECT id FROM announcements WHERE id=?').get(linkedAnnouncement), undefined);
    assert.equal(await db.prepare('SELECT id FROM announcements WHERE id=?').get(professorAnnouncement), undefined);
    const preserved = await db.prepare('SELECT * FROM resources WHERE id=?').get(resource.id);
    assert.equal(preserved.message_id, null);
    assert.equal(preserved.object_key, before.key);
    assert.equal(preserved.removed, 0);
    assert.deepEqual(objects.get(preserved.object_key), before.bytes);
    assert.deepEqual(await db.prepare('SELECT * FROM users WHERE username=?').get('salma'), before.salma);
    assert.equal((await db.prepare('SELECT removed,pinned FROM messages WHERE id=?').get(studentMessageId)).removed, 0);
    assert.ok(await db.prepare('SELECT id FROM announcements WHERE id=?').get(studentAnnouncement));
    await applyStudentCommunityProfiles(db);
    const repeated = await db.prepare('SELECT session_version,auth_revoked_at FROM users WHERE username=?').get('professeure');
    assert.equal(repeated.session_version, professor.session_version);
    assert.equal(repeated.auth_revoked_at, professor.auth_revoked_at);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n, before.resources);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n, before.messages);
    assert.equal(objects.size, 17);
  });
});
