import React,{useState,useEffect,useLayoutEffect,useRef} from 'react';
import {createPortal} from 'react-dom';
import {Link,useNavigate} from 'react-router-dom';
import {X,FileText,FolderOpen,ArrowRight,Search,ArrowUpRight,Mail,CheckCircle2,Flag,Download,Bookmark,MessageSquare,Command,Users,BookOpen,CalendarDays,CornerDownLeft,AlertTriangle,History,Maximize2,Minimize2} from 'lucide-react';
import {useApp} from '../context';
import {api} from '../api';
import {getFiliere} from '../../shared/studies.js';
import {UploadClassificationModal} from './UploadModal';
import {CategoryIcon,EmptyState,Avatar} from './ui';
import {categoryNames,categoryKeys,resourcePath,messagePath,formatBytes,formatDate} from '../utils';
export function ModalHost(){const{modal,closeModal,t}=useApp();const ref=useRef(null);const requestClose=()=>{if(modal?.type==='upload'&&ref.current?.querySelector('form[aria-busy="true"]'))return;closeModal();};useLayoutEffect(()=>{if(!modal)return;const previous=document.activeElement;const focusables=()=>ref.current?.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]):not([hidden]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]');const initial=ref.current?.querySelector('[autofocus],input:not([hidden]),textarea')||focusables()?.[0];initial?.focus();const onKey=e=>{if(e.key==='Escape'){requestClose();}if(e.key==='Tab'){const elements=focusables();if(!elements?.length)return;const first=elements[0],last=elements[elements.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};document.addEventListener('keydown',onKey);const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=overflow;previous?.focus();};},[modal?.type]);if(!modal)return null;const Component={upload:UploadClassificationModal,contact:AdminContactModal,report:ReportModal,preview:ResourcePreviewModal,search:SearchCommandPalette}[modal.type];if(!Component)return null;return createPortal(<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)requestClose();}}><section ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title" className={`modal modal-${modal.type}`}><button className="modal-close icon-button" onClick={requestClose} aria-label={t('close','Fermer')}><X size={20}/></button><Component payload={modal.payload||{}}/></section></div>,document.body);}
function ModalHeading({icon:Icon,title,description}){return <div className="modal-heading">{Icon&&<span className="modal-heading-icon"><Icon size={24} strokeWidth={1.4}/></span>}<h2 id="modal-title">{title}</h2>{description&&<p>{description}</p>}</div>}
export function AdminContactModal({payload}){const{t,user,closeModal}=useApp();const[name,setName]=useState(user?.name||''),[email,setEmail]=useState(''),[subject,setSubject]=useState(payload.recovery?'credentials':'general'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[sent,setSent]=useState(false),[error,setError]=useState('');const submit=async e=>{e.preventDefault();setBusy(true);try{await api('/contact',{method:'POST',body:{name,email,subject,message}});setSent(true);}catch(e){setError(e.message);}finally{setBusy(false);}};return sent?<div className="modal-success"><CheckCircle2 size={45}/><h2 id="modal-title">{t('requestSent','Votre demande a été transmise.')}</h2><p>{t('contactSuccess','L’administration la retrouvera dans son espace de gestion et pourra vous recontacter.')}</p><button className="btn gold-btn" onClick={closeModal}>{t('done','Terminé')}</button></div>:<><ModalHeading icon={Mail} title={t('contactAdministrator',"Contacter l'administrateur")} description={t(payload.recovery?'recoveryDescription':'contactDescription',payload.recovery?'Un problème d’accès ? Votre administration est là pour vous aider.':'Une question, une demande ? Écrivez à l’équipe de votre faculté.')}/><form onSubmit={submit}>{!user&&<label className="field">{t('fullName','Nom complet')}<input required value={name} onChange={e=>setName(e.target.value)} autoComplete="name"/></label>}<label className="field">{t('contactEmail','E-mail de contact')}<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" placeholder="vous@exemple.ma"/></label><label className="field">{t('subject','Objet')}<select aria-label={t('subject','Objet')} value={subject} onChange={e=>setSubject(e.target.value)}>{[['general','generalQuestion','Question générale'],['credentials','forgotAccess','Identifiants oubliés'],['faculty','facultyCorrection','Correction de faculté'],['resource','resourceIssue','Problème de ressource']].map(([value,key,label])=><option value={value} key={value}>{t(key,label)}</option>)}</select></label><label className="field">{t('yourMessage','Votre message')}<textarea required rows={4} value={message} onChange={e=>setMessage(e.target.value)} maxLength={3000} placeholder={t('describeRequest','Décrivez votre demande…')}/></label>{error&&<p role="alert" className="form-error">{t(error,error)}</p>}<button className="btn gold-btn full" disabled={busy}>{t(busy?'sending':'sendRequest',busy?'Envoi en cours…':'Envoyer ma demande')}<ArrowRight size={16}/></button></form></>}
export function ReportModal({payload}){const{t,toast,closeModal}=useApp();const[reason,setReason]=useState('inappropriate'),[details,setDetails]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const submit=async e=>{e.preventDefault();setBusy(true);try{await api('/reports',{method:'POST',body:{...payload,reason,details}});toast(t('reportSent','Signalement transmis à la modération.'));closeModal();}catch(e){setError(e.message);}finally{setBusy(false);}};return <><ModalHeading icon={Flag} title={t('reportContent','Signaler un contenu')} description={t('reportDescription','Aidez-nous à garder un espace fiable et respectueux.')}/><form onSubmit={submit}><label className="field">{t('reason','Motif')}<select aria-label={t('reason','Motif')} value={reason} onChange={e=>setReason(e.target.value)}>{[['inappropriate','inappropriate','Contenu inapproprié'],['incorrect','incorrectResource','Ressource incorrecte'],['duplicate','duplicateFile','Fichier en double'],['classification','wrongClassification','Mauvais semestre ou catégorie'],['broken','brokenFile','Fichier inaccessible']].map(([v,key,label])=><option value={v} key={v}>{t(key,label)}</option>)}</select></label><label className="field">{t('detailsOptional','Précisions (facultatif)')}<textarea rows={4} value={details} onChange={e=>setDetails(e.target.value)} maxLength={2000} placeholder={t('helpModerators','Quelques détails pour aider l’équipe de modération…')}/></label>{error&&<p role="alert" className="form-error">{t(error,error)}</p>}<button className="btn gold-btn full" disabled={busy}>{t(busy?'sending':'sendReport',busy?'Envoi en cours…':'Envoyer le signalement')}<Flag size={15}/></button></form></>}
export function ResourcePreviewModal({payload:r}){
  const{t,lang,data,openModal,closeModal,refresh,saved,toggleSave,toast}=useApp();
  const[documentText,setDocumentText]=useState('');
  const[documentError,setDocumentError]=useState('');
  const[documentLoading,setDocumentLoading]=useState(false);
  const[fullscreen,setFullscreen]=useState(false);
  const previewRef=useRef(null);

  useEffect(()=>{
    const onFullscreenChange=()=>setFullscreen(document.fullscreenElement===previewRef.current);
    document.addEventListener('fullscreenchange',onFullscreenChange);
    return()=>document.removeEventListener('fullscreenchange',onFullscreenChange);
  },[]);

  useEffect(()=>{
    if(r.mime!=='text/plain')return;
    const controller=new AbortController();
    setDocumentLoading(true);
    setDocumentError('');
    fetch(`/api/files/${r.id}`,{signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw new Error(t('documentUnavailable','Ce document est indisponible.'));
        return response.text();
      })
      .then(text=>{
        setDocumentText(text.slice(0,200000));
        refresh().catch(()=>{});
      })
      .catch(e=>{if(e.name!=='AbortError')setDocumentError(e.message);})
      .finally(()=>setDocumentLoading(false));
    return()=>controller.abort();
  },[r.id,r.mime]);

  const isSaved=saved.some(s=>s.type==='resource'&&String(s.id)===String(r.id));
  const discussion=r.message_id?((data?.messages||[]).find(m=>m.id===r.message_id)||{id:r.message_id,channel:r.channel,semester:r.chat_semester}):null;
  const filiereName=getFiliere(r.filiere_id)?.name;
  const related=data?.resources.filter(x=>x.id!==r.id&&x.module===r.module&&x.category!==r.category).slice(0,3)||[];

  const toggleFullscreen=async()=>{
    try{
      if(document.fullscreenElement===previewRef.current){
        await document.exitFullscreen?.();
      }else{
        await previewRef.current?.requestFullscreen?.();
      }
    }catch{
      toast(t('fullscreenUnavailable',"Le plein écran n’est pas disponible sur cet appareil."),'error');
    }
  };

  return <>
    <div className="preview-modal-heading">
      <CategoryIcon category={r.category}/>
      <div>
        <span className="section-label">{t(r.category,categoryNames[r.category])} {r.semester?`· S${r.semester}`:''} · {r.module}{r.part_number?` · ${t('resourcePart','Partie')} ${r.part_number}`:''}</span>
        <h2 id="modal-title">{r.title}</h2>
        {r.relative_path&&<div className="resource-folder-path"><FolderOpen size={14}/><span dir="auto">{r.relative_path}</span></div>}
        {filiereName&&<p className="preview-study-meta"><bdi>{filiereName}</bdi>{r.resource_type&&['td','tp','correction','image','pdf','document','other'].includes(r.resource_type)&&<> · {t(({td:'resourceTD',tp:'resourceTP',correction:'resourceCorrection',image:'resourceImage',pdf:'resourcePDF',document:'resourceDocument',other:'resourceOther'})[r.resource_type],r.resource_type.toUpperCase())}</>}</p>}
        {r.teacher_name&&<p className="preview-study-meta">{t('resourceTeacher','Professeur / auteur')} · <bdi>{r.teacher_name}</bdi></p>}
        <p>{r.author?.name} · {formatDate(r.created_at,lang,{year:'numeric'})} · {formatBytes(r.size,lang)}</p>
      </div>
    </div>

    <div ref={previewRef} className={`document-preview ${fullscreen?'is-fullscreen':''}`}>
      {r.mime==='text/plain'
        ?(documentLoading
          ?<div className="loader" role="status" aria-label={t('loading','Chargement…')}/>
          :documentError
            ?<EmptyState icon={FileText} title={documentError}/>
            :<pre className="text-document">{documentText}</pre>)
        :r.mime?.includes('image')
          ?<img src={`/api/files/${r.id}`} alt={r.title} onLoad={()=>refresh().catch(()=>{})}/>
          :r.mime==='application/pdf'
            ?<iframe onLoad={()=>refresh().catch(()=>{})} title={r.title} src={`/api/files/${r.id}#toolbar=1&navpanes=0&view=FitH`}/>
            :<EmptyState icon={FileText} title={t('documentReady','Votre document est prêt.')} description={t('downloadToRead','Téléchargez-le pour le lire dans votre application habituelle.')}/>}
      {r.mime==='application/pdf'&&<button type="button" className="preview-fullscreen-button" onClick={toggleFullscreen} aria-label={t(fullscreen?'exitFullScreen':'fullScreen',fullscreen?'Quitter le plein écran':'Plein écran')}>{fullscreen?<Minimize2 size={16}/>:<Maximize2 size={16}/>}<span>{t(fullscreen?'exitFullScreen':'fullScreen',fullscreen?'Quitter le plein écran':'Plein écran')}</span></button>}
    </div>

    <div className="preview-actions">
      <a className="btn gold-btn" href={`/api/files/${r.id}?download=1`} download={r.filename}><Download size={15}/>{t('download','Télécharger')}</a>
      {discussion&&<Link to={messagePath(discussion)} className="btn outline" onClick={closeModal}><MessageSquare size={15}/>{t('viewDiscussion','Voir la discussion')}</Link>}
      <button className={`btn outline ${isSaved?'is-saved':''}`} onClick={()=>toggleSave('resource',r.id).catch(e=>toast(e.message,'error'))}><Bookmark size={15} fill={isSaved?'currentColor':'none'}/>{t(isSaved?'saved':'save',isSaved?'Enregistré':'Enregistrer')}</button>
      <button className="btn outline preview-close-action" onClick={closeModal}><X size={15}/>{t('close','Fermer')}</button>
      <button className="icon-button" onClick={()=>openModal('report',{target_type:'resource',target_id:r.id})} aria-label={t('report','Signaler')}><Flag size={16}/></button>
    </div>

    {r.version>1&&<div className="version-history"><History size={14}/>{t('updatedVersion','Version mise à jour')} · v{r.version}{r.versions?.map(v=><span key={v.id||v.version}>{formatDate(v.created_at,lang)} · v{v.version}</span>)}</div>}
    {related.length>0&&<div className="related-resources"><span className="section-label">{t('keepLearning','POUR ALLER PLUS LOIN')}</span>{related.map(x=><Link key={x.id} to={resourcePath(x)} onClick={()=>openModal('preview',x)}><CategoryIcon category={x.category} size={16}/><span>{x.title}<small>{t(x.category,categoryNames[x.category])} · S{x.semester}</small></span><ArrowUpRight size={14}/></Link>)}</div>}
  </>;
}

export function SearchCommandPalette({payload}){const{t,openModal,closeModal,data}=useApp();const navigate=useNavigate();const[query,setQuery]=useState(''),[type,setType]=useState(payload.type||''),[semester,setSemester]=useState(''),[results,setResults]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[active,setActive]=useState(0);const commands=[{title:t('goCourses','Aller aux cours'),path:'/app/resources/courses',icon:BookOpen},{title:t('openAnnouncements','Ouvrir les annonces'),path:'/app/announcements',icon:MessageSquare},{title:t('openSaved','Retrouver mes enregistrés'),path:'/app/saved',icon:Bookmark},{title:t('calendar','Calendrier'),path:'/app/calendar',icon:CalendarDays},{title:t('contactAdmin',"Contacter l'admin"),action:()=>openModal('contact'),icon:Mail}];useEffect(()=>{if(!query.trim()&&!type&&!semester){setResults([]);return;}let canceled=false;const timeout=setTimeout(async()=>{setBusy(true);try{const params=new URLSearchParams({q:query,type,semester});const r=await api(`/search?${params}`);if(!canceled){setResults(r.results);setError('');setActive(0);}}catch(e){if(!canceled)setError(e.message);}finally{if(!canceled)setBusy(false);}},200);return()=>{canceled=true;clearTimeout(timeout);};},[query,type,semester]);const searching=query.trim()||type||semester;const items=searching?results:commands;const select=item=>{if(item.action){item.action();return;}closeModal();navigate(item.path);};return <div className="command-palette"><div className="command-input"><Search size={22}/><input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('commandSearch','Que recherchez-vous ?')} aria-label={t('search','Rechercher')} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setActive(i=>Math.min(i+1,items.length-1));}if(e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(i-1,0));}if(e.key==='Enter'&&items[active])select(items[active]);}}/><kbd>ESC</kbd></div><h2 id="modal-title" className="sr-only">{t('globalSearch','Recherche globale')}</h2><div className="command-filters"><select value={type} onChange={e=>setType(e.target.value)} aria-label={t('type','Type')}><option value="">{t('allTypes','Tous les types')}</option>{[['message','Messages'],...categoryKeys.map(c=>[c,categoryNames[c]]),['announcement','Annonces'],['member','Membres']].map(([v,label])=><option key={v} value={v}>{t(v,label)}</option>)}</select><select value={semester} onChange={e=>setSemester(e.target.value)} aria-label={t('semester','Semestre')}><option value="">{t('allSemesters','Tous les semestres')}</option>{[1,2,3,4,5,6].map(s=><option key={s} value={s}>S{s}</option>)}</select><button onClick={()=>{closeModal();navigate(`/app/search?q=${encodeURIComponent(query)}`);}}>{t('advancedSearch','Recherche avancée')}<ArrowUpRight size={12}/></button></div><div className="command-results"><span className="section-label">{t(searching?'searchResults':'quickCommands',searching?'RÉSULTATS':'ACCÈS RAPIDE')}{busy&&' …'}</span>{error&&<p className="form-error">{t(error,error)}</p>}{items.length?items.slice(0,18).map((item,i)=>{const Icon=item.icon||({message:MessageSquare,member:Users,announcement:MessageSquare}[item.type])||FileText;return <button key={`${item.type||'cmd'}-${item.id||i}`} className={'command-result '+(active===i?'active':'')} onMouseEnter={()=>setActive(i)} onClick={()=>select(item)}><span className="command-result-icon"><Icon size={18}/></span><span><b>{item.title}</b>{item.context&&<small>{item.context}</small>}</span><ArrowUpRight size={15}/></button>}):!busy&&<EmptyState icon={Search} title={t('noSearchResults','Aucun résultat trouvé.')} description={t('tryOtherKeywords','Essayez un autre mot-clé ou ajustez vos filtres.')}/>}</div><footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd>{t('navigate','Naviguer')}</span><span><CornerDownLeft size={12}/>{t('open','Ouvrir')}</span><span>CampusLink Taza</span></footer></div>}
