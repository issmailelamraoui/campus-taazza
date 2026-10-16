import { moduleName } from './modules.js';

const problem = (status, message) => Object.assign(new Error(message), { status });

export function moduleShareResourceId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) throw problem(400, 'Référence du module invalide.');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw problem(400, 'Référence du module invalide.');
  return id;
}

// Call within the existing message transaction, after channel write validation.
// The browser supplies one document ID; every scope field comes from the DB.
export async function attachModuleShare(db, messageId, resourceId, user) {
  if (!resourceId) return;
  const resource = await db.prepare('SELECT * FROM resources WHERE id=? FOR SHARE').get(resourceId);
  if (!resource || resource.removed || resource.library_visible !== 1 ||
      resource.faculty_id !== user.faculty_id || resource.filiere_id !== user.filiere_id ||
      !Number.isInteger(resource.semester) || resource.semester < 1 || resource.semester > 6) {
    throw problem(403, 'Ce module ne peut pas être partagé depuis votre bibliothèque.');
  }
  await db.prepare('INSERT INTO message_module_shares (message_id,resource_id,faculty_id,filiere_id,semester,module) VALUES (?,?,?,?,?,?)')
    .run(messageId, resourceId, resource.faculty_id, resource.filiere_id, resource.semester, moduleName(resource.module));
}

export async function assertSameModuleShare(db, messageId, resourceId) {
  const prior = await db.prepare('SELECT resource_id FROM message_module_shares WHERE message_id=?').get(messageId);
  if ((prior?.resource_id ?? null) !== resourceId) throw problem(409, 'Cet identifiant correspond déjà à un autre message.');
}

export async function moduleSharesFor(db, messageIds, viewerId) {
  if (!messageIds.length) return new Map();
  const rows = await db.prepare(`SELECT s.*,
      (u.faculty_id=s.faculty_id AND u.filiere_id=s.filiere_id AND EXISTS (
        SELECT 1 FROM resources r WHERE r.faculty_id=s.faculty_id AND r.filiere_id=s.filiere_id
          AND r.semester=s.semester AND r.removed=0 AND r.library_visible=1
          AND lower(regexp_replace(trim(normalize(r.module,NFKC)), '\\s+', ' ', 'g'))=lower(s.module)
      )) AS accessible
    FROM message_module_shares s JOIN users u ON u.id=? WHERE s.message_id=ANY(?)`).all(viewerId, messageIds);
  return new Map(rows.map(({ message_id, ...share }) => [message_id, share]));
}
