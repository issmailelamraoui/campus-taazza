import {requestId} from '../lib/identifiers';
import {getFiliere} from '../data/studies';
import PageLoading from '../components/PageLoading';
import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { MessageSquare, Plus, Send, ArrowLeft, Lock, Paperclip, Download, RefreshCw, ThumbsUp, Heart, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../i18n';
import { useApp } from '../context';
import { PageHeader, Button, Field, EmptyState, Badge, Avatar, Modal } from '../components/ui';
import { Select } from '../components/Select';
import { SUPPORTED_FILE_ACCEPT, MAX_UPLOAD_FILE_BYTES, isSupportedFile } from '../lib/files';
import './campus.css';
import './feedback.css';

const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export default function FeedbackPage() {
  const { user, selection, tr, language, notify, isAdmin, notificationDestinationViewed, notificationVisitRevision } = useApp();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location=useLocation();
  const focusedReply=useRef(null);
  const administrative = isAdmin && params.get('admin') === '1';
  const prefix = administrative ? '/admin/feedback' : '/feedback';
  const ticketId = params.get('ticket');
  const academicScope = `${user.id}:${selection?.facultyId || user.facultyId || ''}:${selection?.filiereId || user.filiereId || ''}`;
  const destination = `${academicScope}:${prefix}:${ticketId || ''}`;
  const destinationRef = useRef(destination);
  destinationRef.current = destination;
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState(false);
  const [confirmDelete,setConfirmDelete]=useState(false),[deletedDestination,setDeletedDestination]=useState(null),[deleteError,setDeleteError]=useState('');
  const [revision, setRevision] = useState(0);
  const [category, setCategory] = useState('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState('reviewing');
  const [attachmentError, setAttachmentError] = useState('');
  const [uploadName, setUploadName] = useState('');
  const mutation = useRef(null),mutationVersion=useRef(0),lastServerStatus=useRef(null);
  const replyRequest=useRef(null),createRequest=useRef(null);
  const fileInput = useRef(null);
  const data = payload?.destination === destination ? payload.data : null;
  const ticketRemoved=deletedDestination===destination;
  const ticket = ticketId&&!ticketRemoved ? data?.ticket : null;
  const closed=!!ticket?.closed_at||['closed','resolved','done'].includes(ticket?.status);
  const canDelete=administrative&&ticket?.can_delete===true;
  useEffect(()=>{
    const match=/^#reply-(\d+)$/.exec(location.hash);
    const key=`${destination}:${location.hash}:${notificationVisitRevision}`;
    if(!match||!ticket?.replies?.some(item=>String(item.id)===match[1])||focusedReply.current===key)return;
    const frame=requestAnimationFrame(()=>{
      const node=document.getElementById('reply-'+match[1]);if(!node)return;
      focusedReply.current=key;node.scrollIntoView({block:'center',behavior:'instant'});node.focus({preventScroll:true});
    });return()=>cancelAnimationFrame(frame);
  },[destination,location.hash,ticket?.replies?.length,notificationVisitRevision]);
  const tickets = data?.tickets || [];
  const files = ticket?.attachments || [];
  const bytes = files.reduce((total, file) => total + Number(file.size || 0), 0);

  useEffect(() => {
    mutation.current = null;
    setBusy(false);
    setReply('');
    setStatus('reviewing');lastServerStatus.current=null;
    setAttachmentError('');
    setUploadName('');
    if (ticketId) setCreate(false);
    setConfirmDelete(false);
    return () => { mutation.current = null; };
  }, [destination]);

  useEffect(() => {
    setCreate(false);
    setTitle('');
    setDescription('');
    setCategory('bug');
  }, [academicScope]);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;const version=mutationVersion.current;
    setLoading(true);
    setError('');
    api(ticketId ? `${prefix}/${ticketId}` : '/feedback', { signal: controller.signal })
      .then(result => {
        if (!live || destinationRef.current !== destination || mutation.current || version!==mutationVersion.current) return;
        setPayload({ destination, data: result });
        if (ticketId) {
          const previousStatus=lastServerStatus.current;setStatus(current=>previousStatus===null||current===previousStatus?result.ticket.status:current);lastServerStatus.current=result.ticket.status;
          notificationDestinationViewed('feedback', ticketId);
        }
      })
      .catch(e => {
        if (live && !controller.signal.aborted && version===mutationVersion.current) {
          if(e.status===404&&ticketId){setDeletedDestination(destination);setPayload(null);setError('');return;}
          if ([401, 403, 404, 410].includes(e.status)) setPayload(null);
          setError(e.message);
        }
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [destination, revision]);

  useEffect(() => {
    const update=event=>{
      const change=event?.detail;if(change?.presence||change?.messageIds||change?.discussionReads)return;
      if(ticketId&&String(change?.removedFeedbackId)===ticketId){
        if(mutation.current?.removing)return;
        mutationVersion.current++;mutation.current=null;setBusy(false);setConfirmDelete(false);setDeletedDestination(destination);setPayload(null);setReply('');setError('');return;
      }
      if(document.visibilityState!=='hidden')setRevision(value=>value+1);
    };
    window.addEventListener('campus-live-update',update);
    const timer=setInterval(update,15000);
    return()=>{window.removeEventListener('campus-live-update',update);clearInterval(timer);};
  },[destination]);

  const statusLabel = value => ({
    open: tr('Reçue', 'Received', 'مستلمة'), received: tr('Reçue', 'Received', 'مستلمة'),
    reviewing: tr('En cours d’examen', 'Under review', 'قيد المراجعة'),
    accepted: tr('Acceptée', 'Accepted', 'مقبولة'), planned: tr('Prévue', 'Planned', 'مخططة'),
    done: tr('Réalisée', 'Completed', 'منجزة'), resolved: tr('Réalisée', 'Completed', 'منجزة'),
    closed: tr('Clôturée', 'Closed', 'مغلقة'), declined: tr('Refusée', 'Declined', 'مرفوضة'),
  }[value] || value);
  const categoryLabel = value => ({
    bug: tr('Problème', 'Issue', 'مشكلة'), feature: tr('Nouvelle fonctionnalité', 'New feature', 'ميزة جديدة'),
    improvement: tr('Amélioration', 'Improvement', 'تحسين'), concern: tr('Préoccupation', 'Concern', 'ملاحظة مهمة'),
  }[value] || value);
  const dateLabel = value => value && !Number.isNaN(Date.parse(value)) ? formatDate(value, language, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca',
  }) : '';
  const sizeLabel = size => {
    const bytes = Number(size || 0), small = bytes < 1024 * 1024;
    return new Intl.NumberFormat(language === 'ar' ? 'ar-MA' : language === 'en' ? 'en-GB' : 'fr-FR', {
      maximumFractionDigits: 1,
    }).format(small ? Math.max(1, bytes / 1024) : bytes / 1024 / 1024) + ' ' + (small ? tr('Ko', 'KB', 'كيلوبايت') : tr('Mo', 'MB', 'ميغابايت'));
  };

  function beginMutation() {
    if (mutation.current) return null;
    const operation = { destination };
    mutationVersion.current++;mutation.current = operation;
    setBusy(true);
    return operation;
  }
  const currentMutation = operation => mutation.current === operation && destinationRef.current === operation.destination;
  function endMutation(operation) {
    if (currentMutation(operation)) { mutationVersion.current++;mutation.current = null; setBusy(false); }
  }
  async function ticketAction(suffix,body){
    const operation=beginMutation();if(!operation)return;
    try{const result=await api(suffix.startsWith('/')?suffix:`${prefix}/${ticketId}/${suffix}`,{method:'POST',body});if(currentMutation(operation)){setPayload({destination,data:result});setStatus(result.ticket.status);}}
    catch(e){if(currentMutation(operation))setError(e.message);}finally{endMutation(operation);}
  }
  async function deleteConversation(){
    if(!canDelete)return;
    const operation=beginMutation();if(!operation)return;operation.removing=true;setError('');setDeleteError('');
    try{
      try{await api(`/admin/feedback/${ticketId}`,{method:'DELETE'});}catch(failure){if(failure.status!==404)throw failure;}
      if(!currentMutation(operation))return;
      setConfirmDelete(false);setPayload(null);setReply('');
      notify(tr('Conversation et fichiers supprimés.','Conversation and files deleted.','تم حذف المحادثة وملفاتها.'));
      navigate('/app/admin?tab=assistance');
    }catch(failure){if(currentMutation(operation)){setDeleteError(failure.message);setRevision(value=>value+1);}}
    finally{endMutation(operation);}
  }
  async function submit(event) {
    event.preventDefault();
    if (ticketId ? !reply.trim() : !title.trim() || !description.trim()) return;
    const operation = beginMutation();
    if (!operation) return;
    try {
      if (ticketId) {
        const submittedReply = reply;
        if(replyRequest.current?.content!==reply.trim()||replyRequest.current?.destination!==destination)replyRequest.current={content:reply.trim(),destination,id:requestId()};
        const result = await api(`${prefix}/${ticketId}/replies`, {
          method: 'POST', body: { content: reply.trim(), client_id:replyRequest.current.id, ...(administrative && status !== ticket?.status ? { status } : {}) },
        });
        if (!currentMutation(operation)) return;
        replyRequest.current=null;setReply(current => current === submittedReply ? '' : current);
        if (result.ticket) {
          setPayload({ destination, data: result });
          setStatus(result.ticket.status);
        } else setRevision(value => value + 1);
      } else {
        const signature=JSON.stringify([title.trim(),description.trim(),category]);
        if(createRequest.current?.signature!==signature)createRequest.current={signature,id:requestId()};
        const result = await api('/feedback', { method: 'POST', body: { client_id:createRequest.current.id, category, title: title.trim(), description: description.trim() } });
        if (!currentMutation(operation)) return;
        setCreate(false); setTitle(''); setDescription('');
        setParams({ ticket: result.ticket.id });
      }
      notify(tr('Message enregistré.', 'Message saved.', 'تم حفظ الرسالة.'));
    } catch (e) { if (currentMutation(operation)) notify(e.message, 'error'); }
    finally { endMutation(operation); }
  }
  async function attach(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !ticket) return;
    setAttachmentError('');
    if (!isSupportedFile(file) || !file.size || file.size > MAX_UPLOAD_FILE_BYTES) {
      setAttachmentError(tr('Choisissez un fichier pris en charge, non vide, de 20 Mo maximum.', 'Choose a supported, non-empty file up to 20 MB.', 'اختر ملفاً مدعوماً وغير فارغ لا يتجاوز 20 ميغابايت.'));
      return;
    }
    if (files.length >= MAX_FILES || bytes + file.size > MAX_TOTAL_BYTES) {
      setAttachmentError(tr('Maximum 5 fichiers et 50 Mo au total par demande.', 'Up to 5 files and 50 MB total per request.', 'حتى 5 ملفات و50 ميغابايت إجمالاً لكل طلب.'));
      return;
    }
    const operation = beginMutation();
    if (!operation) return;
    setUploadName(file.name);
    try {
      const form = new FormData(); form.append('file', file);
      const result = await api(`/feedback/${ticketId}/attachments`, { method: 'POST', body: form, timeout: 600000 });
      if (!currentMutation(operation)) return;
      if (result.attachment) setPayload(previous => previous?.destination === destination ? {
        destination, data: { ticket: { ...previous.data.ticket, attachments: [...(previous.data.ticket.attachments || []), result.attachment] } },
      } : previous);
      else setRevision(value => value + 1);
      notify(tr('Fichier joint.', 'File attached.', 'تم إرفاق الملف.'));
    } catch (e) { if (currentMutation(operation)) setAttachmentError(e.message); }
    finally { if (currentMutation(operation)) setUploadName(''); endMutation(operation); }
  }

  const authorName = ticket?.name || ticket?.author?.name || ticket?.user?.name || (!administrative ? user.name : '') || tr('Étudiant', 'Student', 'طالب');
  const authorEmail = ticket?.email || ticket?.author?.email || '';
  return <div className="feedback-page">
    <PageHeader eyebrow={tr('ADMINISTRATION', 'ADMINISTRATION', 'الإدارة')} title={tr('Campus Feedback', 'Campus Feedback', 'ملاحظات الفضاء الجامعي')}
      description={tr('Signalez un problème ou proposez une amélioration. Vos échanges restent privés.', 'Report an issue or suggest an improvement. Your conversation stays private.', 'أبلغ عن مشكلة أو اقترح تحسيناً. تبقى محادثاتك خاصة.')}
      actions={ticketId ? <Button icon={ArrowLeft} onClick={() => administrative ? navigate('/app/admin?tab=assistance') : setParams({})}>{administrative ? tr('Toutes les demandes', 'All requests', 'كل الطلبات') : tr('Mes demandes', 'My requests', 'طلباتي')}</Button>
        : <Button icon={Plus} aria-expanded={create} onClick={() => setCreate(value => !value)}>{tr('Nouvelle demande', 'New request', 'طلب جديد')}</Button>} />
    <p className="campus-privacy"><Lock size={14} />{tr('Visible uniquement par vous et l’administration autorisée.', 'Visible only to you and authorized administration.', 'مرئي لك وللإدارة المخولة فقط.')}</p>
    {error && <p className="notice" role="alert">{error}<Button icon={RefreshCw} onClick={() => setRevision(value => value + 1)}>{tr('Réessayer', 'Retry', 'أعد المحاولة')}</Button></p>}
    {create && !ticketId && <form className="card campus-form feedback-create" onSubmit={submit} aria-busy={busy}>
      <Field label={tr('Catégorie', 'Category', 'الفئة')}><Select value={category} onChange={event => setCategory(event.target.value)}>{['bug', 'feature', 'improvement', 'concern'].map(value => <option key={value} value={value}>{categoryLabel(value)}</option>)}</Select></Field>
      <Field label={tr('Titre', 'Title', 'العنوان')}><input required maxLength={180} value={title} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label={tr('Description', 'Description', 'الوصف')}><textarea required rows={5} maxLength={6000} value={description} onChange={event => setDescription(event.target.value)} /></Field>
      <Button type="submit" variant="primary" disabled={busy || !title.trim() || !description.trim()} icon={Send}>{busy ? tr('Envoi…', 'Sending…', 'جارٍ الإرسال…') : tr('Envoyer', 'Send', 'إرسال')}</Button>
    </form>}
    {ticketRemoved&&ticketId?<div className="card feedback-removed" role="status"><EmptyState icon={MessageSquare} title={tr('Cette conversation n’est plus disponible','This conversation is no longer available','هذه المحادثة لم تعد متاحة')} description={tr('Vous pouvez revenir aux demandes ou en créer une nouvelle.','Return to your requests or create a new one.','يمكنك الرجوع إلى الطلبات أو إنشاء طلب جديد.')}/></div>:loading && !data ? <PageLoading label={tr('Chargement…', 'Loading…', 'جارٍ التحميل…')}/> : ticket ? <article className="card campus-detail feedback-detail" id={`feedback-${ticket.id}`} aria-busy={loading}>
      <header className="feedback-ticket-header">
        <div className="feedback-ticket-labels"><span>#{ticket.id}</span>{ticket.category && <span>{categoryLabel(ticket.category)}</span>}<Badge className={`feedback-status feedback-status-${ticket.status}`}>{statusLabel(ticket.status)}</Badge></div>
        <h2 dir="auto">{ticket.title}</h2><p className="feedback-refresh">{ticket.username&&`@${ticket.username} · `}{ticket.faculty_id?.toUpperCase()}{ticket.filiere_id&&` · ${getFiliere(ticket.filiere_id)?.name||ticket.filiere_id}`}</p>
        <div className="feedback-person"><Avatar name={authorName} size="sm" /><div><strong dir="auto">{authorName}</strong>{authorEmail && <span dir="ltr">{authorEmail}</span>}</div>{ticket.created_at && <time dateTime={ticket.created_at}>{dateLabel(ticket.created_at)}</time>}</div>
      </header>
      <div className="campus-thread feedback-thread" aria-label={tr('Conversation privée', 'Private conversation', 'محادثة خاصة')}>
        <article className="feedback-message feedback-message-original"><div className="feedback-message-heading"><strong dir="auto">{authorName}</strong><span>{tr('Demande initiale', 'Initial request', 'الطلب الأول')}</span></div><p className="campus-prose" dir="auto">{ticket.description}</p></article>
        {(ticket.replies || []).map(message => {
          const fromAdministration = message.administrative || message.author?.name === 'Administration';
          const name = message.author?.name || (fromAdministration ? tr('Administration', 'Administration', 'الإدارة') : authorName);
          return <article key={message.id} id={`reply-${message.id}`} tabIndex={-1} className={`feedback-message ${fromAdministration ? 'feedback-message-admin' : 'feedback-message-student'}`}><div className="feedback-message-heading"><strong dir="auto">{name}</strong>{message.created_at && <time dateTime={message.created_at}>{dateLabel(message.created_at)}</time>}</div><p className="campus-prose" dir="auto">{message.content}</p>{ticket.assigned_to&&!ticket.restricted&&<div className="feedback-reactions">{[['like',ThumbsUp],['heart',Heart]].map(([reaction,Icon])=><button key={reaction} type="button" disabled={busy} aria-pressed={message.my_reactions?.includes(reaction)||false} aria-label={reaction==='like'?tr('J’aime','Like','إعجاب'):tr('J’adore','Love','أحببت')} onClick={()=>ticketAction(`/feedback/${ticketId}/replies/${message.id}/reactions`,{reaction,active:!message.my_reactions?.includes(reaction),administrative})}><Icon size={15}/>{message.reactions?.[reaction]||0}</button>)}</div>}</article>;
        })}
      </div>
      {!!files.length && <section className="feedback-files" aria-label={tr('Pièces jointes', 'Attachments', 'المرفقات')}><h3><Paperclip size={15} />{tr('Pièces jointes', 'Attachments', 'المرفقات')} <span>{files.length}/{MAX_FILES}</span></h3><ul>{files.map(file => <li key={file.id}><a href={file.url} download={file.filename}><Download size={15} /><span dir="auto">{file.filename}</span><small>{sizeLabel(file.size)}</small></a></li>)}</ul></section>}
      {!ticket.assigned_to&&!['closed','done','resolved'].includes(ticket.status)&&<div className="notice"><span>{tr('En attente de prise en charge','Waiting for an administrator','في انتظار تولي المسؤولية')}</span>{administrative&&!['closed','done','resolved'].includes(ticket.status)&&<Button disabled={busy} onClick={()=>ticketAction('accept')}>{tr('Accepter la demande','Accept request','قبول الطلب')}</Button>}</div>}
      {ticket.assigned&&<p className="feedback-refresh">{tr('Responsable','Assigned administrator','المسؤول')} : {ticket.assigned.name}{ticket.assigned.username&&` · @${ticket.assigned.username}`}</p>}
      {ticket.restricted&&<p className="notice">{tr('Cette conversation est privée entre l’étudiant et l’administrateur assigné.','This conversation is private to the student and assigned administrator.','هذه المحادثة خاصة بالطالب والمسؤول المعين.')}</p>}
      {ticket.assigned_to&&!ticket.restricted&&!ticket.closed_at&&!['closed','resolved','done'].includes(ticket.status)&&<form className="campus-form feedback-reply" onSubmit={submit} aria-busy={busy}>
        {administrative && <Field label={tr('Statut', 'Status', 'الحالة')}><Select value={status} onChange={event => setStatus(event.target.value)}>{['received', 'reviewing', 'accepted', 'planned', 'done', 'declined', 'open', 'resolved', 'closed'].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</Select></Field>}
        <Field label={tr('Ajouter une précision', 'Add a clarification', 'أضف توضيحاً')}><textarea required rows={3} maxLength={4000} value={reply} onChange={event => setReply(event.target.value)} placeholder={tr('Votre message à propos de cette demande…', 'Your message about this request…', 'رسالتك بخصوص هذا الطلب…')} /></Field>
        <div className="feedback-reply-actions">
          {!administrative && <><input ref={fileInput} id="feedback-attachment" type="file" accept={SUPPORTED_FILE_ACCEPT} hidden disabled={busy || files.length >= MAX_FILES || bytes >= MAX_TOTAL_BYTES} onChange={attach} aria-label={tr('Joindre un fichier (20 Mo maximum)', 'Attach a file (20 MB maximum)', 'إرفاق ملف (20 ميغابايت كحد أقصى)')} /><Button icon={Paperclip} disabled={busy || files.length >= MAX_FILES || bytes >= MAX_TOTAL_BYTES} onClick={() => fileInput.current?.click()}>{tr('Joindre un fichier', 'Attach a file', 'إرفاق ملف')}</Button></>}
          <Button type="submit" variant="primary" icon={Send} disabled={busy || !reply.trim()}>{tr('Répondre', 'Reply', 'رد')}</Button>
        </div>
        {!administrative && <p className="feedback-upload-hint">{tr('5 fichiers maximum · 20 Mo par fichier · 50 Mo au total', 'Up to 5 files · 20 MB each · 50 MB total', 'حتى 5 ملفات · 20 ميغابايت لكل ملف · 50 ميغابايت إجمالاً')}</p>}
        {uploadName && <p className="feedback-upload-hint" role="status">{tr('Envoi du fichier…', 'Uploading file…', 'جارٍ رفع الملف…')} <bdi>{uploadName}</bdi></p>}
        {attachmentError && <p className="field-error" role="alert">{attachmentError}</p>}
        {administrative&&<Button disabled={busy} onClick={()=>ticketAction('close')}>{tr('Clôturer la conversation','Close conversation','إغلاق المحادثة')}</Button>}
      </form>}
      {canDelete&&<div className="feedback-delete-actions"><p>{tr('Une fois le problème résolu, supprimez la demande, ses messages et ses fichiers.','Once the issue is resolved, delete the request, its messages and files.','بعد حل المشكلة، احذف الطلب ورسائله وملفاته.')}</p><Button icon={Trash2} className="feedback-delete-button" disabled={busy} onClick={()=>{setDeleteError('');setConfirmDelete(true);}}>{closed?tr('Supprimer la conversation','Delete conversation','حذف المحادثة'):tr('Terminer et supprimer','Finish and delete','إنهاء المحادثة وحذفها')}</Button></div>}
      {loading && <p className="feedback-refresh" role="status">{tr('Actualisation…', 'Refreshing…', 'جارٍ التحديث…')}</p>}
    </article> : !error && data ? <div className="campus-cards feedback-tickets">{tickets.length ? tickets.map(item => <button className="card campus-entry feedback-ticket" key={item.id} onClick={() => setParams({ ticket: item.id })}><div className="feedback-ticket-labels"><span>#{item.id}</span><Badge className={`feedback-status feedback-status-${item.status}`}>{statusLabel(item.status)}</Badge></div><strong dir="auto">{item.title}</strong><p dir="auto">{item.description?.slice(0, 180)}</p><small>{categoryLabel(item.category)}{item.created_at && <> · <time dateTime={item.created_at}>{dateLabel(item.created_at)}</time></>}</small></button>) : <EmptyState icon={MessageSquare} title={tr('Aucune demande', 'No requests yet', 'لا توجد طلبات بعد')} description={tr('Créez une demande pour échanger avec l’administration.', 'Create a request to speak with administration.', 'أنشئ طلباً للتواصل مع الإدارة.')} />}</div> : null}
    {confirmDelete&&canDelete&&<Modal className="feedback-delete-modal" title={tr('Supprimer définitivement cette conversation ?','Permanently delete this conversation?','حذف هذه المحادثة نهائياً؟')} onClose={()=>{if(!busy)setConfirmDelete(false);}} footer={<><Button disabled={busy} onClick={()=>setConfirmDelete(false)}>{tr('Annuler','Cancel','إلغاء')}</Button><Button icon={Trash2} className="feedback-delete-button" disabled={busy} aria-busy={busy} onClick={deleteConversation}>{busy?tr('Suppression…','Deleting…','جارٍ الحذف…'):tr('Supprimer définitivement','Delete permanently','حذف نهائياً')}</Button></>}><p>{tr('Cette action termine la session et efface la demande, tous ses messages, ses réactions, ses fichiers et ses notifications. Elle ne peut pas être annulée.','This ends the session and removes the request, all messages, reactions, files and notifications. This cannot be undone.','سينهي هذا الإجراء الجلسة ويحذف الطلب وجميع رسائله وتفاعلاته وملفاته وإشعاراته. لا يمكن التراجع عنه.')}</p>{deleteError&&<p role="alert" className="notice">{deleteError}</p>}</Modal>}
  </div>;
}
