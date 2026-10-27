import {randomUUID} from 'node:crypto';

const date=()=>new Date().toISOString();
const eligible=u=>u&&!u.disabled&&u.account_status==='approved'&&['student','faculty_leader'].includes(u.role);
export function sameStudyScope(a,b){return !!a?.faculty_id&&!!a?.filiere_id&&a.faculty_id===b?.faculty_id&&a.filiere_id===b?.filiere_id;}
export function sourceAnchor(raw){
 if(raw==null)return[];
 const bad=()=>{throw Object.assign(new Error('Zone source invalide.'),{status:400});};
 if(!Array.isArray(raw)||raw.length>100)return bad();
 return raw.map(value=>{if(!value||!['x','y','width','height'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0&&value[key]<=1)||value.width<=0||value.height<=0||value.x+value.width>1.000001||value.y+value.height>1.000001)return bad();return{x:value.x,y:value.y,width:value.width,height:value.height};});
}
export function boardOperation(raw){
 const bad=()=>{throw Object.assign(new Error('Opération de tableau invalide.'),{status:400});};
 if(!raw||typeof raw!=='object')return bad();
 if(raw.type==='clear')return {type:'clear'};
 const color=['#2563eb','#111827','#dc2626','#16a34a'].includes(raw.color)?raw.color:'#2563eb';
 if(raw.type==='text'){
  if(typeof raw.text!=='string'||!raw.text.trim()||raw.text.length>500||![raw.x,raw.y].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1))return bad();
  return {type:'text',text:raw.text.trim(),x:raw.x,y:raw.y,color};
 }
 if(raw.type==='shape'){if(!['rectangle','ellipse','line'].includes(raw.shape)||!['x1','y1','x2','y2'].every(key=>typeof raw[key]==='number'&&Number.isFinite(raw[key])&&raw[key]>=0&&raw[key]<=1)||(raw.x1===raw.x2&&raw.y1===raw.y2))return bad();return{type:'shape',shape:raw.shape,x1:raw.x1,y1:raw.y1,x2:raw.x2,y2:raw.y2,color,width:Math.max(1,Math.min(8,Number(raw.width)||2))};}
 if(raw.type!=='stroke'||!Array.isArray(raw.points)||raw.points.length<2||raw.points.length>1000)return bad();
 const points=raw.points.map(p=>{if(!Array.isArray(p)||p.length!==2||!p.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1))return bad();return p;});
 return {type:'stroke',points,color,width:Math.max(1,Math.min(8,Number(raw.width)||2))};
}

export function installCampusRoutes(app,{db,requireFaculty,problem,assertResource,author,notifyDirect,notifyProgram,broadcast,canAdminFaculty,auditAdministrative}){
 const id=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw problem(400,'Identifiant invalide.');return n;};
 const text=(v,label,max=4000)=>{if(typeof v!=='string'||!v.trim()||v.includes('\u0000')||v.trim().length>max)throw problem(400,label+' invalide.');return v.trim();};
 const scope=(row,user)=>sameStudyScope(row,user);
 const manage=(user,faculty,filiere=null)=>canAdminFaculty(user,faculty,filiere);
 const notice=(user,type,title,body,path,context=null)=>notifyDirect(user,type,title,body,path,context);
 const cooldown=async(table,key,user,seconds)=>{
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('campus:rate:'+table+':'+user.id);
  if(await db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=? AND created_at>? LIMIT 1`).get(user.id,new Date(Date.now()-seconds*1000).toISOString()))throw problem(429,'Veuillez patienter avant de publier à nouveau.');
 };
 async function source(req){
  const resourceId=req.body.resource_id? id(req.body.resource_id):null;
  let version=null;if(resourceId){const r=await assertResource(resourceId,req);version=req.body.source_version==null?r.version:id(req.body.source_version);if(version!==r.version&&!await db.prepare('SELECT 1 FROM resource_versions WHERE resource_id=? AND version=?').get(r.id,version))throw problem(404,'Version source indisponible.');}
  const page=req.body.source_page==null?null:id(req.body.source_page);if(page>100000)throw problem(400,'Page invalide.');
  if(page&&!resourceId)throw problem(400,'Une page nécessite un document source.');
  return {resourceId,page,version};
 }
 async function question(user,value){const q=await db.prepare('SELECT * FROM campus_questions WHERE id=? AND removed=FALSE').get(id(value));if(!q||!scope(q,user))throw problem(404,'Question inaccessible.');return q;}
 async function answer(user,value){const a=await db.prepare('SELECT * FROM campus_answers WHERE id=? AND removed=FALSE').get(id(value));if(!a)throw problem(404,'Réponse inaccessible.');await question(user,a.question_id);return a;}
 async function pairLock(a,b){await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campus:${db.schema}:block-pair:${Math.min(a,b)}:${Math.max(a,b)}`);}
 async function pairSafety(userId,peerId){
  const rows=await db.prepare('SELECT blocker_id FROM campus_blocks WHERE (blocker_id=? AND blocked_id=?) OR(blocker_id=? AND blocked_id=?)').all(userId,peerId,peerId,userId);
  return {blocked:rows.length>0,blocked_by_me:rows.some(row=>row.blocker_id===userId),peer_id:peerId};
 }
 async function assertUnblocked(a,b){if((await pairSafety(a,b)).blocked)throw problem(403,'Les échanges avec ce partenaire sont bloqués.');}
 async function expireRequests(user){await db.prepare("UPDATE close_requests SET status='closed',close_reason='expired' WHERE faculty_id=? AND filiere_id=? AND status='open' AND expires_at<=now()").run(user.faculty_id,user.filiere_id);}
 async function room(user,value,{interaction=false,lockPair=false,holdUsers=false}={}){
  let row=await db.prepare('SELECT r.*,q.faculty_id,q.filiere_id,q.title,q.module,q.resource_id,q.source_page,q.source_version,q.source_anchor,q.excerpt FROM close_rooms r JOIN close_requests q ON q.id=r.request_id WHERE r.id=?').get(id(value));
  if(!row||![row.requester_id,row.helper_id].includes(user.id)||!scope(row,user))throw problem(404,'CloseRoom inaccessible.');
  if(lockPair){await pairLock(row.requester_id,row.helper_id);row={...row,...await db.prepare('SELECT * FROM close_rooms WHERE id=?').get(row.id)};}
  if(interaction)await assertUnblocked(row.requester_id,row.helper_id);
  const peers=await db.prepare(`SELECT * FROM users WHERE id=ANY(?) ORDER BY id${holdUsers?' FOR SHARE':''}`).all([row.requester_id,row.helper_id]);
  if(peers.length!==2||peers.some(peer=>!eligible(peer)||!scope(row,peer)))throw problem(403,'Cette session n’est plus accessible dans votre filière.');return row;
 }
 async function group(user,value,membership=false){const row=await db.prepare('SELECT * FROM revision_groups WHERE id=? AND closed=FALSE').get(id(value));if(!row||!scope(row,user))throw problem(404,'Groupe inaccessible.');if(membership&&!await db.prepare('SELECT 1 FROM revision_members WHERE group_id=? AND user_id=?').get(row.id,user.id))throw problem(403,'Rejoignez le groupe pour accéder à ses échanges.');return row;}
 async function listing(user,value){const row=await db.prepare("SELECT * FROM market_listings WHERE id=? AND status<>'removed'").get(id(value));if(!row||row.faculty_id!==user.faculty_id)throw problem(404,'Annonce inaccessible.');return row;}
 const withAuthor=async row=>({...row,author:await author(row.author_id)});
 async function awardForumFeedback(questionId){
  const candidate=await db.prepare('SELECT * FROM campus_questions WHERE id=?').get(questionId);if(!candidate)return 0;
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${candidate.faculty_id}:${candidate.filiere_id}`);
  const q=await db.prepare('SELECT * FROM campus_questions WHERE id=? FOR SHARE').get(questionId);
  if(q.removed||!q.accepted_answer_id||!Number.isFinite(Date.parse(q.created_at))||Date.now()-Date.parse(q.created_at)<120000)return 0;
  const a=await db.prepare('SELECT * FROM campus_answers WHERE id=? AND removed=FALSE FOR SHARE').get(q.accepted_answer_id);
  if(!a||a.question_id!==q.id||a.author_id===q.author_id)return 0;
  const participants=await db.prepare('SELECT * FROM users WHERE id=ANY(?) ORDER BY id FOR SHARE').all([q.author_id,a.author_id]);
  const established=u=>eligible(u)&&scope(q,u)&&Date.now()-Date.parse(u.reviewed_at||u.registered_at)>=7*86400000;
  if(participants.length!==2||!participants.every(established))return 0;
  const votes=await db.prepare('SELECT u.* FROM campus_votes v JOIN users u ON u.id=v.user_id WHERE v.answer_id=? AND v.value=1 AND v.user_id<>? AND v.user_id<>? ORDER BY u.id FOR SHARE OF u').all(a.id,q.author_id,a.author_id);
  if(votes.filter(established).length<3)return 0;
  const eventKey=`forum:question:${q.id}:accepted`;
  if(await db.prepare('SELECT 1 FROM xp_events WHERE event_key=? LIMIT 1').get(eventKey))return 0;
  const recent=await db.prepare("SELECT 1 FROM xp_events WHERE user_id=? AND category='contribution' AND details::jsonb->>'requester_id'=? AND created_at>? LIMIT 1").get(a.author_id,String(q.author_id),new Date(Date.now()-30*86400000).toISOString());if(recent)return 0;
  const daily=await db.prepare("SELECT COALESCE(SUM(points),0) AS points FROM xp_events WHERE user_id=? AND category='contribution' AND status='valid' AND details->>'evidence' IS DISTINCT FROM 'published_library_file' AND (created_at::timestamptz AT TIME ZONE 'Africa/Casablanca')::date=(now() AT TIME ZONE 'Africa/Casablanca')::date").get(a.author_id);if(Number(daily.points)>=10)return 0;
  const points=Math.min(5,10-Number(daily.points));
  await db.prepare("INSERT INTO xp_events(user_id,category,event_key,points,details,created_at) VALUES(?,'contribution',?,?,?,?) ON CONFLICT(user_id,event_key) DO NOTHING").run(a.author_id,eventKey,points,JSON.stringify({question_id:q.id,answer_id:a.id,requester_id:q.author_id,evidence:'accepted_answer_and_independent_feedback',independent_voters:votes.filter(established).map(v=>v.id),not_comprehension_proof:true}),date());return points;
 }

 app.get('/api/campus/forum',requireFaculty,async(req,res)=>{
  const query=String(req.query.q||'').trim().slice(0,200),filter=req.query.filter||'recent';
  const pattern='%'+query.toLocaleLowerCase().replace(/[\\%_]/g,'\\$&')+'%';
  const questions=await db.prepare("SELECT q.*,COUNT(a.id)::integer AS answer_count FROM campus_questions q LEFT JOIN campus_answers a ON a.question_id=q.id AND a.removed=FALSE WHERE q.faculty_id=? AND q.filiere_id=? AND q.removed=FALSE AND (?='' OR lower(q.title||' '||q.body||' '||q.module) LIKE ? ESCAPE E'\\\\') AND (?<>'resolved' OR q.accepted_answer_id IS NOT NULL) GROUP BY q.id HAVING (?<>'unanswered' OR COUNT(a.id)=0) ORDER BY q.created_at DESC,q.id DESC LIMIT 200").all(req.user.faculty_id,req.user.filiere_id,query,pattern,filter,filter);
  res.json({questions:await Promise.all(questions.map(withAuthor))});
 });
 app.post('/api/campus/forum',requireFaculty,async(req,res)=>{
  if(!req.user.filiere_id)throw problem(403,'Une filière autorisée est nécessaire.');
  const title=text(req.body.title,'Titre',160),body=text(req.body.body,'Description',10000),module=String(req.body.module||'').trim().slice(0,160),{resourceId,page,version}=await source(req),anchor=sourceAnchor(req.body.source_anchor);if(anchor.length&&(!resourceId||!page))throw problem(400,'Une zone nécessite une page source autorisée.');
  const excerpt=String(req.body.excerpt||'').trim().slice(0,2000);const q=await db.transaction(async()=>{await cooldown('campus_questions','author_id',req.user,30);const row=await db.prepare('INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,module,resource_id,source_page,source_version,source_anchor,source_excerpt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *').get(req.user.faculty_id,req.user.filiere_id,req.user.id,title,body,module,resourceId,page,version,JSON.stringify(anchor),excerpt,date());if(notifyProgram)await notifyProgram(row.faculty_id,'questions','Nouvelle question dans votre filière',row.title,`/app/campus?tab=forum&question=${row.id}`,req.user.id,row.filiere_id,{kind:'forum-question',questionId:row.id,actorId:req.user.id});return row;});
  await broadcast(req.user.faculty_id,req.user.filiere_id);res.status(201).json({question:await withAuthor(q)});
 });
 app.get('/api/campus/forum/:id',requireFaculty,async(req,res)=>{
  const q=await question(req.user,req.params.id);
  const answers=await db.prepare('SELECT a.*,COALESCE(SUM(v.value),0)::integer AS score,COALESCE(MAX(v.value) FILTER(WHERE v.user_id=?),0)::integer AS my_vote FROM campus_answers a LEFT JOIN campus_votes v ON v.answer_id=a.id WHERE a.question_id=? AND a.removed=FALSE GROUP BY a.id ORDER BY a.created_at,a.id').all(req.user.id,q.id);
  const comments=answers.length?await db.prepare('SELECT * FROM campus_comments WHERE answer_id=ANY(?) ORDER BY id').all(answers.map(a=>a.id)):[];
  res.json({question:await withAuthor(q),answers:await Promise.all(answers.map(withAuthor)),comments:await Promise.all(comments.map(withAuthor))});
 });
 app.post('/api/campus/forum/:id/answers',requireFaculty,async(req,res)=>{
  const q=await question(req.user,req.params.id),body=text(req.body.body,'Réponse',10000);
  const a=await db.transaction(async()=>{await cooldown('campus_answers','author_id',req.user,15);const row=await db.prepare('INSERT INTO campus_answers(question_id,author_id,body,created_at) VALUES(?,?,?,?) RETURNING *').get(q.id,req.user.id,body,date());if(q.author_id!==req.user.id)await notice(q.author_id,'campus','Nouvelle réponse',q.title,`/app/campus?tab=forum&question=${q.id}&answer=${row.id}#answer-${row.id}`,{kind:'forum-answer',questionId:q.id,answerId:row.id,actorId:req.user.id});return row;});
  await broadcast(req.user.faculty_id,req.user.filiere_id);res.status(201).json({answer:await withAuthor(a)});
 });
 app.post('/api/campus/answers/:id/comments',requireFaculty,async(req,res)=>{
  const a=await answer(req.user,req.params.id),body=text(req.body.body,'Commentaire',2000);
  const row=await db.transaction(async()=>{await cooldown('campus_comments','author_id',req.user,10);return db.prepare('INSERT INTO campus_comments(answer_id,author_id,body,created_at) VALUES(?,?,?,?) RETURNING *').get(a.id,req.user.id,body,date());});
  res.status(201).json({comment:await withAuthor(row)});
 });
 app.post('/api/campus/answers/:id/vote',requireFaculty,async(req,res)=>{
  const a=await answer(req.user,req.params.id),value=Number(req.body.value);if(a.author_id===req.user.id||![0,1,-1].includes(value))throw problem(400,'Vote invalide.');
  const awarded=await db.transaction(async()=>{await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${req.user.faculty_id}:${req.user.filiere_id}`);if(value===0)await db.prepare('DELETE FROM campus_votes WHERE answer_id=? AND user_id=?').run(a.id,req.user.id);else await db.prepare('INSERT INTO campus_votes(answer_id,user_id,value,created_at) VALUES(?,?,?,?) ON CONFLICT(answer_id,user_id) DO UPDATE SET value=excluded.value').run(a.id,req.user.id,value,date());return awardForumFeedback(a.question_id);});
  if(awarded)await broadcast(req.user.faculty_id,req.user.filiere_id);res.json({ok:true,awarded});
 });
 app.post('/api/campus/forum/:id/accept',requireFaculty,async(req,res)=>{
  const q=await question(req.user,req.params.id),a=await answer(req.user,req.body.answer_id);if(q.author_id!==req.user.id||a.question_id!==q.id)throw problem(403,'Seul l’auteur peut choisir une réponse de sa question.');
  const awarded=await db.transaction(async()=>{await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${q.faculty_id}:${q.filiere_id}`);const locked=await db.prepare('SELECT id,accepted_answer_id FROM campus_questions WHERE id=? FOR UPDATE').get(q.id);await db.prepare('UPDATE campus_questions SET accepted_answer_id=? WHERE id=?').run(a.id,q.id);if(locked.accepted_answer_id!==a.id&&a.author_id!==req.user.id)await notice(a.author_id,'campus','Réponse acceptée',q.title,`/app/campus?tab=forum&question=${q.id}&answer=${a.id}#answer-${a.id}`,{kind:'forum-accepted',questionId:q.id,answerId:a.id,actorId:req.user.id});return awardForumFeedback(q.id);});await broadcast(req.user.faculty_id,req.user.filiere_id);res.json({ok:true,awarded});
 });

 app.get('/api/campus/blocks',requireFaculty,async(req,res)=>{
  const rows=await db.prepare('SELECT blocked_id,created_at FROM campus_blocks WHERE blocker_id=? ORDER BY created_at DESC,blocked_id').all(req.user.id);
  res.json({blocks:await Promise.all(rows.map(async row=>({...row,user:await author(row.blocked_id)})))});
 });
 app.post('/api/campus/blocks/:id',requireFaculty,async(req,res)=>{
  const peerId=id(req.params.id);if(peerId===req.user.id||!eligible(req.user))throw problem(403,'Choisissez un autre partenaire étudiant.');
  await db.transaction(async()=>{
   await pairLock(req.user.id,peerId);
   const users=await db.prepare('SELECT * FROM users WHERE id=ANY(?) ORDER BY id FOR SHARE').all([req.user.id,peerId]),actor=users.find(u=>u.id===req.user.id),peer=users.find(u=>u.id===peerId);
   const previous=await db.prepare('SELECT 1 FROM close_rooms WHERE (requester_id=? AND helper_id=?) OR(requester_id=? AND helper_id=?) LIMIT 1').get(req.user.id,peerId,peerId,req.user.id);
   if(!eligible(actor)||!peer||!((eligible(peer)&&scope(actor,peer))||previous))throw problem(404,'Partenaire inaccessible.');
   await db.prepare('INSERT INTO campus_blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?) ON CONFLICT(blocker_id,blocked_id) DO NOTHING').run(req.user.id,peerId,date());
   // Requests precede room locks everywhere, including acceptance and closing.
   const requests=await db.prepare('SELECT q.id FROM close_requests q JOIN close_rooms r ON r.request_id=q.id WHERE (r.requester_id=? AND r.helper_id=?) OR(r.requester_id=? AND r.helper_id=?) ORDER BY q.id FOR UPDATE OF q').all(req.user.id,peerId,peerId,req.user.id);
   const rooms=await db.prepare('SELECT id FROM close_rooms WHERE (requester_id=? AND helper_id=?) OR(requester_id=? AND helper_id=?) ORDER BY id FOR UPDATE').all(req.user.id,peerId,peerId,req.user.id);
   if(requests.length)await db.prepare("UPDATE close_requests SET status='closed',close_reason='blocked' WHERE id=ANY(?)").run(requests.map(q=>q.id));
   if(rooms.length){const roomIds=rooms.map(r=>r.id);await db.prepare('UPDATE close_rooms SET closed_at=COALESCE(closed_at,?),recording=FALSE,requester_consent=FALSE,helper_consent=FALSE,recording_started_at=NULL,recording_expires_at=NULL WHERE id=ANY(?)').run(date(),roomIds);await db.prepare('UPDATE close_board SET recorded=FALSE WHERE room_id=ANY(?)').run(roomIds);}
   await db.prepare("UPDATE study_match_requests SET status='declined' WHERE (requester_id=? AND recipient_id=?) OR(requester_id=? AND recipient_id=?)").run(req.user.id,peerId,peerId,req.user.id);
  });res.json({ok:true});
 });
 app.delete('/api/campus/blocks/:id',requireFaculty,async(req,res)=>{const peerId=id(req.params.id);await db.transaction(async()=>{await pairLock(req.user.id,peerId);await db.prepare('DELETE FROM campus_blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id,peerId);});res.json({ok:true});});
 app.get('/api/campus/close-requests',requireFaculty,async(req,res)=>{
  if(!eligible(req.user))throw problem(403,'CloseRoom est réservé aux étudiants autorisés.');
  await expireRequests(req.user);
  const requests=await db.prepare("SELECT q.* FROM close_requests q JOIN users u ON u.id=q.requester_id WHERE q.faculty_id=? AND q.filiere_id=? AND q.status='open' AND u.faculty_id=q.faculty_id AND u.filiere_id=q.filiere_id AND u.disabled=0 AND u.account_status='approved' AND u.role IN('student','faculty_leader') AND NOT EXISTS(SELECT 1 FROM campus_blocks b WHERE (b.blocker_id=? AND b.blocked_id=q.requester_id) OR(b.blocker_id=q.requester_id AND b.blocked_id=?)) ORDER BY q.id DESC LIMIT 100").all(req.user.faculty_id,req.user.filiere_id,req.user.id,req.user.id);
  const rooms=await db.prepare('SELECT r.id,r.closed_at,r.created_at,q.title,q.module FROM close_rooms r JOIN close_requests q ON q.id=r.request_id WHERE (r.requester_id=? OR r.helper_id=?) AND q.faculty_id=? AND q.filiere_id=? ORDER BY r.id DESC LIMIT 100').all(req.user.id,req.user.id,req.user.faculty_id,req.user.filiere_id);
  const expiredRequests=await db.prepare("SELECT id,title,module,expires_at,close_reason FROM close_requests WHERE requester_id=? AND close_reason='expired' AND faculty_id=? AND filiere_id=? ORDER BY id DESC LIMIT 20").all(req.user.id,req.user.faculty_id,req.user.filiere_id);
  res.json({requests:await Promise.all(requests.map(async r=>({...r,author:await author(r.requester_id)}))),rooms,expiredRequests,expiryDays:7});
 });
 app.post('/api/campus/close-requests',requireFaculty,async(req,res)=>{
  if(!eligible(req.user)||!req.user.filiere_id)throw problem(403,'CloseRoom est réservé aux étudiants autorisés.');
  const title=text(req.body.title,'Titre',160),topic=text(req.body.topic,'Sujet',4000),module=String(req.body.module||'').trim().slice(0,160),excerpt=String(req.body.excerpt||'').trim().slice(0,2000),{resourceId,page,version}=await source(req),anchor=sourceAnchor(req.body.source_anchor);if(anchor.length&&(!resourceId||!page))throw problem(400,'Une zone nécessite une page source autorisée.');
  await expireRequests(req.user);
  const row=await db.transaction(async()=>{await cooldown('close_requests','requester_id',req.user,60);return db.prepare('INSERT INTO close_requests(faculty_id,filiere_id,requester_id,title,topic,module,resource_id,source_page,source_version,source_anchor,excerpt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *').get(req.user.faculty_id,req.user.filiere_id,req.user.id,title,topic,module,resourceId,page,version,JSON.stringify(anchor),excerpt,date());});res.status(201).json({request:row});
 });
 app.post('/api/campus/close-requests/:id/accept',requireFaculty,async(req,res)=>{
  if(!eligible(req.user))throw problem(403,'Un compte étudiant autorisé est nécessaire.');
  await expireRequests(req.user);
  const row=await db.transaction(async()=>{
   const snapshot=await db.prepare('SELECT * FROM close_requests WHERE id=?').get(id(req.params.id));if(!snapshot||!scope(snapshot,req.user))throw problem(404,'Demande inaccessible.');
   await pairLock(req.user.id,snapshot.requester_id);
   const q=await db.prepare('SELECT * FROM close_requests WHERE id=? FOR UPDATE').get(snapshot.id);if(!q||!scope(q,req.user)||q.requester_id!==snapshot.requester_id)throw problem(404,'Demande inaccessible.');if(q.status!=='open')throw problem(409,'Cette demande a déjà été prise ou fermée.');if(q.requester_id===req.user.id)throw problem(400,'Vous ne pouvez pas accepter votre propre demande.');
   if(Date.parse(q.expires_at)<=Date.now()){await db.prepare("UPDATE close_requests SET status='closed',close_reason='expired' WHERE id=?").run(q.id);return {expired:true};}
   await assertUnblocked(req.user.id,q.requester_id);
   const peers=await db.prepare('SELECT * FROM users WHERE id=ANY(?) ORDER BY id FOR SHARE').all([q.requester_id,req.user.id]);if(peers.length!==2||peers.some(peer=>!eligible(peer)||!scope(q,peer)))throw problem(403,'Ces étudiants ne peuvent plus participer.');
   const created=await db.prepare('INSERT INTO close_rooms(request_id,requester_id,helper_id,created_at) VALUES(?,?,?,?) RETURNING *').get(q.id,q.requester_id,req.user.id,date());await db.prepare("UPDATE close_requests SET status='accepted' WHERE id=?").run(q.id);await notice(q.requester_id,'campus','Votre CloseRoom est prête',q.title,`/app/campus?tab=rooms&room=${created.id}`);return created;
  });if(row.expired)throw problem(409,'Cette demande a expiré après sept jours.');await broadcast(req.user.faculty_id,req.user.filiere_id);res.status(201).json({room:row});
 });
 app.delete('/api/campus/close-requests/:id',requireFaculty,async(req,res)=>{await db.transaction(async()=>{const q=await db.prepare('SELECT * FROM close_requests WHERE id=? FOR UPDATE').get(id(req.params.id));if(!q||q.requester_id!==req.user.id||!scope(q,req.user))throw problem(404,'Demande inaccessible.');if(q.status!=='open')throw problem(409,'Fermez la session depuis votre CloseRoom.');await db.prepare("UPDATE close_requests SET status='closed',close_reason='cancelled' WHERE id=?").run(q.id);});res.json({ok:true});});
 app.get('/api/campus/rooms/:id',requireFaculty,async(req,res)=>{
  const row=await room(req.user,req.params.id),messages=await db.prepare('SELECT * FROM close_messages WHERE room_id=? ORDER BY id DESC LIMIT 200').all(row.id),board=await db.prepare('SELECT * FROM close_board WHERE room_id=? ORDER BY revision').all(row.id);
  res.json({room:row,safety:await pairSafety(req.user.id,row.requester_id===req.user.id?row.helper_id:row.requester_id),participants:await Promise.all([author(row.requester_id),author(row.helper_id)]),messages:await Promise.all(messages.reverse().map(withAuthor)),board});
 });
 app.post('/api/campus/rooms/:id/messages',requireFaculty,async(req,res)=>{
  const body=text(req.body.body,'Message',4000),clientId=req.body.client_id?text(req.body.client_id,'Envoi',80):randomUUID(),{resourceId,page,version}=await source(req);
  const row=await db.transaction(async()=>{const access=await room(req.user,req.params.id,{interaction:true,lockPair:true,holdUsers:true});const r=await db.prepare('SELECT * FROM close_rooms WHERE id=? FOR UPDATE').get(access.id);if(r.closed_at)throw problem(409,'Session fermée.');await cooldown('close_messages','author_id',req.user,1);const m=await db.prepare('INSERT INTO close_messages(room_id,author_id,body,resource_id,source_page,source_version,client_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(room_id,author_id,client_id) DO NOTHING RETURNING *').get(r.id,req.user.id,body,resourceId,page,version,clientId,date());if(m)await notice(r.requester_id===req.user.id?r.helper_id:r.requester_id,'campus','Nouveau message CloseRoom',r.title,`/app/campus?tab=rooms&room=${r.id}`);return m||await db.prepare('SELECT * FROM close_messages WHERE room_id=? AND author_id=? AND client_id=?').get(r.id,req.user.id,clientId);});res.json({message:await withAuthor(row)});
 });
 app.post('/api/campus/rooms/:id/close',requireFaculty,async(req,res)=>{await db.transaction(async()=>{const r=await room(req.user,req.params.id,{lockPair:true,holdUsers:true});await db.prepare('SELECT id FROM close_requests WHERE id=? FOR UPDATE').get(r.request_id);await db.prepare('SELECT id FROM close_rooms WHERE id=? FOR UPDATE').get(r.id);await db.prepare('UPDATE close_rooms SET closed_at=COALESCE(closed_at,?),recording=FALSE WHERE id=?').run(date(),r.id);await db.prepare("UPDATE close_requests SET status='closed',close_reason=COALESCE(close_reason,'room_closed') WHERE id=?").run(r.request_id);});res.json({ok:true});});
 app.post('/api/campus/rooms/:id/board',requireFaculty,async(req,res)=>{
  const operation=boardOperation(req.body.operation),revision=Number(req.body.revision);if(!Number.isSafeInteger(revision)||revision<0)throw problem(400,'Révision invalide.');
  const row=await db.transaction(async()=>{const access=await room(req.user,req.params.id,{interaction:true,lockPair:true,holdUsers:true}),r=await db.prepare('SELECT * FROM close_rooms WHERE id=? FOR UPDATE').get(access.id);if(r.closed_at)throw problem(409,'Session fermée.');if(r.board_revision!==revision)throw Object.assign(problem(409,'Le tableau a changé. Actualisez et recommencez.'),{code:'BOARD_CONFLICT'});if(revision>=2000)throw problem(413,'Limite de tableau atteinte.');const next=revision+1;await db.prepare('UPDATE close_rooms SET board_revision=? WHERE id=?').run(next,r.id);return db.prepare('INSERT INTO close_board(room_id,revision,operation,recorded,created_at) VALUES(?,?,?,?,?) RETURNING *').get(r.id,next,JSON.stringify(operation),r.recording&&r.requester_consent&&r.helper_consent&&Date.parse(r.recording_expires_at)>Date.now(),date());});res.status(201).json({event:row});
 });
 app.post('/api/campus/rooms/:id/consent',requireFaculty,async(req,res)=>{
  if(typeof req.body.consent!=='boolean')throw problem(400,'Choisissez explicitement votre accord.');
  await db.transaction(async()=>{const r=await room(req.user,req.params.id,{interaction:req.body.consent,lockPair:true,holdUsers:true});await db.prepare('SELECT id FROM close_rooms WHERE id=? FOR UPDATE').get(r.id);if(r.closed_at&&req.body.consent)throw problem(409,'Session fermée.');const column=r.requester_id===req.user.id?'requester_consent':'helper_consent';await db.prepare(`UPDATE close_rooms SET ${column}=?,recording=CASE WHEN ?=FALSE THEN FALSE ELSE recording END WHERE id=?`).run(req.body.consent,req.body.consent,r.id);});res.json({ok:true});
 });
 app.post('/api/campus/rooms/:id/recording',requireFaculty,async(req,res)=>{
  if(typeof req.body.recording!=='boolean')throw problem(400,'État invalide.');
  await db.transaction(async()=>{const access=await room(req.user,req.params.id,{interaction:req.body.recording,lockPair:true,holdUsers:true}),r=await db.prepare('SELECT * FROM close_rooms WHERE id=? FOR UPDATE').get(access.id);if(r.requester_id!==req.user.id)throw problem(403,'Seul le demandeur peut gérer son enregistrement.');if(req.body.recording&&(r.closed_at||!r.requester_consent||!r.helper_consent))throw problem(403,'Les deux participants doivent autoriser l’enregistrement.');await db.prepare('UPDATE close_rooms SET recording=?,recording_started_at=COALESCE(recording_started_at,?),recording_expires_at=COALESCE(recording_expires_at,?) WHERE id=?').run(req.body.recording,date(),new Date(Date.now()+30*86400000).toISOString(),r.id);});res.json({ok:true});
 });
 app.get('/api/campus/rooms/:id/replay',requireFaculty,async(req,res)=>{const r=await room(req.user,req.params.id,{interaction:true});if(!r.requester_consent||!r.helper_consent||!r.recording_expires_at||Date.parse(r.recording_expires_at)<Date.now())throw problem(403,'Relecture indisponible : accord absent ou conservation expirée.');res.json({events:await db.prepare('SELECT revision,operation,created_at FROM close_board WHERE room_id=? AND recorded=TRUE ORDER BY revision').all(r.id),expires_at:r.recording_expires_at});});
 app.delete('/api/campus/rooms/:id/replay',requireFaculty,async(req,res)=>{await db.transaction(async()=>{const r=await room(req.user,req.params.id,{lockPair:true,holdUsers:true});await db.prepare('SELECT id FROM close_rooms WHERE id=? FOR UPDATE').get(r.id);await db.prepare('UPDATE close_board SET recorded=FALSE WHERE room_id=?').run(r.id);await db.prepare('UPDATE close_rooms SET recording=FALSE,recording_started_at=NULL,recording_expires_at=NULL,requester_consent=FALSE,helper_consent=FALSE WHERE id=?').run(r.id);});res.json({ok:true});});
 app.post('/api/campus/rooms/:id/rating',requireFaculty,async(req,res)=>{
  const rating=req.body.rating;if(!['helpful','very_helpful','not_helpful'].includes(rating))throw problem(400,'Évaluation invalide.');
  const result=await db.transaction(async()=>{
   const snapshot=await room(req.user,req.params.id);
   // Administrative XP changes take scope before users. Keep that ordering
   // before private pair, peer and room locks as well.
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${snapshot.faculty_id}:${snapshot.filiere_id}`);
   const access=await room(req.user,req.params.id,{interaction:true,lockPair:true});if(access.faculty_id!==snapshot.faculty_id||access.filiere_id!==snapshot.filiere_id||access.helper_id!==snapshot.helper_id)throw problem(409,'Le contexte de cette session a changé.');
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('campus:help:'+access.helper_id);
   const peers=await db.prepare('SELECT * FROM users WHERE id=ANY(?) ORDER BY id FOR SHARE').all([access.requester_id,access.helper_id]);const validPeers=peers.length===2&&peers.every(peer=>eligible(peer)&&scope(access,peer));if(!validPeers)throw problem(403,'Ces étudiants ne peuvent plus participer.');
   const r=await db.prepare('SELECT * FROM close_rooms WHERE id=? FOR UPDATE').get(access.id);if(r.requester_id!==req.user.id)throw problem(403,'Seul le demandeur peut évaluer l’aide.');if(!r.closed_at)throw problem(409,'Fermez la session avant de l’évaluer.');if(r.help_rating)return {awarded:0,already_rated:true};
   const stats=await db.prepare('SELECT COUNT(*)::integer AS total,COUNT(DISTINCT author_id)::integer AS authors FROM close_messages WHERE room_id=?').get(r.id),old=await db.prepare("SELECT 1 FROM close_rooms WHERE id<>? AND help_rating IN('helpful','very_helpful') AND created_at>? AND ((requester_id=? AND helper_id=?) OR(requester_id=? AND helper_id=?)) LIMIT 1").get(r.id,new Date(Date.now()-7*86400000).toISOString(),r.requester_id,r.helper_id,r.helper_id,r.requester_id);
   const daily=await db.prepare("SELECT COALESCE(SUM(points),0)::integer AS total FROM xp_events WHERE user_id=? AND category='help' AND status='valid' AND (created_at::timestamptz AT TIME ZONE 'Africa/Casablanca')::date=(now() AT TIME ZONE 'Africa/Casablanca')::date").get(r.helper_id);
   const points=rating==='not_helpful'?0:rating==='very_helpful'?15:10,qualifies=validPeers&&Date.parse(r.closed_at)-Date.parse(r.created_at)>=120000&&stats.total>=4&&stats.authors===2&&!old&&daily.total+points<=45;
   await db.prepare('UPDATE close_rooms SET help_rating=? WHERE id=?').run(rating,r.id);let awarded=0;if(points&&qualifies){const e=await db.prepare("INSERT INTO xp_events(user_id,category,event_key,points,actor_id,details,created_at) VALUES(?,'help',?,?,?,?,?) ON CONFLICT(user_id,event_key) DO NOTHING RETURNING id").get(r.helper_id,`closeroom:${r.id}:help`,points,req.user.id,JSON.stringify({room_id:r.id,rating}),date());awarded=e?points:0;}return {awarded,eligible:qualifies};});if(result.awarded)await broadcast(req.user.faculty_id,req.user.filiere_id);res.json(result);
 });

 app.get('/api/campus/match',requireFaculty,async(req,res)=>{const offers=await db.prepare("SELECT m.*,u.faculty_id,u.filiere_id FROM study_matches m JOIN users u ON u.id=m.user_id WHERE u.faculty_id=? AND u.filiere_id=? AND u.disabled=0 AND u.account_status='approved' AND u.role IN('student','faculty_leader') AND NOT EXISTS(SELECT 1 FROM campus_blocks b WHERE (b.blocker_id=? AND b.blocked_id=u.id) OR(b.blocker_id=u.id AND b.blocked_id=?)) ORDER BY m.updated_at DESC LIMIT 100").all(req.user.faculty_id,req.user.filiere_id,req.user.id,req.user.id);const requests=await db.prepare("SELECT r.* FROM study_match_requests r JOIN users peer ON peer.id=CASE WHEN r.requester_id=? THEN r.recipient_id ELSE r.requester_id END WHERE (r.requester_id=? OR r.recipient_id=?) AND peer.faculty_id=? AND peer.filiere_id=? AND peer.disabled=0 AND peer.account_status='approved' AND peer.role IN('student','faculty_leader') AND NOT EXISTS(SELECT 1 FROM campus_blocks b WHERE (b.blocker_id=r.requester_id AND b.blocked_id=r.recipient_id) OR(b.blocker_id=r.recipient_id AND b.blocked_id=r.requester_id)) ORDER BY r.id DESC LIMIT 100").all(req.user.id,req.user.id,req.user.id,req.user.faculty_id,req.user.filiere_id);res.json({offers:await Promise.all(offers.map(async m=>({...m,user:await author(m.user_id)}))),requests});});
 app.post('/api/campus/match',requireFaculty,async(req,res)=>{if(!eligible(req.user))throw problem(403,'Compte étudiant nécessaire.');await db.prepare('INSERT INTO study_matches(user_id,module,topic,availability,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET module=excluded.module,topic=excluded.topic,availability=excluded.availability,updated_at=excluded.updated_at').run(req.user.id,text(req.body.module,'Module',160),text(req.body.topic,'Sujet',500),text(req.body.availability,'Disponibilité générale',300),date());res.json({ok:true});});
 app.delete('/api/campus/match',requireFaculty,async(req,res)=>{await db.prepare('DELETE FROM study_matches WHERE user_id=?').run(req.user.id);res.json({ok:true});});
 app.post('/api/campus/match/:id/request',requireFaculty,async(req,res)=>{const peerId=id(req.params.id);if(peerId===req.user.id)throw problem(403,'Ce partenaire n’est pas disponible.');await db.transaction(async()=>{await pairLock(req.user.id,peerId);await assertUnblocked(req.user.id,peerId);const peers=await db.prepare('SELECT * FROM users WHERE id=ANY(?) ORDER BY id FOR SHARE').all([req.user.id,peerId]);if(peers.length!==2||peers.some(peer=>!eligible(peer)||!scope(peer,req.user))||!await db.prepare('SELECT 1 FROM study_matches WHERE user_id=? FOR SHARE').get(peerId))throw problem(403,'Ce partenaire n’est pas disponible.');await cooldown('study_match_requests','requester_id',req.user,30);const inserted=await db.prepare("INSERT INTO study_match_requests(requester_id,recipient_id,created_at) VALUES(?,?,?) ON CONFLICT(requester_id,recipient_id) DO UPDATE SET status='pending',created_at=excluded.created_at WHERE study_match_requests.status='declined' RETURNING id").get(req.user.id,peerId,date());if(inserted)await notice(peerId,'campus','Demande de révision',(await author(req.user.id)).name,'/app/campus?tab=match');});res.json({ok:true});});
 app.patch('/api/campus/match-requests/:id',requireFaculty,async(req,res)=>{if(!['accepted','declined'].includes(req.body.status))throw problem(400,'État invalide.');await db.transaction(async()=>{const snapshot=await db.prepare('SELECT * FROM study_match_requests WHERE id=? AND recipient_id=?').get(id(req.params.id),req.user.id);if(!snapshot)throw problem(404,'Demande inaccessible.');await pairLock(snapshot.requester_id,snapshot.recipient_id);await assertUnblocked(snapshot.requester_id,snapshot.recipient_id);const peers=await db.prepare('SELECT * FROM users WHERE id=ANY(?) ORDER BY id FOR SHARE').all([snapshot.requester_id,snapshot.recipient_id]);if(peers.length!==2||peers.some(peer=>!eligible(peer)||!scope(peer,req.user)))throw problem(403,'Ce partenaire n’est plus accessible.');const r=await db.prepare('SELECT * FROM study_match_requests WHERE id=? AND recipient_id=? FOR UPDATE').get(snapshot.id,req.user.id);if(!r||r.requester_id!==snapshot.requester_id)throw problem(404,'Demande inaccessible.');if(r.status===req.body.status)return;if(r.status!=='pending')throw problem(409,'Cette demande a déjà reçu une réponse.');await db.prepare('UPDATE study_match_requests SET status=? WHERE id=?').run(req.body.status,r.id);await notice(r.requester_id,'campus','Votre demande de révision',req.body.status,'/app/campus?tab=match');});res.json({ok:true});});

 app.get('/api/campus/groups',requireFaculty,async(req,res)=>{const rows=await db.prepare('SELECT g.*,COUNT(m.user_id)::integer AS member_count,BOOL_OR(m.user_id=?) AS joined FROM revision_groups g LEFT JOIN revision_members m ON m.group_id=g.id WHERE g.faculty_id=? AND g.filiere_id=? AND g.closed=FALSE GROUP BY g.id ORDER BY g.id DESC LIMIT 100').all(req.user.id,req.user.faculty_id,req.user.filiere_id);res.json({groups:rows});});
 app.post('/api/campus/groups',requireFaculty,async(req,res)=>{if(!eligible(req.user)||!req.user.filiere_id)throw problem(403,'Compte étudiant nécessaire.');const title=text(req.body.title,'Titre',120),module=text(req.body.module,'Module',160);const row=await db.transaction(async()=>{await cooldown('revision_groups','owner_id',req.user,60);const g=await db.prepare('INSERT INTO revision_groups(faculty_id,filiere_id,owner_id,title,module,created_at) VALUES(?,?,?,?,?,?) RETURNING *').get(req.user.faculty_id,req.user.filiere_id,req.user.id,title,module,date());await db.prepare('INSERT INTO revision_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(g.id,req.user.id,date());return g;});res.status(201).json({group:row});});
 app.post('/api/campus/groups/:id/join',requireFaculty,async(req,res)=>{if(!eligible(req.user))throw problem(403,'Compte étudiant nécessaire.');await db.transaction(async()=>{const access=await group(req.user,req.params.id);await db.prepare('SELECT id FROM revision_groups WHERE id=? FOR UPDATE').get(access.id);if(await db.prepare('SELECT 1 FROM revision_members WHERE group_id=? AND user_id=?').get(access.id,req.user.id))return;if((await db.prepare('SELECT COUNT(*)::integer AS total FROM revision_members WHERE group_id=?').get(access.id)).total>=8)throw problem(409,'Ce groupe a atteint sa limite de huit membres.');await db.prepare('INSERT INTO revision_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(access.id,req.user.id,date());});res.json({ok:true});});
 app.post('/api/campus/groups/:id/leave',requireFaculty,async(req,res)=>{await db.transaction(async()=>{const g=await group(req.user,req.params.id,true);await db.prepare('SELECT id FROM revision_groups WHERE id=? FOR UPDATE').get(g.id);await db.prepare('DELETE FROM revision_members WHERE group_id=? AND user_id=?').run(g.id,req.user.id);if(g.owner_id===req.user.id){const next=await db.prepare('SELECT user_id FROM revision_members WHERE group_id=? ORDER BY joined_at,user_id LIMIT 1').get(g.id);await db.prepare('UPDATE revision_groups SET owner_id=?,closed=? WHERE id=?').run(next?.user_id||req.user.id,!next,g.id);}});res.json({ok:true});});
 app.get('/api/campus/groups/:id',requireFaculty,async(req,res)=>{const g=await group(req.user,req.params.id,true),members=await db.prepare('SELECT user_id FROM revision_members WHERE group_id=? ORDER BY joined_at').all(g.id),messages=await db.prepare('SELECT * FROM revision_messages WHERE group_id=? ORDER BY id DESC LIMIT 200').all(g.id);res.json({group:g,members:await Promise.all(members.map(m=>author(m.user_id))),messages:await Promise.all(messages.reverse().map(withAuthor))});});
 app.post('/api/campus/groups/:id/messages',requireFaculty,async(req,res)=>{const body=text(req.body.body,'Message',4000),{resourceId,page,version}=await source(req);const m=await db.transaction(async()=>{const g=await group(req.user,req.params.id,true);await cooldown('revision_messages','author_id',req.user,1);return db.prepare('INSERT INTO revision_messages(group_id,author_id,body,resource_id,source_page,source_version,created_at) VALUES(?,?,?,?,?,?,?) RETURNING *').get(g.id,req.user.id,body,resourceId,page,version,date());});res.status(201).json({message:await withAuthor(m)});});

 app.get('/api/campus/market',requireFaculty,async(req,res)=>{const rows=await db.prepare("SELECT * FROM market_listings WHERE faculty_id=? AND status<>'removed' ORDER BY id DESC LIMIT 200").all(req.user.faculty_id);res.json({listings:await Promise.all(rows.map(async m=>({...m,seller:await author(m.seller_id)})))});});
 app.post('/api/campus/market',requireFaculty,async(req,res)=>{const title=text(req.body.title,'Titre',160),body=text(req.body.body,'Description',4000),category=req.body.category,price=req.body.price==null||req.body.price===''?null:Number(req.body.price);if(!['books','calculators','supplies','equipment'].includes(category)||price!==null&&(!Number.isSafeInteger(price)||price<0||price>10000000))throw problem(400,'Catégorie ou prix invalide.');const image=req.body.image_resource_id?await assertResource(id(req.body.image_resource_id),req):null;if(image&&!String(image.mime).startsWith('image/'))throw problem(400,'Choisissez une image.');const m=await db.transaction(async()=>{await cooldown('market_listings','seller_id',req.user,60);return db.prepare('INSERT INTO market_listings(faculty_id,seller_id,title,body,category,price,image_resource_id,created_at) VALUES(?,?,?,?,?,?,?,?) RETURNING *').get(req.user.faculty_id,req.user.id,title,body,category,price,image?.id||null,date());});res.status(201).json({listing:m});});
 app.get('/api/campus/market/:id',requireFaculty,async(req,res)=>{const row=await listing(req.user,req.params.id);const requests=row.seller_id===req.user.id?await db.prepare('SELECT * FROM market_requests WHERE listing_id=? ORDER BY id').all(row.id):await db.prepare('SELECT * FROM market_requests WHERE listing_id=? AND author_id=? ORDER BY id').all(row.id,req.user.id);const replies=requests.length?await db.prepare('SELECT * FROM market_request_replies WHERE request_id=ANY(?) ORDER BY id').all(requests.map(r=>r.id)):[];res.json({listing:{...row,seller:await author(row.seller_id)},requests:await Promise.all(requests.map(async request=>({...await withAuthor(request),replies:await Promise.all(replies.filter(reply=>reply.request_id===request.id).map(withAuthor))})))});});
 app.post('/api/campus/market/:id/requests/:requestId/replies',requireFaculty,async(req,res)=>{const row=await listing(req.user,req.params.id),request=await db.prepare('SELECT * FROM market_requests WHERE id=? AND listing_id=?').get(id(req.params.requestId),row.id);if(!request||![request.author_id,row.seller_id].includes(req.user.id))throw problem(404,'Conversation inaccessible.');const body=text(req.body.body,'Réponse',2000);const reply=await db.transaction(async()=>{await cooldown('market_request_replies','author_id',req.user,2);const value=await db.prepare('INSERT INTO market_request_replies(request_id,author_id,body,created_at) VALUES(?,?,?,?) RETURNING *').get(request.id,req.user.id,body,date());await notice(req.user.id===row.seller_id?request.author_id:row.seller_id,'campus','Réponse pour votre annonce',row.title,`/app/campus?tab=market&listing=${row.id}`);return value;});res.status(201).json({reply:await withAuthor(reply)});});
 app.patch('/api/campus/market/:id',requireFaculty,async(req,res)=>{const row=await listing(req.user,req.params.id);if(row.seller_id!==req.user.id)throw problem(403,'Seul le vendeur peut modifier cette annonce.');if(!['available','reserved','sold','removed'].includes(req.body.status))throw problem(400,'État invalide.');await db.prepare('UPDATE market_listings SET status=? WHERE id=?').run(req.body.status,row.id);res.json({ok:true});});
 app.post('/api/campus/market/:id/contact',requireFaculty,async(req,res)=>{const row=await listing(req.user,req.params.id),body=text(req.body.body,'Demande',2000);if(row.seller_id===req.user.id||row.status!=='available')throw problem(400,'Annonce indisponible pour une demande.');await db.transaction(async()=>{await cooldown('market_requests','author_id',req.user,30);await db.prepare('INSERT INTO market_requests(listing_id,author_id,body,created_at) VALUES(?,?,?,?)').run(row.id,req.user.id,body,date());await notice(row.seller_id,'campus','Demande pour votre annonce',row.title,`/app/campus?tab=market&listing=${row.id}`);});res.status(201).json({ok:true});});

 async function reportTarget(user,type,value){const targetId=id(value);if(type==='question')return question(user,targetId);if(type==='answer')return answer(user,targetId);if(type==='room')return room(user,targetId);if(type==='listing')return listing(user,targetId);throw problem(400,'Type de signalement invalide.');}
 app.post('/api/campus/reports',requireFaculty,async(req,res)=>{const type=req.body.target_type,target=await reportTarget(req.user,type,req.body.target_id),reason=text(req.body.reason,'Motif',2000);await db.prepare('INSERT INTO campus_reports(faculty_id,reporter_id,target_type,target_id,reason,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(reporter_id,target_type,target_id) DO UPDATE SET reason=excluded.reason,status=\'open\'').run(req.user.faculty_id,req.user.id,type,target.id,reason,date());res.status(201).json({ok:true});});
 async function reportScope(report,lock=true){
  if(report.target_type==='question')return db.prepare(`SELECT id,faculty_id,filiere_id FROM campus_questions WHERE id=?${lock?' FOR UPDATE':''}`).get(report.target_id);
  if(report.target_type==='answer'){
   // Match Forum's lock order: question before answer. No answer body is read.
   const q=await db.prepare(`SELECT q.id,q.faculty_id,q.filiere_id FROM campus_questions q JOIN campus_answers a ON a.question_id=q.id WHERE a.id=?${lock?' FOR UPDATE OF q':''}`).get(report.target_id);
   if(!q)return null;
   const a=await db.prepare(`SELECT id,question_id FROM campus_answers WHERE id=?${lock?' FOR UPDATE':''}`).get(report.target_id);
   return a?.question_id===q.id?{...q,id:a.id,question_id:q.id}:null;
  }
  if(report.target_type==='room')return db.prepare(`SELECT r.id,q.faculty_id,q.filiere_id FROM close_requests q JOIN close_rooms r ON r.request_id=q.id WHERE r.id=?${lock?' FOR SHARE OF q':''}`).get(report.target_id);
  if(report.target_type==='listing'){
   const listing=await db.prepare(`SELECT id,faculty_id,seller_id FROM market_listings WHERE id=?${lock?' FOR UPDATE':''}`).get(report.target_id);
   if(!listing)return null;
   const seller=await db.prepare(`SELECT faculty_id,filiere_id FROM users WHERE id=?${lock?' FOR SHARE':''}`).get(listing.seller_id);
   return {id:listing.id,faculty_id:listing.faculty_id,filiere_id:seller?.faculty_id===listing.faculty_id?seller.filiere_id:null};
  }
  return null;
 }
 app.get('/api/campus/reports',requireFaculty,async(req,res)=>{
  const faculty=req.user.faculty_id,broad=await manage(req.user,faculty),filieres=[];
  if(!broad)for(const appointment of req.user.appointments||[])if(appointment.faculty_id===faculty&&appointment.filiere_id&&appointment.capabilities.includes('content.moderate')&&!filieres.includes(appointment.filiere_id)&&await manage(req.user,faculty,appointment.filiere_id))filieres.push(appointment.filiere_id);
  if(!broad&&!filieres.length)throw problem(403,'Modération non autorisée.');
  // Derive only target metadata; private CloseRoom conversations, excerpts,
  // participants and recordings never enter the moderation response.
  const reports=await db.prepare(`WITH scoped_reports AS (
   SELECT r.*,CASE r.target_type WHEN 'question' THEN q.faculty_id WHEN 'answer' THEN aq.faculty_id WHEN 'room' THEN rq.faculty_id WHEN 'listing' THEN l.faculty_id END AS target_faculty,
    CASE r.target_type WHEN 'question' THEN q.filiere_id WHEN 'answer' THEN aq.filiere_id WHEN 'room' THEN rq.filiere_id WHEN 'listing' THEN CASE WHEN seller.faculty_id=l.faculty_id THEN seller.filiere_id END END AS target_filiere
   FROM campus_reports r LEFT JOIN campus_questions q ON r.target_type='question' AND q.id=r.target_id
   LEFT JOIN campus_answers a ON r.target_type='answer' AND a.id=r.target_id LEFT JOIN campus_questions aq ON aq.id=a.question_id
   LEFT JOIN close_rooms room ON r.target_type='room' AND room.id=r.target_id LEFT JOIN close_requests rq ON rq.id=room.request_id
   LEFT JOIN market_listings l ON r.target_type='listing' AND l.id=r.target_id LEFT JOIN users seller ON seller.id=l.seller_id
   WHERE r.faculty_id=?
  ) SELECT id,faculty_id,reporter_id,target_type,target_id,reason,status,created_at FROM scoped_reports
   WHERE target_faculty=faculty_id AND (?::boolean OR target_filiere=ANY(?)) ORDER BY id DESC LIMIT 200`).all(faculty,broad,filieres);
  res.json({reports});
 });
 app.patch('/api/campus/reports/:id',requireFaculty,async(req,res)=>{
  if(!['resolved','dismissed'].includes(req.body.status)||req.body.remove!==undefined&&typeof req.body.remove!=='boolean')throw problem(400,'État ou action invalide.');
  const snapshot=await db.prepare('SELECT * FROM campus_reports WHERE id=?').get(id(req.params.id));
  if(!snapshot)throw problem(404,'Signalement introuvable.');
  const before=await reportScope(snapshot,false);
  if(!before||before.faculty_id!==snapshot.faculty_id||!await manage(req.user,before.faculty_id,before.filiere_id))throw problem(403,'Modération non autorisée.');
  const faculty=await db.transaction(async()=>{
   if(req.body.remove&&['question','answer'].includes(snapshot.target_type))await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${before.faculty_id}:${before.filiere_id}`);
   const report=await db.prepare('SELECT * FROM campus_reports WHERE id=? FOR UPDATE').get(id(req.params.id));
   if(!report)throw problem(404,'Signalement introuvable.');
   if(report.target_type!==snapshot.target_type||report.target_id!==snapshot.target_id)throw problem(409,'Le signalement a changé. Rechargez avant de continuer.');
   const target=await reportScope(report);
   if(!target||target.faculty_id!==before.faculty_id||target.filiere_id!==before.filiere_id||target.question_id!==before.question_id)throw problem(409,'Le contexte du contenu a changé. Rechargez avant de continuer.');
   if(!target||target.faculty_id!==report.faculty_id||!await manage(req.user,target.faculty_id,target.filiere_id))throw problem(403,'Modération non autorisée.');
   let revoked=[];
   if(req.body.remove){
    const table={question:'campus_questions',answer:'campus_answers',listing:'market_listings'}[report.target_type];
    if(!table)throw problem(400,'CloseRoom ne peut pas être consultée par la modération.');
    await db.prepare(`UPDATE ${table} SET ${report.target_type==='listing'?"status='removed'":'removed=TRUE'} WHERE id=?`).run(report.target_id);
    if(report.target_type==='answer')await db.prepare('UPDATE campus_questions SET accepted_answer_id=NULL WHERE accepted_answer_id=?').run(report.target_id);
    if(['question','answer'].includes(report.target_type)){
     const questionId=report.target_type==='question'?target.id:target.question_id;
     revoked=await db.prepare(`UPDATE xp_events SET status='revoked' WHERE category='contribution' AND status='valid' AND event_key=?${report.target_type==='answer'?" AND details->>'answer_id'=?":''} RETURNING id`).all(`forum:question:${questionId}:accepted`,...(report.target_type==='answer'?[String(target.id)]:[]));
    }
   }
   await db.prepare('UPDATE campus_reports SET status=? WHERE id=?').run(req.body.status,report.id);
   await auditAdministrative(req.user,'campus.report-moderate',report.target_type,report.target_id,{report_id:report.id,status:req.body.status,removed:!!req.body.remove,revoked_xp_event_ids:revoked.map(e=>e.id)});
   return report.faculty_id;
  });
  await broadcast(faculty);res.json({ok:true});
 });

 async function authorizeNotificationTarget(user,path){
  try{const url=new URL(path,'https://campuslink.local');if(url.pathname!=='/app/campus')return false;const p=url.searchParams,tab=p.get('tab');if(tab==='forum'&&p.get('question')){const q=await question(user,p.get('question'));if(p.get('answer')){const a=await answer(user,p.get('answer'));return a.question_id===q.id;}return true;}if(tab==='rooms'&&p.get('room')){await room(user,p.get('room'));return true;}if(tab==='market'&&p.get('listing')){await listing(user,p.get('listing'));return true;}if(tab==='groups'&&p.get('group')){await group(user,p.get('group'),true);return true;}return tab==='match';}catch{return false;}
 }
 return {authorizeNotificationTarget};
}
