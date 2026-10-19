import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { FACULTIES } from '../data/mock';
import { getFiliere, getFilieres } from '../data/studies';
import { Button, EmptyState, Field, Modal, PageHeader } from '../components/ui';
import { Select } from '../components/Select';
import './admin.css';

const CAPS = ['content.moderate', 'resource.manage', 'resource.upload', 'announcement.publish', 'student.support', 'student.admit', 'feedback.manage', 'channel.manage'];

export default function PermissionsPage() {
  const { tr, notify, user } = useApp();
  const [params] = useSearchParams();
  const [users, setUsers] = useState([]), [appointments, setAppointments] = useState([]);
  const [target, setTarget] = useState(params.get('user') || ''), [role, setRole] = useState('faculty_admin');
  const [scope, setScope] = useState('');
  const [filiere, setFiliere] = useState(''), [caps, setCaps] = useState([]);
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [revoking, setRevoking] = useState(null), [actionError, setActionError] = useState('');
  const request = useRef(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([api('/admin'), api('/admin/appointments')]).then(([accounts, access]) => {
      if (live) {
        setUsers((accounts.users || []).filter(account => String(account.id) !== String(user.id)));
        setAppointments(access.appointments || []);
        setError('');
      }
    }).catch(failure => { if (live) setError(failure.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [revision, user.id]);

  const eligibleUsers = users.filter(account => !account.disabled && account.account_status === 'approved' && account.role !== 'global_admin' && account.faculty_id);
  const student = eligibleUsers.find(account => String(account.id) === target);
  const selectedFaculty=scope||student?.faculty_id;
  const programs = getFilieres(selectedFaculty);
  const allFaculties=selectedFaculty==='all';
  const uploadNeedsProgramme = caps.includes('resource.upload') && !filiere;
  const accountName = appointment => users.find(account => String(account.id) === String(appointment.user_id))?.name || '#' + appointment.user_id;
  const capabilityLabels = {
    'content.moderate': tr('Modérer les contenus', 'Moderate content', 'الإشراف على المحتوى'),
    'resource.manage': tr('Gérer les documents', 'Manage documents', 'إدارة المستندات'),
    'resource.upload': tr('Déposer dans tous les semestres de la filière', 'Upload across the programme’s semesters', 'الرفع في فصول المسلك'),
    'announcement.publish': tr('Publier des annonces', 'Publish announcements', 'نشر الإعلانات'),
    'student.support': tr('Assister les comptes étudiants', 'Support student accounts', 'مساعدة حسابات الطلبة'),
    'student.admit': tr('Accepter ou refuser les inscriptions','Approve or reject registrations','قبول أو رفض التسجيلات'),
    'feedback.manage': tr('Traiter les demandes privées', 'Manage private feedback', 'إدارة الطلبات الخاصة'),
    'channel.manage': tr('Configurer les discussions', 'Configure discussions', 'إعداد المناقشات'),
  };
  const roleLabels = {
    faculty_admin: tr('Administrateur de faculté', 'Faculty administrator', 'مسؤول الكلية'),
    moderator: tr('Modérateur', 'Moderator', 'مشرف'),
    faculty_leader: tr('Faculty Leader (classement validé)', 'Faculty Leader (validated ranking)', 'قائد الكلية (ترتيب معتمد)'),
  };

  async function grant(event) {
    event.preventDefault();
    if (request.current || !student || !caps.length || uploadNeedsProgramme) return;
    request.current = true; setBusy(true); setActionError('');
    try {
      await api('/admin/appointments', { method: 'POST', body: { user_id: target, role, faculty_id: selectedFaculty, filiere_id: filiere || null, capabilities: caps } });
      setRevision(value => value + 1);
      setCaps([]);
      notify(tr('Nomination enregistrée.', 'Appointment saved.', 'تم حفظ التعيين.'));
    } catch (failure) { setActionError(failure.message); notify(failure.message, 'error'); }
    finally { request.current = false; setBusy(false); }
  }

  async function revoke(appointment) {
    if (request.current) return;
    request.current = true; setBusy(true); setActionError('');
    try {
      await api(appointment.all?'/admin/users/'+appointment.user_id+'/appointments':'/admin/appointments/' + appointment.id, { method: 'DELETE' });
      setRevoking(null);
      setRevision(value => value + 1);
      notify(tr('Nomination révoquée.', 'Appointment revoked.', 'تم إلغاء التعيين.'));
    } catch (failure) { setActionError(failure.message); notify(failure.message, 'error'); }
    finally { request.current = false; setBusy(false); }
  }
  function closeRevocation() { if (!request.current) { setRevoking(null); setActionError(''); } }

  return <div className="permissions-page" aria-busy={loading || busy}>
    <PageHeader eyebrow={tr('AUTORISATIONS', 'AUTHORIZATION', 'التفويضات')} title={tr('Nominations et permissions', 'Appointments and permissions', 'التعيينات والصلاحيات')} description={tr('Attribuez séparément les droits par faculté, filière ou pour toutes les facultés. Les nominations protégées sont réservées au propriétaire.', 'Assign separate permissions by faculty, programme or across all faculties. Protected appointments are managed by the owner.', 'امنح صلاحيات منفصلة لكل كلية أو مسلك أو جميع الكليات. يدير المالك التعيينات المحمية.')} />
    {error ? <div className="admin-server-error"><p role="alert">{error}</p><Button onClick={() => setRevision(value => value + 1)}>{tr('Réessayer', 'Retry', 'إعادة المحاولة')}</Button></div> : loading ? <p className="admin-loading-status" role="status">{tr('Chargement des permissions…', 'Loading permissions…', 'جارٍ تحميل الصلاحيات…')}</p> : <>
      <form className="card permissions-form" onSubmit={grant}>
        <div className="permissions-fields">
          <Field label={tr('Compte', 'Account', 'الحساب')} hint={tr('Comptes approuvés et actifs uniquement.', 'Approved, active accounts only.', 'الحسابات المقبولة والمفعّلة فقط.')}><Select required disabled={busy || !eligibleUsers.length} value={student ? target : ''} onChange={event => { setTarget(event.target.value); setScope(''); setFiliere(''); setActionError(''); }}><option value="">{eligibleUsers.length ? tr('Choisissez un compte', 'Choose an account', 'اختر حسابًا') : tr('Aucun compte éligible', 'No eligible accounts', 'لا توجد حسابات مؤهلة')}</option>{eligibleUsers.map(account => <option key={account.id} value={account.id}>{account.name} · @{account.username} · {FACULTIES.find(faculty => faculty.id === account.faculty_id)?.code || account.faculty_id}</option>)}</Select></Field>
          <Field label={tr('Responsabilité', 'Responsibility', 'المسؤولية')}><Select disabled={busy} value={role} onChange={event => { setRole(event.target.value); setScope(''); setFiliere(''); setCaps([]); }}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
          <Field label={tr('Périmètre', 'Scope', 'نطاق الصلاحيات')}><Select disabled={busy || !student || role==='faculty_leader'} value={selectedFaculty||''} onChange={event=>{setScope(event.target.value);setFiliere('');setCaps(values=>values.filter(c=>c!=='resource.upload'));}}>{FACULTIES.map(faculty=><option key={faculty.id} value={faculty.id}>{faculty.code} · {faculty.name}</option>)}<option value="all">{tr('Toutes les facultés', 'All faculties', 'جميع الكليات')}</option></Select></Field>
          <Field label={tr('Filière autorisée', 'Authorized programme', 'المسلك المخول')} hint={uploadNeedsProgramme ? tr('Choisissez une filière pour autoriser les dépôts.', 'Choose a programme to allow uploads.', 'اختر مسلكًا للسماح بالرفع.') : undefined}><Select disabled={busy || !student || allFaculties} required={caps.includes('resource.upload')} aria-invalid={uploadNeedsProgramme || undefined} value={filiere} onChange={event => setFiliere(event.target.value)}><option value="">{tr('Faculté entière (hors dépôts)', 'Whole faculty (uploads excluded)', 'كل الكلية (باستثناء الرفع)')}</option>{programs.map(program => <option value={program.id} key={program.id}>{program.name}</option>)}</Select></Field>
        </div>
        <fieldset className="permissions-capabilities" disabled={busy}>
          <legend>{tr('Permissions explicites', 'Explicit permissions', 'صلاحيات محددة')}</legend>
          <div>{CAPS.filter(capability => (selectedFaculty===student?.faculty_id||capability!=='resource.upload') && (role !== 'faculty_leader' || ['content.moderate', 'student.support'].includes(capability))).map(capability => <label className={`permissions-capability ${caps.includes(capability) ? 'selected' : ''}`} key={capability}><input type="checkbox" checked={caps.includes(capability)} onChange={event => setCaps(values => event.target.checked ? [...values, capability] : values.filter(value => value !== capability))} /><span>{capabilityLabels[capability]}</span></label>)}</div>
        </fieldset>
        {allFaculties && <p className="muted admin-form-note">{tr('Les permissions cochées s’appliquent à toutes les facultés. La gestion des administrateurs reste réservée au propriétaire.', 'Selected permissions apply across all faculties. Only the owner can manage administrators.', 'تُطبق الصلاحيات المختارة على جميع الكليات. تبقى إدارة المسؤولين حصرية للمالك.')}</p>}
        {role === 'faculty_leader' && <p className="muted admin-form-note">{tr('Ce rôle exige la première place au classement validé de la faculté. L’éligibilité est vérifiée lors de l’enregistrement.', 'This role requires first place in the faculty’s validated ranking. Eligibility is checked when saving.', 'يتطلب هذا الدور المرتبة الأولى في ترتيب الكلية المعتمد. تُتحقق الأهلية عند الحفظ.')}</p>}
        {actionError && !revoking && <p className="admin-form-error" role="alert">{actionError}</p>}
        <Button type="submit" icon={ShieldCheck} variant="primary" disabled={busy || !student || !caps.length || uploadNeedsProgramme}>{busy && !revoking ? tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : tr('Accorder la nomination', 'Grant appointment', 'منح التعيين')}</Button>
      </form>
      <section className="admin-subsection" aria-labelledby="permissions-appointments-title">
        <div className="admin-section-header"><div><h2 id="permissions-appointments-title">{tr('Nominations enregistrées', 'Saved appointments', 'التعيينات المحفوظة')}</h2></div><span className="admin-status">{appointments.length}</span></div>
        {!appointments.length ? <div className="card"><EmptyState icon={ShieldCheck} title={tr('Aucune nomination', 'No appointments', 'لا توجد تعيينات')} description={tr('Les responsabilités accordées apparaîtront ici.', 'Granted responsibilities will appear here.', 'ستظهر المسؤوليات الممنوحة هنا.')} /></div> : <div className="permissions-appointments">{appointments.map(appointment => <article className="card permissions-appointment" key={appointment.id}>
          <div className="permissions-appointment-heading"><div><strong dir="auto">{accountName(appointment)}</strong>{appointment.role && <span>{roleLabels[appointment.role] || appointment.role}</span>}</div><span className={`admin-status ${appointment.revoked_at ? 'revoked' : 'active'}`}>{appointment.revoked_at ? tr('Révoquée', 'Revoked', 'ملغاة') : tr('Active', 'Active', 'مفعّلة')}</span></div>
          <p className="permissions-appointment-context">{FACULTIES.find(faculty => faculty.id === appointment.faculty_id)?.name || appointment.faculty_id}{appointment.filiere_id && <> · {getFiliere(appointment.filiere_id)?.name || appointment.filiere_id}</>}</p>
          <ul className="permissions-granted-list">{appointment.capabilities.map(capability => <li key={capability}>{capabilityLabels[capability] || capability}</li>)}</ul>
          {!appointment.revoked_at && <div className="permissions-appointment-actions"><Button disabled={busy} onClick={() => { setActionError(''); setRevoking(appointment); }}>{tr('Révoquer cette nomination', 'Revoke appointment', 'إلغاء التعيين')}</Button>{appointments.filter(a=>!a.revoked_at&&a.user_id===appointment.user_id).length>1&&<Button disabled={busy} onClick={()=>{setActionError('');setRevoking({...appointment,all:true});}}>{tr('Retirer tous ses accès administratifs','Revoke all their administrative access','سحب جميع صلاحياته الإدارية')}</Button>}</div>}
        </article>)}</div>}
      </section>
    </>}
    {revoking && <Modal className="admin-modal" title={revoking.all?tr('Retirer tous ses accès administratifs ?', 'Revoke all administrative access?', 'سحب جميع الصلاحيات الإدارية؟'):tr('Révoquer cette nomination ?', 'Revoke this appointment?', 'إلغاء هذا التعيين؟')} onClose={closeRevocation} footer={<><Button disabled={busy} onClick={closeRevocation}>{tr('Annuler', 'Cancel', 'إلغاء')}</Button><Button variant="primary" disabled={busy} onClick={() => revoke(revoking)}>{busy ? tr('Révocation…', 'Revoking…', 'جارٍ الإلغاء…') : tr('Révoquer la nomination', 'Revoke appointment', 'إلغاء التعيين')}</Button></>}><div className="stack"><p className="admin-modal-description"><strong dir="auto">{accountName(revoking)}</strong><br />{tr('Les permissions sélectionnées seront retirées et les sessions du compte seront révoquées.', 'This appointment’s permissions will be removed and the account’s sessions revoked.', 'ستُسحب صلاحيات هذا التعيين وتُلغى جلسات الحساب.')}</p>{actionError && <p className="admin-form-error" role="alert">{actionError}</p>}</div></Modal>}
  </div>;
}
