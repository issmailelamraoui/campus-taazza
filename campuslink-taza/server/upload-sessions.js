import express from 'express';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {UPLOAD_CHUNK_BYTES,UPLOAD_MAX_BYTES,chunkUploadTarget} from '../shared/upload-transport.js';
import {storageObjectKey} from './storage.js';
import {uploadFilePath} from './upload-path.js';
import {EDUCATIONAL_EXTENSIONS} from './files.js';
import {extname} from 'node:path';

const publicationEffects=new AsyncLocalStorage();
// Chunk publication owns a wider transaction than the original route. Defer
// live refresh events until its metadata and completion receipt are committed.
export function afterUploadCommit(effect){
 const pending=publicationEffects.getStore();
 if(pending){pending.push(effect);return Promise.resolve();}
 return effect();
}

const failure=(status,message)=>Object.assign(new Error(message),{status});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const timestamp=()=>new Date().toISOString();
const expiry=duration=>new Date(Date.now()+duration).toISOString();
const hour=60*60*1000,day=24*hour;
const partCount=row=>Math.ceil(row.size/UPLOAD_CHUNK_BYTES);
const partKey=(row,index)=>`${row.object_prefix}/${index}`;

// Bound both the storage handshake and stream consumption. A stalled private
// piece must release its database transaction and destroy the stream.
export async function readUploadPart({storage,key,part,timeoutMs=15000}){
 let body,timer,expired=false;
 const unavailable=()=>failure(504,'Le stockage répond trop lentement. Réessayez le dépôt.');
 const read=async()=>{
  const file=await storage.get(key);body=file.body;
  if(expired){body?.destroy?.();throw unavailable();}
  const chunks=[];let bytes=0;
  for await(const chunk of body){bytes+=chunk.length;if(bytes>part.size)throw failure(400,'Morceau de fichier invalide.');chunks.push(chunk);}
  const buffer=Buffer.concat(chunks);
  if(bytes!==part.size||hash(buffer)!==part.sha256)throw failure(400,'Le fichier reçu est incomplet ou a changé.');
  return buffer;
 };
 try{return await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;body?.destroy?.();reject(unavailable());},Math.max(1,timeoutMs));})]);}
 finally{clearTimeout(timer);body?.destroy?.();}
}

export function installUploadSessions(app,{db,storage,requireFaculty,refreshActor}){
 // Track only writes made by a resumed route, without changing concurrent
 // requests. A receipt failure must roll back metadata and remove new objects.
 const objectWrites=new AsyncLocalStorage(),put=storage.put;
 storage.put=async function(key,...args){objectWrites.getStore()?.add(key);return put.call(this,key,...args);};
 async function cleanup(row){
  const results=await Promise.allSettled(Array.from({length:partCount(row)},(_,index)=>storage.delete(partKey(row,index+1))));
  if(results.every(result=>result.status==='fulfilled'))await db.prepare('UPDATE upload_sessions SET cleanup_pending=0 WHERE id=?').run(row.id);
 }
 async function prune(){
  const rows=await db.prepare('SELECT * FROM upload_sessions WHERE expires_at<? AND cleanup_pending=1 ORDER BY expires_at LIMIT 4').all(timestamp());
  for(const row of rows)await cleanup(row).catch(()=>{});
  await db.prepare('DELETE FROM upload_sessions WHERE expires_at<? AND cleanup_pending=0').run(timestamp());
 }
 async function session(req,lock=false){
  if(!/^[0-9a-f-]{36}$/i.test(req.params.id||''))throw failure(404,'Dépôt introuvable.');
  const row=await db.prepare(`SELECT * FROM upload_sessions WHERE id=?${lock?' FOR UPDATE':''}`).get(req.params.id);
  if(!row||row.user_id!==req.user.id)throw failure(404,'Dépôt introuvable.');
  if(row.expires_at<=timestamp())throw failure(410,'Ce dépôt a expiré. Relancez le fichier.');
  if(row.faculty_id!==req.user.faculty_id)throw failure(403,'Votre contexte universitaire a changé. Relancez le fichier.');
  return row;
 }
 function snapshot(row){return {id:row.id,state:row.state,chunk_bytes:UPLOAD_CHUNK_BYTES,parts:Object.keys(row.parts).map(Number),...(row.response_status?{response_status:row.response_status,response:row.response_body}:{})};}
 app.post('/api/upload-sessions',requireFaculty,async(req,res)=>{
  const {path,file,fields,client_id:clientId}=req.body;
  if(clientId!==undefined&&(typeof clientId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)))throw failure(400,'Identifiant du dépôt invalide.');
  if(!chunkUploadTarget(path))throw failure(400,'Destination du dépôt invalide.');
  if(!file||!Number.isSafeInteger(file.size)||file.size<1||file.size>UPLOAD_MAX_BYTES)throw failure(400,'Le fichier doit faire au maximum 20 Mo.');
  if(typeof file.name!=='string'||file.name.length>180||!EDUCATIONAL_EXTENSIONS.has(extname(file.name).toLowerCase()))throw failure(400,'Nom ou format de fichier invalide.');
  const {filename}=uploadFilePath(file.name,file.name);
  if(filename!==file.name)throw failure(400,'Nom du fichier invalide.');
  if(!Array.isArray(fields)||fields.length>20||JSON.stringify(fields).length>40000)throw failure(400,'Paramètres du dépôt invalides.');
  for(const field of fields)if(!Array.isArray(field)||field.length!==2||typeof field[0]!=='string'||typeof field[1]!=='string'||field[0].length>80||field[1].length>10000||['file','__proto__','constructor','prototype'].includes(field[0]))throw failure(400,'Paramètres du dépôt invalides.');
  if(fields.some(([key,value])=>key==='faculty_id'&&(value!==req.user.faculty_id||value.length>30)))throw failure(403,'Le dépôt appartient à une autre faculté.');
  await prune();
  const row=await db.transaction(async()=>{
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:upload-sessions:${req.user.id}`);
   if(clientId){
    const prior=await db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(clientId);
    if(prior){
     if(prior.user_id!==req.user.id||prior.faculty_id!==req.user.faculty_id||prior.target_path!==path||prior.filename!==filename||prior.size!==file.size||prior.mime!==String(file.type||'application/octet-stream').slice(0,120)||JSON.stringify(prior.fields)!==JSON.stringify(fields))throw failure(409,'Cet identifiant correspond déjà à un autre dépôt.');
     return prior;
    }
   }
   const active=await db.prepare("SELECT COUNT(*) AS total FROM upload_sessions WHERE user_id=? AND expires_at>? AND state IN ('uploading','finalizing')").get(req.user.id,timestamp());
   if(Number(active.total)>=4)throw failure(429,'Quatre fichiers sont déjà en cours de dépôt. Attendez leur fin.');
   const id=clientId||randomUUID();
   return db.prepare('INSERT INTO upload_sessions(id,user_id,faculty_id,target_path,fields,filename,mime,size,object_prefix,created_at,expires_at) VALUES (?,?,?,?,?::jsonb,?,?,?,?,?,?) RETURNING *').get(id,req.user.id,req.user.faculty_id,path,JSON.stringify(fields),filename,String(file.type||'application/octet-stream').slice(0,120),file.size,storageObjectKey(`upload-sessions/${req.user.id}/${id}`),timestamp(),expiry(hour));
  });
  res.status(201).json(snapshot(row));
 });
 app.get('/api/upload-sessions/:id',requireFaculty,async(req,res)=>res.json(snapshot(await session(req))));
 app.put('/api/upload-sessions/:id/parts/:part',requireFaculty,express.raw({type:'application/octet-stream',limit:UPLOAD_CHUNK_BYTES}),async(req,res)=>{
  if(!Buffer.isBuffer(req.body))throw failure(400,'Données de fichier invalides.');
  await db.transaction(async()=>{
   const row=await session(req,true),index=Number(req.params.part);
   if(row.state!=='uploading')throw failure(409,'Ce dépôt ne reçoit plus de morceaux.');
   if(!Number.isInteger(index)||index<1||index>partCount(row))throw failure(400,'Morceau de fichier invalide.');
   const expected=Math.min(UPLOAD_CHUNK_BYTES,row.size-(index-1)*UPLOAD_CHUNK_BYTES);
   if(req.body.length!==expected)throw failure(400,'Morceau de fichier incomplet.');
   const checksum=hash(req.body);
   // Repeating a piece also repairs a missing or damaged storage object.
   await storage.put(partKey(row,index),req.body,'application/octet-stream');
   await db.prepare('UPDATE upload_sessions SET parts=parts||?::jsonb WHERE id=?').run(JSON.stringify({[index]:{size:req.body.length,sha256:checksum}}),row.id);
  });
  res.json({ok:true});
 });
 app.delete('/api/upload-sessions/:id',requireFaculty,async(req,res)=>{
  const row=await db.transaction(async()=>{const value=await session(req,true);if(value.state==='finalizing')throw failure(409,'La vérification du dépôt est déjà en cours.');if(value.state==='uploading')await db.prepare("UPDATE upload_sessions SET state='cancelled',expires_at=? WHERE id=?").run(timestamp(),value.id);return value;});
  await cleanup(row).catch(()=>{});res.json({ok:true});
 });
 app.post('/api/upload-sessions/:id/complete',requireFaculty,async(req,res,next)=>{
  const respond=res.json.bind(res),writes=new Set(),effects=[];let row;
  const publish=()=>Promise.allSettled(effects.splice(0).map(effect=>Promise.resolve().then(effect)));
  try{
   const result=await objectWrites.run(writes,()=>publicationEffects.run(effects,()=>db.transaction(async()=>{
    // Publication and its replay receipt commit together. Concurrent completion
    // requests wait on this row, then return the same durable response.
    row=await session(req,true);
    if(row.response_status)return {status:row.response_status,body:row.response_body};
    if(row.state!=='uploading')throw failure(409,'Ce dépôt ne peut plus être finalisé.');
    if(Object.keys(row.parts).length!==partCount(row))throw failure(400,'Le fichier n’est pas encore entièrement envoyé.');
    const buffers=[],assemblyDeadline=Date.now()+30000;
    for(let index=1;index<=partCount(row);index++){
     try{
      const remaining=assemblyDeadline-Date.now();
      if(remaining<=0)throw failure(504,'Le stockage répond trop lentement. Réessayez le dépôt.');
      buffers.push(await readUploadPart({storage,key:partKey(row,index),part:row.parts[index],timeoutMs:Math.min(15000,remaining)}));
     }catch(error){
      if(error.status===400||error.status===404)throw Object.assign(failure(400,'Un morceau du fichier doit être renvoyé. Réessayez le dépôt.'),{invalidPart:index});
      throw error;
     }
    }
    // Storage assembly can take time: permissions and account/session state
    // must be current when the existing destination route is entered.
    if(refreshActor)await refreshActor(req);
    if(req.user.faculty_id!==row.faculty_id)throw failure(403,'Votre contexte universitaire a changé. Relancez le fichier.');
    await db.prepare("UPDATE upload_sessions SET state='finalizing' WHERE id=?").run(row.id);
    req.body=Object.create(null);
    for(const [key,value]of row.fields)req.body[key]=Object.hasOwn(req.body,key)?[].concat(req.body[key],value):value;
    req.file={fieldname:'file',originalname:row.filename,encoding:'7bit',mimetype:row.mime,size:row.size,buffer:Buffer.concat(buffers,row.size)};
    req.url='/api'+row.target_path;
    let captured;
    try{
     await db.transaction(()=>new Promise((resolve,reject)=>{
      req.uploadSessionCapture=true;
      res.json=body=>{
       if(captured)return res;
       captured={status:res.statusCode,body};
       if(captured.status>=400)reject(Object.assign(new Error('Upload destination rejected.'),{uploadResponse:captured}));
       else resolve(captured);
       return res;
      };
      next();
     }));
    }catch(error){if(!error.uploadResponse)throw error;captured=error.uploadResponse;}
    finally{res.json=respond;delete req.uploadSessionCapture;}
    await db.prepare('UPDATE upload_sessions SET state=?,response_status=?,response_body=?::jsonb,expires_at=? WHERE id=?').run(captured.status<400?'complete':'failed',captured.status,JSON.stringify(captured.body),expiry(day),row.id);
    return captured;
   })));
   if(result.status>=400)await Promise.allSettled([...writes].map(key=>storage.delete(key)));
   else await publish();
   await cleanup(row).catch(()=>{});
   res.status(result.status);respond(result.body);
  }catch(error){
   res.json=respond;delete req.uploadSessionCapture;
   // An unknown COMMIT outcome may have published both metadata and receipt;
   // preserve its object and chunks until the next status/replay request.
   let rolledBack=error.code!=='DATABASE_UNAVAILABLE';
   if(!rolledBack&&row){
    // Reacquiring the row waits for an uncertain transaction to finish. With
    // an atomic receipt, its absence now proves that publication rolled back.
    const recovered=await db.transaction(async()=>db.prepare('SELECT * FROM upload_sessions WHERE id=? FOR UPDATE').get(row.id)).catch(()=>null);
    if(recovered?.response_status){
     if(recovered.response_status<400)await publish();
     await cleanup(recovered).catch(()=>{});
     res.status(recovered.response_status);respond(recovered.response_body);return;
    }
    rolledBack=recovered?.state==='uploading';
   }
   if(rolledBack)await Promise.allSettled([...writes].map(key=>storage.delete(key)));
   if(error.invalidPart&&row)await db.prepare("UPDATE upload_sessions SET parts=parts-? WHERE id=? AND state='uploading' AND response_status IS NULL").run(String(error.invalidPart),row.id).catch(()=>{});
   next(error);
  }
 });
}
