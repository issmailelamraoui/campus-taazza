import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { translate } from './i18n';
const Context = createContext(null);
export function AppProvider({ children }) {
  const [user, setUser] = useState(null), [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [lang, setLanguage] = useState(localStorage.getItem('campus-language') || 'fr');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');
  const [modal, setModal] = useState(null), [toasts, setToasts] = useState([]);
  const t = useCallback((key, fallback) => translate(lang, key, fallback), [lang]);
  const toast = useCallback((message, type='success') => { const id = crypto.randomUUID(); setToasts(prev=>[...prev.slice(-2),{id,message,type}]); setTimeout(()=>setToasts(prev=>prev.filter(item=>item.id!==id)),4000); }, []);
  const refresh = useCallback(async () => { try { const result = await api('/bootstrap'); setData(result); if(result.user)setUser(result.user); setError(''); return result; } catch(e) { setError(e.message); if(e.status===401){setUser(null);setData(null);} throw e; } }, []);
  useEffect(() => { api('/session').then(async result=>{ setUser(result.user); if(result.user?.language)setLanguage(result.user.language); if(result.user?.faculty_id)await refresh(); }).catch(e=>setError(e.message)).finally(()=>setLoading(false)); },[refresh]);
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
  useEffect(()=>{ if(!user?.faculty_id)return; const stream=new EventSource('/api/events/stream'); stream.addEventListener('update',()=>refresh().catch(()=>{})); return ()=>stream.close(); },[user?.faculty_id,user?.filiere_id,refresh]);
  const setLang = next => { setLanguage(next); if(user)api('/profile',{method:'PATCH',body:{language:next}}).catch(()=>{}); };
  const login = async (username,password) => { const result=await api('/login',{method:'POST',body:{username,password}}); setUser(result.user); if(result.user.faculty_id)await refresh(); return result.user; };
  const logout = async () => {await api('/logout',{method:'POST'});setUser(null);setData(null);};
  const setAccount = next => {setUser(next);};
  const toggleSave = async (type,id) => {await api('/saved',{method:'POST',body:{type,id}}); await refresh();};
  return <Context.Provider value={{user,data,loading,error,refresh,login,logout,t,lang,setLang,theme,toggleTheme:()=>setTheme(current=>current==='dark'?'light':'dark'),toast,modal,openModal:(type,payload)=>setModal({type,payload}),closeModal:()=>setModal(null),toasts,saved:data?.saved||[],toggleSave,setAccount}}>{children}</Context.Provider>;
}
export const useApp=()=>useContext(Context);
