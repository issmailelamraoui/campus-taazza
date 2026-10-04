import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api';
import { translate } from './i18n';
import { OptimisticState, pendingMessage, putMessage, setSaved } from './optimistic';
import { AdminNotificationFeed } from './admin-notifications';
import { createClientId } from './client-id';
import { RefreshQueue } from './live-updates';
const Context = createContext(null);
const approved = user => user && (user.account_status || 'approved') === 'approved';
export function AppProvider({ children }) {
  const [user, setUser] = useState(null), [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [lang, setLanguage] = useState(localStorage.getItem('campus-language') || 'fr');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');
  const [modal, setModal] = useState(null), [toasts, setToasts] = useState([]);
  const [registrationRevision,setRegistrationRevision]=useState(0);
  const [adminAlerts,setAdminAlerts]=useState([]);
  const adminInbox=useRef(new AdminNotificationFeed());
  const dismissAdminAlert=useCallback(id=>setAdminAlerts(previous=>previous.filter(item=>item.id!==id)),[]);
  const refreshVersion = useRef(0);
  const epoch = useRef(0), requests = useRef(new Map()), refreshQueue = useRef(null);
  const state = useRef(null);
  if (!state.current) state.current = new OptimisticState(setData);
  const t = useCallback((key, fallback) => translate(lang, key, fallback), [lang]);
  const toast = useCallback((message, type='success') => { const id = createClientId(); setToasts(prev=>[...prev.slice(-2),{id,message,type}]); setTimeout(()=>setToasts(prev=>prev.filter(item=>item.id!==id)),4000); }, []);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await api('/bootstrap', { signal: controller.signal });
      if(controller.signal.aborted)throw new Error('La connexion a expiré. Réessayez.');
      if (version === refreshVersion.current) {
        const previous=state.current.base?.user;
        if(previous&&(previous.id!==result.user?.id||previous.faculty_id!==result.user?.faculty_id||previous.filiere_id!==result.user?.filiere_id||previous.account_status!==result.user?.account_status||(!previous.chat_blocked&&result.user?.chat_blocked))){
          epoch.current++;requests.current.clear();state.current.operations.clear();
        }
        state.current.replace(result); if(result.user)setUser(result.user); setError('');
      }
      return result;
    } catch(error) {
      const e=controller.signal.aborted?new Error('La connexion a expiré. Réessayez.'):error;
      if (version === refreshVersion.current) {
        if(!state.current.base)setError(e.message);
        if(e.status===401){epoch.current++;requests.current.clear();setUser(null);state.current.reset();}
        if(['ACCOUNT_PENDING','ACCOUNT_REJECTED'].includes(e.data?.code)){
          epoch.current++;requests.current.clear();state.current.reset();setError('');
          setUser(current=>current?{...current,account_status:e.data.code==='ACCOUNT_PENDING'?'pending':'rejected'}:null);
        }
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }, []);
  if(!refreshQueue.current)refreshQueue.current=new RefreshQueue(refresh);
  const scheduleRefresh = useCallback(() => refreshQueue.current.schedule(), []);
  useEffect(() => () => refreshQueue.current.cancel(), []);
  const optimisticAction = useCallback(({key, apply, request, commit=apply, failed}) => {
    if(requests.current.has(key))return requests.current.get(key);
    const currentEpoch=epoch.current;
    state.current.put(key,apply);
    const pending=Promise.resolve().then(request).then(result=>{
      if(currentEpoch===epoch.current){
        refreshVersion.current++;
        state.current.confirm(key,base=>commit(base,result));
        scheduleRefresh();
      }
      return result;
    }).catch(error=>{
      if(currentEpoch===epoch.current){
        refreshVersion.current++;
        if(failed)state.current.put(key,base=>failed(base,error));else state.current.remove(key);
        scheduleRefresh();
      }
      throw error;
    }).finally(()=>{if(requests.current.get(key)===pending)requests.current.delete(key);});
    requests.current.set(key,pending);
    return pending;
  },[scheduleRefresh]);
  useEffect(() => { api('/session').then(async result=>{ setUser(result.user); if(result.user?.language)setLanguage(result.user.language); if(approved(result.user)&&result.user?.faculty_id)await refresh(); }).catch(e=>setError(e.message)).finally(()=>setLoading(false)); },[refresh]);
  useEffect(()=>{ document.documentElement.lang=lang; document.documentElement.dir=lang==='ar'?'rtl':'ltr'; localStorage.setItem('campus-language',lang); },[lang]);
  useEffect(()=>{
    document.documentElement.dataset.theme=theme;
    document.documentElement.style.colorScheme=theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#151412':'#f6f4ef');
    try { localStorage.setItem('campus-theme',theme); } catch {}
  },[theme]);
  useEffect(()=>{
    const sync=e=>{if(e.key==='campus-theme')setTheme(e.newValue==='light'?'light':'dark');};
    window.addEventListener('storage',sync);
    return ()=>window.removeEventListener('storage',sync);
  },[]);
  useEffect(()=>{
    if(!data?.user||data.user.id!==user?.id||!approved(user)||!['global_admin','faculty_admin','moderator'].includes(user.role)){adminInbox.current.reset();setAdminAlerts(previous=>previous.length?[]:previous);return;}
    const incoming=adminInbox.current.capture(user,data.notifications||[]);
    const owner=`${user.id}:${user.faculty_id}:${user.role}`;
    const unread=new Set((data.notifications||[]).filter(item=>!item.read).map(item=>item.id));
    setAdminAlerts(previous=>{
      const existing=previous.filter(item=>item._inboxOwner===owner&&unread.has(item.id));
      if(!incoming.length&&existing.length===previous.length)return previous;
      return [...existing,...incoming.map(item=>({...item,_inboxOwner:owner}))].slice(-3);
    });
  },[data,user?.id,user?.faculty_id,user?.role,user?.account_status]);
  useEffect(()=>{
    if(!approved(user)||!user?.faculty_id)return;
    const sync=()=>{if(document.visibilityState!=='hidden'&&navigator.onLine!==false)scheduleRefresh();};
    const resume=()=>{if(document.visibilityState!=='hidden'&&navigator.onLine!==false){setRegistrationRevision(value=>value+1);scheduleRefresh();}};
    const stream=!user.chat_blocked&&typeof EventSource==='function'?new EventSource('/api/events/stream'):null;
    stream?.addEventListener('open',resume);
    stream?.addEventListener('error',sync);
    stream?.addEventListener('update',event=>{
      try{const change=JSON.parse(event.data);if(change.registrations||change.adminInbox)setRegistrationRevision(value=>value+1);}catch{}
      scheduleRefresh();
    });
    // Reconcile even a silently stalled stream; hidden/offline phones stay quiet.
    const reconcile=setInterval(sync,10000);
    document.addEventListener('visibilitychange',resume);
    window.addEventListener('focus',resume);
    window.addEventListener('online',resume);
    window.addEventListener('pageshow',resume);
    return ()=>{
      stream?.close();clearInterval(reconcile);refreshQueue.current.cancel();
      document.removeEventListener('visibilitychange',resume);
      window.removeEventListener('focus',resume);
      window.removeEventListener('online',resume);
      window.removeEventListener('pageshow',resume);
    };
  },[user?.id,user?.faculty_id,user?.filiere_id,user?.role,user?.chat_blocked,user?.account_status,scheduleRefresh]);
  const setLang = next => { setLanguage(next); if(approved(user))api('/profile',{method:'PATCH',body:{language:next}}).catch(()=>{}); };
  const login = async (username,password) => { const result=await api('/login',{method:'POST',body:{username,password}});resetActions();setUser(result.user);if(approved(result.user)&&result.user.faculty_id)await refresh();return result.user; };
  const resetActions = () => {epoch.current++;refreshVersion.current++;refreshQueue.current.cancel();requests.current.clear();state.current.reset();adminInbox.current.reset();setAdminAlerts([]);};
  const register = async body => {
    const result=await api('/register',{method:'POST',body});resetActions();setError('');
    setUser({...result.user,registration_session:result.authenticated!==false});
    return result.user;
  };
  const refreshAccount = async () => {
    const result=await api('/session');
    resetActions();setError('');setUser(result.user);
    if(approved(result.user)&&result.user.faculty_id)await refresh();
    return result.user;
  };
  const logout = async () => {await api('/logout',{method:'POST'});resetActions();setUser(null);};
  const setAccount = next => {refreshVersion.current++;if(next?.id!==user?.id||next?.faculty_id!==user?.faculty_id||next?.filiere_id!==user?.filiere_id||next?.account_status!==user?.account_status)resetActions();setUser(next);};
  const toggleSave = (type,id) => {
    const desired=!state.current.project()?.saved.some(s=>s.type===type&&s.id===id);
    return optimisticAction({key:`saved-${type}-${id}`,apply:base=>setSaved(base,type,id,desired),request:()=>api('/saved',{method:'POST',body:{type,id}}),commit:(base,result)=>setSaved(base,type,id,result.saved)});
  };
  const sendMessage = draft => optimisticAction({
    key:`send-${draft.client_id}`,apply:base=>pendingMessage(base,{...draft,_status:'pending'}),
    request:()=>api('/messages',{method:'POST',body:{client_id:draft.client_id,content:draft.content,channel:draft.channel,...(draft.channel==='filiere'?{semester:draft.semester}:{}),reply_to:draft.reply_to}}),
    commit:(base,result)=>putMessage(base,result.message),failed:base=>pendingMessage(base,{...draft,_status:'failed'}),
  });
  const discardMessage = draft => state.current.remove(`send-${draft.client_id}`);
  return <Context.Provider value={{user,data,loading,error,refresh,refreshAccount,register,registrationRevision,adminAlerts,dismissAdminAlert,scheduleRefresh,optimisticAction,sendMessage,discardMessage,login,logout,t,lang,setLang,theme,toggleTheme:()=>setTheme(current=>current==='dark'?'light':'dark'),toast,modal,openModal:(type,payload)=>setModal({type,payload}),closeModal:()=>setModal(null),toasts,saved:data?.saved||[],toggleSave,setAccount}}>{children}</Context.Provider>;
}
export const useApp=()=>useContext(Context);
