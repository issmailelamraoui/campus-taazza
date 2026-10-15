// Explicit private downloads; the service worker never caches these API responses.
const DB='campuslink-private-files-v1',STORE='documents';
export const OFFLINE_FILE_LIMIT=50*1024*1024;
export const OFFLINE_TOTAL_LIMIT=100*1024*1024;
const LEASE=24*60*60*1000;
let generation=0,connection=null;
const request=op=>new Promise((resolve,reject)=>{op.onsuccess=()=>resolve(op.result);op.onerror=()=>reject(op.error);});
async function database(){if(!globalThis.indexedDB)throw new Error('Le stockage hors ligne n’est pas disponible dans ce navigateur.');if(!connection)connection=new Promise((resolve,reject)=>{const open=indexedDB.open(DB,1);open.onupgradeneeded=()=>{const store=open.result.createObjectStore(STORE,{keyPath:'key'});store.createIndex('owner','userId');};open.onsuccess=()=>resolve(open.result);open.onerror=()=>{connection=null;reject(open.error);};});return connection;}
const key=(userId,resourceId,version)=>`${userId}:${resourceId}:${version}`;
async function cachePublicReaderAssets(){
 if(!navigator.serviceWorker)return;
 const paths=performance.getEntriesByType('resource').map(entry=>{try{return new URL(entry.name).pathname;}catch{return '';}}).filter(path=>/^\/assets\/[\w.-]+\.(?:js|mjs|css)$/.test(path));
 if(!paths.length)return;
 let timer;const registration=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Le lecteur hors ligne n’est pas encore prêt. Réessayez une fois connecté.')),10000);})]).finally(()=>clearTimeout(timer));
 if(!registration.active)return;
 await new Promise((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(new Error('Impossible de préparer le lecteur hors ligne. Réessayez une fois connecté.'));},10000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data?.ok?resolve():reject(new Error('Impossible de préparer le lecteur hors ligne. Réessayez une fois connecté.'));};registration.active.postMessage({type:'CACHE_PUBLIC_ASSETS',paths},[channel.port2]);});
}
export async function listOfflineDocuments(userId){const db=await database();return(await request(db.transaction(STORE).objectStore(STORE).index('owner').getAll(String(userId)))).filter(value=>value.expiresAt>Date.now()).map(({blob,...metadata})=>metadata);}
export async function getOfflineDocument(userId,resourceId,version){const owner=generation,db=await database();const records=version?[await request(db.transaction(STORE).objectStore(STORE).get(key(userId,resourceId,version)))]:await request(db.transaction(STORE).objectStore(STORE).index('owner').getAll(String(userId)));if(owner!==generation)return null;const found=records.filter(value=>value&&String(value.resourceId)===String(resourceId)&&value.expiresAt>Date.now()).sort((a,b)=>b.version-a.version)[0];return found||null;}
export async function saveOfflineDocument(userId,payload){
 const owner=generation;
 await cachePublicReaderAssets();
 if(owner!==generation)throw new Error('La session a changé.');
 const document=payload.document;if(Number(document.size)>OFFLINE_FILE_LIMIT)throw new Error('Limite hors ligne : 50 Mo par document.');
 const response=await fetch(document.url,{credentials:'same-origin'});if(!response.ok)throw new Error('Impossible de vérifier et télécharger ce document pour le mode hors ligne.');if(Number(response.headers.get('content-length'))>OFFLINE_FILE_LIMIT)throw new Error('Limite hors ligne : 50 Mo par document.');
 const reader=response.body?.getReader(),parts=[];let total=0;if(reader){try{for(;;){const{value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>OFFLINE_FILE_LIMIT){await reader.cancel();throw new Error('Limite hors ligne : 50 Mo par document.');}parts.push(value);}}finally{reader.releaseLock();}}else{const bytes=await response.arrayBuffer();if(bytes.byteLength>OFFLINE_FILE_LIMIT)throw new Error('Limite hors ligne : 50 Mo par document.');parts.push(bytes);}
 if(owner!==generation)throw new Error('La session a changé.');
 const blob=new Blob(parts,{type:document.mime||response.headers.get('content-type')||'application/octet-stream'}),db=await database();if(owner!==generation)throw new Error('La session a changé.');
 const value={key:key(userId,document.id,document.version),userId:String(userId),resourceId:document.id,version:document.version,bytes:blob.size,blob,payload,savedAt:Date.now(),expiresAt:Date.now()+LEASE};
 await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);const all=store.getAll();all.onsuccess=()=>{let used=0;for(const record of all.result){if(record.expiresAt<=Date.now()){store.delete(record.key);continue;}if(record.key!==value.key)used+=record.bytes;}if(used+blob.size>OFFLINE_TOTAL_LIMIT){tx.abort();reject(new Error('Limite hors ligne : 100 Mo au total. Retirez un document avant d’en ajouter un autre.'));return;}if(owner!==generation){tx.abort();reject(new Error('La session a changé.'));return;}store.put(value);};tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('Le stockage local est plein ou indisponible.'));tx.onabort=()=>reject(new Error('Le document n’a pas été enregistré hors ligne.'));});
 window.dispatchEvent(new CustomEvent('campus-offline-enabled',{detail:{userId:String(userId)}}));return{...value,blob:undefined};
}
export async function removeOfflineDocument(userId,resourceId,version){const db=await database();if(version!==undefined&&version!==null){await request(db.transaction(STORE,'readwrite').objectStore(STORE).delete(key(userId,resourceId,version)));return;}await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite'),cursor=tx.objectStore(STORE).index('owner').openCursor(IDBKeyRange.only(String(userId)));cursor.onsuccess=()=>{const current=cursor.result;if(!current)return;if(String(current.value.resourceId)===String(resourceId))current.delete();current.continue();};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export async function clearOfflineDocuments(){generation++;try{const db=await database();await request(db.transaction(STORE,'readwrite').objectStore(STORE).clear());}catch{}}
if(typeof window!=='undefined')window.addEventListener('campus-session-cleared',clearOfflineDocuments);
