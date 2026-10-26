// Module identity is scoped to a faculty, a programme and a semester. Keep the
// display label from the first upload; spelling variants share its database ID.
export const moduleName = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
export const MODULE_NAME_SQL = "lower(regexp_replace(trim(normalize(name,NFKC)), '\\s+', ' ', 'g'))";
export const RESOURCE_MODULE_SQL = "lower(regexp_replace(trim(normalize(module,NFKC)), '\\s+', ' ', 'g'))";

// Fixed aliases keep catalog reads and cleanup aligned, including old rows
// whose module_id was absent but whose canonical academic label is known.
export const SCOPED_MODULE_RESOURCE_SQL = `r.faculty_id=m.faculty_id
  AND r.filiere_id IS NOT DISTINCT FROM m.filiere_id
  AND r.semester IS NOT DISTINCT FROM m.semester
  AND (r.module_id=m.id OR ${RESOURCE_MODULE_SQL.replace(/\bmodule\b/g, 'r.module')}=${MODULE_NAME_SQL.replace(/\bname\b/g, 'm.name')})`;

export async function lockModuleIdentity(db, { facultyId, filiereId = null, semester = null, name }) {
  // PostgreSQL lower() must agree with the unique index even for Unicode case
  // mappings. Resource creation and removal hold this lock in their transaction.
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?),hashtext(lower(?)))').get(
    JSON.stringify(['campuslink-module', db.schema, facultyId, filiereId, semester]), moduleName(name),
  );
}

export async function lockResourceModule(db, resource) {
  if (!resource?.faculty_id) return null;
  const scope = { facultyId: resource.faculty_id, filiereId: resource.filiere_id ?? null, semester: resource.semester ?? null };
  const linked = resource.module_id ? await db.prepare(`SELECT name FROM modules WHERE id=? AND faculty_id=?
    AND filiere_id IS NOT DISTINCT FROM ? AND semester IS NOT DISTINCT FROM ?`).get(resource.module_id, scope.facultyId, scope.filiereId, scope.semester) : null;
  scope.name = moduleName(linked?.name || resource.module);
  if (!scope.name) return null;
  await lockModuleIdentity(db, scope);
  return scope;
}

export async function pruneRemovedResourceModule(db, resource) {
  return db.transaction(async () => {
    const scope = await lockResourceModule(db, resource);
    if (!scope) return false;
    const module = await db.prepare(`SELECT id,name FROM modules WHERE faculty_id=?
      AND filiere_id IS NOT DISTINCT FROM ? AND semester IS NOT DISTINCT FROM ?
      AND ${MODULE_NAME_SQL}=lower(?) ORDER BY id LIMIT 1 FOR UPDATE`).get(scope.facultyId, scope.filiereId, scope.semester, scope.name);
    if (!module) return false;
    const active = await db.prepare(`SELECT 1 FROM resources WHERE faculty_id=?
      AND filiere_id IS NOT DISTINCT FROM ? AND semester IS NOT DISTINCT FROM ? AND removed=0
      AND (module_id=? OR ${RESOURCE_MODULE_SQL}=lower(?)) LIMIT 1`).get(scope.facultyId, scope.filiereId, scope.semester, module.id, scope.name);
    if (active) return false; // Chat-only and supporting files count as active.
    // Do not repair another scope's legacy FK while removing this module.
    const foreignReference = await db.prepare(`SELECT 1 FROM resources WHERE module_id=? AND
      (faculty_id IS DISTINCT FROM ? OR filiere_id IS DISTINCT FROM ? OR semester IS DISTINCT FROM ?) LIMIT 1`)
      .get(module.id, scope.facultyId, scope.filiereId, scope.semester);
    if (foreignReference) return false;
    await db.prepare(`UPDATE resources SET module_id=NULL WHERE module_id=? AND removed=1
      AND faculty_id=? AND filiere_id IS NOT DISTINCT FROM ? AND semester IS NOT DISTINCT FROM ?`)
      .run(module.id, scope.facultyId, scope.filiereId, scope.semester);
    const result = await db.prepare('DELETE FROM modules WHERE id=?').run(module.id);
    return result.changes > 0;
  });
}

export async function resolveModule(db, { facultyId, filiereId = null, semester = null, name }) {
  const label = moduleName(name);
  await lockModuleIdentity(db, { facultyId, filiereId, semester, name: label });
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
