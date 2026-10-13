import { randomUUID, createHash } from 'node:crypto';
import { extname } from 'node:path';
import { digest } from './db.js';
import { detectFile } from './files.js';
import { uploadFilePath } from './upload-path.js';
import { resourceObjectKey, storageObjectKey } from './storage.js';
import { yearsOf, yearsOverlap, compareAcademicYears, academicYear } from './academic-years.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const integer = value => { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Référence de document invalide.'); return id; };
const moduleKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
const category = row => ['td','tp','correction','corrections'].includes(row.resource_type) ? row.resource_type.replace(/^correction$/, 'corrections') : row.category;
export const SUPPLEMENT_POLICY = Object.freeze({ perMain: 20, fileBytes: 20 * 1024 * 1024, accountBytes: 1024 * 1024 * 1024, uploadsPerDay: 50, linksPerDay: 100 });
export function supplementScopeMatches(main, child) {
  return !!main && !!child && main.id !== child.id && !main.removed && !child.removed && main.library_visible !== 0 && child.library_visible === 0 && main.faculty_id === child.faculty_id && main.filiere_id === child.filiere_id && main.semester === child.semester && moduleKey(main.module) === moduleKey(child.module) && category(main) === category(child) && main.part_number === child.part_number && yearsOverlap(yearsOf(main), yearsOf(child));
}
// The parent is always a visible main resource, so this cannot recurse through
// chains of hidden uploads. Current membership and classification apply on every
// preview/download, including after unlinking, deletion or reassignment.
export async function canReadSupplement(resource, req, { db, assertMain }) {
  if (!resource || resource.removed || resource.library_visible !== 0) return false;
  const links = await db.prepare(`SELECT s.main_resource_id FROM resource_supplements s JOIN resources r ON r.id=s.main_resource_id
    WHERE s.supplement_resource_id=? AND r.removed=0 AND r.library_visible=1 AND r.faculty_id=? AND r.filiere_id=? AND r.semester=?
      AND lower(normalize(regexp_replace(trim(r.module),'\\s+',' ','g'),NFKC))=? AND r.part_number=?
      AND (CASE WHEN r.resource_type IN ('td','tp','corrections') THEN r.resource_type WHEN r.resource_type='correction' THEN 'corrections' ELSE r.category END)=?
      AND ${yearsOf(resource).length ? '(r.academic_year=ANY(?) OR jsonb_exists_any(r.academic_years,?::text[]))' : "r.academic_year IS NULL AND jsonb_array_length(r.academic_years)=0"} LIMIT 20`)
    .all(resource.id,resource.faculty_id,resource.filiere_id,resource.semester,moduleKey(resource.module),resource.part_number,category(resource),...(yearsOf(resource).length?[yearsOf(resource),yearsOf(resource)]:[]));
  for (const link of links) {
    const main = await db.prepare('SELECT * FROM resources WHERE id=? AND removed=0 AND library_visible=1').get(link.main_resource_id);
    if (!supplementScopeMatches(main, resource)) continue;
    try { const fresh = await assertMain(main.id, req); if (supplementScopeMatches(fresh, resource)) return true; }
    catch (error) { if (![403,404].includes(error.status)) throw error; }
  }
  return false;
}
export function installResourceSupplementRoutes(app, { db, requireFaculty, assertResource, permissions, upload, storage, resourceDTO, broadcast }) {
  async function freshActor(req,lock=false){const row=await db.prepare(`SELECT * FROM users WHERE id=?${lock?' FOR SHARE':''}`).get(req.user.id);if(!row||row.disabled||row.account_status!=='approved'||!row.faculty_id)throw failure(403,'Votre compte ou votre accès a changé.');return permissions.load(row);}
  const mayUnlink=(actor,main,child,link)=>permissions.can(actor,'resource.manage',main.faculty_id,main.filiere_id)||main.author_id===actor.id||child.author_id===actor.id||link.linked_by===actor.id;
  const mayCleanup=(actor,main,link)=>permissions.can(actor,'resource.manage',main.faculty_id,main.filiere_id)||main.author_id===actor.id||link.linked_by===actor.id;
  async function verifyStoredBytes(row) {
    const file=await storage.get(row.object_key),hash=createHash('sha256');let count=0,timer;
    try{const read=(async()=>{for await(const chunk of file.body){count+=chunk.length;if(count>row.size||count>SUPPLEMENT_POLICY.fileBytes)throw failure(409,'Le fichier stocké ne correspond plus à sa version validée.');hash.update(chunk);}if(count!==row.size||hash.digest('hex')!==row.sha256)throw failure(409,'Le fichier stocké ne correspond plus à sa version validée.');})();await Promise.race([read,new Promise((_,reject)=>{timer=setTimeout(()=>{file.body?.destroy?.();reject(failure(504,'Le stockage a mis trop de temps à répondre. Réessayez.'));},20000);})]);}finally{clearTimeout(timer);file.body?.destroy?.();}
  }
  async function mainResource(req, id) {
    const main = await assertResource(id, req);
    if (main.library_visible === 0 || !main.filiere_id || !main.semester || !moduleKey(main.module) || !main.part_number) throw failure(400, 'Choisissez un document principal classé dans la bibliothèque.');
    return main;
  }
  async function allowed(req, main) { return permissions.assertUpload(req.user, main.faculty_id, main.filiere_id, main.semester); }
  async function linked(main, child, actor) {
    if (!supplementScopeMatches(main, child)) throw failure(400, 'Le complément doit reprendre le module, semestre, catégorie, partie et année du document principal et rester hors de la liste principale.');
    const duplicate = await db.prepare('SELECT 1 FROM resource_supplements WHERE main_resource_id=? AND supplement_resource_id=?').get(main.id, child.id); if (duplicate) return true;
    const count = await db.prepare('SELECT COUNT(*)::integer AS count FROM resource_supplements WHERE main_resource_id=?').get(main.id);
    if (count.count >= SUPPLEMENT_POLICY.perMain) throw failure(429, 'Ce document possède déjà vingt compléments.');
    const recent = await db.prepare('SELECT COUNT(*)::integer AS count FROM resource_supplements WHERE linked_by=? AND created_at>=?').get(actor.id, new Date(Date.now()-86400000).toISOString());
    if (recent.count >= SUPPLEMENT_POLICY.linksPerDay) throw failure(429, 'La limite quotidienne de liens complémentaires est atteinte.');
    await db.prepare('INSERT INTO resource_supplements(main_resource_id,supplement_resource_id,linked_by,created_at) VALUES(?,?,?,?)').run(main.id, child.id, actor.id, new Date().toISOString());
    await permissions.audit(actor, 'resource.supplement.link', 'resource', main.id, { supplement_resource_id: child.id }); return false;
  }
  app.get('/api/resource-supplements/:mainId', requireFaculty, async (req,res) => {
    const main = await mainResource(req, integer(req.params.mainId));
    const rows = await db.prepare('SELECT r.*,s.linked_by FROM resource_supplements s JOIN resources r ON r.id=s.supplement_resource_id WHERE s.main_resource_id=? ORDER BY s.created_at,r.id LIMIT ?').all(main.id,SUPPLEMENT_POLICY.perMain), items = [];
    const fresh = await mainResource(req,main.id),actor=await freshActor(req);let canManage = false;
    const available=rows.filter(row=>supplementScopeMatches(fresh,row));available.sort((a,b)=>compareAcademicYears(a,b,req.user.current_academic_year||academicYear(process.env.CAMPUS_ACADEMIC_YEAR)));
    for (const row of available) {const{linked_by,...child}=row;items.push({...await resourceDTO(child,req.user),available:true,can_unlink:mayUnlink(actor,fresh,child,{linked_by})});}
    for(const row of rows)if(!supplementScopeMatches(fresh,row)&&mayCleanup(actor,fresh,row))items.push({id:row.id,available:false,can_unlink:true});
    try { await db.transaction(async()=>{await allowed(req,fresh);}); canManage = true; } catch (error) { if (error.status !== 403) throw error; }
    res.set('Cache-Control','private, no-store').json({ mainResourceId: main.id, items, canManage, remainingSlots:Math.max(0,SUPPLEMENT_POLICY.perMain-rows.length), policy: SUPPLEMENT_POLICY });
  });
  app.post('/api/resource-supplements/:mainId', requireFaculty, async (req,res) => {
    const mainId=integer(req.params.mainId),childId=integer(req.body.resource_id); if(mainId===childId)throw failure(400,'Un document ne peut pas être son propre complément.');
    const result=await db.transaction(async()=>{
      const initial=await mainResource(req,mainId),actor=await allowed(req,initial);
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`resource-supplements:${mainId}`);
      await db.prepare('SELECT id FROM resources WHERE id=ANY(?) ORDER BY id FOR SHARE').all([mainId,childId]);
      const main=await mainResource(req,mainId),child=await assertResource(childId,req);
      const reused=await linked(main,child,actor);return {resource:await resourceDTO(child,req.user),reused};
    });
    if(broadcast)await broadcast(req.user.faculty_id,req.user.filiere_id);res.set('Cache-Control','private, no-store').status(result.reused?200:201).json(result);
  });
  app.delete('/api/resource-supplements/:mainId/:childId',requireFaculty,async(req,res)=>{
    const mainId=integer(req.params.mainId),childId=integer(req.params.childId);
    await db.transaction(async()=>{await mainResource(req,mainId);await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`resource-supplements:${mainId}`);await db.prepare('SELECT id FROM resources WHERE id=ANY(?) ORDER BY id FOR SHARE').all([mainId,childId]);const fresh=await mainResource(req,mainId),actor=await freshActor(req,true),link=await db.prepare('SELECT * FROM resource_supplements WHERE main_resource_id=? AND supplement_resource_id=? FOR UPDATE').get(mainId,childId);if(!link)return;const stored=await db.prepare('SELECT * FROM resources WHERE id=?').get(childId);let permitted;if(!supplementScopeMatches(fresh,stored))permitted=mayCleanup(actor,fresh,link);else{const child=await assertResource(childId,req);permitted=mayUnlink(actor,fresh,child,link);}if(!permitted)throw failure(403,'Vous pouvez retirer vos propres compléments. Les autres liens nécessitent la permission de gestion du document.');const result=await db.prepare('DELETE FROM resource_supplements WHERE main_resource_id=? AND supplement_resource_id=?').run(mainId,childId);if(result.changes)await permissions.audit(actor,'resource.supplement.unlink','resource',mainId,{supplement_resource_id:childId,unavailable:!supplementScopeMatches(fresh,stored)});});
    if(broadcast)await broadcast(req.user.faculty_id,req.user.filiere_id);res.json({ok:true});
  });
  app.post('/api/resource-supplements/:mainId/upload',requireFaculty,upload.single('file'),async(req,res)=>{
    const mainId=integer(req.params.mainId);if(!req.file?.buffer?.length||req.file.size!==req.file.buffer.length||req.file.size>SUPPLEMENT_POLICY.fileBytes)throw failure(400,'Choisissez un fichier éducatif de 20 Mo maximum.');
    const {filename,relativePath:path}=uploadFilePath(req.file.originalname,req.body.relative_path),mime=detectFile(req.file.buffer,filename),hash=digest(req.file.buffer),title=req.body.title===undefined?(filename.replace(/\.[^.]+$/,'').slice(0,180)||filename):req.body.title;
    if(typeof title!=='string'||!title.trim()||title.length>180||/[\u0000-\u001f]/.test(title))throw failure(400,'Titre de complément invalide.');let newKey=null,committed=false;
    try {
      const result=await db.transaction(async()=>{
        const initial=await mainResource(req,mainId),actor=await allowed(req,initial);
        await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`resource-supplements:${mainId}`);
        await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:upload-quota:${actor.id}`);
        await db.prepare('SELECT id FROM resources WHERE id=? FOR SHARE').get(mainId);const main=await mainResource(req,mainId);
        if(req.body.main_version!==undefined&&integer(req.body.main_version)!==main.version)throw failure(409,'Le document principal a changé. Rouvrez sa version actuelle.');
        if(hash===main.sha256)throw failure(409,'Ce fichier est identique au document principal.');
        await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:resource-bytes:${main.faculty_id}:${main.filiere_id}:${hash}`);
        const identical=await db.prepare('SELECT * FROM resources WHERE faculty_id=? AND filiere_id=? AND sha256=? AND removed=0 ORDER BY id').all(main.faculty_id,main.filiere_id,hash);
        for(const candidate of identical)if(supplementScopeMatches(main,candidate)&&candidate.filename===filename&&candidate.relative_path===path&&candidate.title===title.trim()){let accessible;try{accessible=await assertResource(candidate.id,req);}catch(error){if(![403,404].includes(error.status))throw error;continue;}await verifyStoredBytes(accessible);const freshActor=await allowed(req,main),freshMain=await mainResource(req,mainId),freshChild=await assertResource(candidate.id,req);const reused=await linked(freshMain,freshChild,freshActor);return {resource:await resourceDTO(freshChild,req.user),reused,bytesReused:true};}
        const cap=await db.prepare('SELECT COUNT(*)::integer AS count FROM resource_supplements WHERE main_resource_id=?').get(mainId);if(cap.count>=SUPPLEMENT_POLICY.perMain)throw failure(429,'Ce document possède déjà vingt compléments.');
        const quota=await db.prepare('SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) FILTER(WHERE created_at>?) AS recent FROM resources WHERE author_id=? AND removed=0').get(new Date(Date.now()-86400000).toISOString(),actor.id);if(Number(quota.bytes)+req.file.size>SUPPLEMENT_POLICY.accountBytes||Number(quota.recent)>=SUPPLEMENT_POLICY.uploadsPerDay)throw failure(429,'Quota de dépôt atteint. Contactez l’administration.');
        // Sharing a byte object does not expose the earlier row or its private
        // metadata. Each distinct filename/path retains its own authorized row.
        const physical=identical.find(row=>row.mime===mime&&row.size===req.file.size);
        let objectKey=physical?.object_key;
        if(physical)await verifyStoredBytes(physical);
        if(!objectKey){objectKey=main.module_id?resourceObjectKey({filiereId:main.filiere_id,semester:main.semester,moduleId:main.module_id,filename}):storageObjectKey(`resource-supplements/${mainId}/${randomUUID()}${extname(filename).toLowerCase()}`);newKey=objectKey;await storage.put(objectKey,req.file.buffer,mime);}
        const freshActor=await allowed(req,main),freshMain=await mainResource(req,mainId);
        if(freshMain.version!==main.version||freshMain.sha256!==main.sha256)throw failure(409,'Le document principal a changé pendant le dépôt.');
        const at=new Date().toISOString(),child=await db.prepare(`INSERT INTO resources(faculty_id,filiere_id,semester,module_id,module,category,resource_type,part_number,academic_year,academic_years,teacher_name,title,filename,relative_path,object_key,sha256,size,mime,author_id,created_at,library_visible)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0) RETURNING *`).get(main.faculty_id,main.filiere_id,main.semester,main.module_id,main.module,main.category,main.resource_type,main.part_number,main.academic_year,JSON.stringify(yearsOf(main)),main.teacher_name||'',title.trim(),filename,path,objectKey,hash,req.file.size,mime,freshActor.id,at);
        await linked(freshMain,child,freshActor);await permissions.audit(freshActor,'resource.supplement.upload','resource',main.id,{supplement_resource_id:child.id,bytes_reused:!!physical});return {resource:await resourceDTO(child,req.user),reused:false};
      });
      committed=true;if(broadcast)await broadcast(req.user.faculty_id,req.user.filiere_id);res.status(result.reused?200:201).json(result);
    } catch(error){if(!committed&&newKey&&error.code!=='DATABASE_UNAVAILABLE')await storage.delete(newKey).catch(()=>{});throw error;}
  });
}
