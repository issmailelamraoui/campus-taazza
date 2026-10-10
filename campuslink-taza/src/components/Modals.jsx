import { Select } from './Select';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Search,FileText,BookOpen,Megaphone,MessageSquare,ArrowUpRight,Download,Maximize,Minimize,Bookmark,BookmarkCheck,Mail,Check,ArrowRight,LifeBuoy,Send,Lock,Info,Trash2} from 'lucide-react';
import {useApp} from '../context';
import {formatDate} from '../i18n';
import {getFiliere} from '../data/studies';
import {moduleSuggestions,partLabel} from '../lib/resources';
import {normalizeSearch} from '../utils';
import {Modal,Button,Field,Badge,Avatar,EmptyState} from './ui';
import UploadModal from './UploadModal';

function DocumentPreview({item}){
 const {t,tr,language,closeDialog,isSaved,isPending,saveItem}=useApp();
 const [fullscreen,setFullscreen]=useState(false);const [text,setText]=useState(null);const [textError,setTextError]=useState(false);
 const saved=isSaved('document',item.id),saving=isPending('saved:document:'+item.id);
 const fileType=String(item.fileType||item.originalName?.split('.').pop()||'PDF').toUpperCase();
 const filename=item.originalName||item.title;const image=['JPG','JPEG','PNG','WEBP'].includes(fileType);
 const demoPdf=false;
 useEffect(()=>{
  setText(null);setTextError(false);
  if(fileType!=='TXT'||!item.url)return;
  const controller=new AbortController();
  fetch(item.url,{signal:controller.signal}).then(response=>{if(!response.ok)throw new Error('File unavailable');return response.text();}).then(value=>setText(value)).catch(error=>{if(error.name!=='AbortError')setTextError(true);});
  return()=>controller.abort();
 },[item.id,item.url,fileType]);
 function download(){
  if(!item.url&&!demoPdf)return;
  const url=item.downloadUrl||item.url;
  const a=document.createElement('a');a.href=url;a.download=item.originalName||`${item.title.replace(/[\\/:*?"<>|]/g,'-')}.${fileType.toLowerCase()}`;a.click();
 }
 const details=[
  [t('file'),filename],[t('title'),item.title],
  [t('filiere'),getFiliere(item.filiereId)?.name||item.filiereId],
  [t('semester'),`S${item.semester}`],[t('module'),item.module],
  [tr('Catégorie','Category','الفئة'),t(item.category)],[t('part'),partLabel(item.part,language)],
  ...(item.author?[[t('author'),item.author]]:[]),
  [tr('Type de fichier','File type','نوع الملف'),fileType],
  ...(item.size?[[tr('Taille','Size','الحجم'),item.size]]:[]),
  ...(item.uploader?[[tr('Partagé par','Shared by','شارك بواسطة'),item.uploader]]:[]),
  ...(item.date?[[t('date'),formatDate(item.date,language,{day:'numeric',month:'long',year:'numeric'})]]:[]),
 ];
 return <Modal title={t('preview')} onClose={closeDialog} wide className={`preview-modal ${fullscreen?'fullscreen':''}`}>
  <div className="preview-meta"><Badge className={`document-category-${item.category}`}>{t(item.category)}</Badge><span>S{item.semester}</span><span>·</span><bdi>{item.module}</bdi><span>·</span><span>{partLabel(item.part,language)}</span><span className="preview-session-note">{item.localOnly?tr('Fichier local · cette session','Local file · this session','ملف محلي · هذه الجلسة'):demoPdf?tr('Document de démonstration','Demo document','مستند تجريبي'):null}</span></div>
  <div className="preview-layout">
   <div className={`pdf-area document-preview-area document-preview-${fileType.toLowerCase()}`}>
    {item.url&&fileType==='PDF'?<iframe title={filename} src={item.url.split('#')[0]+'#toolbar=0&view=FitH'}/>:
     item.url&&image?<img className="document-image-preview" src={item.url} alt={filename}/>:
     item.url&&fileType==='TXT'?textError?<EmptyState icon={FileText} title={t('noPreview')} description={tr('Téléchargez le fichier pour le lire sur votre appareil.','Download the file to read it on your device.','نزّل الملف لقراءته على جهازك.')}/>:text===null?<p className="muted" role="status">{tr('Lecture du fichier…','Reading file…','جارٍ قراءة الملف…')}</p>:<pre className="document-text-preview" dir="auto">{text}</pre>:
     demoPdf?<div className="pdf-sheet" dir="ltr"><div className="pdf-brand">CAMPUSLINK TAZA <span style={{float:'right'}}>S{item.semester}</span></div><h3>{item.title}</h3><p>{item.module} · {partLabel(item.part,language)}</p>{item.author&&<div className="pdf-author">{item.author}</div>}<hr/><h4 style={{fontSize:13,margin:'20px 0 10px'}}>01 — Objectifs de lecture</h4><p>Relire les notions essentielles de ce module et identifier les points à approfondir avec votre enseignant.</p><div className="pdf-lines"/><h4 style={{fontSize:13,marginBottom:10}}>02 — Pour aller plus loin</h4><p>Échangez vos questions et vos méthodes de travail dans le Chat de filière.</p><div className="pdf-lines" style={{height:30}}/><div className="pdf-page-num"><span>Support illustratif · contenu de démonstration</span><span>01</span></div></div>:
     <EmptyState icon={FileText} title={filename} description={tr(`Aperçu ${fileType} indisponible. Téléchargez le fichier pour l’ouvrir avec une application compatible.`,`${fileType} preview unavailable. Download the file to open it in a compatible application.`,`معاينة ${fileType} غير متوفرة. نزّل الملف لفتحه بتطبيق متوافق.`)}/>}
    <span className="pdf-caption">{demoPdf?tr('Aperçu simulé · le téléchargement génère un PDF de démonstration.','Simulated preview · downloading creates a demo PDF.','معاينة تجريبية · التنزيل ينشئ ملف PDF تجريبياً.'):item.localOnly?tr('Fichier sélectionné sur votre appareil · disponible pendant cette session.','File selected on your device · available during this session.','ملف محدد من جهازك · متاح خلال هذه الجلسة.'):null}</span>
   </div>
   <aside className="preview-information"><h3>{t('fileInfo')}</h3><dl>{details.map(([label,value])=><div className="info-row" key={label}><dt>{label}</dt><dd dir="auto">{value||'—'}</dd></div>)}</dl><Button icon={Download} variant="primary" disabled={!item.url&&!demoPdf} onClick={download}>{t('download')}</Button><Button icon={saved?BookmarkCheck:Bookmark} disabled={saving} aria-busy={saving} onClick={()=>saveItem('document',item.id)}>{saving?tr('Enregistrement…','Saving…','جارٍ الحفظ…'):t(saved?'unsave':'save')}</Button><Button icon={fullscreen?Minimize:Maximize} variant="ghost" onClick={()=>setFullscreen(!fullscreen)}>{fullscreen?tr('Réduire','Exit fullscreen','تصغير'):t('fullscreen')}</Button></aside>
  </div>
 </Modal>;
}
function AnnouncementDetail({item}){const {t,tr,language,closeDialog,resources,openDocument,isSaved,isPending,saveItem}=useApp();const navigate=useNavigate();return <Modal title={t('announcement')} onClose={closeDialog} wide><article className="detail-announcement"><Badge className={item.pinned?'badge-blue':''}>{item.pinned?tr('À retenir','Worth knowing','للتذكير'):t('announcements')}</Badge><h3 dir="auto">{item.title}</h3><div style={{display:'flex',alignItems:'center',gap:10}}><Avatar name={item.author} size="sm"/><div style={{fontSize:12}}>{item.author}<p className="muted" style={{fontSize:11}}>{formatDate(item.date,language,{day:'numeric',month:'long',year:'numeric'})}</p></div></div><p className="announcement-content" dir="auto">{item.content}</p><div className="detail-actions"><Button icon={isSaved('announcement',item.id)?BookmarkCheck:Bookmark} disabled={isPending('saved:announcement:'+item.id)} aria-busy={isPending('saved:announcement:'+item.id)} onClick={()=>saveItem('announcement',item.id)}>{isPending('saved:announcement:'+item.id)?tr('Enregistrement…','Saving…','جارٍ الحفظ…'):t(isSaved('announcement',item.id)?'unsave':'save')}</Button><Button icon={MessageSquare} onClick={()=>{closeDialog();navigate(`/app/community?channel=${item.channel||'important'}`);}}>{tr('Voir la discussion associée','View related discussion','عرض النقاش المرتبط')}</Button>{item.resourceId&&<Button icon={FileText} onClick={()=>openDocument(resources.find(d=>d.id===item.resourceId))}>{tr('Consulter le document','View document','عرض المستند')}</Button>}</div></article></Modal>;}
function GlobalSearch(){const {t,tr,resources,announcements,messages,selection,openDocument,openAnnouncement,closeDialog}=useApp();const [query,setQuery]=useState('');const [active,setActive]=useState(0);const inputRef=useRef(null);const navigate=useNavigate();const q=normalizeSearch(query);
 const groups=useMemo(()=>{
  const match=text=>!q||normalizeSearch(text).includes(q);
  const modules=[1,2,3,4,5,6].flatMap(semester=>moduleSuggestions(resources,{...selection,semester}).filter(match).map((name,index)=>({id:`resource-module-${semester}-${index}`,semester,name})));
  return [{label:t('documents'),icon:FileText,items:resources.filter(r=>match(`${r.title} ${r.originalName||''} ${r.module} ${r.author||''} ${r.uploader||''} ${t(r.category)}`)).slice(0,5).map(r=>({id:r.id,title:r.title,meta:`${r.module} · S${r.semester} · ${r.fileType||'PDF'}`,open:()=>openDocument(r)}))},{label:t('module'),icon:BookOpen,items:modules.slice(0,4).map(m=>({id:m.id,title:m.name,meta:`S${m.semester} · ${t('library')}`,open:()=>{closeDialog();navigate(`/app/library?semester=${m.semester}&module=${encodeURIComponent(m.name)}`);}}))},{label:t('announcements'),icon:Megaphone,items:announcements.filter(a=>match(`${a.title} ${a.content}`)).slice(0,3).map(a=>({id:a.id,title:a.title,meta:a.author,open:()=>openAnnouncement(a)}))},{label:t('community'),icon:MessageSquare,items:messages.filter(m=>match(`${m.content} ${m.author} ${(m.attachments||[]).map(a=>a.originalName||a.name||a.title||'').join(' ')} ${m.attachment?.title||''}`)).slice(0,3).map(m=>({id:m.id,title:m.content||(m.attachments||[]).map(a=>a.originalName||a.name||a.title||'').filter(Boolean).join(' · ')||m.attachment?.title||'',meta:m.author,open:()=>{closeDialog();navigate(`/app/community?channel=${m.channel}&message=${m.id}`);}}))}].filter(g=>g.items.length);
 },[q,resources,announcements,messages,selection?.facultyId,selection?.filiereId,t]);
 const flattened=groups.flatMap(g=>g.items);useEffect(()=>{inputRef.current?.focus();},[]);useEffect(()=>setActive(0),[query]);
 function key(e){if(e.key==='ArrowDown'){e.preventDefault();setActive(i=>Math.min(i+1,flattened.length-1));}else if(e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(i-1,0));}else if(e.key==='Enter'&&flattened[active]){e.preventDefault();flattened[active].open();}}
 let index=-1;return <Modal title={t('search')} onClose={closeDialog} className="search-modal"><div className="search-input-row"><Search size={20} className="muted"/><input ref={inputRef} value={query} onKeyDown={key} onChange={e=>setQuery(e.target.value)} aria-label={t('search')} placeholder={t('searchPlaceholder')} aria-controls="global-results" aria-activedescendant={flattened[active]?`result-${flattened[active].id}`:undefined}/></div><div className="search-results" id="global-results">{!q&&<p className="muted" style={{fontSize:11,padding:'0 10px 10px'}}>{tr('Quelques pistes pour commencer. Recherchez dans votre filière.','A few places to start. Search within your programme.','بعض الاقتراحات للبدء. ابحث داخل شعبتك.')}</p>}{groups.length?groups.map(g=><div className="search-group" key={g.label}><div className="search-group-label">{g.label}</div>{g.items.map(item=>{index++;const itemIndex=index;return <button id={`result-${item.id}`} className="search-result" style={active===itemIndex?{background:'var(--accent-soft)'}:undefined} key={item.id} onMouseEnter={()=>setActive(itemIndex)} onClick={item.open}><g.icon size={18}/><div><strong dir="auto">{item.title}</strong><small dir="auto">{item.meta}</small></div><ArrowUpRight size={14} className="muted"/></button>;})}</div>):<EmptyState icon={Search} title={t('empty')} description={tr('Essayez le nom d’un module, d’un document ou un autre mot-clé.','Try a module name, document title, or another keyword.','جرّب اسم وحدة أو مستند أو كلمة مفتاحية أخرى.')}/>}</div><footer className="search-footer"><span>↑ ↓ {tr('Naviguer','Navigate','تنقّل')} <span style={{marginInline:10}}>↵ {t('open')}</span></span><span>Esc {t('close')}</span></footer></Modal>;
}
function ContactDialog(){
 const {t,tr,user,requestSupport,closeDialog}=useApp();
 const [username,setUsername]=useState(user?.username||'');
 const [name,setName]=useState(user?.name||'');
 const [email,setEmail]=useState(user?.email||'');
 const [reason,setReason]=useState('credentials');
 const [message,setMessage]=useState('');
 const [sent,setSent]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const subjects={credentials:tr('Identifiants oubliés','Forgotten credentials','بيانات دخول منسية'),assignment:tr('Correction d’établissement / filière','Faculty / programme correction','تصحيح المؤسسة / الشعبة'),help:tr('Autre question','Another question','سؤال آخر')};
 async function submit(e){
  e.preventDefault();if(busy)return;
  if(!username.trim()||!message.trim()){setError(t('required'));return;}
  setBusy(true);setError('');
  try{await requestSupport({username:username.trim(),name:name.trim()||user?.name,email:email.trim(),reason,subject:subjects[reason],message:message.trim()});setSent(true);}
  catch(error){setError(error.message);}
  finally{setBusy(false);}
 }
 return <Modal title={t('contact')} onClose={()=>{if(!busy)closeDialog();}}>{sent?<EmptyState icon={Check} title={tr('Demande envoyée','Request sent','تم إرسال الطلب')} description={tr('Votre demande a été transmise à l’administration. Elle sera examinée depuis son espace d’assistance.','Your request has been sent to administration for review in its support area.','تم إرسال طلبك إلى الإدارة لمراجعته في فضاء المساعدة.')} action={<Button variant="primary" onClick={closeDialog}>{t('close')}</Button>}/>:<form onSubmit={submit} className="stack" aria-busy={busy}><p className="muted" style={{fontSize:13}}>{tr('Pour vos identifiants ou votre affectation, adressez-vous à l’administration.','Contact administration for credentials or programme corrections.','تواصل مع الإدارة لاسترجاع بياناتك أو تصحيح شعبتك.')}</p><Field label={t('username')}><input required maxLength={100} value={username} onChange={e=>setUsername(e.target.value)} readOnly={!!user} disabled={busy}/></Field>{!user&&<><Field label={tr('Nom complet','Full name','الاسم الكامل')}><input required maxLength={100} autoComplete="name" value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></Field><Field label={tr('Adresse e-mail','Email address','البريد الإلكتروني')}><input required type="email" autoComplete="email" maxLength={160} value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></Field></>}<Field label={tr('Objet de la demande','Request subject','موضوع الطلب')}><Select value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}>{Object.entries(subjects).map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></Field><Field label={tr('Votre message','Your message','رسالتك')} error={error}><textarea required value={message} maxLength={1000} disabled={busy} onChange={e=>setMessage(e.target.value)} placeholder={tr('Décrivez votre demande en quelques mots…','Briefly describe your request…','صف طلبك باختصار…')}/></Field><div style={{display:'flex',justifyContent:'flex-end',gap:10}}><Button type="button" onClick={closeDialog} disabled={busy}>{t('cancel')}</Button><Button type="submit" variant="primary" icon={Send} disabled={busy}>{busy?tr('Envoi…','Sending…','جارٍ الإرسال…'):tr('Envoyer la demande','Send request','إرسال الطلب')}</Button></div></form>}</Modal>;
}

function AnnouncementManage({item,remove=false}){
 const {t,tr,closeDialog,editAnnouncement,deleteAnnouncement,notify}=useApp();
 const [title,setTitle]=useState(item.title),[content,setContent]=useState(item.content),[pinned,setPinned]=useState(item.pinned),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event){event.preventDefault();if(busy)return;setBusy(true);setError('');
  try{if(remove)await deleteAnnouncement(item.id);else await editAnnouncement(item.id,{title:title.trim(),content:content.trim(),pinned});notify(remove?tr('Annonce supprimée.','Announcement deleted.','تم حذف الإعلان.'):tr('Annonce modifiée.','Announcement updated.','تم تعديل الإعلان.'));closeDialog();}
  catch(error){setError(error.message);}finally{setBusy(false);}
 }
 return <Modal title={remove?tr('Supprimer l’annonce','Delete announcement','حذف الإعلان'):tr('Modifier l’annonce','Edit announcement','تعديل الإعلان')} onClose={()=>{if(!busy)closeDialog();}}><form className="stack" onSubmit={submit} aria-busy={busy}>{remove?<p>{tr('Supprimer cette annonce pour tous les étudiants concernés ?','Delete this announcement for all affected students?','حذف هذا الإعلان لجميع الطلاب المعنيين؟')} <strong dir="auto">{item.title}</strong></p>:<><Field label={t('title')}><input value={title} maxLength={160} required disabled={busy} onChange={event=>setTitle(event.target.value)}/></Field><Field label={tr('Contenu','Content','المحتوى')}><textarea value={content} maxLength={4000} rows={6} required disabled={busy} onChange={event=>setContent(event.target.value)}/></Field><label className="setting-row"><span>{tr('Épingler l’annonce','Pin announcement','تثبيت الإعلان')}</span><input type="checkbox" checked={pinned} disabled={busy} onChange={event=>setPinned(event.target.checked)}/></label></>}{error&&<p className="field-error" role="alert">{error}</p>}<div className="detail-actions"><Button type="button" disabled={busy} onClick={closeDialog}>{t('cancel')}</Button><Button type="submit" variant={remove?'danger':'primary'} disabled={busy} aria-busy={busy} icon={remove?Trash2:Check}>{busy?tr('Enregistrement…','Saving…','جارٍ الحفظ…'):remove?tr('Supprimer','Delete','حذف'):t('submit')}</Button></div></form></Modal>;
}

export default function Dialogs(){const {dialog,closeDialog}=useApp();if(!dialog)return null;if(dialog.type==='document')return <DocumentPreview item={dialog.item}/>;if(dialog.type==='announcement')return <AnnouncementDetail item={dialog.item}/>;if(dialog.type==='announcement-edit'||dialog.type==='announcement-delete')return <AnnouncementManage key={dialog.item.id+dialog.type} item={dialog.item} remove={dialog.type==='announcement-delete'}/>;if(dialog.type==='upload')return <UploadModal onClose={closeDialog}/>;if(dialog.type==='search')return <GlobalSearch/>;if(dialog.type==='contact')return <ContactDialog/>;return null;}
