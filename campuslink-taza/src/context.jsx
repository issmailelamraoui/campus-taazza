import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { translate } from './i18n';
const Context = createContext(null);
export function AppProvider({ children }) {
  const [user, setUser] = useState(null), [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [lang, setLanguage] = useState(localStorage.getItem('campus-language') || 'fr');
  const [modal, setModal] = useState(null), [toasts, setToasts] = useState([]);
  const t = useCallback((key, fallback) => translate(lang, key, fallback), [lang]);
  const toast = useCallback((message, type='success') => { const id = crypto.randomUUID(); setToasts(prev=>[...prev.slice(-2),{id,message,type}]); setTimeout(()=>setToasts(prev=>prev.filter(item=>item.id!==id)),4000); }, []);
  const refresh = useCallback(async () => { try { const result = await api('/bootstrap'); setData(result); if(result.user)setUser(result.user); setError(''); return result; } catch(e) { setError(e.message); if(e.status===401){setUser(null);setData(null);} throw e; } }, []);
  useEffect(() => { api('/session').then(async result=>{ setUser(result.user); if(result.user?.language)setLanguage(result.user.language); if(result.user?.faculty_id)await refresh(); }).catch(e=>setError(e.message)).finally(()=>setLoading(false)); },[refresh]);
  useEffect(()=>{ document.documentElement.lang=lang; document.documentElement.dir=lang==='ar'?'rtl':'ltr'; localStorage.setItem('campus-language',lang); },[lang]);
  useEffect(()=>{ if(!user?.faculty_id)return; const stream=new EventSource('/api/events/stream'); stream.addEventListener('update',()=>refresh().catch(()=>{})); return ()=>stream.close(); },[user?.faculty_id,refresh]);
  const setLang = next => { setLanguage(next); if(user)api('/profile',{method:'PATCH',body:{language:next}}).catch(()=>{}); };
  const login = async (username,password) => { const result=await api('/login',{method:'POST',body:{username,password}}); setUser(result.user); if(result.user.faculty_id)await refresh(); return result.user; };
  const logout = async () => {await api('/logout',{method:'POST'});setUser(null);setData(null);};
  const setAccount = next => {setUser(next);};
  const toggleSave = async (type,id) => {await api('/saved',{method:'POST',body:{type,id}}); await refresh();};
  return <Context.Provider value={{user,data,loading,error,refresh,login,logout,t,lang,setLang,toast,modal,openModal:(type,payload)=>setModal({type,payload}),closeModal:()=>setModal(null),toasts,saved:data?.saved||[],toggleSave,setAccount}}>{children}</Context.Provider>;
}
export const useApp=()=>useContext(Context);
