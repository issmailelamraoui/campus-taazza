import {UPLOAD_CHUNK_THRESHOLD,chunkUploadTarget} from '../../shared/upload-transport.js';

// Private file handles are page-local. A retry of the same file and metadata
// resumes its receipt instead of publishing again after a lost final response.
const sessions=new WeakMap();
export function chunkUploadFile(path,body,method){
 if(!(body instanceof FormData)||!chunkUploadTarget(path,method))return null;
 const files=[...body.entries()].filter(([,value])=>value instanceof Blob);
 return files.length===1&&files[0][0]==='file'&&files[0][1].size>UPLOAD_CHUNK_THRESHOLD?files[0][1]:null;
}
const pause=(ms,signal)=>new Promise((resolve,reject)=>{
 if(signal.aborted)return reject(new DOMException('Cancelled','AbortError'));
 const done=()=>{signal.removeEventListener('abort',abort);resolve();};
 const timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
 signal.addEventListener('abort',abort,{once:true});
});
export async function uploadInChunks(path,body,{signal,headers,generation}){
 const file=body.get('file'),fields=[...body.entries()].filter(([key])=>key!=='file');
 const signature=JSON.stringify([generation,path,fields,file.name,file.type,file.size]);
 let known=sessions.get(file);if(!known){known=new Map();sessions.set(file,known);}
 async function control(url,{method='GET',data,raw,retry=false}={}){
  let last;
  for(let attempt=0;attempt<(retry?3:1);attempt++){
   try{
    const requestHeaders=new Headers(headers);requestHeaders.set('Content-Type',raw?'application/octet-stream':'application/json');
    const response=await fetch('/api'+url,{method,credentials:'same-origin',headers:requestHeaders,signal,body:raw|| (data===undefined?undefined:JSON.stringify(data))});
    const result=await response.clone().json().catch(()=>null);
    if(!response.ok)throw Object.assign(new Error(result?.error||`Erreur ${response.status}`),{response,status:response.status,data:result});
    if(!result||typeof result!=='object')throw new Error('La réponse du serveur est invalide. Réessayez.');
    return result;
   }catch(error){last=error;if(signal.aborted||error.status&&error.status<500||attempt===(retry?2:0))throw error;await pause(250*(attempt+1),signal);}
  }
  throw last;
 }
 function receipt(session){if(session.state==='failed')known.delete(signature);return new Response(JSON.stringify(session.response),{status:session.response_status,headers:{'Content-Type':'application/json'}});}
 try{
  let current=known.get(signature);
  if(current){try{current=await control('/upload-sessions/'+current.id);}catch(error){if(![404,410].includes(error.status))throw error;known.delete(signature);current=null;}}
  if(!current){
   const clientId=crypto.randomUUID();
   // Retain the identity even if all creation responses disappear. The next
   // explicit retry can GET the same session instead of consuming another slot.
   known.set(signature,{id:clientId});
   current=await control('/upload-sessions',{method:'POST',data:{client_id:clientId,path,file:{name:file.name,type:file.type,size:file.size},fields},retry:true});
   known.set(signature,current);
  }
  if(current.response_status)return receipt(current);
  const destination='/upload-sessions/'+current.id;
  if(current.state==='uploading'){
   const existing=new Set(current.parts),count=Math.ceil(file.size/current.chunk_bytes);
   // Keep two pieces at most in flight, independently retryable and far below
   // the hosting function's request-body cap (including envelope overhead).
   let next=1;
   const send=async()=>{while(next<=count){const index=next++;if(existing.has(index))continue;await control(destination+'/parts/'+index,{method:'PUT',raw:file.slice((index-1)*current.chunk_bytes,Math.min(index*current.chunk_bytes,file.size)),retry:true});}};
   await Promise.all([send(),send()]);
   try{await control(destination+'/complete',{method:'POST',data:{}});}
   catch(error){
    // A response can be lost after publication. Consult the durable receipt;
    // never automatically repeat the original non-idempotent upload route.
    if(signal.aborted)throw error;
    const state=await control(destination).catch(()=>null);
    if(state?.response_status)return receipt(state);
    if(state?.state!=='finalizing')throw error;
   }
  }
  for(let attempt=0;attempt<60;attempt++){
   const state=await control(destination);
   if(state.response_status)return receipt(state);
   if(state.state!=='finalizing')throw new Error('Le dépôt est incomplet. Réessayez pour reprendre le fichier.');
   await pause(500,signal);
  }
  throw new Error('Le fichier est encore en cours de vérification. Réessayez pour retrouver son résultat.');
 }catch(error){if(error.response)return error.response;throw error;}
}
