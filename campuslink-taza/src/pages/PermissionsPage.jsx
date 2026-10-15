import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { FACULTIES } from '../data/mock';
import { getFiliere, getFilieres } from '../data/studies';
import { Button, EmptyState, Field, PageHeader } from '../components/ui';
import { Select } from '../components/Select';
import './admin.css';

const CAPS = ['content.moderate', 'resource.manage', 'resource.upload', 'announcement.publish', 'student.support', 'feedback.manage', 'channel.manage'];

export default function PermissionsPage() {
  const { tr, notify, user } = useApp();
  const [params] = useSearchParams();
  const [users, setUsers] = useState([]), [appointments, setAppointments] = useState([]);
  const [target, setTarget] = useState(params.get('user') || ''), [role, setRole] = useState('faculty_admin');
  const [filiere, setFiliere] = useState(''), [caps, setCaps] = useState([]);
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([api('/admin'), api('/admin/appointments')]).then(([accounts, access]) => {
      if (live) {
        setUsers(accounts.users.filter(account => String(account.id) !== String(user.id)));
        setAppointments(access.appointments);
        setError('');
      }
    }).catch(failure => { if (live) setError(failure.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [revision]);

  const student = users.find(account => String(account.id) === target);
  const programs = getFilieres(student?.faculty_id);
  const capabilityLabels = {
    'content.moderate': tr('Modérer les contenus', 'Moderate content', 'الإشراف على المحتوى'),
    'resource.manage': tr('Gérer les documents', 'Manage documents', 'إدارة المستندات'),
    'resource.upload': tr('Déposer dans tous les semestres de la filière', 'Upload across the programme’s semesters', 'الرفع في فصول المسلك'),
    'announcement.publish': tr('Publier des annonces', 'Publish announcements', 'نشر الإعلانات'),
    'student.support': tr('Assister les comptes étudiants', 'Support student accounts', 'مساعدة حسابات الطلبة'),
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
    if (busy || !student) return;
    setBusy(true);
    try {
      await api('/admin/appointments', { method: 'POST', body: { user_id: target, role, faculty_id: student.faculty_id, filiere_id: filiere || null, capabilities: caps } });
      setRevision(value => value + 1);
      notify(tr('Nomination enregistrée.', 'Appointment saved.', 'تم حفظ التعيين.'));
    } catch (failure) { notify(failure.message, 'error'); }
    finally { setBusy(false); }
  }

  async function revoke(appointment) {
    setBusy(true);
    try {
      await api('/admin/appointments/' + appointment.id, { method: 'DELETE' });
      setRevision(value => value + 1);
    } catch (failure) { notify(failure.message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="permissions-page" aria-busy={loading || busy}>
    <PageHeader eyebrow={tr('AUTORISATIONS', 'AUTHORIZATION', 'التفويضات')} title={tr('Nominations et permissions', 'Appointments and permissions', 'التعيينات والصلاحيات')} description={tr('Attribuez des responsabilités explicites dans un établissement et une filière. Les nominations protégées sont réservées au propriétaire.', 'Assign explicit responsibilities within a faculty and programme. Protected appointments are managed by the owner.', 'امنح مسؤوليات محددة داخل كلية ومسلك. يدير المالك التعيينات المحمية.')} />
    {error ? <div className="admin-server-error"><p role="alert">{error}</p><Button onClick={() => setRevision(value => value + 1)}>{tr('Réessayer', 'Retry', 'إعادة المحاولة')}</Button></div> : loading ? <p className="admin-loading-status" role="status">{tr('Chargement des permissions…', 'Loading permissions…', 'جارٍ تحميل الصلاحيات…')}</p> : <>
      <form className="card permissions-form" onSubmit={grant}>
        <div className="permissions-fields">
          <Field label={tr('Compte', 'Account', 'الحساب')}><Select required disabled={busy} value={target} onChange={event => { setTarget(event.target.value); setFiliere(''); }}><option value="">{tr('Choisissez un compte', 'Choose an account', 'اختر حسابًا')}</option>{users.map(account => <option key={account.id} value={account.id}>{account.name} · @{account.username}</option>)}</Select></Field>
          <Field label={tr('Responsabilité', 'Responsibility', 'المسؤولية')}><Select disabled={busy} value={role} onChange={event => { setRole(event.target.value); setCaps([]); }}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
          <Field label={tr('Filière autorisée', 'Authorized programme', 'المسلك المخول')}><Select disabled={busy || !student} value={filiere} onChange={event => setFiliere(event.target.value)}><option value="">{tr('Faculté entière (hors dépôts)', 'Whole faculty (uploads excluded)', 'كل الكلية (باستثناء الرفع)')}</option>{programs.map(program => <option value={program.id} key={program.id}>{program.name}</option>)}</Select></Field>
        </div>
        <fieldset className="permissions-capabilities" disabled={busy}>
          <legend>{tr('Permissions explicites', 'Explicit permissions', 'صلاحيات محددة')}</legend>
          <div>{CAPS.filter(capability => role !== 'faculty_leader' || ['content.moderate', 'student.support'].includes(capability)).map(capability => <label className={`permissions-capability ${caps.includes(capability) ? 'selected' : ''}`} key={capability}><input type="checkbox" checked={caps.includes(capability)} onChange={event => setCaps(values => event.target.checked ? [...values, capability] : values.filter(value => value !== capability))} /><span>{capabilityLabels[capability]}</span></label>)}</div>
        </fieldset>
        <Button type="submit" icon={ShieldCheck} variant="primary" disabled={busy || !student || !caps.length}>{busy ? tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : tr('Accorder la nomination', 'Grant appointment', 'منح التعيين')}</Button>
      </form>
      <section className="admin-subsection" aria-labelledby="permissions-appointments-title">
        <div className="admin-section-header"><div><h2 id="permissions-appointments-title">{tr('Nominations enregistrées', 'Saved appointments', 'التعيينات المحفوظة')}</h2></div><span className="admin-status">{appointments.length}</span></div>
        {!appointments.length ? <div className="card"><EmptyState icon={ShieldCheck} title={tr('Aucune nomination', 'No appointments', 'لا توجد تعيينات')} description={tr('Les responsabilités accordées apparaîtront ici.', 'Granted responsibilities will appear here.', 'ستظهر المسؤوليات الممنوحة هنا.')} /></div> : <div className="permissions-appointments">{appointments.map(appointment => <article className="card permissions-appointment" key={appointment.id}>
          <div className="permissions-appointment-heading"><div><strong dir="auto">{users.find(account => Number(account.id) === Number(appointment.user_id))?.name || '#' + appointment.user_id}</strong>{appointment.role && <span>{roleLabels[appointment.role] || appointment.role}</span>}</div><span className={`admin-status ${appointment.revoked_at ? 'revoked' : 'active'}`}>{appointment.revoked_at ? tr('Révoquée', 'Revoked', 'ملغاة') : tr('Active', 'Active', 'مفعّلة')}</span></div>
          <p className="permissions-appointment-context">{FACULTIES.find(faculty => faculty.id === appointment.faculty_id)?.name || appointment.faculty_id}{appointment.filiere_id && <> · {getFiliere(appointment.filiere_id)?.name || appointment.filiere_id}</>}</p>
          <ul className="permissions-granted-list">{appointment.capabilities.map(capability => <li key={capability}>{capabilityLabels[capability] || capability}</li>)}</ul>
          {!appointment.revoked_at && <div className="permissions-appointment-actions"><Button disabled={busy} onClick={() => revoke(appointment)}>{tr('Révoquer cette nomination', 'Revoke appointment', 'إلغاء التعيين')}</Button></div>}
        </article>)}</div>}
      </section>
    </>}
  </div>;
}
