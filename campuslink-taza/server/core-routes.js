import {randomUUID} from 'node:crypto';
import {CAPABILITIES} from './permissions.js';
import {academicYears,yearsOf,yearsOverlap} from './academic-years.js';
import {pipeline} from 'node:stream/promises';
import {extname} from 'node:path';
import {detectFile,mayInlineFile} from './files.js';
import {uploadFilePath} from './upload-path.js';
import {digest} from './db.js';
import {storageObjectKey} from './storage.js';
import {validatedAchievements} from './xp-achievements.js';
import {FILE_CONTRIBUTION_POLICY,fileContributionSummary} from './file-contribution-xp.js';

export function installCoreRoutes(app,{db,requireFaculty,problem,permissions,asId,string,resource,scoped,broadcast,author,authorizeNotificationTarget,notifyDirect,upload,storage,notifyAdminInbox,broadcastAdminInbox}) {
  const now=()=>new Date().toISOString();
  const owner=(req,_res,next)=>permissions.isOwner(req.user)?next():next(problem(403,'Seul le propriétaire peut effectuer cette action.'));
  const statuses=['open','resolved','closed','received','reviewing','accepted','planned','done','declined'];
  async function activeActor(req){
    const row=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(req.user.id);
    if(!row||row.disabled||row.account_status!=='approved'||!row.faculty_id||row.faculty_id!==req.user.faculty_id)throw problem(403,'Votre compte ou votre accès a changé. Rechargez avant de continuer.');
    return permissions.load(row);
  }
  async function ticket(req,id,administrative=false){
    const row=await db.prepare('SELECT * FROM contacts WHERE id=?').get(asId(id));
    if(!row)throw problem(404,'Demande introuvable.');
    if(administrative){if(!permissions.can(req.user,'feedback.manage',row.faculty_id,row.filiere_id))throw problem(403,'Demande privée.');}
    else if(row.user_id!==req.user.id)throw problem(403,'Demande privée.');
    return row;
  }
  async function ticketDTO(row){
    const [replies,attachments]=await Promise.all([
      db.prepare('SELECT * FROM contact_replies WHERE contact_id=? ORDER BY id').all(row.id),
      db.prepare('SELECT id,filename,size,mime,created_at FROM contact_attachments WHERE contact_id=? ORDER BY id').all(row.id),
    ]);
    return {...row,title:row.subject,description:row.message,attachments:attachments.map(r=>({...r,url:`/api/feedback/attachments/${r.id}/file`})),replies:await Promise.all(replies.map(async r=>({id:r.id,content:r.content,created_at:r.created_at,author:r.administrative?{id:null,name:'Administration',username:'',avatar:'',role:'student'}:await author(r.author_id)})))};
  }
  async function reply(req,row,administrative){
    const content=string(req.body.content??req.body.reply,'Réponse',4000);
    if(req.body.status!==undefined&&!statuses.includes(req.body.status))throw problem(400,'Statut invalide.');
    await db.transaction(async()=>{
      const fresh=await db.prepare('SELECT * FROM contacts WHERE id=? FOR UPDATE').get(row.id);
      if(!fresh)throw problem(404,'Demande introuvable.');
      const actor=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(req.user.id);
      if(!actor||actor.disabled||actor.account_status!=='approved')throw problem(403,'Compte indisponible.');
      if(administrative&&!permissions.can(await permissions.load(actor),'feedback.manage',fresh.faculty_id,fresh.filiere_id))throw problem(403,'Demande privée.');
      if(!administrative&&fresh.user_id!==actor.id)throw problem(403,'Demande privée.');
      await db.prepare('INSERT INTO contact_replies(contact_id,author_id,content,administrative,created_at) VALUES(?,?,?,?,?)').run(row.id,req.user.id,content,administrative?1:0,now());
      await db.prepare('UPDATE contacts SET updated_at=?,status=? WHERE id=?').run(now(),administrative?(req.body.status||fresh.status):fresh.status,row.id);
      if(administrative){
        await permissions.audit(req.user,'feedback.reply','contact',row.id,{status:req.body.status||row.status});
        if(row.user_id)await notifyDirect(row.user_id,'admin',`Réponse : ${row.subject}`,content,`/app/feedback?ticket=${row.id}#feedback-${row.id}`);
      }
    });
    await broadcast(row.faculty_id);
    return ticketDTO(await db.prepare('SELECT * FROM contacts WHERE id=?').get(row.id));
  }
  app.get('/api/feedback',requireFaculty,async(req,res)=>{
    const rows=await db.prepare('SELECT * FROM contacts WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(req.user.id);
    res.json({tickets:rows.map(r=>({...r,title:r.subject,description:r.message}))});
  });
  app.post('/api/feedback',requireFaculty,async(req,res)=>{
    const category=req.body.category||'concern';
    if(!['feature','bug','improvement','concern'].includes(category))throw problem(400,'Catégorie invalide.');
    const title=string(req.body.title,'Titre',180),description=string(req.body.description,'Description',6000);
    const {row,recipients}=await db.transaction(async()=>{
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:feedback-rate:${req.user.id}`);
      const count=await db.prepare('SELECT COUNT(*) AS daily,COUNT(*) FILTER(WHERE created_at>?) AS hourly FROM contacts WHERE user_id=? AND created_at>?').get(new Date(Date.now()-3600000).toISOString(),req.user.id,new Date(Date.now()-86400000).toISOString());
      if(Number(count.hourly)>=10||Number(count.daily)>=30)throw problem(429,'Limite de demandes atteinte : 10 par heure et 30 par jour. Réessayez plus tard.');
      const row=await db.prepare("INSERT INTO contacts(faculty_id,user_id,name,email,subject,message,created_at,status,category,updated_at,filiere_id) VALUES(?,?,?,?,?,?,?,'received',?,?,?) RETURNING *").get(req.user.faculty_id,req.user.id,req.user.name,req.user.email,title,description,now(),category,now(),req.user.filiere_id);
      const recipients=await notifyAdminInbox(row.faculty_id,'Nouvelle demande de feedback',title,`/app/admin?tab=contacts&contact=${row.id}`,{filiereId:row.filiere_id});
      return {row,recipients};
    });
    await broadcastAdminInbox(recipients);
    res.status(201).json({ticket:await ticketDTO(row)});
  });
  app.get('/api/feedback/:id',requireFaculty,async(req,res)=>res.json({ticket:await ticketDTO(await ticket(req,req.params.id))}));
  app.post('/api/feedback/:id/replies',requireFaculty,async(req,res)=>res.status(201).json({ticket:await reply(req,await ticket(req,req.params.id),false)}));
  app.get('/api/admin/feedback/:id',requireFaculty,async(req,res)=>res.json({ticket:await ticketDTO(await ticket(req,req.params.id,true))}));
  app.post('/api/admin/feedback/:id/replies',requireFaculty,async(req,res)=>res.status(201).json({ticket:await reply(req,await ticket(req,req.params.id,true),true)}));
  app.post('/api/feedback/:id/attachments',requireFaculty,upload.single('file'),async(req,res)=>{
    const row=await ticket(req,req.params.id);
    if(!req.file?.size)throw problem(400,'Sélectionnez un fichier.');
    const {filename}=uploadFilePath(req.file.originalname),mime=detectFile(req.file.buffer,filename),hash=digest(req.file.buffer);
    const key=storageObjectKey(`feedback/${row.id}/${randomUUID()}${extname(filename).toLowerCase()}`);
    let uploaded=false,attachment;
    try{await db.transaction(async()=>{
      async function authorize(){
        const fresh=await db.prepare('SELECT * FROM contacts WHERE id=? FOR UPDATE').get(row.id),actor=await activeActor(req);
        if(!fresh||fresh.user_id!==actor.id)throw problem(403,'Demande privée.');
        return actor;
      }
      await authorize();
      const quota=await db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM contact_attachments WHERE contact_id=?').get(row.id);
      if(Number(quota.n)>=5||Number(quota.bytes)+req.file.size>50*1024*1024)throw problem(429,'Maximum cinq pièces jointes et 50 Mo par demande.');
      if(await db.prepare('SELECT 1 FROM contact_attachments WHERE contact_id=? AND sha256=?').get(row.id,hash))throw problem(409,'Cette pièce jointe existe déjà.');
      uploaded=true;await storage.put(key,req.file.buffer,mime);
      const actor=await authorize();
      attachment=await db.prepare('INSERT INTO contact_attachments(contact_id,author_id,filename,object_key,sha256,size,mime,created_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id,filename,size,mime,created_at').get(row.id,req.user.id,filename,key,hash,req.file.size,mime,now());
      await permissions.audit(actor,'feedback.attachment','contact',row.id,{attachment_id:attachment.id});
    });}catch(error){if(uploaded&&error.code!=='DATABASE_UNAVAILABLE')try{await storage.delete(key);}catch{console.error('[CampusLink storage] Feedback upload cleanup failed.');}throw error;}
    res.status(201).json({attachment:{...attachment,url:`/api/feedback/attachments/${attachment.id}/file`}});
  });
  app.get('/api/feedback/attachments/:id/file',requireFaculty,async(req,res)=>{
    const attachment=await db.prepare('SELECT * FROM contact_attachments WHERE id=?').get(asId(req.params.id));
    if(!attachment)throw problem(404,'Pièce jointe introuvable.');
    const row=await db.prepare('SELECT * FROM contacts WHERE id=?').get(attachment.contact_id);
    if(!row||row.user_id!==req.user.id&&!permissions.can(req.user,'feedback.manage',row.faculty_id,row.filiere_id))throw problem(403,'Pièce jointe privée.');
    const file=await storage.get(attachment.object_key);
    res.type(attachment.mime);res.set('Content-Disposition',`${mayInlineFile(attachment.mime,attachment.filename)?'inline':'attachment'}; filename="${attachment.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.set('Content-Security-Policy',"sandbox; default-src 'none'");
    if(file.contentLength!==undefined)res.set('Content-Length',String(file.contentLength));await pipeline(file.body,res);
  });
  app.patch('/api/resources/:id/academic-years',requireFaculty,async(req,res)=>{
    const row=await scoped('resources',req.params.id,req),years=academicYears(req.body.academic_years,req.body.academic_year);
    if(row.author_id!==req.user.id&&!permissions.can(req.user,'resource.manage',row.faculty_id,row.filiere_id))throw problem(403,'Vous ne pouvez pas corriger ce fichier.');
    await db.transaction(async()=>{
      const slotCategory=['td','tp','corrections'].includes(row.resource_type)?row.resource_type:row.resource_type==='correction'?'corrections':row.category;
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(JSON.stringify([row.faculty_id,row.filiere_id,row.semester,row.module.normalize('NFKC').toLocaleLowerCase(),slotCategory,row.part_number]));
      const fresh=await db.prepare('SELECT * FROM resources WHERE id=? AND removed=0 FOR UPDATE').get(row.id);
      if(!fresh)throw problem(404,'Ressource introuvable.');
      const actor=await activeActor(req);
      await scoped('resources',fresh.id,{...req,user:actor});
      if(fresh.author_id!==actor.id&&!permissions.can(actor,'resource.manage',fresh.faculty_id,fresh.filiere_id))throw problem(403,'Vous ne pouvez pas corriger ce fichier.');
      const others=await db.prepare('SELECT * FROM resources WHERE faculty_id=? AND filiere_id=? AND semester=? AND module_id=? AND part_number=? AND removed=0 AND library_visible=1 AND id<>?').all(fresh.faculty_id,fresh.filiere_id,fresh.semester,fresh.module_id,fresh.part_number,fresh.id);
      const category=r=>['td','tp','corrections'].includes(r.resource_type)?r.resource_type:r.resource_type==='correction'?'corrections':r.category;
      if(others.some(r=>category(r)===category(fresh)&&yearsOverlap(yearsOf(r),years)))throw problem(409,'Cette partie existe déjà pour cette année universitaire.');
      await db.prepare('UPDATE resources SET academic_year=?,academic_years=? WHERE id=?').run(years[0]||null,JSON.stringify(years),row.id);
      await permissions.audit(actor,'resource.academic-years','resource',row.id,{academic_years:years});
    });
    await broadcast(row.faculty_id);
    res.json({resource:await resource(await db.prepare('SELECT * FROM resources WHERE id=?').get(row.id),req.user)});
  });
  app.get('/api/admin/appointments',requireFaculty,owner,async(_req,res)=>res.json({appointments:await db.prepare('SELECT * FROM scoped_appointments ORDER BY id DESC').all()}));
  app.post('/api/admin/appointments',requireFaculty,owner,async(req,res)=>{
    const target=await db.prepare('SELECT * FROM users WHERE id=?').get(asId(req.body.user_id));
    if(!target||target.disabled||target.account_status!=='approved')throw problem(404,'Compte étudiant actif introuvable.');
    if(permissions.isOwner(target))throw problem(403,'Les privilèges du propriétaire sont permanents.');
    const faculty=req.body.faculty_id,filiere=req.body.filiere_id||null,role=req.body.role;
    if(!['faculty_admin','faculty_leader','moderator'].includes(role)||faculty!==target.faculty_id)throw problem(400,'Rôle ou faculté invalide.');
    if(filiere&&!await db.prepare('SELECT 1 FROM filieres WHERE id=? AND faculty_id=?').get(filiere,faculty))throw problem(400,'Filière invalide.');
    const capabilities=req.body.capabilities;
    if(!Array.isArray(capabilities)||capabilities.length>CAPABILITIES.length||capabilities.some(c=>!CAPABILITIES.includes(c)))throw problem(400,'Permissions invalides.');
    if(capabilities.includes('resource.upload')&&!filiere)throw problem(400,'Le droit de dépôt requiert une filière explicite.');
    if(role==='faculty_leader'&&capabilities.some(c=>!['content.moderate','student.support'].includes(c)))throw problem(400,'Un Faculty Leader reçoit seulement des permissions locales de modération ou de soutien.');
    const appointment=await db.transaction(async()=>{
      if(role==='faculty_leader'){
        const scopes=await db.prepare("SELECT DISTINCT filiere_id FROM users WHERE faculty_id=? AND role IN('student','faculty_leader') AND disabled=0 AND account_status='approved' ORDER BY filiere_id").all(faculty);
        for(const scope of scopes)await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${faculty}:${scope.filiere_id}`);
      }
      const current=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(target.id);
      if(!current||current.disabled||current.account_status!=='approved'||current.faculty_id!==faculty)throw problem(409,'Ce compte ou sa faculté a changé. Rechargez la nomination.');
      if(role==='faculty_leader'){
        const eligible=await permissions.load(current),ranking=await permissions.facultyStanding(faculty),standing=ranking.find(r=>r.id===target.id);
        if(eligible.validated_xp<=0||!standing||standing.ranking_score<=0||standing.ranking_score!==ranking[0]?.ranking_score)throw problem(400,'Seul un étudiant en tête du classement validé de sa faculté est éligible.');
      }
      if(current.role!==role)await db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now(),target.id);
      const row=await db.prepare('INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,filiere_id,capabilities,created_at) VALUES(?,?,?,?,?,?) RETURNING *').get(target.id,req.user.id,faculty,filiere,JSON.stringify([...new Set(capabilities)]),now());
      await db.prepare('UPDATE users SET role=?,session_version=session_version+1,auth_revoked_at=? WHERE id=?').run(role,now(),target.id);
      await permissions.audit(req.user,'appointment.grant','appointment',row.id,{user_id:target.id,faculty_id:faculty,filiere_id:filiere,capabilities});
      return row;
    });
    await broadcast(target.faculty_id);res.status(201).json({appointment});
  });
  app.delete('/api/admin/appointments/:id',requireFaculty,owner,async(req,res)=>{
    const row=await db.prepare('SELECT * FROM scoped_appointments WHERE id=?').get(asId(req.params.id));
    if(!row)throw problem(404,'Nomination introuvable.');
    await db.transaction(async()=>{
      await db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(),row.id);
      await db.prepare('UPDATE users SET session_version=session_version+1,auth_revoked_at=? WHERE id=?').run(now(),row.user_id);
      await permissions.audit(req.user,'appointment.revoke','appointment',row.id);
    });
    await broadcast(row.faculty_id);res.json({ok:true});
  });
  app.get('/api/admin/audit',requireFaculty,owner,async(_req,res)=>res.json({records:await db.prepare('SELECT * FROM administrative_audit ORDER BY id DESC LIMIT 200').all()}));
  app.post('/api/admin/xp-events/:id/revoke',requireFaculty,owner,async(req,res)=>{
    const row=await db.prepare('SELECT * FROM xp_events WHERE id=?').get(asId(req.params.id));
    if(!row)throw problem(404,'Contribution introuvable.');
    const faculty=await db.transaction(async()=>{
      const target=await db.prepare('SELECT faculty_id,filiere_id FROM users WHERE id=?').get(row.user_id);
      if(!target)throw problem(404,'Compte associé introuvable.');
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${target.faculty_id}:${target.filiere_id}`);
      // Keep the ranking scope and account fixed through revocation. A study
      // change while waiting must not invalidate XP under a different lock
      // from the one protecting uploads and Faculty Leader eligibility.
      const current=await db.prepare('SELECT faculty_id,filiere_id FROM users WHERE id=? FOR SHARE').get(row.user_id);
      if(!current||current.faculty_id!==target.faculty_id||current.filiere_id!==target.filiere_id)throw problem(409,'La faculté ou la filière du compte a changé. Rechargez avant de révoquer cette contribution.');
      const actor=await activeActor(req);
      if(!permissions.isOwner(actor))throw problem(403,'Seul le propriétaire peut effectuer cette action.');
      await db.prepare("UPDATE xp_events SET status='revoked' WHERE id=?").run(row.id);
      await permissions.audit(actor,'xp.revoke','xp_event',row.id);
      return current.faculty_id;
    });
    await broadcast(faculty||req.user.faculty_id);res.json({ok:true});
  });
  app.get('/api/xp',requireFaculty,async(req,res)=>{
    const payload=await db.transaction(async()=>{
      // The total, progress bar, badges and ranking describe one ledger
      // snapshot, even while another tab publishes or an admin revokes XP.
      await db.prepare('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY').run();
      const rows=await permissions.facultyStanding(req.user.faculty_id);
      const ledger=await db.prepare('SELECT id,category,event_key,points,status,created_at FROM xp_events WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id);
      const breakdown=await db.prepare("SELECT category,SUM(points) AS points FROM xp_events WHERE user_id=? AND status='valid' GROUP BY category").all(req.user.id);
      const achievements=await validatedAchievements(db,req.user.id);
      const fileContributions=await fileContributionSummary(db,req.user.id);
      return {xp:achievements.level.xp,events:ledger,breakdown:Object.fromEntries(breakdown.map(r=>[r.category,Number(r.points)])),ranking:rows,ranking_rule:'Study, Help et Contribution comptent intégralement. La pratique compte jusqu’à 25 % de ces activités. Les étudiants ex æquo partagent le même rang.',upload_policy:FILE_CONTRIBUTION_POLICY,file_contributions:fileContributions,...achievements};
    });
    res.json(payload);
  });
  app.get('/api/members/:id/achievements',requireFaculty,async(req,res)=>{
    const member=await db.prepare("SELECT id FROM users WHERE id=? AND faculty_id=? AND disabled=0 AND account_status='approved'").get(asId(req.params.id),req.user.faculty_id);
    if(!member)throw problem(404,'Profil étudiant introuvable.');
    const {achievements}=await validatedAchievements(db,member.id);
    res.json({achievements:achievements.filter(a=>a.earned).map(({id,title,tier})=>({id,title,tier}))});
  });
  async function notification(req){
    const row=await db.prepare('SELECT * FROM notifications WHERE id=? AND user_id=? AND faculty_id=?').get(asId(req.params.id),req.user.id,req.user.faculty_id);
    if(!row)throw problem(404,'Notification introuvable.');
    if(row.target_deleted||!await authorizeNotificationTarget(req.user,row.path))throw problem(403,'La destination est indisponible ou non autorisée.');
    return row;
  }
  app.get('/api/notifications',requireFaculty,async(req,res)=>{
    const limit=req.query.limit===undefined?100:asId(req.query.limit);if(limit>200)throw problem(400,'Limite invalide.');
    const before=req.query.before_id===undefined?null:asId(req.query.before_id);
    const rows=await db.prepare(`SELECT id,type,title,body,path,created_at,read,target_deleted FROM notifications WHERE user_id=? AND faculty_id=?${before?' AND id<?':''} AND type<>'calendar' AND path NOT LIKE '/app/calendar%' ORDER BY id DESC LIMIT ?`).all(req.user.id,req.user.faculty_id,...(before?[before]:[]),limit+1);
    const count=await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND faculty_id=? AND read=0 AND type<>'calendar' AND path NOT LIKE '/app/calendar%'").get(req.user.id,req.user.faculty_id);
    res.json({notifications:await Promise.all(rows.slice(0,limit).map(async n=>({...n,read:!!n.read,target_available:!n.target_deleted&&await authorizeNotificationTarget(req.user,n.path)}))),unread_count:Number(count.n),has_more:rows.length>limit,next_before_id:rows.length>limit?rows[limit-1].id:null});
  });
  app.post('/api/notifications/:id/viewed',requireFaculty,async(req,res)=>{
    const row=await notification(req);
    if(req.body.path!==row.path)throw problem(400,'La destination doit correspondre à la notification.');
    const token=randomUUID();
    await db.prepare('INSERT INTO notification_visits(token,notification_id,user_id,path,viewed_at,expires_at) VALUES(?,?,?,?,?,?)').run(token,row.id,req.user.id,row.path,now(),new Date(Date.now()+12*3600000).toISOString());
    res.json({visit_token:token});
  });
  app.post('/api/notifications/:id/departed',requireFaculty,async(req,res)=>{
    const row=await notification(req);
    const token=string(req.body.visit_token,'Visite',80);
    await db.transaction(async()=>{
      const visit=await db.prepare('SELECT * FROM notification_visits WHERE token=? AND notification_id=? AND user_id=? FOR UPDATE').get(token,row.id,req.user.id);
      if(!visit||visit.path!==row.path||visit.expires_at<now())throw problem(409,'La destination doit être ouverte avant de terminer la visite.');
      if(!await authorizeNotificationTarget(req.user,row.path))throw problem(403,'La destination n’est plus autorisée.');
      await db.prepare('UPDATE notification_visits SET departed_at=? WHERE token=?').run(now(),token);
      await db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(row.id,req.user.id);
    });
    await broadcast(req.user.faculty_id);res.json({ok:true});
  });
  app.post('/api/notifications/read',requireFaculty,(_req,_res,next)=>next(problem(400,'Ouvrez la destination puis terminez sa visite pour lire une notification.')));
  return {ticketDTO,reply,statuses};
}
