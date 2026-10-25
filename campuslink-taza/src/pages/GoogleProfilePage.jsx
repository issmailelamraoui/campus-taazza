import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { accountDestination } from '../lib/backend';
import { Select } from '../components/Select';
import { Badge, Button, Field } from '../components/ui';
import { googleErrorMessage } from '../components/GoogleAuth';
import { PublicHeader, PublicFooter } from './PublicPages';
import './public.css';

export default function GoogleProfilePage() {
  const { tr, user, selection, completeGoogleProfile } = useApp();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null), [faculties, setFaculties] = useState([]);
  const [form, setForm] = useState({ name: '', username: '', faculty_id: '', filiere_id: '', current_semester: '1' });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const request = useRef(false);
  useEffect(() => {
    if (user) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setProfile(null);
    Promise.all([
      api('/auth/google/profile', { signal: controller.signal }),
      api('/registration-options', { signal: controller.signal }),
    ]).then(([identity, options]) => {
      if (controller.signal.aborted) return;
      if (!identity.profile?.email || !options.faculties?.length) throw new Error(tr('Votre profil n’a pas pu être chargé. Réessayez.', 'Your profile could not be loaded. Try again.', 'تعذر تحميل ملفك. حاول مجددًا.'));
      setProfile(identity.profile); setFaculties(options.faculties);
      setForm(previous => ({ ...previous, name: previous.name || identity.profile.name || '' }));
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.data?.code ? googleErrorMessage(error.data.code, tr) : error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user?.id, retry]);
  if (user) return <Navigate to={accountDestination(user, selection)} replace />;
  const field = (name, value) => setForm(previous => ({ ...previous, [name]: value, ...(name === 'faculty_id' ? { filiere_id: '' } : {}) }));
  const filieres = faculties.find(faculty => faculty.id === form.faculty_id)?.filieres || [];
  const submit = async event => {
    event.preventDefault();
    if (request.current || loading || !profile || !form.faculty_id || !form.filiere_id) return;
    request.current = true; setBusy(true); setError('');
    try {
      await completeGoogleProfile({ ...form, name: form.name.trim(), username: form.username.trim(), current_semester: Number(form.current_semester) });
      navigate('/account-review', { replace: true });
    } catch (error) {
      setError(error.data?.code ? googleErrorMessage(error.data.code, tr) : error.message);
    } finally { request.current = false; setBusy(false); }
  };
  return <div className="public-page google-profile-page"><PublicHeader /><main className="onboarding-main"><header className="onboarding-heading"><Badge>{tr('INSCRIPTION ÉTUDIANTE', 'STUDENT REGISTRATION', 'تسجيل الطلبة')}</Badge><h1>{tr('Complétez votre\nprofil étudiant.', 'Complete your\nstudent profile.', 'أكمل\nملفك الدراسي.')}</h1><p>{tr('Votre adresse Google est confirmée. Ajoutez vos informations universitaires pour envoyer votre demande à l’administration.', 'Your Google address is verified. Add your academic information to send your application to administration.', 'تم تأكيد بريدك لدى Google. أضف معلوماتك الجامعية لإرسال طلبك إلى الإدارة.')}</p></header><section className="onboarding-confirmation google-profile-card" aria-busy={loading || busy}>{loading ? <p role="status">{tr('Chargement du profil…', 'Loading your profile…', 'جارٍ تحميل الملف…')}</p> : profile && <form className="login-form" onSubmit={submit}><Field label={tr('Adresse académique vérifiée', 'Verified academic email', 'البريد الجامعي المؤكد')}><input className="input" id="google-profile-email" type="email" value={profile.email} readOnly dir="ltr" /></Field><Field label={tr('Nom complet', 'Full name', 'الاسم الكامل')}><input className="input" id="google-profile-name" name="name" required minLength={2} maxLength={100} autoComplete="name" disabled={busy} value={form.name} onChange={event => field('name', event.target.value)} /></Field><Field label={tr('Nom d’utilisateur', 'Username', 'اسم المستخدم')}><input className="input" id="google-profile-username" name="username" required minLength={3} maxLength={40} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy} value={form.username} onChange={event => field('username', event.target.value)} /></Field><Field label={tr('Faculté', 'Faculty', 'الكلية')}><Select className="input" id="google-profile-faculty" required disabled={busy} value={form.faculty_id} onChange={event => field('faculty_id', event.target.value)}><option value="">{tr('Choisissez votre faculté', 'Choose your faculty', 'اختر كليتك')}</option>{faculties.map(faculty => <option key={faculty.id} value={faculty.id}>{faculty.name}</option>)}</Select></Field><Field label={tr('Filière', 'Programme', 'المسلك')}><Select className="input" id="google-profile-filiere" required disabled={busy || !form.faculty_id} value={form.filiere_id} onChange={event => field('filiere_id', event.target.value)}><option value="">{tr('Choisissez votre filière', 'Choose your programme', 'اختر مسلكك')}</option>{filieres.map(filiere => <option key={filiere.id} value={filiere.id}>{filiere.name}</option>)}</Select></Field><Field label={tr('Semestre actuel', 'Current semester', 'الفصل الحالي')}><Select className="input" id="google-profile-semester" disabled={busy} value={form.current_semester} onChange={event => field('current_semester', event.target.value)}>{[1, 2, 3, 4, 5, 6].map(semester => <option key={semester} value={semester}>S{semester}</option>)}</Select></Field><div className="onboarding-lock-note"><ShieldCheck size={20} /><p>{tr('Votre demande restera en attente jusqu’à sa validation par un administrateur. Choisissez votre faculté et votre filière avec soin.', 'Your application will remain pending until an administrator approves it. Choose your faculty and programme carefully.', 'يبقى طلبك قيد المراجعة إلى أن يوافق عليه مسؤول. اختر كليتك ومسلكك بعناية.')}</p></div><Button className="login-submit" type="submit" variant="primary" icon={ArrowRight} disabled={busy || !form.faculty_id || !form.filiere_id} aria-busy={busy}>{busy ? tr('Envoi de la demande…', 'Submitting application…', 'جارٍ إرسال الطلب…') : tr('Envoyer ma demande', 'Submit my application', 'إرسال طلبي')}</Button></form>}{error && <p className="public-form-error" role="alert">{error}</p>}{!loading && (!profile || !faculties.length) && <Button onClick={() => setRetry(value => value + 1)}>{tr('Réessayer', 'Retry', 'إعادة المحاولة')}</Button>}<Link className="text-link google-profile-back" to="/login">{tr('Retour à la connexion', 'Back to sign in', 'العودة إلى تسجيل الدخول')}</Link></section></main><PublicFooter /></div>;
}
