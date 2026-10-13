import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Link as LinkIcon, RefreshCw, X } from 'lucide-react';
import { useApp } from '../context';
import { api } from '../api.js';
import { Button, Field } from './ui';
import { Select } from './Select';
import { PDFIndexControl } from './DocumentTextSearch';
import './document-relations.css';

const moduleKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const field = (resource, camel, snake) => resource?.[camel] ?? resource?.[snake];
const sameScope = (a, b) => field(a, 'facultyId', 'faculty_id') === field(b, 'facultyId', 'faculty_id') && field(a, 'filiereId', 'filiere_id') === field(b, 'filiereId', 'filiere_id') && Number(a.semester) === Number(b.semester) && moduleKey(a.module) === moduleKey(b.module);
const courseDocument = item => item.category === 'courses' && (item.fileType === 'PDF' || item.mime === 'application/pdf') && item.libraryVisible !== false && item.library_visible !== false && item.library_visible !== 0;

export default function DocumentRelations({ resource, page = 1, version = resource.version }) {
  const { user, resources, tr, notify, openDocument } = useApp();
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [courseId, setCourseId] = useState(''), [coursePage, setCoursePage] = useState(1), [exercisePage, setExercisePage] = useState(page), [reason, setReason] = useState(''), [editing, setEditing] = useState(null), [editReason, setEditReason] = useState('');
  const generation = useRef(0), sequence = useRef(0), loadController = useRef(null), writeController = useRef(null), mounted = useRef(true);
  const courses = useMemo(() => resources.filter(item => String(item.id) !== String(resource.id) && courseDocument(item) && sameScope(resource, item)), [resources, resource]);
  const course = courses.find(item => String(item.id) === courseId), currentVersion = Number(version) === Number(resource.currentVersion || resource.version || version), online = navigator.onLine !== false;
  useEffect(() => {
    generation.current++; sequence.current++; loadController.current?.abort(); writeController.current?.abort(); mounted.current = true;
    setData(null); setCourseId(''); setCoursePage(1); setReason(''); setEditing(null); setError(''); setBusy(false); setLoading(false);
    return () => { mounted.current = false; generation.current++; sequence.current++; loadController.current?.abort(); writeController.current?.abort(); };
  }, [user.id, user.facultyId, user.filiereId, resource.id, version]);
  useEffect(() => { setExercisePage(page); }, [page]);
  useEffect(() => { if (courseId && !course) { setCourseId(''); setCoursePage(1); } }, [courseId, course]);
  async function refresh({ preserveError = false } = {}) {
    if (!online || !currentVersion) return;
    const owner = generation.current, requestId = ++sequence.current; loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    setLoading(true); if (!preserveError) setError('');
    try {
      const response = await api(`/document-relations/${resource.id}?exercise_page=${page}`, { signal: controller.signal });
      if (mounted.current && owner === generation.current && requestId === sequence.current) {
        if (Number(response.version) !== Number(version)) { setData(null); setError(tr('La version a changé. Rouvrez le document actuel.','The version changed. Reopen the current document.','تغيّرت النسخة. افتح المستند الحالي من جديد.')); }
        else setData(response);
      }
    } catch (failure) { if (mounted.current && owner === generation.current && requestId === sequence.current && !controller.signal.aborted) { setError(failure.message); setData(null); } }
    finally { if (mounted.current && owner === generation.current && requestId === sequence.current) setLoading(false); }
  }
  useEffect(() => { if (open) refresh(); else { sequence.current++; loadController.current?.abort(); setLoading(false); } }, [open, resource.id, version, page, user.id, user.facultyId, user.filiereId]);
  useEffect(() => {
    const indexed = event => { if (open && (String(event.detail?.resourceId) === String(resource.id) || courses.some(item => String(item.id) === String(event.detail?.resourceId)))) refresh(); };
    window.addEventListener('campus-document-indexed', indexed); return () => window.removeEventListener('campus-document-indexed', indexed);
  }, [open, resource.id, version, page, courses]);
  async function write(path, body, method = 'POST') {
    if (busy || !online || !currentVersion) return;
    const owner = generation.current, controller = new AbortController(); writeController.current = controller; setBusy(true); setError('');
    try {
      await api(path, { method, body, signal: controller.signal });
      if (!mounted.current || owner !== generation.current) return;
      setEditing(null); if (method === 'POST') setReason('');
      notify(tr('Relation enregistrée. Les propositions restent distinctes des liens vérifiés.','Relationship saved. Proposals remain separate from verified links.','حُفظت العلاقة. تبقى الاقتراحات منفصلة عن الروابط المعتمدة.'));
      await refresh();
    } catch (failure) { if (mounted.current && owner === generation.current && !controller.signal.aborted) { setError(failure.message); if ([403,404,409].includes(failure.status)) await refresh({ preserveError: true }); } }
    finally { if (mounted.current && owner === generation.current) setBusy(false); }
  }
  function visit(source) {
    const item = resources.find(item => String(item.id) === String(source.resourceId));
    if (item && Number(item.version) === Number(source.version)) openDocument({ ...item, initialPage: source.page, initialVersion: source.version });
    else setError(tr('La source a changé ou est devenue inaccessible. Actualisez la liste.','The source changed or is no longer accessible. Refresh the list.','تغيّر المصدر أو أصبح غير متاح. حدّث القائمة.'));
  }
  const statusLabel = status => ({ proposed: tr('Proposition','Proposal','اقتراح'), verified: tr('Vérifiée','Verified','معتمدة'), rejected: tr('Rejetée','Rejected','مرفوضة') })[status];
  return <details className="document-relations" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><BookOpen size={16}/>{tr('Cours liés possibles','Possible related course pages','صفحات دروس قد تكون مرتبطة')}</summary>
    {open && <div className="document-relations-body">
      <p className="muted">{tr('Des mots communs suggèrent une page de cours. Vérifiez le contenu : les numéros d’exercices et de parties ne déterminent aucun lien.','Shared words suggest a course page. Check the content: exercise and part numbers do not establish a relationship.','تقترح الكلمات المشتركة صفحة درس. تحقق من المحتوى: أرقام التمارين والأجزاء لا تحدد العلاقة.')}</p>
      {!online ? <p role="status">{tr('Les relations sont consultables en ligne.','Relationships are available online.','العلاقات متاحة عبر الإنترنت.')}</p> : !currentVersion ? <p role="status">{tr('Ouvrez la version actuelle pour proposer un lien.','Open the current version to propose a link.','افتح النسخة الحالية لاقتراح رابط.')}</p> : <>
        <div className="document-relations-tools"><PDFIndexControl key={`${resource.id}:${version}`} resourceId={resource.id} version={version}/><Button icon={RefreshCw} disabled={loading || busy} onClick={() => refresh()}>{tr('Actualiser les liens','Refresh relationships','تحديث العلاقات')}</Button></div>
        {loading && <p role="status">{tr('Recherche des pages liées…','Finding related pages…','البحث عن الصفحات المرتبطة…')}</p>}
        {data?.state === 'not_indexed' && <p>{tr('Préparez ce PDF et les cours du module pour comparer leur texte.','Prepare this PDF and the module’s courses to compare their text.','أعد هذا الملف ودروس الوحدة لمقارنة نصوصها.')}</p>}
        {data?.state === 'unknown' && <p>{tr('Aucun lien fiable proposé pour cette page. Vous pouvez proposer une relation manuelle, y compris pour une page numérisée.','No reliable relationship suggested for this page. You can propose a manual link, including for a scanned page.','لم تُقترح علاقة موثوقة لهذه الصفحة. يمكنك اقتراح رابط يدوي، بما في ذلك صفحة ممسوحة.')}</p>}
        {!!data?.suggestions?.length && <div className="document-relation-suggestions"><h4>{tr('Passages possibles à vérifier','Possible passages to check','مقاطع محتملة للتحقق')} · p. {page}</h4>{data.suggestions.map(item => <article className="document-relation-card" key={`${item.exercise.page}:${item.course.resourceId}:${item.course.page}`}>
          <button className="document-relation-source" onClick={() => visit(item.course)}><BookOpen size={16}/><strong dir="auto">{item.course.title} · p. {item.course.page}</strong><span>v{item.course.version}</span></button>
          <p className="document-relation-evidence">{tr('Mots communs','Shared words','كلمات مشتركة')}: {(item.evidence?.terms || []).map(word => <bdi key={word.term}>{word.term}</bdi>)}</p>
          {!!item.evidence?.phrases?.length && <p className="muted">{tr('Expressions communes','Shared phrases','عبارات مشتركة')}: {item.evidence.phrases.join(' · ')}</p>}
          <Button disabled={busy || !courses.some(course => String(course.id) === String(item.course.resourceId))} onClick={() => { setCourseId(String(item.course.resourceId)); setCoursePage(item.course.page); setExercisePage(item.exercise.page); setReason(''); }}>{tr('Préparer une proposition','Prepare a proposal','إعداد اقتراح')}</Button>
        </article>)}</div>}
        {data?.limited && <small className="muted">{tr('Comparaison limitée aux pages et au texte disponibles. Une absence de suggestion ne prouve pas l’absence de lien.','Comparison is limited to available pages and text. No suggestion does not prove that no relationship exists.','تقتصر المقارنة على الصفحات والنص المتاح. غياب الاقتراح لا يعني غياب العلاقة.')}</small>}
        <form className="document-relation-form" onSubmit={event => { event.preventDefault(); if (course) write('/document-relations/' + resource.id, { course_resource_id: Number(course.id), course_version: Number(course.version), exercise_version: Number(version), course_page: Number(coursePage), exercise_page: Number(exercisePage), reason }); }}>
          <h4>{tr('Proposer un lien de pages','Propose a page link','اقتراح رابط بين الصفحات')}</h4>
          <Field label={tr('Cours du même module','Course in this module','درس من الوحدة نفسها')}><Select required value={courseId} disabled={busy} onChange={event => { setCourseId(event.target.value); setCoursePage(1); }}><option value="">—</option>{courses.map(item => <option value={item.id} key={item.id}>{item.title} · {item.part === 'complete' ? tr('Complet','Complete','كامل') : `${tr('Partie','Part','جزء')} ${item.part}`} · v{item.version}</option>)}</Select></Field>
          {course && <PDFIndexControl key={`${course.id}:${course.version}`} resourceId={course.id} version={course.version}/>}
          <div className="document-relation-pages"><Field label={tr('Page du TD','Exercise page','صفحة التمرين')}><input type="number" required min={1} max={500} value={exercisePage} disabled={busy} onChange={event => setExercisePage(event.target.value)}/></Field><Field label={tr('Page du cours','Course page','صفحة الدرس')}><input type="number" required min={1} max={500} value={coursePage} disabled={busy} onChange={event => setCoursePage(event.target.value)}/></Field></div>
          <Field label={tr('Pourquoi ces pages sont liées','Why these pages relate','لماذا ترتبط هذه الصفحات')}><textarea required minLength={8} maxLength={2000} rows={3} value={reason} disabled={busy} onChange={event => setReason(event.target.value)}/></Field>
          {!courses.length && <p className="muted">{tr('Aucun PDF de cours accessible dans ce module et ce semestre.','No accessible course PDF in this module and semester.','لا يوجد ملف درس PDF متاح لهذه الوحدة والفصل.')}</p>}
          <Button type="submit" icon={LinkIcon} variant="primary" disabled={busy || !course || reason.trim().length < 8}>{busy ? tr('Enregistrement…','Saving…','جارٍ الحفظ…') : tr('Envoyer la proposition','Send proposal','إرسال الاقتراح')}</Button>
        </form>
        {!!data?.mappings?.length && <div className="document-relation-mappings"><h4>{tr('Liens proposés et vérifiés','Proposed and verified links','روابط مقترحة ومعتمدة')}</h4>{data.mappings.map(mapping => <article className={`document-relation-card relation-${mapping.status}`} key={mapping.id}>
          <span className="document-relation-status">{statusLabel(mapping.status)}</span><p>p. {mapping.exercise.page} → <button className="document-relation-inline-source" onClick={() => visit(mapping.course)}>{mapping.course.title} · p. {mapping.course.page} · v{mapping.course.version}</button></p>
          {editing === mapping.id ? <form onSubmit={event => { event.preventDefault(); write(`/document-relations/${resource.id}/${mapping.id}`, { revision: mapping.revision, reason: editReason }, 'PATCH'); }}><Field label={tr('Explication corrigée','Corrected explanation','الشرح المصحح')}><textarea rows={3} minLength={8} maxLength={2000} required value={editReason} disabled={busy} onChange={event => setEditReason(event.target.value)}/></Field><Button type="submit" disabled={busy || editReason.trim().length < 8}>{tr('Enregistrer la correction','Save correction','حفظ التصحيح')}</Button><Button disabled={busy} onClick={() => setEditing(null)}>{tr('Annuler','Cancel','إلغاء')}</Button></form> : <p className="document-relation-reason" dir="auto">{mapping.reason}</p>}
          <div className="document-relation-actions">{!editing && mapping.status === 'proposed' && (String(mapping.proposerId) === String(user.id) || data.canVerify) && <Button disabled={busy} onClick={() => { setEditing(mapping.id); setEditReason(mapping.reason); }}>{tr('Corriger mon explication','Correct explanation','تصحيح الشرح')}</Button>}{data.canVerify && <><Button icon={Check} disabled={busy || mapping.status === 'verified'} onClick={() => write(`/document-relations/${resource.id}/${mapping.id}`, { revision: mapping.revision, status: 'verified' }, 'PATCH')}>{tr('Vérifier le lien','Verify link','اعتماد الرابط')}</Button><Button icon={X} disabled={busy || mapping.status === 'rejected'} onClick={() => write(`/document-relations/${resource.id}/${mapping.id}`, { revision: mapping.revision, status: 'rejected' }, 'PATCH')}>{tr('Rejeter le lien','Reject link','رفض الرابط')}</Button></>}</div>
        </article>)}</div>}
      </>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>}
  </details>;
}
