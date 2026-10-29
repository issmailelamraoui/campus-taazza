import {moduleName,moduleCatalogKey} from './modules.js';
import {filiereBelongsToFaculty} from '../shared/studies.js';
import {resourceCategory,normalizeResourceCategory,RESOURCE_CATEGORIES} from '../shared/resource-categories.js';

const failure=(status,message,code)=>Object.assign(new Error(message),{status,...(code?{code}:{})});
const id=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw failure(400,'Identifiant du module invalide.');return n;};
const semesterOf=value=>{const n=Number(String(value??'').replace(/^s/i,''));if(!Number.isInteger(n)||n<1||n>6)throw failure(400,'Choisissez un semestre de S1 à S6.');return n;};
const clean=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw failure(400,`${label} invalide.`);return value.trim();};
const publicModule=row=>({id:row.id,name:row.name,faculty_id:row.faculty_id,filiere_id:row.filiere_id,semester:row.semester,catalog_status:row.catalog_status,curriculum_source:row.curriculum_source});

// Public uploads never call resolveModule: accepting a label must not create an
// academic identity, even when the request was made through a chat attachment.
export async function selectedOfficialModule(db,{moduleId,facultyId,filiereId,semester,lock=false}) {
  if(moduleId===undefined||moduleId===null||moduleId==='')throw failure(400,'Sélectionnez un module officiel existant.','MODULE_SELECTION_REQUIRED');
  const row=await db.prepare(`SELECT * FROM modules WHERE id=? AND faculty_id=? AND filiere_id=? AND semester=?${lock?' FOR SHARE':''}`).get(id(moduleId),facultyId,filiereId,semester);
  if(!row)throw failure(400,'Ce module ne correspond pas à la faculté, à la filière et au semestre sélectionnés.','MODULE_SCOPE_MISMATCH');
  if(row.catalog_status!=='official')throw failure(409,'Ce module doit être vérifié par l’administration avant un nouveau dépôt.','MODULE_NOT_OFFICIAL');
  return row;
}

export function installLibraryCatalog(app,{db,permissions,requireUser,resourcesFor}) {
  function canRead(user,faculty,filiere){return faculty===user.faculty_id&&!!user.filiere_id&&filiereBelongsToFaculty(faculty,user.filiere_id)&&filiere===user.filiere_id||permissions.can(user,'resource.manage',faculty,filiere)||permissions.can(user,'resource.upload',faculty,filiere);}
  function assertRead(user,faculty,filiere){if(!canRead(user,faculty,filiere))throw failure(403,'Cette bibliothèque appartient à une autre filière.');}
  function assertAdmin(user,faculty,filiere){if(!permissions.can(user,'resource.manage',faculty,filiere))throw failure(403,'Seule l’administration autorisée peut gérer le catalogue officiel.');}
  async function currentAdmin(req,faculty,filiere){const user=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(req.user.id);if(!user||user.disabled||user.account_status!=='approved'||user.session_version!==req.user.session_version||user.auth_user_id!==req.user.auth_user_id)throw failure(403,'Votre accès au compte a changé.');const actor=await permissions.load(user);assertAdmin(actor,faculty,filiere);return actor;}
  function queryScope(req){const faculty=String(req.query.faculty_id||req.user.faculty_id),filiere=String(req.query.filiere_id||req.user.filiere_id||'');if(!filiereBelongsToFaculty(faculty,filiere))throw failure(400,'Choisissez une filière de votre faculté.');assertRead(req.user,faculty,filiere);return {faculty,filiere,semester:semesterOf(req.query.semester)};}
  function bodyScope(req){const faculty=req.body.faculty_id||req.user.faculty_id,filiere=String(req.body.filiere_id||'');if(!filiereBelongsToFaculty(faculty,filiere))throw failure(400,'Choisissez une filière de la faculté.');assertAdmin(req.user,faculty,filiere);return {faculty,filiere,semester:semesterOf(req.body.semester)};}
  app.get('/api/modules',requireUser,async(req,res)=>{
    const {faculty,filiere,semester}=queryScope(req);
    const rows=await db.prepare(`SELECT * FROM modules WHERE faculty_id=? AND filiere_id=? AND semester=?${req.query.official==='1'?" AND catalog_status='official'":''} ORDER BY name,id`).all(faculty,filiere,semester);
    res.json({modules:rows.map(publicModule),official_only:req.query.official==='1',can_manage:permissions.can(req.user,'resource.manage',faculty,filiere)});
  });
  app.get('/api/library/modules/:id',requireUser,async(req,res)=>{
    const module=await db.prepare('SELECT * FROM modules WHERE id=?').get(id(req.params.id));
    if(!module)throw failure(404,'Module introuvable.');
    assertRead(req.user,module.faculty_id,module.filiere_id);
    const rows=await db.prepare(`SELECT r.* FROM resources r JOIN modules m ON r.module_id=m.id AND r.faculty_id=m.faculty_id AND r.filiere_id IS NOT DISTINCT FROM m.filiere_id AND r.semester IS NOT DISTINCT FROM m.semester WHERE m.id=? AND r.removed=0 AND r.library_visible=1 ORDER BY r.created_at DESC,r.id DESC`).all(module.id);
    const categories=new Map(RESOURCE_CATEGORIES.map(key=>[key,{key,count:0,owners:new Set()}]));
    for(const row of rows){const key=resourceCategory(row);if(!categories.has(key))categories.set(key,{key,count:0,owners:new Set()});const entry=categories.get(key);entry.count++;entry.owners.add(row.author_id);}
    const category=req.query.category===undefined?null:normalizeResourceCategory(String(req.query.category));
    const inCategory=category===null?rows:rows.filter(row=>resourceCategory(row)===category);
    const contributors=new Map();
    const dtos=await resourcesFor(inCategory,req.user);
    for(const row of dtos){const owner=row.uploader_id;const key=owner===null?'unknown':String(owner);let entry=contributors.get(key);if(!entry){entry={id:owner,name:row.author.name,username:row.author.username,avatar:row.author.avatar,count:0,paths:new Set()};contributors.set(key,entry);}entry.count++;if(row.relative_path?.includes('/'))entry.paths.add(row.relative_path.slice(0,row.relative_path.lastIndexOf('/')));}
    const uploader=req.query.uploader_id===undefined?undefined:req.query.uploader_id==='unknown'?null:id(req.query.uploader_id);
    const resources=uploader===undefined?dtos:dtos.filter(row=>row.uploader_id===uploader);
    res.json({module:publicModule(module),category,categories:[...categories.values()].map(({owners,...entry})=>({...entry,contributors:owners.size})),contributors:[...contributors.values()].map(({paths,...entry})=>({...entry,paths:[...paths]})),resources});
  });
  app.post('/api/admin/modules',requireUser,async(req,res)=>{
    const {faculty,filiere,semester}=bodyScope(req),name=moduleName(clean(req.body.name,'Nom du module',120)),source=clean(req.body.curriculum_source,'Source du programme officiel',2000),key=moduleCatalogKey(name);
    if(req.body.confirmed!==true)throw failure(400,'Confirmez la vérification du programme officiel.');
    const result=await db.transaction(async()=>{
      const actor=await currentAdmin(req,faculty,filiere);
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(JSON.stringify(['module-catalog',db.schema,faculty,filiere,semester,key]));
      const candidates=await db.prepare('SELECT id,name,catalog_status FROM modules WHERE faculty_id=? AND filiere_id=? AND semester=?').all(faculty,filiere,semester);
      if(candidates.some(row=>moduleCatalogKey(row.name)===key))throw failure(409,'Ce nom existe déjà. Vérifiez le module existant au lieu de créer un doublon.','MODULE_ALREADY_EXISTS');
      const row=await db.prepare("INSERT INTO modules(faculty_id,filiere_id,semester,name,catalog_status,catalog_key,curriculum_source,verified_by,verified_at) VALUES(?,?,?,?,'official',?,?,?,?) RETURNING *").get(faculty,filiere,semester,name,key,source,actor.id,new Date().toISOString());
      await permissions.audit(actor,'module.catalog.create','module',row.id,{faculty_id:faculty,filiere_id:filiere,semester,name,curriculum_source:source});return row;
    });
    res.status(201).json({module:publicModule(result)});
  });
  app.patch('/api/admin/modules/:id',requireUser,async(req,res)=>{
    const result=await db.transaction(async()=>{
      const row=await db.prepare('SELECT * FROM modules WHERE id=? FOR UPDATE').get(id(req.params.id));if(!row)throw failure(404,'Module introuvable.');const actor=await currentAdmin(req,row.faculty_id,row.filiere_id);
      if(!filiereBelongsToFaculty(row.faculty_id,row.filiere_id)||!row.semester)throw failure(400,'Le périmètre historique doit être vérifié séparément. Aucune réaffectation automatique.');
      if(Object.keys(req.body).some(key=>!['catalog_status','curriculum_source','confirmed'].includes(key)))throw failure(400,'Ce formulaire ne modifie ni le nom ni les associations historiques.');
      const status=req.body.catalog_status||'official';if(!['legacy','official'].includes(status))throw failure(400,'Statut du catalogue invalide.');
      const source=status==='official'?clean(req.body.curriculum_source,'Source du programme officiel',2000):row.curriculum_source;
      if(req.body.confirmed!==true)throw failure(400,'Confirmez la vérification du programme officiel.');
      const key=moduleCatalogKey(row.name);
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(JSON.stringify(['module-catalog',db.schema,row.faculty_id,row.filiere_id,row.semester,key]));
      const duplicate=await db.prepare("SELECT id FROM modules WHERE faculty_id=? AND filiere_id=? AND semester=? AND catalog_status='official' AND catalog_key=? AND id<>?").get(row.faculty_id,row.filiere_id,row.semester,key,row.id);
      if(status==='official'&&duplicate)throw failure(409,'Un module officiel utilise déjà ce nom normalisé. Préparez un plan de consolidation.','MODULE_ALREADY_EXISTS');
      await db.prepare('UPDATE modules SET catalog_status=?,catalog_key=?,curriculum_source=?,verified_by=?,verified_at=? WHERE id=?').run(status,key,source,status==='official'?actor.id:null,status==='official'?new Date().toISOString():null,row.id);
      await permissions.audit(actor,'module.catalog.verify','module',row.id,{previous_status:row.catalog_status,catalog_status:status,curriculum_source:source});
      return {...row,catalog_status:status,curriculum_source:source};
    });res.json({module:publicModule(result)});
  });
}
