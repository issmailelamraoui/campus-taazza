import {useEffect,useRef,useState} from 'react';
import {api} from '../api';

// Bounded activity signals; page rewards are decided and deduplicated by server.
export function useReadingActivity({resourceId,version,page,enabled,active,ready,viewport}){
 const [status,setStatus]=useState(''),[retry,setRetry]=useState(0),[awarded,setAwarded]=useState(0),lastInteraction=useRef(Date.now());
 useEffect(()=>{const node=viewport.current;if(!node)return;const interact=()=>{lastInteraction.current=Date.now();};for(const event of ['pointerdown','keydown','wheel','scroll'])node.addEventListener(event,interact,{passive:true});return()=>{for(const event of ['pointerdown','keydown','wheel','scroll'])node.removeEventListener(event,interact);};},[viewport]);
 useEffect(()=>{const prepared=event=>{if(event.detail.resourceId===String(resourceId)){setRetry(n=>n+1);}};window.addEventListener('campus-document-indexed',prepared);return()=>window.removeEventListener('campus-document-indexed',prepared);},[resourceId]);
 useEffect(()=>{
  if(!enabled||!active||!ready||navigator.onLine===false){setStatus(enabled?'paused':'');return;}
  let live=true,token=null,timer,working=false;const controller=new AbortController();lastInteraction.current=Date.now();setStatus('starting');
  async function heartbeat(){if(!live||working||!token)return;working=true;const rect=viewport.current?.getBoundingClientRect(),visible=document.visibilityState==='visible'&&document.hasFocus()&&!!rect&&rect.bottom>0&&rect.top<window.innerHeight&&rect.right>0&&rect.left<window.innerWidth&&navigator.onLine!==false;try{const result=await api('/reading-activity/'+resourceId+'/heartbeat',{method:'POST',signal:controller.signal,body:{session_token:token,page,visible,recent_interaction:Date.now()-lastInteraction.current<120000}});if(live){setStatus(result.status);if(result.awarded){setAwarded(n=>n+result.awarded);window.dispatchEvent(new Event('campus-xp-updated'));}if(['daily_cap','already_rewarded','rewarded'].includes(result.status))clearInterval(timer);}}catch(e){if(live){if(e.data?.code==='READING_SESSION_REPLACED'){setStatus('replaced');clearInterval(timer);}else if(e.status===429)setStatus('active');else{setStatus('unavailable');clearInterval(timer);}}}finally{working=false;}}
  api('/reading-activity/'+resourceId+'/start',{method:'POST',signal:controller.signal,body:{page,version}}).then(result=>{if(!live){api('/reading-activity/'+resourceId+'/end',{method:'POST',body:{session_token:result.session_token},keepalive:true}).catch(()=>{});return;}token=result.session_token;setStatus('active');timer=setInterval(heartbeat,result.heartbeat_seconds*1000);}).catch(e=>{if(live)setStatus(e.data?.code==='DOCUMENT_INDEX_REQUIRED'?'index-required':'unavailable');});
  return()=>{live=false;controller.abort();clearInterval(timer);if(token)api('/reading-activity/'+resourceId+'/end',{method:'POST',body:{session_token:token},keepalive:true}).catch(()=>{});};
 },[resourceId,version,page,enabled,active,ready,retry]);
 return {status,awarded};
}
