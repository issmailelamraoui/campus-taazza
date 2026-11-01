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

export function installCoreRoutes(app,{db,requireFaculty,problem,permissions,asId,string,resource,scoped,broadcast,broadcastUserUpdate,author,authorizeNotificationTarget,notificationStore,notifyDirect,upload,storage,notifyAdminInbox,broadcastAdminInbox}) {
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
  async function ticketDTO(row,viewer=null){
    if(!row)throw problem(404,'Demande introuvable.');
    const {recovery_hash,client_id,...safe}=row;
    const restricted=viewer&&viewer.id!==row.user_id&&row.assigned_to&&viewer.id!==row.assigned_to&&!permissions.isOwner(viewer);
    const actorKey=viewer?'user:'+viewer.id:'guest:'+row.id;
    // All collections share one parallel round trip. Avoid author/profile/XP
    // queries for each message in an ever-growing private conversation.
    const [replies,attachments,people,reactions]=await Promise.all([
      restricted?[]:db.prepare('SELECT * FROM contact_replies WHERE contact_id=? ORDER BY id').all(row.id),
      restricted?[]:db.prepare('SELECT id,filename,size,mime,created_at FROM contact_attachments WHERE contact_id=? ORDER BY id').all(row.id),
      db.prepare('SELECT id,name,username,avatar,account_status FROM users WHERE id IN (SELECT author_id FROM contact_replies WHERE contact_id=? UNION SELECT user_id FROM contacts WHERE id=? UNION SELECT assigned_to FROM contacts WHERE id=?)').all(row.id,row.id,row.id),
      restricted?[]:db.prepare('SELECT r.reply_id,r.reaction,COUNT(*) AS count,BOOL_OR(r.actor_key=?) AS mine FROM contact_reactions r JOIN contact_replies m ON m.id=r.reply_id WHERE m.contact_id=? GROUP BY r.reply_id,r.reaction').all(actorKey,row.id),
    ]);
    const byId=new Map(people.map(({account_status,...person})=>[person.id,account_status==='deleted'?{id:person.id,name:'Étudiant supprimé',username:'',avatar:''}:person]));
    const requester=byId.get(row.user_id);
    const privateOwner=!permissions.isOwner(viewer);
    const administrativeIdentity=person=>privateOwner&&person&&permissions.isOwner(person)?{id:null,name:'Administration',username:'',avatar:''}:person;
    const assigned=administrativeIdentity(byId.get(row.assigned_to))||null;
    if(privateOwner&&row.assigned_to&&permissions.isOwner({id:row.assigned_to}))safe.assigned_to='administration';
    return {...safe,can_delete:!!viewer&&permissions.can(viewer,'feedback.manage',row.faculty_id,row.filiere_id)&&(row.assigned_to===viewer.id||permissions.isOwner(viewer)),username:requester?.username||'',assigned,title:row.subject,description:row.message,restricted:!!restricted,attachments:attachments.map(r=>({...r,url:`/api/feedback/attachments/${r.id}/file`})),replies:replies.map(r=>({id:r.id,content:r.content,created_at:r.created_at,administrative:!!r.administrative,author:(r.administrative?administrativeIdentity(byId.get(r.author_id)):byId.get(r.author_id))||{id:null,name:row.name,username:''},my_reactions:reactions.filter(x=>x.reply_id===r.id&&x.mine).map(x=>x.reaction),reactions:Object.fromEntries(reactions.filter(x=>x.reply_id===r.id).map(x=>[x.reaction,Number(x.count)]))}))};
  }
  function assertParticipant(row,actor,administrative){
    if(!row.assigned_to)throw problem(409,'Cette demande attend d’être acceptée par un administrateur.');
    if(administrative&&row.assigned_to!==actor.id&&!permissions.isOwner(actor))throw problem(403,'Cette conversation appartient à l’administrateur assigné.');
    if(!administrative&&row.user_id!==actor.id)throw problem(403,'Demande privée.');
  }
  app.post('/api/admin/feedback/:id/accept',requireFaculty,async(req,res)=>{
    const row=await db.transaction(async()=>{
      const actor=await activeActor(req);
      const fresh=await db.prepare('SELECT * FROM contacts WHERE id=? FOR UPDATE').get(asId(req.params.id));
      if(!fresh)throw problem(404,'Demande introuvable.');
      if(!permissions.can(actor,'feedback.manage',fresh.faculty_id,fresh.filiere_id))throw problem(403,'Permission d’assistance requise.');
      if(fresh.assigned_to&&fresh.assigned_to!==actor.id)throw problem(409,'Cette demande est déjà prise en charge.');
      if(fresh.closed_at||['closed','resolved','done'].includes(fresh.status))throw problem(409,'Cette demande est clôturée.');
      if(fresh.assigned_to)return fresh;
      const updated=await db.prepare("UPDATE contacts SET assigned_to=?,accepted_at=?,status='reviewing',updated_at=? WHERE id=? RETURNING *").get(actor.id,now(),now(),fresh.id);
      await permissions.audit(actor,'feedback.accept','contact',fresh.id);
      if(fresh.user_id)await notifyDirect(fresh.user_id,'admin','Demande prise en charge',fresh.subject,`/app/feedback?ticket=${fresh.id}`);
      return updated;
    });
    await Promise.all([broadcast(row.faculty_id),broadcastUserUpdate([row.user_id,row.assigned_to].filter(Boolean),{support:true})]);res.json({ticket:await ticketDTO(row,req.user)});
  });
  app.post('/api/admin/feedback/:id/close',requireFaculty,async(req,res)=>{
    const row=await db.transaction(async()=>{
      const actor=await activeActor(req),fresh=await ticket({...req,user:actor},req.params.id,true);
      const locked=await db.prepare('SELECT * FROM contacts WHERE id=? FOR UPDATE').get(fresh.id);
      if(!locked)throw problem(404,'Demande introuvable.');
      Object.assign(fresh,locked);
      assertParticipant(fresh,actor,true);
      if(fresh.closed_at||fresh.status==='closed')return fresh;
      const updated=await db.prepare("UPDATE contacts SET status='closed',closed_at=?,updated_at=? WHERE id=? RETURNING *").get(now(),now(),fresh.id);
      await permissions.audit(actor,'feedback.close','contact',fresh.id);
      if(fresh.user_id)await notifyDirect(fresh.user_id,'admin','Conversation clôturée',fresh.subject,`/app/feedback?ticket=${fresh.id}`);
      return updated;
    });
    await Promise.all([broadcast(row.faculty_id),broadcastUserUpdate([row.user_id,row.assigned_to].filter(Boolean),{support:true})]);res.json({ticket:await ticketDTO(row,req.user)});
  });
  app.delete('/api/admin/feedback/:id',requireFaculty,async(req,res)=>{
    const id=asId(req.params.id);
    async function lockedTicket(){
      const row=await db.prepare('SELECT * FROM contacts WHERE id=? FOR UPDATE').get(id);
      if(!row)throw problem(404,'Demande introuvable.');
      const actor=await activeActor(req);
      if(!permissions.can(actor,'feedback.manage',row.faculty_id,row.filiere_id))throw problem(403,'Permission d’assistance requise.');
      if(!permissions.isOwner(actor))assertParticipant(row,actor,true);
      return {row,actor};
    }
    // Closing is committed before object removal. A storage outage leaves a
    // closed, retryable ticket with every object key, never an orphaned upload
    // or a conversation that can receive more replies during its deletion.
    const closed=await db.transaction(async()=>{
      const {row}=await lockedTicket();
      if(row.closed_at&&['closed','resolved','done'].includes(row.status))return row;
      return db.prepare("UPDATE contacts SET status='closed',closed_at=?,updated_at=? WHERE id=? RETURNING *").get(now(),now(),id);
    });
    let result;
    try{result=await db.transaction(async()=>{
      const {row,actor}=await lockedTicket();
      if(!row.closed_at)throw problem(409,'La conversation a été rouverte. Rechargez avant de la supprimer.');
      const files=await db.prepare('SELECT object_key FROM contact_attachments WHERE contact_id=? ORDER BY id').all(id);
      for(const key of new Set(files.map(file=>file.object_key))){
        try{await storage.delete(key);}catch(error){if(error.status!==404)throw problem(502,'Le nettoyage des fichiers est temporairement indisponible.');}
      }
      // Match exact request IDs in both current and historical destinations.
      const notices=await db.prepare('SELECT id,user_id,path FROM notifications WHERE path LIKE ?').all('%'+id+'%');
      const noticeIds=notices.filter(notice=>{
        try{
          const url=new URL(notice.path,'https://campuslink.invalid');
          if(url.origin!=='https://campuslink.invalid')return false;
          return url.pathname==='/app/feedback'&&(url.searchParams.has('ticket')?Number(url.searchParams.get('ticket'))===id:url.hash==='#feedback-'+id)||url.pathname==='/app/admin'&&['contacts','assistance'].includes(url.searchParams.get('tab'))&&Number(url.searchParams.get('contact'))===id;
        }catch{return false;}
      }).map(notice=>notice.id);
      if(noticeIds.length)await db.prepare('DELETE FROM notifications WHERE id=ANY(?)').run(noticeIds);
      const replies=await db.prepare('DELETE FROM contact_replies WHERE contact_id=?').run(id);
      await db.prepare('DELETE FROM contact_attachments WHERE contact_id=?').run(id);
      await db.prepare('DELETE FROM contacts WHERE id=?').run(id);
      // Keep a single content-free deletion receipt instead of all per-message
      // administrative audit entries for a conversation that no longer exists.
      await db.prepare("DELETE FROM administrative_audit WHERE target_type='contact' AND target_id=?").run(String(id));
      await permissions.audit(actor,'feedback.delete','contact',id,{messages:replies.changes,attachments:files.length});
      const administrators=await db.prepare("SELECT DISTINCT user_id AS id FROM scoped_appointments WHERE revoked_at IS NULL AND faculty_id=? AND (filiere_id IS NULL OR filiere_id=?) AND capabilities @> '[\"feedback.manage\"]'::jsonb UNION SELECT user_id AS id FROM platform_owner").all(row.faculty_id,row.filiere_id);
      return {row,recipients:[...new Set([row.user_id,row.assigned_to,actor.id,...administrators.map(a=>a.id)].filter(Boolean))]};
    });}catch(error){
      await Promise.allSettled([broadcast(closed.faculty_id,null,{support:true}),broadcastUserUpdate([closed.user_id,closed.assigned_to].filter(Boolean),{support:true})]);
      if(error.status===502||error.status===503)throw problem(error.status,'La suppression n’a pas pu être terminée. La conversation est clôturée ; réessayez pour terminer le nettoyage des fichiers.');
      throw error;
    }
    await Promise.all([broadcast(result.row.faculty_id,null,{support:true}),broadcastUserUpdate(result.recipients,{support:true,adminInbox:true,removedFeedbackId:id})]);
    res.json({ok:true,deleted_id:id});
  });
  app.post('/api/feedback/:id/replies/:reply/reactions',requireFaculty,async(req,res)=>{
    const reaction=req.body.reaction;
    if(!['like','heart'].includes(reaction)||typeof req.body.active!=='boolean')throw problem(400,'Réaction invalide.');
    const row=await db.transaction(async()=>{
      const actor=await activeActor(req),row=await ticket({...req,user:actor},req.params.id,req.body.administrative===true);
      const locked=await db.prepare('SELECT * FROM contacts WHERE id=? FOR UPDATE').get(row.id);
      if(!locked)throw problem(404,'Demande introuvable.');
      Object.assign(row,locked);
      assertParticipant(row,actor,req.body.administrative===true);
      const target=await db.prepare('SELECT id FROM contact_replies WHERE id=? AND contact_id=?').get(asId(req.params.reply),row.id);
      if(!target)throw problem(404,'Message introuvable.');
      const key='user:'+actor.id;
      if(req.body.active)await db.prepare('INSERT INTO contact_reactions(reply_id,actor_key,reaction) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(target.id,key,reaction);
      else await db.prepare('DELETE FROM contact_reactions WHERE reply_id=? AND actor_key=? AND reaction=?').run(target.id,key,reaction);
      return row;
    });
    await Promise.all([broadcast(row.faculty_id),broadcastUserUpdate([row.user_id,row.assigned_to].filter(Boolean),{support:true})]);res.json({ticket:await ticketDTO(row,req.user)});
  });
  async function reply(req,row,administrative){
    const content=string(req.body.content??req.body.reply,'Réponse',4000);
    const client=req.body.client_id||null;
    if(client&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(client))throw problem(400,'Identifiant de message invalide.');
    if(req.body.status!==undefined&&!statuses.includes(req.body.status))throw problem(400,'Statut invalide.');
    await db.transaction(async()=>{
      const fresh=await db.prepare('SELECT * FROM contacts WHERE id=? FOR UPDATE').get(row.id);
      if(!fresh)throw problem(404,'Demande introuvable.');
      const actor=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(req.user.id);
      if(!actor||actor.disabled||actor.account_status!=='approved')throw problem(403,'Compte indisponible.');
      if(administrative&&!permissions.can(await permissions.load(actor),'feedback.manage',fresh.faculty_id,fresh.filiere_id))throw problem(403,'Demande privée.');
      if(!administrative&&fresh.user_id!==actor.id)throw problem(403,'Demande privée.');
      assertParticipant(fresh,actor,administrative);
      if(fresh.closed_at||['closed','resolved','done'].includes(fresh.status))throw problem(409,'La conversation est clôturée.');
      if(client){const prior=await db.prepare('SELECT content,author_id FROM contact_replies WHERE contact_id=? AND client_id=?').get(row.id,client);if(prior){if(prior.author_id!==actor.id||prior.content!==content)throw problem(409,'Identifiant de message déjà utilisé.');return;}}
      const posted=await db.prepare('INSERT INTO contact_replies(contact_id,author_id,content,administrative,created_at,client_id) VALUES(?,?,?,?,?,?) RETURNING id').get(row.id,req.user.id,content,administrative?1:0,now(),client);
      await db.prepare('UPDATE contacts SET updated_at=?,status=? WHERE id=?').run(now(),administrative?(req.body.status||fresh.status):fresh.status,row.id);
      if(administrative&&['closed','resolved','done'].includes(req.body.status))await db.prepare('UPDATE contacts SET closed_at=? WHERE id=?').run(now(),row.id);
      if(administrative){
        await permissions.audit(req.user,'feedback.reply','contact',row.id,{status:req.body.status||row.status});
        if(row.user_id)await notifyDirect(row.user_id,'admin',`Réponse : ${row.subject}`,content,`/app/feedback?ticket=${row.id}#reply-${posted.id}`);
      }else if(fresh.assigned_to)await notifyDirect(fresh.assigned_to,'admin',`Réponse : ${fresh.subject}`,content,`/app/feedback?ticket=${fresh.id}&admin=1#reply-${posted.id}`);
    });
    await Promise.all([broadcast(row.faculty_id),broadcastUserUpdate([row.user_id,row.assigned_to].filter(Boolean),{support:true})]);
    return ticketDTO(await db.prepare('SELECT * FROM contacts WHERE id=?').get(row.id),req.user);
  }
  app.get('/api/feedback',requireFaculty,async(req,res)=>{
    const rows=await db.prepare('SELECT * FROM contacts WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(req.user.id);
    res.json({tickets:rows.map(({recovery_hash,client_id,...r})=>({...r,...(!permissions.isOwner(req.user)&&permissions.isOwner({id:r.assigned_to})?{assigned_to:'administration'}:{}),title:r.subject,description:r.message}))});
  });
  app.post('/api/feedback',requireFaculty,async(req,res)=>{
    const category=req.body.category||'concern';
    if(!['feature','bug','improvement','concern'].includes(category))throw problem(400,'Catégorie invalide.');
    const title=string(req.body.title,'Titre',180),description=string(req.body.description,'Description',6000);
    const client=req.body.client_id||null;
    if(client&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(client))throw problem(400,'Identifiant de demande invalide.');
    const {row,recipients}=await db.transaction(async()=>{
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:feedback-rate:${req.user.id}`);
      if(client){const prior=await db.prepare('SELECT * FROM contacts WHERE client_id=?').get(client);if(prior){if(prior.user_id!==req.user.id||prior.subject!==title||prior.message!==description||prior.category!==category)throw problem(409,'Identifiant de demande déjà utilisé.');return {row:prior,recipients:[]};}}
      const count=await db.prepare('SELECT COUNT(*) AS daily,COUNT(*) FILTER(WHERE created_at>?) AS hourly FROM contacts WHERE user_id=? AND created_at>?').get(new Date(Date.now()-3600000).toISOString(),req.user.id,new Date(Date.now()-86400000).toISOString());
      if(Number(count.hourly)>=10||Number(count.daily)>=30)throw problem(429,'Limite de demandes atteinte : 10 par heure et 30 par jour. Réessayez plus tard.');
      const row=await db.prepare("INSERT INTO contacts(faculty_id,user_id,name,email,subject,message,created_at,status,category,updated_at,filiere_id,client_id) VALUES(?,?,?,?,?,?,?,'received',?,?,?,?) RETURNING *").get(req.user.faculty_id,req.user.id,req.user.name,req.user.email,title,description,now(),category,now(),req.user.filiere_id,client);
      const recipients=await notifyAdminInbox(row.faculty_id,'Nouvelle demande de feedback',title,`/app/admin?tab=contacts&contact=${row.id}`,{filiereId:row.filiere_id});
      return {row,recipients};
    });
    await broadcastAdminInbox(recipients);
    res.status(201).json({ticket:await ticketDTO(row)});
  });
  app.get('/api/feedback/:id',requireFaculty,async(req,res)=>res.json({ticket:await ticketDTO(await ticket(req,req.params.id),req.user)}));
  app.post('/api/feedback/:id/replies',requireFaculty,async(req,res)=>res.status(201).json({ticket:await reply(req,await ticket(req,req.params.id),false)}));
  app.get('/api/admin/feedback/:id',requireFaculty,async(req,res)=>res.json({ticket:await ticketDTO(await ticket(req,req.params.id,true),req.user)}));
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
        if(fresh.closed_at||['closed','resolved','done'].includes(fresh.status))throw problem(409,'La conversation est clôturée.');
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
    if(!row||row.user_id!==req.user.id&&!(permissions.can(req.user,'feedback.manage',row.faculty_id,row.filiere_id)&&(row.assigned_to===req.user.id||permissions.isOwner(req.user))))throw problem(403,'Pièce jointe privée.');
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
    const faculties=(await db.prepare('SELECT id FROM faculties ORDER BY id').all()).map(f=>f.id);
    const scopes=faculty==='all'?faculties:[faculty];
    if(!['faculty_admin','faculty_leader','moderator'].includes(role)||!scopes.length||scopes.some(id=>!faculties.includes(id))||role==='faculty_leader'&&faculty!==target.faculty_id||faculty==='all'&&filiere)throw problem(400,'Rôle ou périmètre invalide.');
    if(filiere&&!await db.prepare('SELECT 1 FROM filieres WHERE id=? AND faculty_id=?').get(filiere,faculty))throw problem(400,'Filière invalide.');
    const capabilities=req.body.capabilities;
    if(!Array.isArray(capabilities)||!capabilities.length||capabilities.length>CAPABILITIES.length||capabilities.some(c=>!CAPABILITIES.includes(c)))throw problem(400,'Permissions invalides.');
    if(capabilities.includes('resource.upload')&&faculty!==target.faculty_id)throw problem(400,'Le dépôt se délègue dans la faculté académique du compte.');
    if(capabilities.includes('resource.upload')&&!filiere)throw problem(400,'Le droit de dépôt requiert une filière explicite.');
    if(role==='faculty_leader'&&capabilities.some(c=>!['content.moderate','student.support'].includes(c)))throw problem(400,'Un Faculty Leader reçoit seulement des permissions locales de modération ou de soutien.');
    const appointments=await db.transaction(async()=>{
      if(role==='faculty_leader'){
        const scopes=await db.prepare("SELECT DISTINCT filiere_id FROM users WHERE faculty_id=? AND role IN('student','faculty_leader') AND disabled=0 AND account_status='approved' ORDER BY filiere_id").all(faculty);
        for(const scope of scopes)await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${faculty}:${scope.filiere_id}`);
      }
      const current=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(target.id);
      if(!current||current.disabled||current.account_status!=='approved'||current.faculty_id!==target.faculty_id)throw problem(409,'Ce compte ou sa faculté a changé. Rechargez la nomination.');
      if(role==='faculty_leader'){
        const eligible=await permissions.load(current),ranking=await permissions.facultyStanding(faculty),standing=ranking.find(r=>r.id===target.id);
        if(eligible.validated_xp<=0||!standing||standing.ranking_score<=0||standing.ranking_score!==ranking[0]?.ranking_score)throw problem(400,'Seul un étudiant en tête du classement validé de sa faculté est éligible.');
      }
      if(current.role!==role)await db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now(),target.id);
      const rows=[];
      for(const facultyId of scopes){
        const row=await db.prepare('INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,filiere_id,capabilities,created_at) VALUES(?,?,?,?,?,?) RETURNING *').get(target.id,req.user.id,facultyId,filiere,JSON.stringify([...new Set(capabilities)]),now());
        await permissions.audit(req.user,'appointment.grant','appointment',row.id,{user_id:target.id,faculty_id:facultyId,filiere_id:filiere,capabilities});
        rows.push(row);
      }
      await db.prepare('UPDATE users SET role=?,session_version=session_version+1,auth_revoked_at=? WHERE id=?').run(role,now(),target.id);
      return rows;
    });
    await broadcast(target.faculty_id);res.status(201).json({appointment:appointments[0],appointments});
  });
  app.delete('/api/admin/users/:id/appointments',requireFaculty,owner,async(req,res)=>{
    const target=await db.prepare('SELECT * FROM users WHERE id=?').get(asId(req.params.id));
    if(!target)throw problem(404,'Compte introuvable.');
    if(permissions.isOwner(target))throw problem(403,'Compte propriétaire protégé.');
    await db.transaction(async()=>{
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(target.id);
      await db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now(),target.id);
      await db.prepare('UPDATE users SET session_version=session_version+1,auth_revoked_at=? WHERE id=?').run(now(),target.id);
      await permissions.audit(req.user,'appointment.revoke_all','user',target.id);
    });
    await broadcast(target.faculty_id);res.json({ok:true});
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
    const row=await notificationStore.find(req.user,asId(req.params.id));
    if(!row)throw problem(404,'Notification introuvable.');
    if(row.target_deleted||!await authorizeNotificationTarget(req.user,row.path))throw problem(403,'La destination est indisponible ou non autorisée.');
    return row;
  }
  app.get('/api/notifications',requireFaculty,async(req,res)=>{
    const limit=req.query.limit===undefined?100:asId(req.query.limit);if(limit>200)throw problem(400,'Limite invalide.');
    const before=req.query.before_id===undefined?null:asId(req.query.before_id);
    res.json(await notificationStore.payload(req.user,{limit,before}));
  });
  // Compatibility for existing clients; use the same visibility and retention rules.
  app.get('/api/notifications/state',requireFaculty,async(req,res)=>res.json(await notificationStore.state(req.user)));
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
    const firstRead=await db.transaction(async()=>{
      const visit=await db.prepare('SELECT * FROM notification_visits WHERE token=? AND notification_id=? AND user_id=? FOR UPDATE').get(token,row.id,req.user.id);
      if(!visit||visit.path!==row.path||visit.expires_at<now())throw problem(409,'La destination doit être ouverte avant de terminer la visite.');
      if(!await authorizeNotificationTarget(req.user,row.path))throw problem(403,'La destination n’est plus autorisée.');
      await db.prepare('UPDATE notification_visits SET departed_at=? WHERE token=?').run(now(),token);
      const marked=await notificationStore.markRead(req.user,row.id);
      if(!marked.length)throw problem(404,'Notification introuvable.');
      return marked[0].read_at;
    });
    await broadcastUserUpdate([req.user.id],{notifications:true});res.json({ok:true,read_at:firstRead});
  });
  app.post('/api/notifications/read',requireFaculty,async(req,res)=>{
    await notificationStore.markRead(req.user);
    await broadcastUserUpdate([req.user.id],{notifications:true});
    res.json(await notificationStore.payload(req.user));
  });
  app.post('/api/notifications/:id/read',requireFaculty,async(req,res)=>{
    const row=await notificationStore.find(req.user,asId(req.params.id));
    if(!row)throw problem(404,'Notification introuvable.');
    // The explicit click reads the notice even when its destination is gone.
    // Ownership is required; destination access is never granted by this action.
    await notificationStore.markRead(req.user,row.id);
    await broadcastUserUpdate([req.user.id],{notifications:true});
    res.json(await notificationStore.payload(req.user));
  });
  return {ticketDTO,reply,statuses,assertParticipant};
}
