import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {api,invalidateAPISession,subscribeAPIActivity} from './api.js';
import {FACULTIES} from './data/mock.js';
import {getFiliere, filiereBelongsToFaculty} from './data/studies.js';
import {translations} from './i18n.js';
import {chatRequest, isAdministrator, normalizeAnnouncement, normalizeBootstrap, normalizeMessage, normalizeResource, normalizeUser, requiresPasswordChange} from './lib/backend.js';
import {normalizePart} from './lib/resources.js';
import {saveOfflineSession,loadOfflineSession} from './lib/offline-session.js';
// Session cleanup must be registered even when no reader/study route is loaded.
import './lib/offline-documents.js';
import './lib/reading.js';

const AppContext=createContext(null);
const key='campuslink-prototype-v1:';
export function readLocal(name,fallback){try{const value=localStorage.getItem(key+name);return value?JSON.parse(value):fallback;}catch{return fallback;}}
function useLocal(name,initial){const [value,setValue]=useState(()=>readLocal(name,initial));useEffect(()=>{try{localStorage.setItem(key+name,JSON.stringify(value));}catch{}},[name,value]);return [value,setValue];}
const emptyData=()=>({user:null,faculty:null,resources:[],announcements:[],messages:[],notifications:[],unreadCount:0,notificationsHasMore:false,saved:[],history:[],events:[],channels:[],members:[]});
const preferencesFor=user=>({announcements:true,resources:true,mentions:true,...user?.preferences,calendar:false,discussions:user?.preferences?.important!==false,administration:user?.preferences?.admin!==false});

export function AppProvider({children}){
 const [language,changeLanguage]=useLocal('language','fr');
 const [theme,setTheme]=useLocal('theme','dark');
 const [lowData,setLowData]=useLocal('low-data',false);
 const [data,setData]=useState(emptyData),[loading,setLoading]=useState(true),[connectionError,setConnectionError]=useState('');
 const [registrationRevision,setRegistrationRevision]=useState(0),[dialog,setDialog]=useState(null),[toast,setToast]=useState(null);
 const [pendingActions,setPendingActions]=useState({}),[networkActivity,setNetworkActivity]=useState({reads:0,writes:0});
 const current=useRef(data);current.current=data;
 const epoch=useRef(0),mutationRevision=useRef(0),refreshRequest=useRef(null),refreshTimer=useRef(null),queuedRefresh=useRef(false);
 const actionRequests=useRef(new Map()),stagedUploads=useRef(new Map()),optimistic=useRef(new Map()),messageDrafts=useRef(new Map());
 const notificationVisit=useRef(null);
 const user=data.user,isAdmin=isAdministrator(user);
 const selection=user?.facultyId&&(user.filiereId||isAdmin)?{facultyId:user.facultyId,filiereId:user.filiereId||null,semester:user.semester}:null;
 const faculty=data.faculty||FACULTIES.find(item=>item.id===user?.facultyId),filiere=getFiliere(user?.filiereId);
 const t=name=>translations[language]?.[name]||translations.fr[name]||name;
 const tr=(fr,en,ar)=>language==='ar'?ar||fr:language==='en'?en||fr:fr;
 const notify=useCallback((message,type='success')=>setToast({message,type,id:Date.now()}),[]);
 const clearSession=useCallback(()=>{
  notificationVisit.current=null;window.dispatchEvent(new Event('campus-session-cleared'));
  epoch.current++;invalidateAPISession();refreshRequest.current=null;actionRequests.current.clear();stagedUploads.current.clear();optimistic.current.clear();messageDrafts.current.clear();setPendingActions({});clearTimeout(refreshTimer.current);queuedRefresh.current=false;
  current.current=emptyData();setData(current.current);setDialog(null);setConnectionError('');
 },[]);
 const refresh=useCallback(({afterMutation=false}={})=>{
  if(requiresPasswordChange(current.current.user))return Promise.resolve({user:current.current.user});
  if(afterMutation)mutationRevision.current++;
  if(refreshRequest.current){queuedRefresh.current=true;return refreshRequest.current;}
  const owner=epoch.current,revision=mutationRevision.current;
  const request=api('/bootstrap').then(result=>{
   if(owner===epoch.current){
    if(revision===mutationRevision.current){const snapshot=normalizeBootstrap(result);reconcileDrafts(snapshot);setData(applyOptimistic(snapshot));setConnectionError('');}
    else queuedRefresh.current=true;
   }return result;
  }).catch(async error=>{
   if(owner===epoch.current){
    if(error.status===401)clearSession();
    else if(revision!==mutationRevision.current)queuedRefresh.current=true;
    else if(['PASSWORD_CHANGE_REQUIRED','PASSWORD_RESET_REQUIRED'].includes(error.data?.code)){
     try{const result=await api('/session');if(owner===epoch.current){const next=normalizeUser(result.user);clearSession();setData({...emptyData(),user:next});}}
     catch(sessionError){if(owner===epoch.current)setConnectionError(sessionError.message);}
    }else if(['ACCOUNT_PENDING','ACCOUNT_REJECTED'].includes(error.data?.code)){
     const status=error.data.code==='ACCOUNT_PENDING'?'pending':'rejected';
     setData(previous=>({...emptyData(),user:{...previous.user,accountStatus:status,account_status:status}}));
    }else setConnectionError(error.message);
   }throw error;
  }).finally(()=>{
   if(refreshRequest.current===request)refreshRequest.current=null;
   if(queuedRefresh.current&&owner===epoch.current){queuedRefresh.current=false;clearTimeout(refreshTimer.current);refreshTimer.current=setTimeout(()=>refresh().catch(()=>{}),200);}
  });
  refreshRequest.current=request;return request;
 },[clearSession]);
 const scheduleRefresh=useCallback(()=>{clearTimeout(refreshTimer.current);refreshTimer.current=setTimeout(()=>refresh().catch(()=>{}),350);},[refresh]);
 useEffect(()=>subscribeAPIActivity(setNetworkActivity),[]);
 useEffect(()=>{
  let live=true;const owner=epoch.current;
  if(readLocal('logout-pending',false)){setLoading(false);if(navigator.onLine!==false)api('/logout',{method:'POST'}).then(()=>localStorage.removeItem(key+'logout-pending')).catch(()=>{});return()=>{live=false;};}
  api('/session').then(async result=>{
   if(!live||owner!==epoch.current)return;
   const next=normalizeUser(result.user);if(!next){clearSession();}else if(requiresPasswordChange(next)){clearSession();setData({...emptyData(),user:next});}else setData(previous=>({...previous,user:next}));
   if(next?.language)changeLanguage(next.language);
   if(!requiresPasswordChange(next)&&next?.accountStatus==='approved'&&next.facultyId)await refresh();
  }).catch(async error=>{if(!live||owner!==epoch.current)return;if(navigator.onLine===false){try{const snapshot=await loadOfflineSession();if(snapshot&&!requiresPasswordChange(snapshot.user)&&live&&owner===epoch.current){setData(snapshot);setConnectionError('');return;}}catch{}}if(live)setConnectionError(error.message);}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};
 },[refresh]);
 useEffect(()=>{
  const expired=()=>clearSession();window.addEventListener('campus-session-expired',expired);
  return()=>{window.removeEventListener('campus-session-expired',expired);clearTimeout(refreshTimer.current);};
 },[clearSession]);
 useEffect(()=>{
  document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.documentElement.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#121210':'#f7f5f1');
 },[language,theme]);
 useEffect(()=>{document.documentElement.dataset.lowData=lowData?'true':'false';},[lowData]);
 useEffect(()=>{const cache=event=>{if(!requiresPasswordChange(current.current.user)&&(!event.detail?.userId||String(event.detail.userId)===String(current.current.user?.id)))saveOfflineSession(current.current).catch(()=>notify(tr('Impossible d’enregistrer la session hors ligne.','Could not save the offline session.','تعذر حفظ الجلسة دون اتصال.'),'error'));};window.addEventListener('campus-offline-enabled',cache);return()=>window.removeEventListener('campus-offline-enabled',cache);},[]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),4200);return()=>clearTimeout(timer);},[toast]);
 useEffect(()=>{
  if(!user?.facultyId||user.accountStatus!=='approved'||requiresPasswordChange(user))return;
  let active=true;
  const sync=()=>{if(document.visibilityState!=='hidden'&&navigator.onLine!==false)scheduleRefresh();};
  const stream=navigator.onLine!==false&&!user.chatBlocked&&typeof EventSource==='function'?new EventSource('/api/events/stream'):null;
  stream?.addEventListener('open',sync);stream?.addEventListener('error',sync);
  stream?.addEventListener('update',event=>{
   try{const change=JSON.parse(event.data);if(change.registrations||change.adminInbox)setRegistrationRevision(value=>value+1);}catch{}sync();
  });
  // Refresh notifications sooner than the general fallback, without
  // fetching the full bootstrap response unless the inbox actually changed.
  let lastNotificationState=null,checkingNotifications=false;
  const checkNotifications=async()=>{
   if(checkingNotifications||document.visibilityState==='hidden'||navigator.onLine===false)return;
   checkingNotifications=true;
   try{
    const state=await api('/notifications/state');
    if(!active)return;
    const signature=state.latest_id+':'+state.total+':'+state.unread_count;
    const newest=current.current.notifications.reduce((max,item)=>Math.max(max,Number(item.id)||0),0);
    if(state.unread_count!==current.current.unreadCount||state.latest_id>newest||(lastNotificationState!==null&&lastNotificationState!==signature))scheduleRefresh();
    lastNotificationState=signature;
   }catch{}finally{checkingNotifications=false;}
  };
  const notificationTimer=setInterval(checkNotifications,lowData?30000:15000);
  const timer=setInterval(sync,lowData?90000:30000);
  document.addEventListener('visibilitychange',sync);window.addEventListener('online',sync);window.addEventListener('focus',sync);window.addEventListener('pageshow',sync);window.addEventListener('campus-xp-updated',sync);
  return()=>{active=false;stream?.close();clearInterval(timer);clearInterval(notificationTimer);document.removeEventListener('visibilitychange',sync);window.removeEventListener('online',sync);window.removeEventListener('focus',sync);window.removeEventListener('pageshow',sync);window.removeEventListener('campus-xp-updated',sync);};
 },[user?.id,user?.facultyId,user?.filiereId,user?.accountStatus,user?.chatBlocked,user?.mustChangePassword,scheduleRefresh,lowData]);
 function locked(action,operation){
  if(actionRequests.current.has(action))return actionRequests.current.get(action);
  const owner=epoch.current,promise=Promise.resolve().then(()=>operation(owner)).finally(()=>{if(actionRequests.current.get(action)===promise)actionRequests.current.delete(action);});
  actionRequests.current.set(action,promise);return promise;
 }
 function applyOptimistic(snapshot){for(const apply of optimistic.current.values())snapshot=apply(snapshot);return snapshot;}
 function reconcileDrafts(snapshot){
  const confirmed=new Set(snapshot.messages.filter(item=>item.authorId===snapshot.user?.id&&item.client_id).map(item=>item.client_id));
  for(const [pendingId,draft] of messageDrafts.current){const action='message:'+draft.client_id;if(!actionRequests.current.has(action)&&confirmed.has(draft.client_id)){
   optimistic.current.delete(action);messageDrafts.current.delete(pendingId);
   for(const cacheKey of stagedUploads.current.keys())if(JSON.parse(cacheKey)[0]===draft.client_id)stagedUploads.current.delete(cacheKey);
  }}
 }
 function commit(owner,update){if(owner===epoch.current){mutationRevision.current++;setData(previous=>applyOptimistic(update(previous)));}}
 function beginOptimistic(owner,action,apply){if(owner!==epoch.current)return;optimistic.current.set(action,apply);setPendingActions(previous=>({...previous,[action]:true}));commit(owner,previous=>previous);}
 function finishOptimistic(owner,action,apply){if(owner!==epoch.current)return;optimistic.current.delete(action);setPendingActions(previous=>{const next={...previous};delete next[action];return next;});commit(owner,apply);}
 const isPending=action=>Boolean(pendingActions[action]);
 function requireCurrent(owner){if(owner!==epoch.current)throw new Error('La session a changé. Réessayez depuis votre compte.');}
 async function refreshAccount(){
  const owner=epoch.current;
  try{const result=await api('/session'),next=normalizeUser(result.user);requireCurrent(owner);if(!next||requiresPasswordChange(next)||requiresPasswordChange(current.current.user)){clearSession();current.current={...emptyData(),user:next};setData(current.current);}else {current.current={...current.current,user:next};commit(owner,previous=>({...previous,user:next}));}
   if(!requiresPasswordChange(next)&&next?.accountStatus==='approved'&&next.facultyId)await refresh();setConnectionError('');return next;
  }catch(error){if(owner===epoch.current)setConnectionError(error.message);throw error;}
 }
 async function login(username,password){
  const result=await api('/login',{method:'POST',body:{username:username.trim(),password}});clearSession();
  localStorage.removeItem(key+'logout-pending');const next=normalizeUser(result.user);setData(previous=>({...previous,user:next}));if(next.language)changeLanguage(next.language);
  if(!requiresPasswordChange(next)&&next.accountStatus==='approved'&&next.facultyId)await refresh();
  return {ok:true,user:next,selection:next.facultyId&&next.filiereId?{facultyId:next.facultyId,filiereId:next.filiereId,semester:next.semester}:null};
 }
 async function register(body){
  const result=await api('/register',{method:'POST',body});clearSession();
  const next={...normalizeUser(result.user),registration_session:result.authenticated!==false};setData(previous=>({...previous,user:next}));return next;
 }
 async function completeOnboarding(value){
  const owner=epoch.current;
  if(!user||!filiereBelongsToFaculty(value.facultyId,value.filiereId)||![1,2,3,4,5,6].includes(Number(value.semester)))return false;
  if(user.facultyId&&user.facultyId!==value.facultyId)throw new Error(tr('Votre faculté est déjà associée à votre compte.','Your faculty is already assigned.','كليتك مرتبطة بحسابك مسبقاً.'));
  if(!user.facultyId)await api('/faculty',{method:'POST',body:{faculty_id:value.facultyId,confirmed:true}});requireCurrent(owner);
  const result=await api('/studies',{method:'POST',body:{filiere_id:value.filiereId,current_semester:Number(value.semester)}});
  requireCurrent(owner);const next=normalizeUser(result.user);
  // Old programme requests and private previews must not enter the new scope.
  clearSession();commit(epoch.current,()=>({...emptyData(),user:next}));await refresh();return true;
 }
 async function logout(){if(navigator.onLine===false){localStorage.setItem(key+'logout-pending','true');clearSession();return true;}try{await api('/logout',{method:'POST'});clearSession();localStorage.removeItem(key+'logout-pending');return true;}catch(error){notify(error.message,'error');throw error;}}
 async function updateProfile(patch){const owner=epoch.current,result=await api('/profile',{method:'PATCH',body:patch,timeout:60000});requireCurrent(owner);const next=normalizeUser(result.user);if(patch.avatar&&next.avatar.startsWith('/api/avatars/'))next.avatar+=(next.avatar.includes('?')?'&':'?')+'v='+Date.now().toString(36);commit(owner,previous=>({...previous,user:next}));notify(t('preferencesSaved'));return next;}
 function setLanguage(next){changeLanguage(next);if(user?.accountStatus==='approved'&&!requiresPasswordChange(user)){const owner=epoch.current;api('/profile',{method:'PATCH',body:{language:next}}).then(result=>commit(owner,previous=>({...previous,user:normalizeUser(result.user)}))).catch(error=>{if(owner===epoch.current)notify(error.message,'error');});}}
 function setPreferences(change){return locked('preferences',async owner=>{
  const prefs=preferencesFor(current.current.user),next=typeof change==='function'?change(prefs):{...prefs,...change};
  const original=current.current.user.preferences;
  const patch={announcements:next.announcements,resources:next.resources,mentions:next.mentions,important:next.discussions,admin:next.administration};
  beginOptimistic(owner,'preferences',previous=>({...previous,user:{...previous.user,preferences:{...previous.user.preferences,...patch}}}));
  try{const result=await api('/profile',{method:'PATCH',body:{preferences:patch}});requireCurrent(owner);finishOptimistic(owner,'preferences',previous=>({...previous,user:normalizeUser(result.user)}));return true;}
  catch(error){finishOptimistic(owner,'preferences',previous=>({...previous,user:{...previous.user,preferences:original}}));throw error;}
 });}
 const isSaved=(type,target)=>data.saved.some(item=>item.type===type&&item.id===String(target));
 function saveItem(type,target){return locked('saved:'+type+':'+target,async owner=>{
  const id=String(target),action='saved:'+type+':'+id;
  const wasSaved=current.current.saved.some(item=>item.type===type&&item.id===id);
  const apply=saved=>previous=>({...previous,saved:[...previous.saved.filter(item=>!(item.type===type&&item.id===id)),...(saved?[{type,id}]:[])]});
  beginOptimistic(owner,action,apply(!wasSaved));
  try{const result=await api('/saved',{method:'POST',body:{type:{document:'resource',discussion:'message'}[type]||type,id:target}});
   finishOptimistic(owner,action,apply(result.saved));if(owner===epoch.current)notify(t(result.saved?'savedSuccess':'removedSuccess'));return result.saved;
  }catch(error){finishOptimistic(owner,action,apply(wasSaved));if(owner===epoch.current)notify(error.message,'error');return false;}
 });}
 function openDocument(item){
  if(!item)return;setDialog({type:'document',item});const owner=epoch.current;
  locked('history:'+item.id,async()=>{const original=current.current.history,action='history:'+item.id,id=String(item.id);
   const apply=previous=>({...previous,history:[id,...previous.history.filter(target=>target!==id)].slice(0,20)});
   beginOptimistic(owner,action,apply);
   try{await api('/history',{method:'POST',body:{resource_id:id}});finishOptimistic(owner,action,apply);}
   catch(error){finishOptimistic(owner,action,previous=>({...previous,history:previous.history.filter(target=>target!==id).concat(original.includes(id)?[id]:[])}));if(owner===epoch.current)notify(error.message,'error');}
  });
 }
 function openAnnouncement(item){if(item)setDialog({type:'announcement',item});}
 function leaveNotificationDestination(identity){
  const visit=notificationVisit.current;if(!visit||identity&&visit.viewedIdentity!==identity)return;
  visit.left=true;notificationVisit.current=null;
  if(visit.token)return completeNotificationVisit(visit);
 }
 async function completeNotificationVisit(visit){
  if(visit.completed||!visit.token||visit.epoch!==epoch.current)return false;
  visit.completed=true;
  try{await api('/notifications/'+visit.id+'/departed',{method:'POST',body:{visit_token:visit.token}});
   commit(visit.epoch,previous=>({...previous,unreadCount:Math.max(0,(previous.unreadCount||0)-(previous.notifications.some(item=>item.id===visit.id&&!item.read)?1:0)),notifications:previous.notifications.map(item=>item.id===visit.id?{...item,read:true}:item)}));return true;
  }catch(error){visit.completed=false;if(visit.epoch===epoch.current)notify(error.message,'error');return false;}
 }
 function beginNotificationVisit(notification){
  leaveNotificationDestination();
  if(notification.target_available===false){
   if(!notification.read){
    const owner=epoch.current;
    api('/notifications/'+notification.id+'/read',{method:'POST'}).then(()=>{
     commit(owner,previous=>({...previous,unreadCount:Math.max(0,(previous.unreadCount||0)-(previous.notifications.some(item=>item.id===notification.id&&!item.read)?1:0)),notifications:previous.notifications.map(item=>item.id===notification.id?{...item,read:true}:item)}));
     if(owner===epoch.current)scheduleRefresh();
    }).catch(error=>{if(owner===epoch.current)notify(error.message,'error');});
   }
   notify(tr('La destination n’est plus accessible.','The destination is no longer accessible.','لم تعد الوجهة متاحة.'),'error');return false;
  }
  if(!notification.read)notificationVisit.current={id:notification.id,path:notification.serverPath||notification.path,href:notification.href,epoch:epoch.current,token:null,left:false,viewing:false};
  return true;
 }
 async function notificationDestinationViewed(kind,target){
  const visit=notificationVisit.current;if(!visit||visit.viewing||visit.token)return false;
  const destination=visit.path;
  const matches=kind==='resource'?new RegExp('#resource-'+target+'(?:$|[&?])').test(destination)||new URLSearchParams(destination.split('?')[1]?.split('#')[0]).get('document')===String(target)
   :kind==='message'?destination.includes('#message-'+target)
   :kind==='announcement'?destination.includes('#announcement-'+target)
   :kind==='feedback'?[new URLSearchParams(destination.split('?')[1]?.split('#')[0]).get('ticket'),new URLSearchParams(destination.split('?')[1]?.split('#')[0]).get('contact')].includes(String(target))
   :kind==='campus'?visit.href===String(target):kind==='page'?visit.href===String(target):false;
  if(!matches)return false;visit.viewing=true;visit.viewedIdentity=kind==='resource'?'document:'+target:kind==='announcement'?'announcement:'+target:window.location.pathname+window.location.search+window.location.hash;
  try{const result=await api('/notifications/'+visit.id+'/viewed',{method:'POST',body:{path:visit.path}});if(visit.epoch!==epoch.current)return false;visit.token=result.visit_token;if(visit.left)await completeNotificationVisit(visit);return true;}
  catch{visit.viewing=false;return false;}
 }
 async function loadMoreNotifications(){return locked('notifications:more',async owner=>{const previous=current.current,before=previous.notifications.length?Math.min(...previous.notifications.map(n=>Number(n.id))):undefined;const result=await api('/notifications?limit=100'+(before?'&before_id='+before:''));const normalized=normalizeBootstrap({...result,user:previous.user,resources:previous.resources});requireCurrent(owner);commit(owner,old=>({...old,notifications:[...old.notifications,...normalized.notifications.filter(n=>!old.notifications.some(x=>x.id===n.id))],unreadCount:result.unread_count,notificationsHasMore:result.has_more}));return result;});}
 async function uploadResource({file,path,meta,libraryVisible=true,channel='general'}){
  const form=new FormData(),scope=chatRequest(channel),owner=epoch.current;
  const fields={title:meta.title,semester:meta.semester,module:meta.module,category:meta.category,part_number:normalizePart(meta.part),teacher_name:meta.author||'',filiere_id:meta.filiereId||current.current.user?.filiereId,
   academic_year:meta.academicYear||'',faculty_id:meta.facultyId||current.current.user?.facultyId,resource_type:meta.category==='corrections'?'correction':['courses','exercises','exams','rattrapage','td','tp'].includes(meta.category)?meta.category:'document',relative_path:path||file.name,channel:scope.channel,
   ...(scope.semester?{chat_semester:scope.semester}:{}),library_visible:String(libraryVisible),publish_message:'false'};
  Object.entries(fields).forEach(([name,value])=>{if(value!==undefined&&value!==null)form.append(name,String(value));});form.append('file',file);
  const result=await api('/uploads',{method:'POST',body:form,timeout:600000}),resource=normalizeResource(result.resource);
  requireCurrent(owner);if(libraryVisible)commit(owner,previous=>({...previous,resources:[resource,...previous.resources.filter(item=>item.id!==resource.id)]}));if(Number(result.xp_awarded)>0)window.dispatchEvent(new CustomEvent('campus-xp-updated',{detail:{userId:current.current.user?.id}}));return resource;
 }
 async function updateResourceAcademicYears(target,years){const owner=epoch.current,result=await api('/resources/'+target+'/academic-years',{method:'PATCH',body:{academic_years:years,academic_year:years[0]||null}});requireCurrent(owner);const resource=normalizeResource(result.resource);commit(owner,previous=>({...previous,resources:previous.resources.map(item=>item.id===resource.id?resource:item)}));return resource;}
 function sendMessage(draft){
  const clientId=draft.client_id||globalThis.crypto?.randomUUID?.()||`message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const action='message:'+clientId,pendingId='pending:'+clientId;
  return locked(action,async owner=>{
  draft={...draft,client_id:clientId};messageDrafts.current.set(pendingId,draft);
  const author=current.current.user;
  const pending={id:pendingId,client_id:clientId,channel:draft.channel,content:draft.content||'',date:new Date().toISOString(),facultyId:author.facultyId,filiereId:author.filiereId,author:author.name,authorId:author.id,username:author.username,avatar:author.avatar,replyTo:draft.replyTo||null,sharedModule:draft.sharedModule||null,pinned:false,reactions:{like:0,heart:0},myReactions:[],attachments:(draft.attachments||[]).map(item=>({...item,originalName:item.name||item.file?.name||item.title,libraryVisible:false})),deliveryStatus:'sending'};
  const show=message=>previous=>({...previous,messages:[...previous.messages.filter(item=>item.id!==pendingId&&!(item.client_id===clientId&&item.authorId===author.id)),message]});
  beginOptimistic(owner,action,show(pending));
  try{
  const attachmentIds=[];
  for(const attachment of draft.attachments||[]){
   if(attachment.resourceId){attachmentIds.push(attachment.resourceId);continue;}
   const cacheKey=JSON.stringify([draft.client_id,attachment.id,attachment.path,attachment.title,attachment.module,attachment.category,attachment.part]);
   let staged=stagedUploads.current.get(cacheKey);
   if(!staged){staged=uploadResource({file:attachment.file,path:attachment.path,meta:attachment,libraryVisible:false,channel:draft.channel});stagedUploads.current.set(cacheKey,staged);staged.catch(()=>stagedUploads.current.delete(cacheKey));}
   attachmentIds.push((await staged).id);requireCurrent(owner);
  }
  const result=await api('/messages',{method:'POST',body:{...chatRequest(draft.channel),client_id:draft.client_id,content:draft.content||'',reply_to:draft.replyTo||null,attachment_ids:attachmentIds,module_resource_id:draft.sharedModule?.resourceId||null}});
  const message=normalizeMessage(result.message,current.current.resources);requireCurrent(owner);finishOptimistic(owner,action,previous=>({...previous,messages:[...previous.messages.filter(item=>item.id!==pendingId&&item.id!==message.id&&!(item.client_id===clientId&&item.authorId===author.id)),message]}));
  messageDrafts.current.delete(pendingId);
  for(const cacheKey of stagedUploads.current.keys())if(JSON.parse(cacheKey)[0]===draft.client_id)stagedUploads.current.delete(cacheKey);
  scheduleRefresh();return message;
  }catch(error){
   if(owner===epoch.current){optimistic.current.set(action,show({...pending,deliveryStatus:'failed',deliveryError:error.message}));setPendingActions(previous=>{const next={...previous};delete next[action];return next;});commit(owner,previous=>previous);}
   throw error;
  }
 });}
 function retryMessage(target){const draft=messageDrafts.current.get(String(target));if(!draft)return Promise.reject(new Error(tr('Ce message n’est plus disponible.','This message is no longer available.','هذه الرسالة لم تعد متاحة.')));return sendMessage(draft);}
 function discardMessage(target){const draft=messageDrafts.current.get(String(target));if(!draft||actionRequests.current.has('message:'+draft.client_id))return;messageDrafts.current.delete(String(target));for(const cacheKey of stagedUploads.current.keys())if(JSON.parse(cacheKey)[0]===draft.client_id)stagedUploads.current.delete(cacheKey);finishOptimistic(epoch.current,'message:'+draft.client_id,previous=>({...previous,messages:previous.messages.filter(item=>item.id!==String(target))}));}
 function deleteMessage(target){return locked('delete:'+target,async owner=>{
  const id=String(target),original=current.current.messages.find(item=>item.id===id),action='delete:'+id;
  beginOptimistic(owner,action,previous=>({...previous,messages:previous.messages.filter(item=>item.id!==id)}));
  try{await api('/messages/'+target,{method:'DELETE'});requireCurrent(owner);finishOptimistic(owner,action,previous=>({...previous,messages:previous.messages.filter(item=>item.id!==id)}));scheduleRefresh();}
  catch(error){finishOptimistic(owner,action,previous=>({...previous,messages:original?[...previous.messages.filter(item=>item.id!==id),original].sort((a,b)=>a.date.localeCompare(b.date)):previous.messages}));throw error;}
 });}
 function toggleMessageReaction(target,kind){return locked('reaction:'+target+':'+kind,async owner=>{
  const id=String(target),action='reaction:'+id+':'+kind,original=current.current.messages.find(item=>item.id===id);
  const desired=!original?.myReactions?.includes(kind);
  const apply=selected=>previous=>({...previous,messages:previous.messages.map(item=>{
   if(item.id!==id)return item;const has=item.myReactions?.includes(kind);if(has===selected)return item;
   return {...item,myReactions:[...(item.myReactions||[]).filter(value=>value!==kind),...(selected?[kind]:[])],reactions:{...item.reactions,[kind]:Math.max(0,(item.reactions?.[kind]||0)+(selected?1:-1))}};
  })});
  beginOptimistic(owner,action,apply(desired));
  try{const result=await api('/messages/'+target+'/reaction',{method:'POST',body:{reaction:kind}}),message=normalizeMessage(result.message,current.current.resources);
   finishOptimistic(owner,action,previous=>({...previous,messages:previous.messages.map(item=>item.id===message.id?message:item)}));return message;
  }catch(error){finishOptimistic(owner,action,apply(!desired));throw error;}
 });}
 function toggleMessagePin(target){return locked('pin:'+target,async owner=>{
  const id=String(target),wasPinned=Boolean(current.current.messages.find(item=>item.id===id)?.pinned),action='pin:'+id;
  const apply=pinned=>previous=>({...previous,messages:previous.messages.map(item=>item.id===id?{...item,pinned}:item)});
  beginOptimistic(owner,action,apply(!wasPinned));
  try{const result=await api('/messages/'+target+'/pin',{method:'POST',body:{}});requireCurrent(owner);finishOptimistic(owner,action,previous=>({...apply(result.pinned??!wasPinned)(previous),announcements:result.announcement?[normalizeAnnouncement(result.announcement),...previous.announcements.filter(item=>item.messageId!==id)]:!wasPinned?previous.announcements:previous.announcements.filter(item=>item.messageId!==id)}));scheduleRefresh();return result;}
  catch(error){finishOptimistic(owner,action,apply(wasPinned));throw error;}
 });}
 async function promoteMessage({messageId,title}){const owner=epoch.current,result=await api('/messages/'+messageId+'/pin',{method:'POST',body:{pinned:true,title}});requireCurrent(owner);const announcement=result.announcement?normalizeAnnouncement(result.announcement):null;commit(owner,previous=>({...previous,messages:previous.messages.map(item=>item.id===String(messageId)?{...item,pinned:true}:item),announcements:announcement?[announcement,...previous.announcements.filter(item=>item.id!==announcement.id)]:previous.announcements}));scheduleRefresh();return announcement;}
 async function reportMessage({messageId,reason,details}){const result=await api('/reports',{method:'POST',body:{target_type:'message',target_id:messageId,reason,details:details||''}});notify(tr('Signalement transmis à la modération.','Report sent to moderation.','تم إرسال البلاغ إلى الإدارة.'));return result;}
 function editAnnouncement(target,patch){return locked('announcement:'+target,async owner=>{
  const result=await api('/admin/announcements/'+target,{method:'PATCH',body:patch});requireCurrent(owner);const item=normalizeAnnouncement(result.announcement);
  commit(owner,previous=>({...previous,announcements:previous.announcements.map(value=>value.id===item.id?item:value),messages:previous.messages.map(message=>message.id===item.messageId?{...message,pinned:item.pinned}:message)}));scheduleRefresh();return item;
 });}
 function deleteAnnouncement(target){return locked('announcement:'+target,async owner=>{
  const id=String(target),action='announcement:'+id,original=current.current.announcements.find(item=>item.id===id),source=current.current.messages.find(item=>item.id===original?.messageId);
  const remove=previous=>({...previous,announcements:previous.announcements.filter(item=>item.id!==id),messages:previous.messages.map(item=>item.id===original?.messageId?{...item,pinned:false}:item)});
  beginOptimistic(owner,action,remove);
  try{await api('/admin/announcements/'+target,{method:'DELETE'});requireCurrent(owner);finishOptimistic(owner,action,previous=>({...remove(previous),saved:previous.saved.filter(item=>item.type!=='announcement'||item.id!==id)}));scheduleRefresh();}
  catch(error){finishOptimistic(owner,action,previous=>({...previous,announcements:original?[...previous.announcements.filter(item=>item.id!==id),original]:previous.announcements,messages:previous.messages.map(item=>item.id===source?.id?{...item,pinned:source.pinned}:item)}));throw error;}
 });}
 function applyAdminChanges(change={}){
  if(!isAdministrator(current.current.user))return;
  const owner=epoch.current;
  commit(owner,previous=>{
   const removedMessage=change.removedMessageId==null?null:String(change.removedMessageId),removedResource=change.removedResourceId==null?null:String(change.removedResourceId),removedAnnouncement=change.removedAnnouncementId==null?null:String(change.removedAnnouncementId);
   const inFaculty=item=>item.facultyId===previous.user?.facultyId;
   const upsert=(items,item)=>[item,...items.filter(value=>value.id!==item.id)];
   let resources=previous.resources.filter(item=>item.id!==removedResource),announcements=previous.announcements.filter(item=>item.id!==removedAnnouncement&&(!removedMessage||item.messageId!==removedMessage)).map(item=>removedResource&&item.resourceId===removedResource?{...item,resourceId:null}:item);
   if(change.resource){const item=normalizeResource(change.resource);if(inFaculty(item)&&item.filiereId===previous.user?.filiereId&&item.libraryVisible)resources=upsert(resources,item);}
   for(const raw of change.announcements||(change.announcement?[change.announcement]:[])){const item=normalizeAnnouncement(raw);if(inFaculty(item)&&(!item.filiereId||item.filiereId===previous.user?.filiereId))announcements=upsert(announcements,item);}
   let messages=previous.messages.filter(item=>item.id!==removedMessage).map(item=>removedResource?{...item,attachments:(item.attachments||[]).filter(file=>file.id!==removedResource)}:item).filter(item=>!removedResource||item.content||item.attachments?.length||item.sharedModule);
   const unpinned=previous.announcements.find(item=>item.id===removedAnnouncement)?.messageId;
   if(unpinned)messages=messages.map(item=>item.id===unpinned?{...item,pinned:false}:item);
   if(change.announcement){const announcement=normalizeAnnouncement(change.announcement);if(announcement.messageId)messages=messages.map(item=>item.id===announcement.messageId?{...item,pinned:announcement.pinned}:item);}
   if(change.resource){const resource=normalizeResource(change.resource);messages=messages.map(item=>({...item,attachments:(item.attachments||[]).map(file=>file.id===resource.id?resource:file)}));}
   if(change.message){const item=normalizeMessage(change.message,resources);messages=messages.map(value=>value.id===item.id?item:value);}
   if(change.pinnedMessageId!=null)messages=messages.map(item=>item.id===String(change.pinnedMessageId)?{...item,pinned:change.pinned}:item);
   const messageIds=new Set(messages.map(item=>item.id)),removedMessages=new Set(previous.messages.filter(item=>!messageIds.has(item.id)).map(item=>item.id));if(removedMessage)removedMessages.add(removedMessage);
   announcements=announcements.filter(item=>!removedMessages.has(item.messageId)&&!(change.pinned===false&&item.messageId===String(change.pinnedMessageId)));
   const announcementIds=new Set(announcements.map(item=>item.id)),removedAnnouncements=new Set(previous.announcements.filter(item=>!announcementIds.has(item.id)).map(item=>item.id));if(removedAnnouncement)removedAnnouncements.add(removedAnnouncement);
   const saved=previous.saved.filter(item=>!(item.type==='document'&&item.id===removedResource)&&!(item.type==='discussion'&&removedMessages.has(item.id))&&!(item.type==='announcement'&&removedAnnouncements.has(item.id)));
   return {...previous,resources,announcements,messages,saved,history:previous.history.filter(item=>item!==removedResource)};
  });
 }
 async function requestSupport({username,reason,message,name,email}){return api('/contact',{method:'POST',body:{name:name||user?.name||username,email:email||user?.email,subject:reason==='assignment'?'faculty':reason==='help'?'general':reason||'general',message}});}
 const value={...data,user,selection,faculty,filiere,isAdmin,loading,connectionError,error:connectionError,refresh,refreshAccount,scheduleRefresh,registrationRevision,register,login,logout,completeOnboarding,
  language,setLanguage,theme,setTheme,lowData,setLowData,t,tr,updateProfile,preferences:preferencesFor(user),setPreferences,resources:data.resources,allResources:data.resources,announcements:data.announcements,allAnnouncements:data.announcements,
  messages:data.messages.filter(item=>!['help','life'].includes(item.channel)),allMessages:data.messages,notifications:data.notifications,allNotifications:data.notifications,saved:data.saved,history:data.history,
  saveItem,isSaved,isPending,pendingActions,networkActivity,refreshing:networkActivity.reads>0,openDocument,openAnnouncement,beginNotificationVisit,notificationDestinationViewed,leaveNotificationDestination,loadMoreNotifications,uploadResource,updateResourceAcademicYears,sendMessage,retryMessage,discardMessage,deleteMessage,toggleMessageReaction,toggleMessagePin,reportMessage,promoteMessage,editAnnouncement,deleteAnnouncement,applyAdminChanges,requestSupport,
  dialog,setDialog,closeDialog:()=>setDialog(null),openUpload:()=>setDialog({type:'upload'}),notify,toast,setToast};
 return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
export const useApp=()=>useContext(AppContext);
