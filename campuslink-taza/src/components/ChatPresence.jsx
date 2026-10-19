import {requestId} from '../lib/identifiers';
import React,{useEffect,useState} from 'react';
import {Users} from 'lucide-react';
import {api} from '../api';
import {chatRequest} from '../lib/backend';
import {useApp} from '../context';
export default function ChatPresence({channel,blocked}) {
 const {user,tr,realtimeCapabilities}=useApp();
 const [snapshot,setSnapshot]=useState(null),[failed,setFailed]=useState(false);
 const scope=`${user.id}:${user.facultyId}:${user.filiereId}:${channel}`;
 useEffect(()=>{
  if(blocked||!realtimeCapabilities?.presence)return;
  const client_id=requestId();let live=true,busy=false,arriving=true;
  const body={...chatRequest(channel),client_id};
  async function heartbeat(){
   if(busy||document.visibilityState==='hidden'||navigator.onLine===false)return;
   busy=true;
   try{const result=await api('/presence',{method:'POST',body:{...body,arriving}});arriving=false;if(live){setSnapshot({scope,...result});setFailed(false);}}
   catch{if(live){setSnapshot(null);setFailed(true);}}finally{busy=false;if(!live)leave();}
  }
  function leave(){fetch('/api/presence/'+client_id,{method:'DELETE',credentials:'same-origin',keepalive:true}).catch(()=>{});arriving=true;}
  function visibility(){if(document.visibilityState==='hidden'){leave();setSnapshot(null);}else heartbeat();}
  const offline=()=>{setSnapshot(null);setFailed(true);};
  const liveUpdate=event=>{if(event.detail?.messageIds||event.detail?.discussionReads||event.detail?.support)return;heartbeat();};
  setFailed(false);const timer=setInterval(heartbeat,10000);heartbeat();
  window.addEventListener('offline',offline);
  window.addEventListener('campus-live-update',liveUpdate);document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',leave);
  return()=>{live=false;window.removeEventListener('offline',offline);clearInterval(timer);window.removeEventListener('campus-live-update',liveUpdate);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',leave);leave();};
 },[scope,blocked,realtimeCapabilities?.presence]);
 if(blocked||!realtimeCapabilities?.presence)return null;
 const data=snapshot?.scope===scope?snapshot:null;
 return <details className="chat-presence"><summary aria-label={data?`${data.count} ${tr('en ligne','online','متصل')}`:undefined}><Users size={14}/><span>{data?<>{data.count}<span className="presence-label"> {tr('en ligne','online','متصل')}</span></>:<><span aria-hidden="true">{failed?'—':'…'}</span><span className="sr-only">{failed?tr('Présence indisponible','Presence unavailable','الحضور غير متاح'):tr('Chargement des présences…','Loading presence…','جارٍ تحميل الحضور…')}</span></>}</span></summary>{data&&<ul>{data.members.map(member=><li key={member.id}><bdi>{member.username?'@'+member.username:member.name}</bdi></li>)}</ul>}</details>;
}
