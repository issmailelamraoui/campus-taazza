import {randomUUID} from 'node:crypto';
import {extname} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {digest} from './db.js';
import {detectFile,mayInlineFile} from './files.js';
import {uploadFilePath} from './upload-path.js';
import {storageObjectKey} from './storage.js';

export const FORUM_ATTACHMENT_POLICY=Object.freeze({maxFiles:5,maxFileBytes:20*1024*1024,maxTotalBytes:50*1024*1024,maxUserBytes:1024*1024*1024,uploadsPerDay:50,uploadExpiryMs:15*60*1000});
const date=()=>new Date().toISOString();
const failure=(status,message,code)=>Object.assign(new Error(message),{status,...(code?{code}:{})});
const integer=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw failure(400,'Question invalide.');return n;};
const uuid=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw failure(400,'Identifiant de pièce jointe invalide.');return value.toLowerCase();};

export function installForumAttachmentRoutes(app,{db,requireFaculty,upload,storage,permissions,broadcast}){
 async function access(req,questionId,lock=false){
  const question=await db.prepare(`SELECT * FROM campus_questions WHERE id=?${lock?' FOR UPDATE':''}`).get(questionId);
  const account=await db.prepare(`SELECT * FROM users WHERE id=?${lock?' FOR SHARE':''}`).get(req.user.id);
  if(!account||account.disabled||account.account_status!=='approved'||account.faculty_id!==req.user.faculty_id||account.filiere_id!==req.user.filiere_id)throw failure(403,'Votre compte ou votre accès a changé.');
  if(!question||question.removed||!account.filiere_id||question.faculty_id!==account.faculty_id||question.filiere_id!==account.filiere_id)throw failure(404,'Question inaccessible.');
  const actor=await permissions.load(account);
  return{question,actor,canUpload:question.author_id===actor.id,canModerate:permissions.can(actor,'content.moderate',question.faculty_id,question.filiere_id)};
 }
 function dto(row,authority){return{id:row.id,filename:row.filename,size:row.size,mime:row.mime,url:`/api/campus/forum/${row.question_id}/attachments/${row.id}/file`,can_delete:authority.actor.id===row.author_id||authority.canModerate};}
 async function cleanup(row){
  if(!row?.cleanup_pending||!['removed','failed'].includes(row.status))return;
  try{await db.transaction(async()=>{const current=await db.prepare('SELECT * FROM forum_attachments WHERE id=? FOR UPDATE').get(row.id);if(!current?.cleanup_pending||!['removed','failed'].includes(current.status))return;await storage.delete(current.object_key);await db.prepare('UPDATE forum_attachments SET cleanup_pending=FALSE,file_deleted_at=? WHERE id=?').run(date(),current.id);});}
  catch{console.error('[CampusLink storage] Forum attachment cleanup will be retried.');}
 }
 async function maintain(req,questionId){
  const authority=await access(req,questionId);
  if(!authority.canUpload&&!authority.canModerate)return;
  const authorized=await db.transaction(async()=>{const current=await access(req,questionId,true);if(!current.canUpload&&!current.canModerate)return false;await db.prepare("UPDATE forum_attachments SET status='failed',cleanup_pending=TRUE,updated_at=? WHERE question_id=? AND status='uploading' AND updated_at<?").run(date(),questionId,new Date(Date.now()-FORUM_ATTACHMENT_POLICY.uploadExpiryMs).toISOString());return true;});
  if(!authorized)return;
  const rows=await db.prepare('SELECT * FROM forum_attachments WHERE question_id=? AND cleanup_pending=TRUE ORDER BY updated_at LIMIT 10').all(questionId);
  for(const row of rows)await cleanup(row);
 }
 async function failUpload(row){
  let failed;
  try{failed=await db.transaction(async()=>{const current=await db.prepare('SELECT * FROM forum_attachments WHERE id=? FOR UPDATE').get(row.id);if(!current||current.status==='ready')return current;return db.prepare("UPDATE forum_attachments SET status='failed',cleanup_pending=TRUE,file_deleted_at=NULL,updated_at=? WHERE id=? RETURNING *").get(date(),row.id);});}
  catch{console.error('[CampusLink storage] Forum upload reservation needs reconciliation.');return;}
  await cleanup(failed);
 }
 app.get('/api/campus/forum/:questionId/attachments',requireFaculty,async(req,res)=>{
  const questionId=integer(req.params.questionId);await maintain(req,questionId);
  const rows=await db.prepare("SELECT * FROM forum_attachments WHERE question_id=? AND status='ready' ORDER BY created_at,id LIMIT ?").all(questionId,FORUM_ATTACHMENT_POLICY.maxFiles);
  const authority=await access(req,questionId);res.set('Cache-Control','private, no-store').json({attachments:rows.map(row=>dto(row,authority)),can_upload:authority.canUpload,limits:FORUM_ATTACHMENT_POLICY});
 });
 app.post('/api/campus/forum/:questionId/attachments',requireFaculty,upload.single('file'),async(req,res)=>{
  const questionId=integer(req.params.questionId),file=req.file;
  if(!file?.buffer?.length||file.size!==file.buffer.length||file.size>FORUM_ATTACHMENT_POLICY.maxFileBytes)throw failure(400,'Sélectionnez un fichier pris en charge de 20 Mo maximum.');
  const{filename}=uploadFilePath(file.originalname),mime=detectFile(file.buffer,filename),hash=digest(file.buffer),clientId=req.body.client_id==null?randomUUID():uuid(req.body.client_id);
  await maintain(req,questionId);
  const reserved=await db.transaction(async()=>{
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:forum-attachment-quota:${req.user.id}`);
   const authority=await access(req,questionId,true);if(!authority.canUpload)throw failure(403,'Seul l’auteur peut joindre un fichier à sa question.');
   const existing=await db.prepare('SELECT * FROM forum_attachments WHERE author_id=? AND client_id=?').get(authority.actor.id,clientId);
   if(existing){if(existing.question_id!==questionId||existing.sha256!==hash||existing.filename!==filename)throw failure(409,'Cet identifiant correspond déjà à un autre fichier.');if(existing.status==='uploading')throw failure(409,'Ce dépôt est encore en cours. Actualisez la liste.');if(existing.status!=='ready')throw failure(409,'Ce dépôt a échoué ou a été retiré. Réessayez avec un nouvel identifiant.','ATTACHMENT_RETRY_REQUIRED');return{row:existing,reused:true};}
   const identical=await db.prepare("SELECT * FROM forum_attachments WHERE question_id=? AND status='ready' AND sha256=?").get(questionId,hash);if(identical)return{row:identical,reused:true};
   const quota=await db.prepare("SELECT COUNT(*) FILTER(WHERE question_id=? AND status IN('uploading','ready')) AS files,COALESCE(SUM(size) FILTER(WHERE question_id=? AND status IN('uploading','ready')),0) AS question_bytes,COALESCE(SUM(size) FILTER(WHERE file_deleted_at IS NULL),0) AS user_bytes,COUNT(*) FILTER(WHERE created_at>?) AS daily FROM forum_attachments WHERE author_id=?").get(questionId,questionId,new Date(Date.now()-86400000).toISOString(),authority.actor.id);
   if(Number(quota.files)>=FORUM_ATTACHMENT_POLICY.maxFiles||Number(quota.question_bytes)+file.size>FORUM_ATTACHMENT_POLICY.maxTotalBytes)throw failure(429,'Maximum cinq pièces jointes et 50 Mo par question.');
   if(Number(quota.daily)>=FORUM_ATTACHMENT_POLICY.uploadsPerDay||Number(quota.user_bytes)+file.size>FORUM_ATTACHMENT_POLICY.maxUserBytes)throw failure(429,'Limite de dépôt atteinte. Réessayez plus tard ou retirez des fichiers.');
   const id=randomUUID(),key=storageObjectKey(`forum/${questionId}/${id}${extname(filename).toLowerCase()}`);
   const row=await db.prepare("INSERT INTO forum_attachments(id,question_id,author_id,client_id,filename,object_key,sha256,size,mime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'uploading',?,?) RETURNING *").get(id,questionId,authority.actor.id,clientId,filename,key,hash,file.size,mime,date(),date());return{row,reused:false};
  });
  let row=reserved.row;
  if(!reserved.reused){
   try{await storage.put(row.object_key,file.buffer,mime);row=await db.transaction(async()=>{const authority=await access(req,questionId,true),current=await db.prepare('SELECT * FROM forum_attachments WHERE id=? FOR UPDATE').get(row.id);if(!authority.canUpload||current?.author_id!==authority.actor.id)throw failure(403,'L’autorisation de dépôt a changé.');if(current.status!=='uploading')throw failure(409,'Le dépôt a expiré. Réessayez.');return db.prepare("UPDATE forum_attachments SET status='ready',updated_at=? WHERE id=? RETURNING *").get(date(),current.id);});}
   catch(error){await failUpload(row);if(error.code!=='DATABASE_UNAVAILABLE')error.code='ATTACHMENT_RETRY_REQUIRED';throw error;}
  }
  const authority=await access(req,questionId);await broadcast(authority.question.faculty_id,authority.question.filiere_id);res.status(reserved.reused?200:201).json({attachment:dto(row,authority),reused:reserved.reused});
 });
 app.delete('/api/campus/forum/:questionId/attachments/:attachmentId',requireFaculty,async(req,res)=>{
  const questionId=integer(req.params.questionId),attachmentId=uuid(req.params.attachmentId);
  const row=await db.transaction(async()=>{const authority=await access(req,questionId,true),current=await db.prepare('SELECT * FROM forum_attachments WHERE id=? AND question_id=? FOR UPDATE').get(attachmentId,questionId);if(!current)throw failure(404,'Pièce jointe introuvable.');if(current.author_id!==authority.actor.id&&!authority.canModerate)throw failure(403,'Retrait non autorisé.');if(current.status==='uploading')throw failure(409,'Le dépôt est encore en cours.');if(!['removed','failed'].includes(current.status)){if(authority.canModerate&&current.author_id!==authority.actor.id)await permissions.audit(authority.actor,'forum.attachment-remove','question',questionId,{attachment_id:current.id});return db.prepare("UPDATE forum_attachments SET status='removed',cleanup_pending=TRUE,updated_at=? WHERE id=? RETURNING *").get(date(),current.id);}return current;});
  await cleanup(row);res.json({ok:true});
 });
 app.get('/api/campus/forum/:questionId/attachments/:attachmentId/file',requireFaculty,async(req,res)=>{
  const questionId=integer(req.params.questionId),attachmentId=uuid(req.params.attachmentId);await access(req,questionId);
  const row=await db.prepare("SELECT * FROM forum_attachments WHERE id=? AND question_id=? AND status='ready'").get(attachmentId,questionId);if(!row)throw failure(404,'Pièce jointe indisponible.');
  const file=await storage.get(row.object_key);
  try{await access(req,questionId);const current=await db.prepare("SELECT 1 FROM forum_attachments WHERE id=? AND status='ready' AND object_key=?").get(row.id,row.object_key);if(!current)throw failure(404,'Pièce jointe indisponible.');
   res.type(row.mime);const inline=req.query.download!=='1'&&mayInlineFile(row.mime,row.filename);res.set('Content-Disposition',`${inline?'inline':'attachment'}; filename="${row.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`);res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.set('Content-Security-Policy',"sandbox; default-src 'none'");if(file.contentLength!==undefined)res.set('Content-Length',String(file.contentLength));await pipeline(file.body,res);
  }finally{file.body?.destroy?.();}
 });
}
