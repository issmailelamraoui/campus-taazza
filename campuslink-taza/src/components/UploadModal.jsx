import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, CheckCircle2, FileText, FolderOpen, RotateCw, ShieldCheck, UploadCloud, X } from 'lucide-react';
import { useApp } from '../context';
import { api } from '../api';
import { getFilieres, getChatSemester } from '../../shared/studies.js';
import { formatBytes, messagePath, resourcePath } from '../utils';
import { prepareUploadFiles, runUploadBatch, UPLOAD_ACCEPT } from '../upload-batch.js';
import './upload.css';

export function UploadClassificationModal({ payload }) {
  const { t, lang, user, data, toast, refresh, closeModal } = useApp();
  const navigate = useNavigate();
  const facultyFilieres = data?.filieres || getFilieres(user?.faculty_id);
  const filieres = user?.role === 'student' ? facultyFilieres.filter(item => item.id === user?.filiere_id) : facultyFilieres;
  const [entries, setEntries] = useState(() => prepareUploadFiles(payload.file ? [payload.file] : []));
  const [batch, setBatch] = useState(false), [attempted, setAttempted] = useState(false);
  const [filiere, setFiliere] = useState(user?.filiere_id || '');
  const [semester, setSemester] = useState(Number(String(payload.semester || user?.current_semester || 1).replace(/^s/i, '')));
  const [module, setModule] = useState(''), [resourceType, setResourceType] = useState(payload.category === 'general' ? 'document' : payload.category || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [duplicate, setDuplicate] = useState(null), [notice, setNotice] = useState('');
  const [persistedModules, setPersistedModules] = useState([]);
  const filesInput = useRef(null), folderInput = useRef(null), completed = useRef(false);
  const types = [['courses','courses','Cours'],['exams','exams','Anciens examens'],['exercises','exercises','Exercices'],['td','resourceTD','TD'],['tp','resourceTP','TP'],['correction','resourceCorrection','Correction'],['rattrapage','rattrapage','Rattrapage'],['image','resourceImage','Image'],['pdf','resourcePDF','PDF'],['document','resourceDocument','Document'],['other','resourceOther','Autre ressource']];
  const category = ({ courses:'courses',exercises:'exercises',exams:'exams',rattrapage:'rattrapage',td:'exercises',tp:'exercises',correction:'exercises',image:'general',pdf:'general',document:'general',other:'general' })[resourceType];
  const locked = busy || (batch && attempted);
  useEffect(() => {
    setPersistedModules([]);
    if (!filiere) return;
    const controller = new AbortController();
    api(`/modules?${new URLSearchParams({ filiere_id:filiere,semester:String(semester) })}`, { signal:controller.signal }).then(result => setPersistedModules(result.modules || [])).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [filiere, semester]);
  const modules = [...new Set([...persistedModules.map(m => m.name), ...(data?.resources || []).filter(r => r.filiere_id === filiere && Number(r.semester) === semester).map(r => r.module)].filter(Boolean))];
  const pending = entries.filter(entry => ['queued', 'error'].includes(entry.status));
  const eligible = entries.filter(entry => entry.status !== 'skipped');
  const done = eligible.filter(entry => ['uploaded', 'duplicate', 'error'].includes(entry.status)).length;
  const uploaded = entries.filter(entry => entry.status === 'uploaded').length;
  const duplicates = entries.filter(entry => entry.status === 'duplicate').length;
  const failures = entries.filter(entry => entry.status === 'error').length;
  const skipped = entries.length - eligible.length;
  const update = (id, patch) => setEntries(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
  const selectFiles = (event, folder) => {
    if (!event.target.files?.length) return;
    const rows = prepareUploadFiles(event.target.files, folder);
    setEntries(rows); setBatch(folder || rows.length > 1); setAttempted(false); setError(''); setDuplicate(null); setNotice(''); completed.current = false;
    event.target.value = '';
  };
  const upload = async entry => {
    const form = new FormData();
    form.append('file', entry.file, entry.file.name); form.append('title', entry.title.trim()); form.append('category', category); form.append('filiere_id', filiere); form.append('semester', String(semester)); form.append('module', module.trim()); form.append('resource_type', resourceType); form.append('channel', payload.channel || 'general');
    if (entry.relativePath) form.append('relative_path', entry.relativePath);
    if (payload.channel === 'filiere') form.append('chat_semester', String(getChatSemester(payload.chat_semester || user.current_semester || 1)));
    form.append('content', payload.content || t('resourceShared', 'Je partage cette ressource avec vous.'));
    if (payload.reply_to) form.append('reply_to', payload.reply_to);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try { return await api('/uploads', { method:'POST',body:form,signal:controller.signal }); }
    catch (e) { if (e.name === 'AbortError') throw new Error(t('La connexion a expiré. Réessayez.')); throw e; }
    finally { clearTimeout(timeout); }
  };
  const submit = async event => {
    event.preventDefault();
    if (busy || !pending.length || !filiere || !category || !module.trim() || pending.some(entry => !entry.title.trim())) return;
    setBusy(true); setError(''); setDuplicate(null); setNotice('');
    try {
      if (batch) {
        setAttempted(true);
        let newUploads = 0;
        await runUploadBatch(entries, async entry => { const result = await upload(entry); newUploads++; return result; }, update);
        if (newUploads) {
          if (!completed.current) { completed.current = true; payload.onComplete?.(); }
          try { await refresh(); } catch { setNotice(t('uploadRefreshLater', 'Les fichiers sont envoyés. La bibliothèque se mettra à jour à la reconnexion.')); }
        }
      } else {
        const result = await upload(pending[0]);
        // A successful upload stays successful even if the follow-up refresh fails.
        await refresh().catch(() => {});
        payload.onComplete?.(); closeModal();
        navigate(payload.channel ? messagePath(result.message) : resourcePath(result.resource));
        toast(t('resourcePublished', 'Ressource partagée et classée dans la bibliothèque.'));
      }
    } catch (e) {
      setError(t(e.message, e.message));
      if (e.status === 409) setDuplicate(e.data?.resource || e.data?.existing);
    } finally { setBusy(false); }
  };
  if (!user?.filiere_id && payload.channel === 'filiere') return <><h2 id="modal-title">{t('selectFiliere', 'Sélectionner ma filière')}</h2><Link className="btn gold-btn full" to="/onboarding/studies" onClick={closeModal}>{t('completeSetup', 'Compléter mon compte')}<ArrowRight size={16}/></Link></>;
  return <>
    <div className="modal-heading"><span className="modal-heading-icon"><UploadCloud size={24} strokeWidth={1.4}/></span><h2 id="modal-title">{t('classifyResource', 'Quel type de ressource est-ce ?')}</h2><p>{batch ? t('uploadFolderDescription', 'Classez les fichiers ensemble. Les sous-dossiers et les titres de chaque fichier sont conservés.') : t('classifyDescription', 'Un instant pour bien classer, du temps gagné pour tout le monde.')}</p></div>
    <form className="upload-study-form" aria-busy={busy} onSubmit={submit}>
      <div className="upload-classification-grid">
        <label className="field upload-wide"><span>{t('filiere', 'Filière')}</span><select required aria-label={t('filiere', 'Filière')} value={filiere} onChange={e => { setFiliere(e.target.value); setModule(''); setDuplicate(null); }} disabled={locked}><option value="">{t('chooseFiliere', 'Choisir une filière')}</option>{filieres.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label className="field"><span>{t('semester', 'Semestre')}</span><select required aria-label={t('semester', 'Semestre')} value={semester} disabled={!filiere || locked} onChange={e => { setSemester(Number(e.target.value)); setModule(''); setDuplicate(null); }}>{[1,2,3,4,5,6].map(s => <option key={s} value={s}>S{s}</option>)}</select></label>
        <label className="field"><span>{t('contentType', 'Type de contenu')}</span><select required aria-label={t('contentType', 'Type de contenu')} value={resourceType} disabled={locked} onChange={e => { setResourceType(e.target.value); setDuplicate(null); }}><option value="">{t('selectContentType', 'Choisir un type de contenu')}</option>{types.map(([value,key,label]) => <option key={value} value={value}>{t(key,label)}</option>)}</select></label>
        <label className="field upload-wide"><span>{t('module', 'Module')}</span><input required aria-label={t('module', 'Module')} list="upload-module-suggestions" value={module} onChange={e => setModule(e.target.value)} disabled={!filiere || locked} placeholder={t('selectModule', 'Sélectionner ou saisir un module')} maxLength={120}/><datalist id="upload-module-suggestions">{modules.map(m => <option key={m} value={m}/>)}</datalist></label>
        {!batch && entries.length > 0 && <label className="field upload-wide"><span>{t('resourceTitle', 'Titre de la ressource')}</span><input required aria-label={t('resourceTitle', 'Titre de la ressource')} value={entries[0].title} disabled={busy} onChange={e => update(entries[0].id, { title:e.target.value })} placeholder={t('clearResourceTitle', 'Un titre clair et utile')} maxLength={180}/></label>}
      </div>
      <div className="upload-pickers">
        <button type="button" className="btn outline" disabled={locked} onClick={() => filesInput.current?.click()}><FileText size={18}/>{t('chooseFile', 'Choisir un fichier')}</button>
        <button type="button" className="btn outline upload-folder-picker" disabled={locked} onClick={() => folderInput.current?.click()}><FolderOpen size={18}/>{t('chooseFolder', 'Choisir un dossier')}</button>
        <input ref={filesInput} data-testid="upload-files-input" aria-label={t('file', 'Fichier')} type="file" hidden multiple disabled={locked} accept={UPLOAD_ACCEPT} onChange={e => selectFiles(e, false)}/>
        <input ref={folderInput} data-testid="upload-folder-input" aria-label={t('folder', 'Dossier')} type="file" hidden multiple webkitdirectory="" disabled={locked} onChange={e => selectFiles(e, true)}/>
      </div>
      <p className="upload-picker-hint">{t('uploadFolderHint', 'Sous-dossiers inclus · 20 Mo par fichier. Sur mobile, vous pouvez aussi sélectionner plusieurs fichiers.')}</p>
      {batch ? <section className="upload-batch" aria-label={t('selectedFiles', 'Fichiers sélectionnés')}>
        <div className="upload-batch-heading"><FolderOpen size={20}/><strong dir="auto">{entries[0]?.relativePath?.split('/').slice(0, -1)[0] || t('selectedFiles', 'Fichiers sélectionnés')}</strong><span>{entries.length} {t('files', 'fichiers')}</span></div>
        <div className="upload-batch-summary" role="status" aria-live="polite">{attempted ? <><span>{uploaded} {t('uploadSent', 'envoyés')}</span>{duplicates > 0 && <span>{duplicates} {t('uploadExisting', 'déjà présents')}</span>}{failures > 0 && <span>{failures} {t('uploadFailed', 'en échec')}</span>}</> : <span>{eligible.length} {t('uploadReady', 'prêts à envoyer')}</span>}{skipped > 0 && <span>{skipped} {t('uploadSkipped', 'ignorés')}</span>}{busy && <span>{t('uploading', 'Envoi en cours…')}</span>}</div>
        {attempted && <progress className="upload-batch-progress" value={done} max={eligible.length || 1} aria-label={t('uploadProgress', 'Progression de l’envoi')}/>}
        <div className="upload-batch-list">{entries.map(entry => <article key={entry.id} className="upload-batch-row" data-status={entry.status} data-upload-path={entry.relativePath || entry.file.name}>
          <div className="upload-file-heading"><FileText size={18}/><span className="upload-file-path" dir="auto">{entry.relativePath || entry.file.name}</span>{!locked && <button type="button" className="upload-remove" aria-label={`${t('removeFile', 'Retirer le fichier')} : ${entry.file.name}`} onClick={() => setEntries(rows => rows.filter(row => row.id !== entry.id))}><X size={16}/></button>}</div>
          <div className="upload-file-details"><span>{formatBytes(entry.file.size, lang)}</span><span className="upload-file-status">{t(({ queued:'uploadQueued',uploading:'uploading',uploaded:'uploadFileSent',duplicate:'uploadFileExisting',error:'uploadFileFailed',skipped:'uploadFileSkipped' })[entry.status], ({ queued:'À envoyer',uploading:'Envoi en cours…',uploaded:'Envoyé',duplicate:'Déjà présent',error:'Échec',skipped:'Ignoré' })[entry.status])}</span></div>
          {entry.status !== 'skipped' && <label className="upload-file-title"><span>{t('resourceTitle', 'Titre de la ressource')}</span><input data-upload-title required={['queued','error'].includes(entry.status)} aria-label={`${t('title', 'Titre')} : ${entry.relativePath || entry.file.name}`} value={entry.title} maxLength={180} disabled={busy || ['uploaded','duplicate'].includes(entry.status)} onChange={e => update(entry.id, { title:e.target.value })}/></label>}
          {entry.issue && <p className="upload-file-error">{t(entry.issue, ({ uploadEmptyFile:'Fichier vide.',uploadTooLarge:'Ce fichier dépasse 20 Mo.',uploadUnsupported:'Format non pris en charge.' })[entry.issue])}</p>}
          {entry.error && <p className="upload-file-error" role="alert">{t(entry.error, entry.error)}</p>}
          {!busy && entry.result?.resource && <Link className="upload-result-link" to={resourcePath(entry.result.resource)} onClick={closeModal}><CheckCircle2 size={14}/>{t(entry.status === 'duplicate' ? 'viewExisting' : 'open', entry.status === 'duplicate' ? 'Voir la ressource existante' : 'Ouvrir')}<ArrowUpRight size={14}/></Link>}
        </article>)}</div>
      </section> : entries.length > 0 && <div className="selected-file"><FileText size={25}/><div><b dir="auto">{entries[0].file.name}</b><span>{formatBytes(entries[0].file.size, lang)}</span>{entries[0].issue && <p className="upload-file-error">{t(entries[0].issue, ({ uploadEmptyFile:'Fichier vide.',uploadTooLarge:'Ce fichier dépasse 20 Mo.',uploadUnsupported:'Format non pris en charge.' })[entries[0].issue])}</p>}</div><button type="button" className="upload-remove" disabled={busy} onClick={() => { setEntries([]); setDuplicate(null); }} aria-label={t('removeFile', 'Retirer le fichier')}><X size={16}/></button></div>}
      <p className="upload-info"><ShieldCheck size={15}/>{batch ? t('uploadBatchBothPlaces', 'Chaque fichier sera accessible dans la conversation et dans la bibliothèque.') : t('uploadBothPlaces', 'Un seul fichier, accessible dans la conversation et dans votre bibliothèque.')}</p>
      {error && <div className="form-error" role="alert">{t(error,error)}{duplicate && <Link to={resourcePath(duplicate)} onClick={closeModal}>{t('viewExisting', 'Voir la ressource existante')}<ArrowUpRight size={14}/></Link>}</div>}
      {notice && <p className="upload-picker-hint" role="status">{notice}</p>}
      {(!batch || pending.length > 0) && <button className="btn gold-btn full" disabled={!pending.length || !filiere || !category || !module.trim() || pending.some(entry => !entry.title.trim()) || busy}>{t(busy ? 'uploading' : batch ? attempted ? 'uploadRetryFailed' : 'uploadPublishFiles' : 'publishResource', busy ? 'Envoi en cours…' : batch ? attempted ? 'Réessayer les fichiers en échec' : 'Partager les fichiers' : 'Partager la ressource')}{attempted ? <RotateCw size={16}/> : <ArrowRight size={16}/>}</button>}
      {batch && attempted && <button type="button" className="btn outline full upload-done" disabled={busy} onClick={closeModal}>{t('done', 'Terminé')}</button>}
    </form>
  </>;
}
