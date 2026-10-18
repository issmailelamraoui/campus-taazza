import React,{useEffect,useState} from 'react';
import {Users} from 'lucide-react';
import {api} from '../api';
import {chatRequest} from '../lib/backend';
import {useApp} from '../context';
export default function ChatPresence({channel,blocked}) {
 const {user,tr,realtimeCapabilities}=useApp();
 const [snapshot,setSnapshot]=useState(null);
 const scope=`${user.id}:${user.facultyId}:${user.filiereId}:${channel}`;
 useEffect(()=>{
  if(blocked||!realtimeCapabilities?.presence)return;
  const client_id=crypto.randomUUID();let live=true,busy=false,arriving=true;
  const body={...chatRequest(channel),client_id};
  async function heartbeat(){
   if(busy||document.visibilityState==='hidden'||navigator.onLine===false)return;
   busy=true;
   try{const result=await api('/presence',{method:'POST',body:{...body,arriving}});arriving=false;if(live)setSnapshot({scope,...result});}
   catch{if(live)setSnapshot(null);}finally{busy=false;}
  }
  function leave(){fetch('/api/presence/'+client_id,{method:'DELETE',credentials:'same-origin',keepalive:true}).catch(()=>{});arriving=true;}
  function visibility(){if(document.visibilityState==='hidden'){leave();setSnapshot(null);}else heartbeat();}
  const timer=setInterval(heartbeat,10000);heartbeat();
  window.addEventListener('campus-live-update',heartbeat);document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',leave);
  return()=>{live=false;clearInterval(timer);window.removeEventListener('campus-live-update',heartbeat);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',leave);leave();};
 },[scope,blocked,realtimeCapabilities?.presence]);
 if(blocked||!realtimeCapabilities?.presence)return null;
 const data=snapshot?.scope===scope?snapshot:null;
 return <details className="chat-presence"><summary><Users size={14}/>{data?`${data.count} ${tr('en ligne','online','متصل')}`:tr('Présence indisponible','Presence unavailable','الحضور غير متاح')}</summary>{data&&<ul>{data.members.map(member=><li key={member.id}><bdi>{member.username?'@'+member.username:member.name}</bdi></li>)}</ul>}</details>;
}
