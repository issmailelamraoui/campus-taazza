import {requestId} from '../lib/identifiers';
import React,{useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {Download,Send,ThumbsUp,Heart} from 'lucide-react';
import {api} from '../api';
import {useApp} from '../context';
import {FACULTIES} from '../data/mock';
import {Button,Field,PageHeader} from '../components/ui';
import {Select} from '../components/Select';
import PageLoading from '../components/PageLoading';
import './feedback.css';
const recoveryKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
export default function AccessSupportPage({embedded=false}) {
 const {tr,user,notify}=useApp();
 const [ticket,setTicket]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[mode,setMode]=useState('request');
 const [form,setForm]=useState({name:user?.name||'',email:user?.email||'',faculty_id:user?.facultyId||'',subject:'',message:''});
 const [code,setCode]=useState(''),[key,setKey]=useState(''),[draft,setDraft]=useState('');
 const request=useRef(false),createKey=useRef(null),messageId=useRef(null),live=useRef(true),readEpoch=useRef(0);
 useEffect(()=>{live.current=true;api('/support/session').then(r=>{if(live.current)setTicket(r.ticket);}).catch(e=>{if(live.current&&e.status!==401)setError(e.message);}).finally(()=>{if(live.current)setLoading(false);});return()=>{live.current=false;};},[]);
 useEffect(()=>{
  if(!ticket)return;let active=true,reading=false;
  async function refresh(){if(reading||document.visibilityState==='hidden')return;reading=true;const epoch=readEpoch.current;try{const r=await api('/support/session');if(active&&epoch===readEpoch.current&&!request.current){setTicket(r.ticket);setError('');}}catch(e){if(active){setError(e.message);if(e.status===401){setTicket(null);setKey('');setCode('');setDraft('');createKey.current=null;messageId.current=null;}}}finally{reading=false;}}
  const stream=typeof EventSource==='function'?new EventSource('/api/support/stream'):null;
  stream?.addEventListener('open',refresh);stream?.addEventListener('update',refresh);
  const timer=setInterval(refresh,15000);
  document.addEventListener('visibilitychange',refresh);window.addEventListener('online',refresh);
  return()=>{active=false;stream?.close();clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);};
 },[ticket?.id]);
 async function action(path,body,onSuccess){
  if(request.current)return;readEpoch.current++;request.current=true;setBusy(true);setError('');
  try{const result=await api(path,{method:'POST',body});if(live.current){if(result.ticket)setTicket(result.ticket);onSuccess?.(result);}}
  catch(e){if(live.current)setError(e.message);}finally{readEpoch.current++;request.current=false;if(live.current)setBusy(false);}
 }
 function create(event){event.preventDefault();createKey.current??=recoveryKey();action('/support/request',{...form,recovery_key:createKey.current},r=>setKey(r.recovery_key));}
 function send(event){event.preventDefault();const content=draft.trim();if(!content)return;messageId.current??=requestId();action('/support/replies',{content,client_id:messageId.current},()=>{messageId.current=null;setDraft(current=>current.trim()===content?'':current);});}
 function download(){const url=URL.createObjectURL(new Blob([`CampusLink Taza — Assistance #${ticket.id}\n${location.origin}/support\nCode privé : ${key}\nConservez ce code : il donne accès uniquement à cette demande.\n`],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`campuslink-assistance-${ticket.id}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify(tr('Code téléchargé. Conservez-le dans un endroit privé.','Code downloaded. Keep it private.','تم تنزيل الرمز. احتفظ به في مكان خاص.'));}
 const closed=ticket?.closed_at||['closed','resolved','done'].includes(ticket?.status);
 const Container=embedded?'div':'main';
 return <Container className={embedded?'access-support':'public-page access-support-page'}><div className="access-support">
 {!embedded&&<><Link to="/login">← {tr('Connexion','Sign in','تسجيل الدخول')}</Link><PageHeader title={tr('Assistance CampusLink','CampusLink support','مساعدة CampusLink')} description={tr('Un problème d’accès ? Contactez votre administration et retrouvez votre conversation ici.','Access trouble? Contact administration and return to your conversation here.','مشكلة في الدخول؟ تواصل مع الإدارة وتابع محادثتك هنا.')}/></>}
 {error&&<p className="notice" role="alert">{error}</p>}
 {loading?<PageLoading label={tr('Recherche de votre demande…','Finding your request…','جارٍ البحث عن طلبك…')}/>:ticket?<>
 <header className="feedback-ticket-header"><h2>#{ticket.id} · {ticket.title}</h2><p>{closed?tr('Conversation clôturée','Conversation closed','المحادثة مغلقة'):ticket.assigned?`${tr('Prise en charge par','Assigned to','يتولى الطلب')} ${ticket.assigned.name}${ticket.assigned.username?' · @'+ticket.assigned.username:''}`:tr('En attente d’acceptation par un administrateur','Waiting for an administrator to accept','في انتظار قبول مسؤول')}</p></header>
 {key&&<section className="notice support-recovery"><p>{tr('Conservez ce code pour retrouver cette demande sur un autre appareil ou après la suppression des données du navigateur.','Keep this code to recover this request on another device or after clearing browser data.','احتفظ بالرمز لاستعادة الطلب على جهاز آخر أو بعد مسح بيانات المتصفح.')}</p><code dir="ltr">{key}</code><Button icon={Download} onClick={download}>{tr('Télécharger mon code privé','Download my private code','تنزيل رمزي الخاص')}</Button></section>}
 <div className="feedback-thread"><article className="feedback-message"><strong>{ticket.name}</strong><p dir="auto">{ticket.description}</p></article>{ticket.replies.map(message=><article className={`feedback-message ${message.administrative?'feedback-message-admin':''}`} key={message.id}><strong>{message.author.name}</strong><time>{new Date(message.created_at).toLocaleString()}</time><p dir="auto">{message.content}</p><div className="feedback-reactions">{[['like',ThumbsUp],['heart',Heart]].map(([reaction,Icon])=><button key={reaction} type="button" disabled={busy} aria-label={reaction==='like'?tr('J’aime','Like','إعجاب'):tr('J’adore','Love','أحببت')} onClick={()=>action('/support/reactions',{reply_id:message.id,reaction,active:!message.my_reactions?.includes(reaction)})}><Icon size={15}/>{message.reactions?.[reaction]||0}</button>)}</div></article>)}</div>
 {ticket.assigned_to&&!closed&&<form className="stack" onSubmit={send}><Field label={tr('Votre message','Your message','رسالتك')}><textarea required maxLength={4000} rows={3} value={draft} onChange={e=>{setDraft(e.target.value);messageId.current=null;}}/></Field><Button type="submit" icon={Send} disabled={busy||!draft.trim()}>{tr('Envoyer','Send','إرسال')}</Button></form>}
 <Button variant="ghost" disabled={busy} onClick={()=>action('/support/logout',{},()=>{setTicket(null);setKey('');setCode('');createKey.current=null;})}>{tr('Quitter cette demande','Leave this request','مغادرة هذا الطلب')}</Button>
 </>:<><div className="support-modes"><Button onClick={()=>setMode('request')} aria-pressed={mode==='request'}>{tr('Nouvelle demande','New request','طلب جديد')}</Button><Button onClick={()=>setMode('recover')} aria-pressed={mode==='recover'}>{tr('Retrouver ma demande','Recover my request','استعادة طلبي')}</Button></div>
 {mode==='recover'?<form className="stack" onSubmit={e=>{e.preventDefault();action('/support/recover',{recovery_key:code.trim()},()=>setCode(''));}}><Field label={tr('Code privé de récupération','Private recovery code','رمز الاستعادة الخاص')}><input required autoComplete="off" value={code} onChange={e=>setCode(e.target.value)} dir="ltr"/></Field><Button type="submit" disabled={busy}>{tr('Retrouver la conversation','Recover conversation','استعادة المحادثة')}</Button></form>:<form className="stack" onSubmit={create}>
 {['name','email'].map(field=><Field key={field} label={field==='name'?tr('Nom complet','Full name','الاسم الكامل'):tr('Adresse email','Email address','البريد الإلكتروني')}><input required type={field==='email'?'email':'text'} readOnly={!!user&&user.accountStatus==='approved'} autoComplete={field==='email'?'email':'name'} maxLength={field==='email'?160:100} value={form[field]} onChange={e=>setForm({...form,[field]:e.target.value})}/></Field>)}
 <Field label={tr('Faculté','Faculty','الكلية')}><Select required value={form.faculty_id} onChange={e=>setForm({...form,faculty_id:e.target.value})}><option value="">{tr('Choisir','Choose','اختر')}</option>{FACULTIES.map(f=><option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}</Select></Field>
 <Field label={tr('Objet du problème','Issue subject','موضوع المشكلة')}><Select required value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})}><option value="">{tr('Choisir','Choose','اختر')}</option>{['Problème de connexion','Mot de passe oublié','Première inscription','Compte inaccessible','Autre difficulté d’accès'].map(v=><option value={v} key={v}>{v}</option>)}</Select></Field>
 <Field label={tr('Description','Description','الوصف')}><textarea required rows={4} maxLength={6000} value={form.message} onChange={e=>setForm({...form,message:e.target.value})}/></Field><Button type="submit" disabled={busy} icon={Send}>{tr('Envoyer ma demande','Send request','إرسال طلبي')}</Button>
 </form>}</>}
 </div></Container>;
}
