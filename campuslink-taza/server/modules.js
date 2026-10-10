// Module identity is scoped to a faculty, a programme and a semester. Keep the
// display label from the first upload; spelling variants share its database ID.
export const moduleName = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
export const MODULE_NAME_SQL = "lower(regexp_replace(trim(normalize(name,NFKC)), '\\s+', ' ', 'g'))";
export const RESOURCE_MODULE_SQL = "lower(regexp_replace(trim(normalize(module,NFKC)), '\\s+', ' ', 'g'))";

export async function resolveModule(db, { facultyId, filiereId = null, semester = null, name }) {
  const label = moduleName(name);
  const existing = await db.prepare(`SELECT id,name FROM modules
    WHERE faculty_id=? AND filiere_id IS NOT DISTINCT FROM ?
      AND semester IS NOT DISTINCT FROM ? AND ${MODULE_NAME_SQL}=lower(?)
    ORDER BY id LIMIT 1`).get(facultyId, filiereId, semester, label);
  if (existing) return existing;
  // The normalized unique index handles races even outside a transaction.
  // A concurrent uploader keeps the first label rather than renaming a folder.
  return db.prepare(`INSERT INTO modules (faculty_id,filiere_id,semester,name)
    VALUES (?,?,?,?) ON CONFLICT (faculty_id,filiere_id,semester,${MODULE_NAME_SQL})
    DO UPDATE SET name=modules.name RETURNING id,name`).get(facultyId, filiereId, semester, label);
}
