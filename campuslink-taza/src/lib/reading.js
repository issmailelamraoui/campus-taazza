import {api} from '../api.js';
const PREFIX='campuslink-private-study-v1:';
let activeUser=null,session=0;
const uid=()=>globalThis.crypto?.randomUUID?.()||`study-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const studyId=uid;
export function checklistItemsFromLines(lines, existingItems=[]){
 const remaining=new Map();
 for(const item of existingItems){
  const matches=remaining.get(item.text)||[];matches.push(item);remaining.set(item.text,matches);
 }
 return String(lines).split('\n').map(value=>value.trim()).filter(Boolean).map(text=>{
  const existing=remaining.get(text)?.shift();
  return existing||{id:studyId(),text,done:false};
 });
}
export function beginStudySession(userId){const next=String(userId||'');if(activeUser&&activeUser!==next)clearStudyCache();activeUser=next;return session;}
export function clearStudyCache(){session++;activeUser=null;try{for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith(PREFIX))localStorage.removeItem(key);}}catch{}}
if(typeof window!=='undefined')window.addEventListener('campus-session-cleared',clearStudyCache);
export function studyCache(userId,key,fallback=null){try{return JSON.parse(localStorage.getItem(`${PREFIX}${userId}:${key}`))??fallback;}catch{return fallback;}}
export function writeStudyCache(userId,key,value){if(String(userId)!==activeUser)return false;try{localStorage.setItem(`${PREFIX}${userId}:${key}`,JSON.stringify(value));return true;}catch{return false;}}
function changed(){if(typeof window!=='undefined')window.dispatchEvent(new Event('campus-study-updated'));}
export function sourcePath(resourceId,page=1,version){const query=new URLSearchParams({document:String(resourceId),page:String(page)});if(version)query.set('version',String(version));return`/app/library?${query}#resource-${resourceId}`;}
export function referenceText(item){const source=item.source||{};return[source.author,source.title,item.page?`p. ${item.page}`:'',source.year,item.selectedText?`« ${item.selectedText} »`:'',item.content,item.resourceId?sourcePath(item.resourceId,item.page,item.version):''].filter(Boolean).join(' — ');}
function retain(userId,key,item){const items=studyCache(userId,key,[]);writeStudyCache(userId,key,[item,...items.filter(value=>value.id!==item.id)]);changed();}
export function cachedKnowledge(userId,resourceId){const list=studyCache(userId,'knowledge',[]);return resourceId?list.filter(item=>String(item.resourceId)===String(resourceId)):list;}
export async function loadKnowledge(userId,resourceId){
 const owner=beginStudySession(userId);try{const result=await api('/knowledge'+(resourceId?`?resourceId=${encodeURIComponent(resourceId)}`:''));if(owner!==session||String(userId)!==activeUser)return[];
 const queue=studyCache(userId,'queue',[]),pending=new Map(queue.filter(op=>op.entity==='knowledge'&&op.method!=='DELETE').map(op=>[op.item.id,op.item])),deleted=new Set(queue.filter(op=>op.entity==='knowledge'&&op.method==='DELETE').map(op=>op.item.id));
 let list=resourceId?[...cachedKnowledge(userId).filter(item=>String(item.resourceId)!==String(resourceId)),...result.items]:result.items;list=[...pending.values(),...list.filter(item=>!pending.has(item.id)&&!deleted.has(item.id))];writeStudyCache(userId,'knowledge',list);return resourceId?list.filter(item=>String(item.resourceId)===String(resourceId)):list;
 }catch(error){if(owner!==session||String(userId)!==activeUser)return[];if(error.status&&error.status<500)throw error;const items=cachedKnowledge(userId,resourceId);if(items.length)return items;throw error;}
}
export async function loadStudyTools(userId){const owner=beginStudySession(userId);try{const result=await api('/study-tools');if(owner!==session||String(userId)!==activeUser)return[];const queue=studyCache(userId,'queue',[]),pending=new Map(queue.filter(op=>op.entity==='study-tools'&&op.method!=='DELETE').map(op=>[op.item.id,op.item])),deleted=new Set(queue.filter(op=>op.entity==='study-tools'&&op.method==='DELETE').map(op=>op.item.id));const list=[...pending.values(),...result.items.filter(item=>!pending.has(item.id)&&!deleted.has(item.id))];writeStudyCache(userId,'tools',list);return list;}catch(error){if(owner!==session||String(userId)!==activeUser)return[];if(error.status&&error.status<500)throw error;const items=studyCache(userId,'tools',[]);if(items.length)return items;throw error;}}
async function savePrivate(userId,entity,item,method){
 beginStudySession(userId);const key=entity==='knowledge'?'knowledge':'tools',owner=session,payload={...item,id:item.id||uid()};
 const queue=studyCache(userId,'queue',[]),pendingOperation=queue.find(op=>op.entity===entity&&op.item.id===payload.id),pendingCreate=pendingOperation?.method==='POST';
 const op={id:uid(),entity,item:payload,method:pendingCreate&&method==='PATCH'?'POST':method};
 const path=`/${entity}${op.method==='POST'?'':`/${payload.id}`}`;
 const enqueue=()=>{const remaining=studyCache(userId,'queue',[]).filter(previous=>!(previous.entity===entity&&previous.item.id===payload.id));if(pendingCreate&&method==='DELETE'){writeStudyCache(userId,'queue',remaining);}else if(!writeStudyCache(userId,'queue',[...remaining,op]))throw new Error('Le stockage local est plein. Votre modification n’a pas été enregistrée.');if(method==='DELETE'){writeStudyCache(userId,key,studyCache(userId,key,[]).filter(value=>value.id!==payload.id));changed();return{...payload,pending:true};}const pending={...payload,pending:true};retain(userId,key,pending);return pending;};
 if(navigator.onLine===false||pendingOperation)return enqueue();
 try{const result=await api(path,{method:op.method,body:op.method==='DELETE'?undefined:payload});if(owner!==session)throw new Error('La session a changé.');if(method==='DELETE'){writeStudyCache(userId,key,studyCache(userId,key,[]).filter(value=>value.id!==payload.id));changed();return payload;}retain(userId,key,result.item);return result.item;}
 catch(error){if(owner!==session||error.status&&error.status<500)throw error;return enqueue();}
}
export const saveKnowledge=(userId,item)=>savePrivate(userId,'knowledge',item,item.revision?'PATCH':'POST');
export const deleteKnowledge=(userId,item)=>savePrivate(userId,'knowledge',item,'DELETE');
export const saveStudyTool=(userId,item)=>savePrivate(userId,'study-tools',item,item.revision?'PATCH':'POST');
export const deleteStudyTool=(userId,item)=>savePrivate(userId,'study-tools',item,'DELETE');
let syncing=null;
export function syncStudyQueue(userId){
 const owner=beginStudySession(userId);if(syncing?.owner===owner)return syncing.promise;
 const job={owner,promise:null};
 job.promise=(async()=>{let count=0;while(count++<100){const op=studyCache(userId,'queue',[])[0];if(!op||owner!==session||navigator.onLine===false)break;
  try{const result=await api(`/${op.entity}${op.method==='POST'?'':`/${op.item.id}`}`,{method:op.method,body:op.method==='DELETE'?undefined:op.item});if(owner!==session)break;
   const queue=studyCache(userId,'queue',[]).filter(value=>value.id!==op.id),newer=queue.find(value=>value.entity===op.entity&&value.item.id===op.item.id);
   if(newer&&result.item){newer.item={...newer.item,revision:result.item.revision};if(newer.method==='POST')newer.method='PATCH';}
   writeStudyCache(userId,'queue',queue);
   if(newer&&newer.method!=='DELETE')retain(userId,op.entity==='knowledge'?'knowledge':'tools',{...newer.item,pending:true});
   else if(!newer&&result.item)retain(userId,op.entity==='knowledge'?'knowledge':'tools',result.item);changed();
  }catch(error){if(owner!==session||String(userId)!==activeUser)break;if(error.status===409){window.dispatchEvent(new CustomEvent('campus-study-conflict',{detail:{operation:op,remote:error.data?.item}}));}throw error;}
 }})().finally(()=>{if(syncing===job)syncing=null;});syncing=job;return job.promise;
}
export function resolveStudyConflict(userId,operation,remote,keepLocal){const queue=studyCache(userId,'queue',[]);if(keepLocal){writeStudyCache(userId,'queue',queue.map(op=>op.id===operation.id?{...op,item:{...op.item,revision:remote.revision}}:op));}else{writeStudyCache(userId,'queue',queue.filter(op=>op.id!==operation.id));retain(userId,operation.entity==='knowledge'?'knowledge':'tools',remote);}changed();return syncStudyQueue(userId);}
export const pendingStudyCount=userId=>studyCache(userId,'queue',[]).length;
export function createPositionSync({userId,resourceId,version,position,send=api,onState=()=>{}}){
 beginStudySession(userId);const owner=session,key=`position:${resourceId}:${version}`,deviceKey=`${PREFIX}device`;
 let device;try{device=localStorage.getItem(deviceKey)||uid();localStorage.setItem(deviceKey,device);}catch{device=uid();}
 let current=position||{page:1,zoom:1,scrollRatio:0,revision:0,preferences:{tone:'normal',brightness:1}},pending=null,running=null,conflict=null,disposed=false;
 const local=studyCache(userId,key);if(local?.pending&&local.version===version){pending=local;current={...current,...local,revision:local.expectedRevision??local.revision??0};}
 function update(next){current={...current,...next};pending={...current,version,expectedRevision:current.revision||0,deviceId:device,operationId:uid(),pending:true};const stored=writeStudyCache(userId,key,pending);onState(stored?'pending':'storage-full');}
 async function flush(){if(running)return running;if(!pending||conflict||owner!==session)return;if(typeof navigator!=='undefined'&&navigator.onLine===false){onState('offline');return;}
  const snapshot=pending;running=send(`/reading/${resourceId}/position`,{method:'PUT',body:snapshot,keepalive:true}).then(result=>{if(owner!==session)return;current={...current,revision:result.position.revision};if(pending?.operationId===snapshot.operationId){pending=null;writeStudyCache(userId,key,{...current,version,pending:false});}else if(pending){pending={...pending,expectedRevision:current.revision};writeStudyCache(userId,key,pending);}onState(pending?'pending':'saved');}).catch(error=>{if(owner!==session)return;if(error.status===409){conflict={remote:error.data.position,local:snapshot};onState('conflict',conflict);}else if([401,403,404].includes(error.status)){onState('denied',error);}else onState('offline',error);}).finally(()=>{running=null;if(disposed&&pending&&pending.operationId!==snapshot.operationId&&!conflict&&owner===session)return flush();});return running;
 }
 function resolve(keepLocal){if(!conflict)return;const selected=keepLocal?{...current,revision:conflict.remote?.revision||0}:conflict.remote;conflict=null;current=selected;pending=null;update(selected);return flush();}
 const timer=setInterval(()=>{if(!disposed)flush();},5000);timer.unref?.();
 return{update,flush,resolve,get:()=>current,dispose(){disposed=true;clearInterval(timer);return flush();}};
}
export function normalizeSelection(rects,bounds){return Array.from(rects).map(rect=>({x:Math.max(0,(rect.left-bounds.left)/bounds.width),y:Math.max(0,(rect.top-bounds.top)/bounds.height),width:Math.min(rect.width/bounds.width,(bounds.right-rect.left)/bounds.width),height:Math.min(rect.height/bounds.height,(bounds.bottom-rect.top)/bounds.height)})).filter(rect=>rect.width>0&&rect.height>0).slice(0,100);}
export function parseCSV(value,maxRows=500,maxColumns=100){
 const rows=[];let row=[],field='',quoted=false;for(let i=0;i<value.length&&rows.length<maxRows;i++){const char=value[i];if(char==='"'){if(quoted&&value[i+1]==='"'){field+='"';i++;}else if(!field||quoted)quoted=!quoted;else field+=char;}else if(char===','&&!quoted){if(row.length<maxColumns)row.push(field);field='';}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&value[i+1]==='\n')i++;if(row.length<maxColumns)row.push(field);rows.push(row);row=[];field='';}else field+=char;}if((field||row.length)&&rows.length<maxRows){if(row.length<maxColumns)row.push(field);rows.push(row);}return rows;
}
export async function fetchSafeText(url,signal,maxBytes=2*1024*1024){const response=await fetch(url,{signal,credentials:'same-origin'});if(!response.ok)throw new Error('Le fichier est indisponible.');if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('Aperçu limité à 2 Mo. Téléchargez le fichier original.');const reader=response.body?.getReader();if(!reader)return response.text();const decoder=new TextDecoder();let total=0,result='';try{for(;;){const{value,done}=await reader.read();if(done)break;total+=value.length;if(total>maxBytes){await reader.cancel();throw new Error('Aperçu limité à 2 Mo. Téléchargez le fichier original.');}result+=decoder.decode(value,{stream:true});}return result+decoder.decode();}finally{reader.releaseLock();}}
