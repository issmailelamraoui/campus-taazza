import {randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
const failure=(status,message)=>Object.assign(new Error(message),{status});
const now=()=>new Date().toISOString();
const identifier=value=>{const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw failure(400,'Référence invalide.');return id;};
const uuid=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(value))throw failure(400,'Identifiant de synchronisation invalide.');return value;};
const text=(value,limit,optional=false)=>{if(typeof value!=='string'||value.length>limit||(!optional&&!value.trim()))throw failure(400,'Texte invalide.');return value.trim();};
const parse=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
export function validatePosition(body){
 const page=identifier(body.page),version=identifier(body.version);
 if(page>100000)throw failure(400,'Page invalide.');
 const scroll=body.scrollRatio,zoom=body.zoom,revision=body.expectedRevision;
 if(typeof scroll!=='number'||!Number.isFinite(scroll)||scroll<0||scroll>1||typeof zoom!=='number'||!Number.isFinite(zoom)||zoom<.4||zoom>3||!Number.isSafeInteger(revision)||revision<0)throw failure(400,'Position de lecture invalide.');
 const tone=body.preferences?.tone??'normal',brightness=body.preferences?.brightness??1;
 if(!['normal','sepia','night'].includes(tone)||typeof brightness!=='number'||!Number.isFinite(brightness)||brightness<.35||brightness>1)throw failure(400,'Préférence de lecture invalide.');
 return{page,version,scrollRatio:scroll,zoom,expectedRevision:revision,preferences:{tone,brightness},deviceId:uuid(body.deviceId),operationId:uuid(body.operationId)};
}
export function validateAnchors(anchors=[]){
 if(!Array.isArray(anchors)||anchors.length>100)throw failure(400,'Zone de sélection invalide.');
 return anchors.map(rect=>{const{x,y,width,height}=rect||{};if(![x,y,width,height].every(value=>typeof value==='number'&&Number.isFinite(value))||x<0||y<0||width<=0||height<=0||x+width>1.001||y+height>1.001)throw failure(400,'Zone de sélection invalide.');return{x,y,width,height};});
}
export function validateKnowledge(body){
 const kind=body.kind;if(!['note','highlight','reference','excerpt','region'].includes(kind))throw failure(400,'Type de note invalide.');
 const tags=body.tags||[];if(!Array.isArray(tags)||tags.length>12)throw failure(400,'Étiquettes invalides.');
 const imageData=body.imageData||'';if(typeof imageData!=='string'||imageData.length>350000||imageData&&!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(imageData))throw failure(400,'Image de sélection invalide.');
 const color=body.color||'yellow';if(!['yellow','blue','pink','green'].includes(color))throw failure(400,'Couleur invalide.');
 return{kind,module:text(body.module||'',180,true),title:text(body.title,180),content:text(body.content||'',20000,true),selectedText:text(body.selectedText||'',12000,true),anchor:validateAnchors(body.anchor),imageData,color,tags:tags.map(tag=>text(tag,50)),citationAuthor:text(body.citationAuthor||'',180,true),citationYear:text(body.citationYear||'',20,true)};
}
export function validateStudyTool(body){
 if(!['flashcard','checklist','collection'].includes(body.kind))throw failure(400,'Outil invalide.');
 const data=body.data||{},title=text(body.title,180);
 if(body.kind==='flashcard'){const source=data.source?.knowledgeId?{knowledgeId:uuid(data.source.knowledgeId)}:null;return{kind:body.kind,title,data:{front:text(data.front,5000),back:text(data.back,10000),module:text(data.module||'',180,true),...(source?{source}:{})}};}
 if(body.kind==='checklist'){
  if(!Array.isArray(data.items)||data.items.length>100)throw failure(400,'Liste invalide.');
  const items=data.items.map(item=>({id:uuid(item.id),text:text(item.text,500),done:item.done===true}));if(new Set(items.map(item=>item.id)).size!==items.length)throw failure(400,'Éléments de liste dupliqués.');
  return{kind:body.kind,title,data:{items,module:text(data.module||'',180,true)}};
 }
 let items;
 if(data.items!==undefined){if(!Array.isArray(data.items)||data.items.length>200)throw failure(400,'Collection invalide.');items=data.items.map(item=>{if(!['resource','knowledge'].includes(item?.type))throw failure(400,'Référence de collection invalide.');return{type:item.type,id:item.type==='resource'?identifier(item.id):uuid(item.id)};});}
 else{const resourceIds=data.resourceIds||[],knowledgeIds=data.knowledgeIds||[];if(!Array.isArray(resourceIds)||resourceIds.length>100||!Array.isArray(knowledgeIds)||knowledgeIds.length>100)throw failure(400,'Collection invalide.');items=[...resourceIds.map(id=>({type:'resource',id:identifier(id)})),...knowledgeIds.map(id=>({type:'knowledge',id:uuid(id)}))];}
 const seen=new Set();items=items.filter(item=>{const key=`${item.type}:${item.id}`;if(seen.has(key))return false;seen.add(key);return true;});
 if(items.filter(item=>item.type==='resource').length>100||items.filter(item=>item.type==='knowledge').length>100)throw failure(400,'Collection trop grande.');
 return{kind:body.kind,title,data:{resourceIds:items.filter(item=>item.type==='resource').map(item=>item.id),knowledgeIds:items.filter(item=>item.type==='knowledge').map(item=>item.id),items,description:text(data.description||'',3000,true)}};

}
// A deterministic interval schedule driven solely by the student's own recall grade.
// New/good: 1 day; second/good: 3 days; later/good: interval × ease.
// Again: 10 minutes; hard: 1 day or interval × 1.2; easy: ≥4 days.
export function scheduleFlashcard(previous,grade,reviewedAt=new Date()){
 if(!['again','hard','good','easy'].includes(grade))throw failure(400,'Évaluation de révision invalide.');
 const timestamp=reviewedAt instanceof Date?reviewedAt.getTime():new Date(reviewedAt).getTime();
 if(!Number.isFinite(timestamp))throw failure(400,'Date de révision invalide.');
 let interval=Number(previous.intervalDays)||0,ease=Number(previous.ease)||2.5,repetitions=Number(previous.repetitions)||0,lapses=Number(previous.lapses)||0;
 if(grade==='again'){interval=10/1440;ease=Math.max(1.3,ease-.2);repetitions=0;lapses++;}
 else if(grade==='hard'){interval=Math.max(1,Math.round(interval*1.2));ease=Math.max(1.3,ease-.15);repetitions++;}
 else if(grade==='easy'){interval=Math.max(4,Math.round(interval*ease*1.3));ease=Math.min(3,ease+.15);repetitions++;}
 else{interval=repetitions===0?1:repetitions===1?3:Math.max(1,Math.round(interval*ease));repetitions++;}
 interval=Math.min(365,interval);ease=Math.round(ease*100)/100;
 return{dueAt:new Date(timestamp+Math.round(interval*86400000)).toISOString(),intervalDays:interval,ease,repetitions,lapses,lastReviewedAt:new Date(timestamp).toISOString()};
}
const reviewDTO=row=>({dueAt:row.review_due_at||null,intervalDays:row.review_interval_days||0,ease:row.review_ease||2.5,repetitions:row.review_repetitions||0,lapses:row.review_lapses||0,lastReviewedAt:row.review_last_at||null});
const positionDTO=row=>row?{page:row.page,version:row.document_version,scrollRatio:row.scroll_ratio,zoom:row.zoom,preferences:parse(row.preferences,{}),revision:row.revision,updatedAt:row.updated_at,deviceId:row.device_id}:null;
const knowledgeDTO=row=>({id:row.id,resourceId:row.resource_id,version:row.document_version,page:row.page,kind:row.kind,title:row.title,content:row.content,selectedText:row.selected_text,anchor:parse(row.anchor,[]),imageData:row.image_data,color:row.color,tags:parse(row.tags,[]),source:parse(row.source,{}),revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at});
const toolDTO=row=>({id:row.id,kind:row.kind,title:row.title,data:parse(row.data,{}),revision:row.revision,updatedAt:row.updated_at,...(row.kind==='flashcard'?{review:reviewDTO(row)}:{})});
export function installReadingRoutes(app,{db,requireFaculty,getResource,resourceDTO,storage}){
 async function versionOf(resource,value){
  const version=value===undefined?resource.version:identifier(value);if(version===resource.version)return{...resource,version};
  const older=await db.prepare('SELECT * FROM resource_versions WHERE resource_id=? AND version=? ORDER BY id DESC LIMIT 1').get(resource.id,version);if(!older)throw failure(404,'Cette version du document est indisponible.');return{...resource,...older,id:resource.id,version};
 }
 app.get('/api/reading',requireFaculty,async(req,res)=>{
  const limit=req.query.limit===undefined?100:identifier(req.query.limit);if(limit>500)throw failure(400,'Limite de lectures invalide.');const positions=await db.prepare('SELECT * FROM reading_positions WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(req.user.id,limit);const accessible=[];
  for(const row of positions){try{const r=await getResource(row.resource_id,req);if(r.version===row.document_version)accessible.push({resourceId:r.id,...positionDTO(row)});}catch(error){if(![403,404].includes(error.status))throw error;}}
  res.json({positions:accessible});
 });
 app.get('/api/reading/:resourceId',requireFaculty,async(req,res)=>{
  const resource=await getResource(req.params.resourceId,req),selected=await versionOf(resource,req.query.version);
  const[position,previous,conflicts]=await Promise.all([
   db.prepare('SELECT * FROM reading_positions WHERE user_id=? AND resource_id=? AND document_version=?').get(req.user.id,resource.id,selected.version),
   db.prepare('SELECT * FROM reading_positions WHERE user_id=? AND resource_id=? AND document_version<>? ORDER BY updated_at DESC LIMIT 5').all(req.user.id,resource.id,selected.version),
   db.prepare('SELECT * FROM reading_position_conflicts WHERE user_id=? AND resource_id=? AND document_version=? ORDER BY updated_at DESC LIMIT 5').all(req.user.id,resource.id,selected.version)]);
  res.json({document:{...(await resourceDTO(resource)),version:selected.version,currentVersion:resource.version,filename:selected.filename,mime:selected.mime,url:`/api/reading/${resource.id}/file?version=${selected.version}`,size:selected.size},position:positionDTO(position),previousPositions:previous.map(positionDTO),recovery:conflicts.map(row=>({...parse(row.position,{}),updatedAt:row.updated_at,deviceId:row.device_id}))});
 });
 app.get('/api/reading/:resourceId/file',requireFaculty,async(req,res)=>{
  const resource=await getResource(req.params.resourceId,req),selected=await versionOf(resource,req.query.version),file=await storage.get(selected.object_key,{range:req.get('range')});
  const inline=['application/pdf','image/png','image/jpeg','image/webp','image/gif'].includes(selected.mime),name=String(selected.filename).replace(/[\r\n\u0000]/g,'');
  res.type(selected.mime);res.set('Content-Disposition',`${inline&&req.query.download!=='1'?'inline':'attachment'}; filename="${name.replace(/[^a-zA-Z0-9._-]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);res.set('Content-Security-Policy',"sandbox; default-src 'none'");res.set('X-Content-Type-Options','nosniff');res.set('Cache-Control','private, no-store');res.set('Accept-Ranges','bytes');
  if(file.contentLength!==undefined)res.set('Content-Length',String(file.contentLength));if(file.contentRange){res.status(206);res.set('Content-Range',file.contentRange);}if(file.etag)res.set('ETag',file.etag);await pipeline(file.body,res);
 });
 app.put('/api/reading/:resourceId/position',requireFaculty,async(req,res)=>{
  const resource=await getResource(req.params.resourceId,req),p=validatePosition(req.body);await versionOf(resource,p.version);
  const result=await db.transaction(async()=>{
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`reading:${req.user.id}:${resource.id}:${p.version}`);
   const current=await db.prepare('SELECT * FROM reading_positions WHERE user_id=? AND resource_id=? AND document_version=? FOR UPDATE').get(req.user.id,resource.id,p.version);
   if(current?.operation_id===p.operationId)return{position:positionDTO(current)};
   if((current?.revision||0)!==p.expectedRevision){await db.prepare('INSERT INTO reading_position_conflicts (user_id,resource_id,document_version,device_id,position,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,resource_id,document_version,device_id) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at').run(req.user.id,resource.id,p.version,p.deviceId,JSON.stringify(p),now());return{conflict:true,position:positionDTO(current),recovery:p};}
   const row=await db.prepare('INSERT INTO reading_positions (user_id,resource_id,document_version,page,scroll_ratio,zoom,preferences,revision,device_id,operation_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,resource_id,document_version) DO UPDATE SET page=excluded.page,scroll_ratio=excluded.scroll_ratio,zoom=excluded.zoom,preferences=excluded.preferences,revision=excluded.revision,device_id=excluded.device_id,operation_id=excluded.operation_id,updated_at=excluded.updated_at RETURNING *').get(req.user.id,resource.id,p.version,p.page,p.scrollRatio,p.zoom,JSON.stringify(p.preferences),(current?.revision||0)+1,p.deviceId,p.operationId,now());return{position:positionDTO(row)};
  });res.status(result.conflict?409:200).json(result.conflict?{error:'Une autre session a enregistré une position. Choisissez celle à conserver.',...result}:result);
 });
 app.get('/api/knowledge',requireFaculty,async(req,res)=>{
  const rows=req.query.resourceId?await db.prepare('SELECT * FROM knowledge_items WHERE user_id=? AND resource_id=? ORDER BY updated_at DESC LIMIT 200').all(req.user.id,identifier(req.query.resourceId)):await db.prepare('SELECT * FROM knowledge_items WHERE user_id=? ORDER BY updated_at DESC LIMIT 500').all(req.user.id),access=new Map(),items=[];
  for(const row of rows){let available=false;if(row.resource_id){if(!access.has(row.resource_id)){try{await getResource(row.resource_id,req);access.set(row.resource_id,true);}catch(error){if(![403,404].includes(error.status))throw error;access.set(row.resource_id,false);}}available=access.get(row.resource_id);}items.push({...knowledgeDTO(row),sourceAvailable:available});}res.json({items});
 });
 app.post('/api/knowledge',requireFaculty,async(req,res)=>{
  const values=validateKnowledge(req.body),itemId=uuid(req.body.id||randomUUID());let resource=null,version=null,page=null,source={module:values.module};
  if(req.body.resourceId){resource=await getResource(req.body.resourceId,req);version=identifier(req.body.version);const selected=await versionOf(resource,version);page=identifier(req.body.page);if(page>100000)throw failure(400,'Page invalide.');source={title:resource.title,module:resource.module,author:values.citationAuthor||resource.teacher_name||'',year:values.citationYear||resource.academic_year||'',filename:selected.filename};}
  const existing=await db.prepare('SELECT * FROM knowledge_items WHERE id=? AND user_id=?').get(itemId,req.user.id);if(existing)return res.json({item:knowledgeDTO(existing)});
  const row=await db.prepare('INSERT INTO knowledge_items (id,user_id,resource_id,document_version,page,kind,title,content,selected_text,anchor,image_data,color,tags,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *').get(itemId,req.user.id,resource?.id||null,version,page,values.kind,values.title,values.content,values.selectedText,JSON.stringify(values.anchor),values.imageData,values.color,JSON.stringify(values.tags),JSON.stringify(source),now(),now());res.status(201).json({item:knowledgeDTO(row)});
 });
 app.patch('/api/knowledge/:id',requireFaculty,async(req,res)=>{
  const row=await db.prepare('SELECT * FROM knowledge_items WHERE id=? AND user_id=?').get(uuid(req.params.id),req.user.id);if(!row)throw failure(404,'Note introuvable.');const values=validateKnowledge({...knowledgeDTO(row),...req.body});const source=parse(row.source,{});if(!row.resource_id&&req.body.module!==undefined)source.module=values.module;if(req.body.citationAuthor!==undefined)source.author=values.citationAuthor;if(req.body.citationYear!==undefined)source.year=values.citationYear;
  if(req.body.revision!==row.revision)return res.status(409).json({error:'Cette note a été modifiée dans une autre session.',item:knowledgeDTO(row)});
  const updated=await db.prepare('UPDATE knowledge_items SET title=?,content=?,selected_text=?,anchor=?,image_data=?,color=?,tags=?,source=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=? RETURNING *').get(values.title,values.content,values.selectedText,JSON.stringify(values.anchor),values.imageData,values.color,JSON.stringify(values.tags),JSON.stringify(source),now(),row.id,req.user.id,row.revision);if(!updated)throw failure(409,'Cette note a été modifiée dans une autre session.');res.json({item:knowledgeDTO(updated)});
 });
 app.delete('/api/knowledge/:id',requireFaculty,async(req,res)=>{const result=await db.prepare('DELETE FROM knowledge_items WHERE id=? AND user_id=?').run(uuid(req.params.id),req.user.id);if(!result.changes)throw failure(404,'Note introuvable.');res.json({ok:true});});
 app.get('/api/study-tools',requireFaculty,async(req,res)=>{res.json({items:(await db.prepare('SELECT * FROM study_tools WHERE user_id=? ORDER BY updated_at DESC LIMIT 500').all(req.user.id)).map(toolDTO)});});
 async function saveTool(req,res,update){
  const values=validateStudyTool(req.body),itemId=uuid(update?req.params.id:req.body.id||randomUUID());
  const current=await db.prepare('SELECT * FROM study_tools WHERE id=? AND user_id=?').get(itemId,req.user.id);
  if(!update&&current)return res.json({item:toolDTO(current)});if(update&&!current)throw failure(404,'Outil introuvable.');if(update&&req.body.kind!==current.kind)throw failure(400,'Le type de cet outil ne peut pas être modifié.');
  if(update&&req.body.revision!==current.revision)return res.status(409).json({error:'Cet outil a été modifié dans une autre session.',item:toolDTO(current)});
  const previous=parse(current?.data||'{}',{});
  if(values.kind==='collection'){
   for(const resourceId of values.data.resourceIds){try{await getResource(resourceId,req);}catch(error){if(![403,404].includes(error.status)||!previous.resourceIds?.includes(resourceId))throw error;}}
   for(const knowledgeId of values.data.knowledgeIds){const owned=await db.prepare('SELECT id FROM knowledge_items WHERE id=? AND user_id=?').get(knowledgeId,req.user.id);if(!owned&&!previous.knowledgeIds?.includes(knowledgeId))throw failure(404,'Une note de cette collection est indisponible.');}
  }
  if(values.kind==='flashcard'&&values.data.source){
   const note=await db.prepare('SELECT * FROM knowledge_items WHERE id=? AND user_id=?').get(values.data.source.knowledgeId,req.user.id);
   if(!note){if(previous.source?.knowledgeId!==values.data.source.knowledgeId)throw failure(404,'La note source est indisponible.');values.data.source=previous.source;}
   else{const snapshot=parse(note.source,{});values.data.source={knowledgeId:note.id,resourceId:note.resource_id,version:note.document_version,page:note.page,title:snapshot.title||note.title};}
  }
  const row=update?await db.prepare('UPDATE study_tools SET title=?,data=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=? RETURNING *').get(values.title,JSON.stringify(values.data),now(),itemId,req.user.id,current.revision):await db.prepare('INSERT INTO study_tools (id,user_id,kind,title,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?) RETURNING *').get(itemId,req.user.id,values.kind,values.title,JSON.stringify(values.data),now(),now());if(!row)throw failure(409,'Cet outil a été modifié dans une autre session.');res.status(update?200:201).json({item:toolDTO(row)});
 }
 app.post('/api/study-tools',requireFaculty,(req,res)=>saveTool(req,res,false));app.patch('/api/study-tools/:id',requireFaculty,(req,res)=>saveTool(req,res,true));
 app.post('/api/study-tools/:id/review',requireFaculty,async(req,res)=>{
  const cardId=uuid(req.params.id),operationId=uuid(req.body.operationId),grade=req.body.grade;
  if(!['again','hard','good','easy'].includes(grade)||!Number.isSafeInteger(req.body.revision)||req.body.revision<1)throw failure(400,'Évaluation de révision invalide.');
  const result=await db.transaction(async()=>{
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`flashcard-review:${operationId}`);
   const current=await db.prepare('SELECT * FROM study_tools WHERE id=? AND user_id=? FOR UPDATE').get(cardId,req.user.id);
   if(!current||current.kind!=='flashcard')throw failure(404,'Flashcard introuvable.');
   const duplicate=await db.prepare('SELECT * FROM flashcard_reviews WHERE operation_id=?').get(operationId);
   if(duplicate){if(duplicate.user_id!==req.user.id||duplicate.card_id!==cardId||duplicate.grade!==grade)throw failure(409,'Identifiant de révision déjà utilisé.');return{item:toolDTO(current),duplicate:true};}
   if(current.revision!==req.body.revision)return{conflict:true,item:toolDTO(current),error:'Cette flashcard a été modifiée dans une autre session. Votre évaluation n’a pas été appliquée.'};
   const reviewedAt=new Date();
   if(current.review_due_at&&Date.parse(current.review_due_at)>reviewedAt.getTime())return{conflict:true,code:'CARD_NOT_DUE',item:toolDTO(current),error:'Cette flashcard est déjà programmée pour une prochaine révision.'};
   const review=scheduleFlashcard(reviewDTO(current),grade,reviewedAt);
   await db.prepare('INSERT INTO flashcard_reviews (operation_id,user_id,card_id,grade,previous_revision,due_at,reviewed_at) VALUES (?,?,?,?,?,?,?)').run(operationId,req.user.id,cardId,grade,current.revision,review.dueAt,review.lastReviewedAt);
   const updated=await db.prepare('UPDATE study_tools SET review_due_at=?,review_interval_days=?,review_ease=?,review_repetitions=?,review_lapses=?,review_last_at=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=? RETURNING *').get(review.dueAt,review.intervalDays,review.ease,review.repetitions,review.lapses,review.lastReviewedAt,review.lastReviewedAt,cardId,req.user.id,current.revision);
   if(!updated)throw failure(409,'Cette flashcard a été modifiée dans une autre session.');return{item:toolDTO(updated)};
  });res.status(result.conflict?409:200).json(result);
 });
 app.delete('/api/study-tools/:id',requireFaculty,async(req,res)=>{const result=await db.prepare('DELETE FROM study_tools WHERE id=? AND user_id=?').run(uuid(req.params.id),req.user.id);if(!result.changes)throw failure(404,'Outil introuvable.');res.json({ok:true});});
}
