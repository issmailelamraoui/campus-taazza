import React,{useEffect,useRef,useState} from 'react';
import {Download,Image as ImageIcon,Paperclip,RefreshCw,Upload,X} from 'lucide-react';
import {api} from '../api.js';
import {useApp} from '../context';
import {SUPPORTED_FILE_ACCEPT,MAX_UPLOAD_FILE_BYTES,fileKey,isSupportedFile,sizeLabel} from '../lib/files.js';
import {Button,Field} from './ui';
import './forum-attachments.css';

const DEFAULT_LIMITS={maxFiles:5,maxFileBytes:MAX_UPLOAD_FILE_BYTES,maxTotalBytes:50*1024*1024};
const RASTER_MIMES=new Set(['image/png','image/jpeg','image/webp','image/gif']);

export default function ForumAttachments({questionId}){
 const {user,tr}=useApp();
 const [data,setData]=useState(null),[queue,setQueue]=useState([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState(null),[opened,setOpened]=useState(new Set()),[imageErrors,setImageErrors]=useState(new Set());
 const epoch=useRef(0),readSequence=useRef(0),readController=useRef(null),writeController=useRef(null),lock=useRef(false),halted=useRef(false),fileInput=useRef(null);
 const path='/campus/forum/'+questionId+'/attachments';
 const items=data?.attachments||[],limits={...DEFAULT_LIMITS,...data?.limits};

 async function refresh(preserveError=false){
  if(halted.current)return;
  const owner=epoch.current,sequence=++readSequence.current,controller=new AbortController();
  readController.current?.abort();readController.current=controller;setLoading(true);if(!preserveError)setError('');
  try{
   const result=await api(path,{signal:controller.signal});
   if(owner===epoch.current&&sequence===readSequence.current&&!halted.current){setData(result);return result;}
  }catch(e){
   if(owner===epoch.current&&sequence===readSequence.current&&!controller.signal.aborted&&!halted.current){setData(null);if(!preserveError)setError(e.message);}
  }finally{if(owner===epoch.current&&sequence===readSequence.current&&!halted.current)setLoading(false);}
 }

 useEffect(()=>{
  epoch.current++;halted.current=false;lock.current=false;setData(null);setQueue([]);setOpened(new Set());setImageErrors(new Set());setBusy(false);setProgress(null);setError('');refresh();
  const clear=()=>{epoch.current++;halted.current=true;readSequence.current++;readController.current?.abort();writeController.current?.abort();lock.current=false;setData(null);setQueue([]);setOpened(new Set());setImageErrors(new Set());setBusy(false);setLoading(false);setProgress(null);setError('');if(fileInput.current)fileInput.current.value='';};
  window.addEventListener('campus-session-cleared',clear);
  return()=>{epoch.current++;halted.current=true;readSequence.current++;readController.current?.abort();writeController.current?.abort();window.removeEventListener('campus-session-cleared',clear);};
 },[questionId,user.id,user.facultyId,user.filiereId,user.faculty_id,user.filiere_id]);

 function chooseFiles(event){
  if(lock.current||halted.current)return;
  const selected=Array.from(event.target.files||[]),keys=new Set(queue.map(item=>fileKey(item.file))),next=[...queue];
  event.target.value='';setError('');
  for(const file of selected){
   if(!isSupportedFile(file)||!file.size||file.size>limits.maxFileBytes){setError(tr(`Choisissez des fichiers pris en charge de ${Math.round(limits.maxFileBytes/1024/1024)} Mo maximum chacun.`,`Choose supported files up to ${Math.round(limits.maxFileBytes/1024/1024)} MB each.`,`اختر ملفات مدعومة لا يتجاوز كل منها ${Math.round(limits.maxFileBytes/1024/1024)} ميغابايت.`));return;}
   const key=fileKey(file);if(!keys.has(key)){keys.add(key);next.push({file,clientId:crypto.randomUUID()});}
  }
  if(items.length+next.length>limits.maxFiles){setError(tr(`Maximum ${limits.maxFiles} pièces jointes par question.`,`Up to ${limits.maxFiles} attachments per question.`,`حتى ${limits.maxFiles} مرفقات لكل سؤال.`));return;}
  if(items.reduce((sum,item)=>sum+Number(item.size||0),0)+next.reduce((sum,item)=>sum+item.file.size,0)>limits.maxTotalBytes){setError(tr(`Les pièces jointes dépassent la limite de ${Math.round(limits.maxTotalBytes/1024/1024)} Mo par question.`,`Attachments exceed the ${Math.round(limits.maxTotalBytes/1024/1024)} MB limit per question.`,`تتجاوز المرفقات حد ${Math.round(limits.maxTotalBytes/1024/1024)} ميغابايت لكل سؤال.`));return;}
  setQueue(next);
 }

 async function upload(event){
  event.preventDefault();if(lock.current||halted.current||!data?.can_upload||!queue.length)return;
  lock.current=true;setBusy(true);setError('');const owner=epoch.current,selected=[...queue],controller=new AbortController();let currentFile=null;writeController.current=controller;
  try{
   for(let index=0;index<selected.length;index++){
    if(owner!==epoch.current||halted.current)return;
    const item=selected[index];currentFile=item;setProgress({completed:index,total:selected.length,filename:item.file.name});
    const body=new FormData();body.set('file',item.file);body.set('client_id',item.clientId);
    await api(path,{method:'POST',body,signal:controller.signal,timeout:60000});
    if(owner!==epoch.current||halted.current)return;
    setQueue(current=>current.filter(value=>value.clientId!==item.clientId));
    setProgress({completed:index+1,total:selected.length,filename:item.file.name});
    await refresh();
   }
  }catch(e){if(owner===epoch.current&&!halted.current&&!controller.signal.aborted){if(e.data?.code==='ATTACHMENT_RETRY_REQUIRED'&&currentFile)setQueue(current=>current.map(value=>value.clientId===currentFile.clientId?{...value,clientId:crypto.randomUUID()}:value));setError(e.message);await refresh(true);}}
  finally{if(owner===epoch.current&&!halted.current){lock.current=false;setBusy(false);setProgress(null);}}
 }

 async function remove(item){
  if(lock.current||halted.current||!item.can_delete)return;
  lock.current=true;setBusy(true);setError('');const owner=epoch.current,controller=new AbortController();writeController.current=controller;
  try{await api(path+'/'+item.id,{method:'DELETE',signal:controller.signal});if(owner===epoch.current&&!halted.current){setOpened(current=>new Set([...current].filter(id=>id!==item.id)));await refresh();}}
  catch(e){if(owner===epoch.current&&!halted.current&&!controller.signal.aborted){setError(e.message);await refresh(true);}}
  finally{if(owner===epoch.current&&!halted.current){lock.current=false;setBusy(false);}}
 }

 return<section className="forum-attachments" aria-label={tr('Pièces jointes de la question','Question attachments','مرفقات السؤال')}>
  <div className="forum-attachments-heading"><h3><Paperclip size={17}/>{tr('Pièces jointes','Attachments','المرفقات')}{data&&` (${items.length})`}</h3><Button icon={RefreshCw} variant="ghost" disabled={busy||loading||halted.current} onClick={()=>refresh()}>{tr('Actualiser les fichiers','Refresh files','تحديث الملفات')}</Button></div>
  {loading&&!data&&<p role="status">{tr('Chargement des fichiers…','Loading files…','تحميل الملفات…')}</p>}
  {data&&!items.length&&<p className="muted">{tr('Aucune pièce jointe.','No attachments.','لا توجد مرفقات.')}</p>}
  {!!items.length&&<ul className="forum-attachment-list">{items.map(item=><li key={item.id}>
   <div className="forum-attachment-row"><span className="forum-attachment-name"><strong dir="auto">{item.filename}</strong><small>{sizeLabel(Number(item.size||0))}</small></span><a className="btn btn-secondary" href={item.url+(item.url.includes('?')?'&':'?')+'download=1'} download aria-label={tr(`Télécharger ${item.filename}`,`Download ${item.filename}`,`تنزيل ${item.filename}`)}><Download size={15}/>{tr('Télécharger','Download','تنزيل')}</a>
    {RASTER_MIMES.has(item.mime)&&<Button icon={ImageIcon} variant="ghost" disabled={busy} aria-expanded={opened.has(item.id)} onClick={()=>{setImageErrors(current=>new Set([...current].filter(id=>id!==item.id)));setOpened(current=>{const next=new Set(current);next.has(item.id)?next.delete(item.id):next.add(item.id);return next;});}}>{opened.has(item.id)?tr('Masquer l’image','Hide image','إخفاء الصورة'):tr('Afficher l’image','Show image','عرض الصورة')}</Button>}
    {item.can_delete&&<Button icon={X} variant="ghost" disabled={busy} aria-label={tr(`Retirer ${item.filename}`,`Remove ${item.filename}`,`إزالة ${item.filename}`)} onClick={()=>remove(item)}>{tr('Retirer','Remove','إزالة')}</Button>}
   </div>
   {opened.has(item.id)&&RASTER_MIMES.has(item.mime)&&(imageErrors.has(item.id)?<p className="field-error" role="alert">{tr('Image indisponible. Actualisez les fichiers pour vérifier votre accès.','Image unavailable. Refresh files to check access.','الصورة غير متاحة. حدّث الملفات للتحقق من الوصول.')}</p>:<img className="forum-attachment-image" src={item.url} alt={item.filename} onError={()=>setImageErrors(current=>new Set([...current,item.id]))}/>)}
  </li>)}</ul>}
  {data?.can_upload&&<form className="forum-attachment-form" onSubmit={upload} aria-busy={busy}>
   <Field label={tr('Ajouter des fichiers à ma question','Add files to my question','إضافة ملفات إلى سؤالي')} hint={tr(`${limits.maxFiles} fichiers maximum, ${Math.round(limits.maxFileBytes/1024/1024)} Mo chacun, ${Math.round(limits.maxTotalBytes/1024/1024)} Mo au total.`,`${limits.maxFiles} files maximum, ${Math.round(limits.maxFileBytes/1024/1024)} MB each, ${Math.round(limits.maxTotalBytes/1024/1024)} MB total.`,`${limits.maxFiles} ملفات كحد أقصى، ${Math.round(limits.maxFileBytes/1024/1024)} ميغابايت لكل ملف و${Math.round(limits.maxTotalBytes/1024/1024)} ميغابايت إجمالاً.`)}><input ref={fileInput} type="file" multiple accept={SUPPORTED_FILE_ACCEPT} disabled={busy||loading||items.length>=limits.maxFiles} onChange={chooseFiles}/></Field>
   {!!queue.length&&<ul className="forum-attachment-queue">{queue.map(item=><li key={item.clientId}><span dir="auto">{item.file.name} · {sizeLabel(item.file.size)}</span><button type="button" className="icon-btn" disabled={busy} aria-label={tr(`Enlever la sélection ${item.file.name}`,`Remove selected ${item.file.name}`,`إزالة الملف المحدد ${item.file.name}`)} onClick={()=>setQueue(current=>current.filter(value=>value.clientId!==item.clientId))}><X size={15}/></button></li>)}</ul>}
   <Button icon={Upload} type="submit" variant="primary" disabled={busy||loading||!queue.length}>{busy?tr('Envoi en cours…','Uploading…','جارٍ الإرسال…'):tr('Joindre les fichiers sélectionnés','Attach selected files','إرفاق الملفات المحددة')}</Button>
   {progress&&<p role="status">{progress.completed} / {progress.total} · <bdi>{progress.filename}</bdi></p>}
  </form>}
  {error&&<p className="field-error" role="alert">{error}</p>}
 </section>;
}
