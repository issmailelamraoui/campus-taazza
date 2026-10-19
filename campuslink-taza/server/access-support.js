import {createHash,randomBytes} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const cookieName='campus_support';
export function installAccessSupport(app,{db,problem,limiter,notifyAdminInbox,broadcastAdminInbox,broadcast,ticketDTO,supportStreams,notifyDirect,broadcastUserUpdate,heartbeats}) {
 const now=()=>new Date().toISOString();
 const secret=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
 function cookie(req){return String(req.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);}
 function setCookie(req,res,key){res.cookie(cookieName,key,{httpOnly:true,secure:req.secure||process.env.COOKIE_SECURE==='true',sameSite:'strict',path:'/api/support',maxAge:30*24*3600000});}
 async function current(req,lock=false){
  const key=secret(cookie(req));
  const row=key&&await db.prepare('SELECT * FROM contacts WHERE recovery_hash=?'+(lock?' FOR UPDATE':'')).get(hash(key));
  if(!row)throw problem(401,'Retrouvez votre demande avec son code de récupération.');
  return row;
 }
 const field=(value,name,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw problem(400,name+' invalide.');return value.trim();};
 app.post('/api/support/request',async(req,res)=>{
  limiter.take(req.ip);
  const account=req.user?.account_status==='approved'?req.user:null;
  const name=field(account?.name||req.body.name,'Nom',100),email=field(account?.email||req.body.email,'Email',160).toLowerCase(),subject=field(req.body.subject,'Objet',180),message=field(req.body.message,'Description',6000);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw problem(400,'Adresse email invalide.');
  const faculty=await db.prepare('SELECT id FROM faculties WHERE id=?').get(String(account?.faculty_id||req.body.faculty_id||''));
  if(!faculty)throw problem(400,'Choisissez votre faculté.');
  const key=secret(req.body.recovery_key)||randomBytes(32).toString('hex');
  const {row,recipients}=await db.transaction(async()=>{
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('support:'+hash(key));
   const prior=await db.prepare('SELECT * FROM contacts WHERE recovery_hash=?').get(hash(key));
   if(prior){if(prior.name!==name||prior.email!==email||prior.subject!==subject||prior.message!==message||prior.faculty_id!==faculty.id)throw problem(409,'Ce code appartient déjà à une autre demande.');return {row:prior,recipients:[]};}
   const row=await db.prepare("INSERT INTO contacts(faculty_id,name,email,subject,message,created_at,updated_at,status,category,recovery_hash,user_id,filiere_id) VALUES(?,?,?,?,?,?,?,'received','concern',?,?,?) RETURNING *").get(faculty.id,name,email,subject,message,now(),now(),hash(key),account?.id||null,account?.filiere_id||null);
   const recipients=await notifyAdminInbox(faculty.id,'Problème d’accès à CampusLink',subject,`/app/admin?tab=contacts&contact=${row.id}`,{filiereId:row.filiere_id});
   return {row,recipients};
  });
  setCookie(req,res,key);await broadcastAdminInbox(recipients);
  res.status(201).json({ticket:await ticketDTO(row),recovery_key:key});
 });
 app.post('/api/support/recover',async(req,res)=>{
  limiter.take(req.ip);
  const key=secret(req.body.recovery_key);
  const row=key&&await db.prepare('SELECT * FROM contacts WHERE recovery_hash=?').get(hash(key));
  if(!row)throw problem(401,'Code de récupération invalide.');
  setCookie(req,res,key);res.json({ticket:await ticketDTO(row)});
 });
 app.get('/api/support/stream',async(req,res)=>{
  const row=await current(req);
  if(res.destroyed||res.writableEnded)return;
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.flushHeaders();res.write('retry: 1000\n\n: connected\n\n');
  if(!supportStreams.has(row.faculty_id))supportStreams.set(row.faculty_id,new Set());
  supportStreams.get(row.faculty_id).add(res);
  const timer=setInterval(()=>{if(!res.writableEnded)res.write(': heartbeat\n\n');},15000);
  timer.unref?.();heartbeats.add(timer);
  res.once('close',()=>{clearInterval(timer);heartbeats.delete(timer);supportStreams.get(row.faculty_id)?.delete(res);if(!supportStreams.get(row.faculty_id)?.size)supportStreams.delete(row.faculty_id);});
 });
 app.get('/api/support/session',async(req,res)=>res.json({ticket:await ticketDTO(await current(req))}));
 app.post('/api/support/logout',(_req,res)=>{res.clearCookie(cookieName,{path:'/api/support',httpOnly:true,sameSite:'strict'});res.json({ok:true});});
 app.post('/api/support/replies',async(req,res)=>{
  const content=field(req.body.content,'Message',4000),client=String(req.body.client_id||'');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(client))throw problem(400,'Identifiant de message invalide.');
  const row=await db.transaction(async()=>{
   const row=await current(req,true);
   if(!row.assigned_to||row.closed_at||['closed','resolved','done'].includes(row.status))throw problem(409,'La conversation attend une acceptation ou est clôturée.');
   const prior=await db.prepare('SELECT content,author_id FROM contact_replies WHERE contact_id=? AND client_id=?').get(row.id,client);
   if(prior){if(prior.author_id!==null||prior.content!==content)throw problem(409,'Identifiant déjà utilisé.');return row;}
   const posted=await db.prepare('INSERT INTO contact_replies(contact_id,author_id,content,administrative,created_at,client_id) VALUES(?,NULL,?,0,?,?) RETURNING id').get(row.id,content,now(),client);
   await db.prepare('UPDATE contacts SET updated_at=? WHERE id=?').run(now(),row.id);
   await notifyDirect(row.assigned_to,'admin',`Réponse : ${row.subject}`,content,`/app/feedback?ticket=${row.id}&admin=1#reply-${posted.id}`);
   return row;
  });
  await Promise.all([broadcast(row.faculty_id),broadcastUserUpdate([row.assigned_to].filter(Boolean),{support:true})]);res.json({ticket:await ticketDTO(row)});
 });
 app.post('/api/support/reactions',async(req,res)=>{
  const row=await db.transaction(async()=>{
   const row=await current(req,true),reaction=req.body.reaction;
   if(!row.assigned_to||!['like','heart'].includes(reaction)||typeof req.body.active!=='boolean')throw problem(400,'Réaction invalide.');
   const reply=await db.prepare('SELECT id FROM contact_replies WHERE id=? AND contact_id=?').get(Number(req.body.reply_id)||0,row.id);
   if(!reply)throw problem(404,'Message introuvable.');
   if(req.body.active)await db.prepare('INSERT INTO contact_reactions(reply_id,actor_key,reaction) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(reply.id,'guest:'+row.id,reaction);
   else await db.prepare('DELETE FROM contact_reactions WHERE reply_id=? AND actor_key=? AND reaction=?').run(reply.id,'guest:'+row.id,reaction);
   return row;
  });
  await Promise.all([broadcast(row.faculty_id),broadcastUserUpdate([row.assigned_to].filter(Boolean),{support:true})]);res.json({ticket:await ticketDTO(row)});
 });
}
