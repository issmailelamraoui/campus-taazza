// Module identity is scoped to a faculty, a programme and a semester. Historical
// imports retain their labels; public uploads select a verified existing ID.
export const moduleName = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
export const moduleCatalogKey = value => moduleName(value).normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase().replace(/\s+/g,' ');
export const MODULE_NAME_SQL = "lower(regexp_replace(trim(normalize(name,NFKC)), '\\s+', ' ', 'g'))";
export const RESOURCE_MODULE_SQL = "lower(regexp_replace(trim(normalize(module,NFKC)), '\\s+', ' ', 'g'))";

// Fixed aliases keep catalog reads and cleanup aligned, including old rows
// whose module_id was absent but whose canonical academic label is known.
export const SCOPED_MODULE_RESOURCE_SQL = `r.faculty_id=m.faculty_id
  AND r.filiere_id IS NOT DISTINCT FROM m.filiere_id
  AND r.semester IS NOT DISTINCT FROM m.semester
  AND (r.module_id=m.id OR (r.module_id IS NULL AND ${RESOURCE_MODULE_SQL.replace(/\bmodule\b/g, 'r.module')}=${MODULE_NAME_SQL.replace(/\bname\b/g, 'm.name')}))`;

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
  // Contributor folders are virtual. Only a truly unreferenced legacy module
  // may disappear from storage; soft-deleted files are still references.
  const moduleId=Number(resource?.module_id);
  if(!Number.isSafeInteger(moduleId)||moduleId<1)return false;
  return db.transaction(async()=>{
    const candidate=await db.prepare('SELECT * FROM modules WHERE id=?').get(moduleId);
    if(!candidate||candidate.catalog_status==='official'||candidate.faculty_id!==resource.faculty_id
      ||(candidate.filiere_id??null)!==(resource.filiere_id??null)||(candidate.semester??null)!==(resource.semester??null))return false;
    await lockModuleIdentity(db,{facultyId:candidate.faculty_id,filiereId:candidate.filiere_id,semester:candidate.semester,name:candidate.name});
    const module=await db.prepare('SELECT * FROM modules WHERE id=? FOR UPDATE').get(moduleId);
    if(!module||module.catalog_status==='official'||module.faculty_id!==candidate.faculty_id
      ||(module.filiere_id??null)!==(candidate.filiere_id??null)||(module.semester??null)!==(candidate.semester??null)
      ||moduleName(module.name)!==moduleName(candidate.name))return false;
    if(await db.prepare(`SELECT 1 FROM resources r WHERE r.module_id=? OR (r.module_id IS NULL
      AND r.faculty_id=? AND r.filiere_id IS NOT DISTINCT FROM ? AND r.semester IS NOT DISTINCT FROM ?
      AND ${RESOURCE_MODULE_SQL.replace(/\bmodule\b/g,'r.module')}=lower(?)) LIMIT 1`)
      .get(module.id,module.faculty_id,module.filiere_id,module.semester,moduleName(module.name)))return false;
    if(await hasModuleDependents(db,module))return false;
    return (await db.prepare('DELETE FROM modules WHERE id=?').run(module.id)).changes===1;
  });
}

const quoteIdentifier=value=>'"'+String(value).replaceAll('"','""')+'"';
function moduleContext(value,module) {
  if(typeof value==='string'){
    try{return moduleContext(JSON.parse(value),module);}catch{}
    if(!/[/?]/.test(value))return false;
    try{const url=new URL(value,'http://campuslink.local'),reference=url.searchParams.get('module');
      if(reference&&(reference===`id:${module.id}`||moduleCatalogKey(reference)===moduleCatalogKey(module.name)))return true;
      const last=decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)||'');
      const slug=text=>moduleCatalogKey(text).replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'');
      if(slug(last)&&slug(last)===slug(module.name))return true;
    }catch{}
    return false;
  }
  if(!value||typeof value!=='object')return false;
  if(Array.isArray(value)){
    if(value.length&&value.every(item=>Array.isArray(item)&&item.length===2&&typeof item[0]==='string')
      &&moduleContext(Object.fromEntries(value),module))return true;
    return value.some(item=>moduleContext(item,module));
  }
  if(['module_id','moduleId','base_module_id'].some(key=>value[key]!=null&&Number(value[key])===module.id))return true;
  if(['module','module_name','base_module'].some(key=>typeof value[key]==='string'&&moduleCatalogKey(value[key])===moduleCatalogKey(module.name)))return true;
  if(value.target_type==='module'&&Number(value.target_id)===module.id)return true;
  return Object.values(value).some(item=>moduleContext(item,module));
}

async function hasModuleDependents(db,module) {
  // Do not rely on ON DELETE behaviour: even cascading/SET NULL relationships
  // must prevent automatic pruning. Catalog names are trusted identifiers only
  // after identifier quoting; all values remain bound parameters.
  const foreignKeys=(await db.query(`SELECT ns.nspname AS schema_name,c.relname AS table_name,a.attname AS column_name
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
    JOIN pg_class target ON target.oid=con.confrelid JOIN pg_namespace tn ON tn.oid=target.relnamespace
    JOIN LATERAL unnest(con.conkey,con.confkey) AS keys(source_number,target_number) ON TRUE
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=keys.source_number
    JOIN pg_attribute ta ON ta.attrelid=target.oid AND ta.attnum=keys.target_number
    WHERE con.contype='f' AND tn.nspname=$1 AND target.relname='modules' AND ta.attname='id'`,[db.schema])).rows;
  for(const ref of foreignKeys){
    if((await db.query(`SELECT 1 FROM ${quoteIdentifier(ref.schema_name)}.${quoteIdentifier(ref.table_name)} WHERE ${quoteIdentifier(ref.column_name)}=$1 LIMIT 1`,[module.id])).rows.length)return true;
  }
  const columns=(await db.query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1
    AND (column_name IN ('module','module_name','base_module','module_id','moduleId','base_module_id','target_type','target_id','path','details','target_context','fields','push_context','payload','change','metadata','context')
      OR data_type IN ('json','jsonb'))`,[db.schema])).rows;
  const tables=new Map();for(const column of columns){if(!tables.has(column.table_name))tables.set(column.table_name,[]);tables.get(column.table_name).push(column);}
  for(const [name,fields] of tables){
    if(name==='modules'||name==='resources')continue;
    const table=`${quoteIdentifier(db.schema)}.${quoteIdentifier(name)}`;
    if(fields.some(field=>field.column_name==='target_type')&&fields.some(field=>field.column_name==='target_id')){
      if((await db.query(`SELECT 1 FROM ${table} WHERE target_type='module' AND target_id::text=$1 LIMIT 1`,[String(module.id)])).rows.length)return true;
    }
    for(const field of fields){
      const column=quoteIdentifier(field.column_name);
      if(['module_id','moduleId','base_module_id'].includes(field.column_name)){
        if((await db.query(`SELECT 1 FROM ${table} WHERE ${column}::text=$1 LIMIT 1`,[String(module.id)])).rows.length)return true;
      }else if(['module','module_name','base_module'].includes(field.column_name)){
        // Tables without a full semester scope are ambiguous; retaining an
        // unrelated same-name module is safer than deleting a possible link.
        if((await db.query(`SELECT 1 FROM ${table} WHERE lower(regexp_replace(trim(normalize(${column}::text,NFKC)), '\\s+', ' ', 'g'))=lower($1) LIMIT 1`,[moduleName(module.name)])).rows.length)return true;
      }else if(['path','details','target_context','fields','push_context','payload','change','metadata','context'].includes(field.column_name)||['json','jsonb'].includes(field.data_type)){
        const rows=(await db.query(`SELECT ${column} AS context FROM ${table} WHERE ${column} IS NOT NULL`)).rows;
        if(rows.some(row=>moduleContext(row.context,module)))return true;
      }
    }
  }
  return false;
}

export async function resolveModule(db, { facultyId, filiereId = null, semester = null, name }) {
  // Internal import/seed helper only. Public upload handlers must use
  // selectedOfficialModule rather than admitting arbitrary labels here.
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
