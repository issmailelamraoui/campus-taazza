import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, Plus, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { FACULTIES } from '../data/mock';
import { getFilieres } from '../data/studies';
import { Button, EmptyState, Field, Modal } from './ui';
import { Select } from './Select';
import './module-catalog-admin.css';

export default function ModuleCatalogAdmin() {
  const { user, tr } = useApp();
  const global = (user?.serverRole || user?.role) === 'global_admin';
  const grants = user?.administrative_capabilities;
  const faculties = FACULTIES.filter(item => global || (Array.isArray(grants)
    ? grants.some(grant => grant.facultyId === item.id && grant.capabilities.includes('resource.manage'))
    : item.id === user?.facultyId));
  const [faculty, setFaculty] = useState(() => faculties[0]?.id || '');
  const programs = getFilieres(faculty).filter(item => global || !Array.isArray(grants)
    || grants.some(grant => grant.facultyId === faculty && (!grant.filiereId || grant.filiereId === item.id) && grant.capabilities.includes('resource.manage')));
  const [filiere, setFiliere] = useState(() => programs[0]?.id || '');
  const [semester, setSemester] = useState('1');
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ key: '', loading: true, modules: [], error: '' });
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const scope = `${faculty}:${filiere}:${semester}`;
  const current = state.key === scope ? state : { loading: true, modules: [], error: '' };
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    if (!faculty || !filiere) return;
    const controller = new AbortController();
    let active = true;
    setState({ key: scope, loading: true, modules: [], error: '' });
    api(`/modules?${new URLSearchParams({ faculty_id: faculty, filiere_id: filiere, semester })}`, { signal: controller.signal })
      .then(result => { if (active) setState({ key: scope, loading: false, modules: result.modules || [], error: '' }); })
      .catch(failure => { if (active && !controller.signal.aborted) setState({ key: scope, loading: false, modules: [], error: failure.message }); });
    return () => { active = false; controller.abort(); };
  }, [faculty, filiere, semester, revision]);
  function changeFaculty(value) {
    setFaculty(value);
    setFiliere(getFilieres(value).find(item => global || !Array.isArray(grants) || grants.some(grant => grant.facultyId === value && (!grant.filiereId || grant.filiereId === item.id) && grant.capabilities.includes('resource.manage')))?.id || '');
  }
  function edit(item) {
    setError('');
    setDraft({ id: item?.id, name: item?.name || '', curriculum_source: item?.curriculum_source || '', confirmed: false });
  }
  async function save(event) {
    event.preventDefault();
    if (savingRef.current || !draft?.confirmed) return;
    const savedScope = scope;
    savingRef.current = true; setSaving(true); setError('');
    try {
      await api(draft.id ? `/admin/modules/${draft.id}` : '/admin/modules', {
        method: draft.id ? 'PATCH' : 'POST',
        body: draft.id
          ? { catalog_status: 'official', curriculum_source: draft.curriculum_source, confirmed: true }
          : { faculty_id: faculty, filiere_id: filiere, semester: Number(semester), name: draft.name, curriculum_source: draft.curriculum_source, confirmed: true },
      });
      setDraft(null);
      if (currentScope.current === savedScope) setRevision(value => value + 1);
      window.dispatchEvent(new Event('campus-module-catalog-updated'));
    } catch (failure) { setError(failure.message); }
    finally { savingRef.current = false; setSaving(false); }
  }
  return <section className="admin-tab-section module-catalog-admin">
    <div className="admin-section-header"><div><h2>{tr('Catalogue officiel des modules', 'Official module catalog', 'الفهرس الرسمي للوحدات')}</h2><p>{tr('Vérifiez chaque module à partir du programme officiel de la filière.', 'Verify each module against the official program curriculum.', 'تحقق من كل وحدة بالرجوع إلى البرنامج الرسمي للمسلك.')}</p></div><Button icon={Plus} variant="primary" disabled={!filiere || current.loading} onClick={() => edit(null)}>{tr('Ajouter un module', 'Add module', 'إضافة وحدة')}</Button></div>
    <div className="catalog-scope-controls">
      <Field label={tr('Établissement', 'Faculty', 'الكلية')}><Select value={faculty} onChange={event => changeFaculty(event.target.value)}>{faculties.map(item => <option key={item.id} value={item.id}>{item.code}</option>)}</Select></Field>
      <Field label={tr('Filière', 'Program', 'المسلك')}><Select value={filiere} onChange={event => setFiliere(event.target.value)}>{programs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
      <Field label={tr('Semestre', 'Semester', 'الفصل')}><Select value={semester} onChange={event => setSemester(event.target.value)}>{[1, 2, 3, 4, 5, 6].map(item => <option key={item} value={item}>S{item}</option>)}</Select></Field>
    </div>
    <p className="catalog-preservation-note">{tr('Les modules historiques restent consultables. Seuls les modules vérifiés sont proposés pour les nouveaux dépôts.', 'Historical modules remain available to browse. Only verified modules are offered for new uploads.', 'تبقى الوحدات القديمة متاحة للتصفح. تُعرض الوحدات المتحقق منها فقط لرفع ملفات جديدة.')}</p>
    <div aria-live="polite" aria-busy={current.loading}>
      {current.loading ? <p role="status">{tr('Chargement du catalogue…', 'Loading catalog…', 'جارٍ تحميل الفهرس…')}</p> : current.error ? <div className="catalog-load-error"><p role="alert">{current.error}</p><Button icon={RefreshCw} onClick={() => setRevision(value => value + 1)}>{tr('Réessayer', 'Retry', 'إعادة المحاولة')}</Button></div> : current.modules.length ? <div className="catalog-module-list">{current.modules.map(item => <article className="card catalog-module-row" key={item.id} data-module-id={item.id}>
        <BookOpen size={21} aria-hidden="true" /><div><h3 dir="auto">{item.name}</h3><span className="catalog-verification-status">{item.catalog_status === 'official' ? <><CheckCircle2 size={14} aria-hidden="true" />{tr('Vérifié', 'Verified', 'تم التحقق')}</> : tr('Historique · à vérifier', 'Historical · needs verification', 'قديمة · تحتاج للتحقق')} · #{item.id}</span>{item.curriculum_source && <p dir="auto">{item.curriculum_source}</p>}</div>
        <Button onClick={() => edit(item)}>{tr(item.catalog_status === 'official' ? 'Consulter' : 'Vérifier', item.catalog_status === 'official' ? 'Review' : 'Verify', item.catalog_status === 'official' ? 'مراجعة' : 'تحقق')}</Button>
      </article>)}</div> : <EmptyState icon={BookOpen} title={tr('Aucun module dans ce semestre', 'No modules in this semester', 'لا توجد وحدات في هذا الفصل')} description={tr('Ajoutez les modules uniquement à partir d’un programme officiel vérifié.', 'Add modules only from a verified official curriculum.', 'أضف الوحدات بالاعتماد على برنامج رسمي متحقق منه فقط.')} />}
    </div>
    {draft && <Modal title={draft.id ? tr('Vérifier le module', 'Verify module', 'التحقق من الوحدة') : tr('Ajouter un module officiel', 'Add official module', 'إضافة وحدة رسمية')} onClose={() => { if (!saving) setDraft(null); }} className="catalog-module-modal">
      <form onSubmit={save}>
        <p className="muted">{faculties.find(item => item.id === faculty)?.code} · {programs.find(item => item.id === filiere)?.name} · S{semester}</p>
        <Field label={tr('Nom officiel du module', 'Official module name', 'الاسم الرسمي للوحدة')}><input className="input" required maxLength={120} readOnly={Boolean(draft.id)} value={draft.name} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} dir="auto" /></Field>
        <Field label={tr('Source du programme officiel', 'Official curriculum source', 'مصدر البرنامج الرسمي')} hint={tr('Lien ou référence précise du programme validé.', 'Link or precise reference for the verified curriculum.', 'رابط أو مرجع دقيق للبرنامج المتحقق منه.')}><textarea className="input" required maxLength={2000} rows={3} value={draft.curriculum_source} onChange={event => setDraft(previous => ({ ...previous, curriculum_source: event.target.value }))} dir="auto" /></Field>
        <label className="catalog-confirmation"><input type="checkbox" checked={draft.confirmed} onChange={event => setDraft(previous => ({ ...previous, confirmed: event.target.checked }))} /><span>{tr('J’ai vérifié ce module, sa filière et son semestre dans le programme officiel.', 'I verified this module, program and semester against the official curriculum.', 'تحققت من الوحدة والمسلك والفصل بالرجوع إلى البرنامج الرسمي.')}</span></label>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="catalog-dialog-actions"><Button disabled={saving} onClick={() => setDraft(null)}>{tr('Annuler', 'Cancel', 'إلغاء')}</Button><Button type="submit" variant="primary" disabled={saving || !draft.confirmed || !draft.name.trim() || !draft.curriculum_source.trim()}>{saving ? tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : tr('Enregistrer le module vérifié', 'Save verified module', 'حفظ الوحدة المتحقق منها')}</Button></div>
      </form>
    </Modal>}
  </section>;
}
