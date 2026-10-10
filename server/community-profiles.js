import { readFile } from 'node:fs/promises';

const migration = new URL('./migrations/003_student_community_profiles.sql', import.meta.url);

// A fresh legacy import happens after schema migrations. Apply the same scoped
// profile upgrade once after import or demo seeding so every setup agrees.
export async function applyStudentCommunityProfiles(db) {
  const sql = await readFile(migration, 'utf8');
  await db.transaction(async () => { await db.exec(sql); });
}
