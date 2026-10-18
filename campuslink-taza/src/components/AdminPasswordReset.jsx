import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { Button, Field, Modal } from './ui';
import './admin-password-reset.css';

function newOperationId() { return globalThis.crypto.randomUUID(); }
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-=?';
  const characters = [];
  const limit = 256 - (256 % alphabet.length);
  while (characters.length < 20) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    for (const value of bytes) {
      if (value < limit) characters.push(alphabet[value % alphabet.length]);
      if (characters.length === 20) break;
    }
  }
  return characters.join('');
}

export default function AdminPasswordReset({ account, contact, onClose, onSuccess }) {
  const { user, tr, language } = useApp();
  const formId = useId();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState('draft');
  const [expiresAt, setExpiresAt] = useState(null);
  const operationId = useRef(newOperationId());
  const request = useRef(null);
  const submitted = useRef(null);
  const alive = useRef(true);
  const identity = `${user?.id}:${account.id}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const owner = (user?.serverRole || user?.role) === 'global_admin';
  const eligible = owner && account.can_reset_password === true && account.role === 'student' && account.account_status === 'approved' && !account.disabled && String(account.id) !== String(user?.id);
  const unresolved = phase === 'unknown' || phase === 'pending';
  const locked = busy || unresolved || phase === 'failed';
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function erase() {
    request.current?.abort();
    request.current = null;
    submitted.current = null;
    setPassword(''); setReceipt(''); setVisible(false); setCopied(false); setExpiresAt(null);
  }
  function close() { erase(); closeRef.current(); }
  useEffect(() => {
    alive.current = true;
    const clear = () => { erase(); closeRef.current(); };
    window.addEventListener('campus-session-cleared', clear);
    return () => {
      alive.current = false;
      request.current?.abort();
      request.current = null;
      window.removeEventListener('campus-session-cleared', clear);
    };
  }, []);
  useEffect(() => {
    if (!eligible) close();
  }, [eligible]);
  useEffect(() => {
    erase(); setReason(''); setVerified(false); setError(''); setBusy(false); setPhase('draft');
    operationId.current = newOperationId();
  }, [identity]);

  function editPassword(value) {
    if (locked) return;
    setPassword(value); setError(''); operationId.current = newOperationId();
  }
  function newAttempt() {
    submitted.current = null; operationId.current = newOperationId();
    setPhase('draft'); setError(''); setPassword(''); setReason(''); setVerified(false);
  }
  function generate() {
    try { editPassword(generatePassword()); }
    catch { setError(tr('La génération sécurisée est indisponible. Saisissez un mot de passe.', 'Secure generation is unavailable. Enter a password.', 'تعذّر التوليد الآمن. أدخل كلمة مرور.')); }
  }
  async function submit(event) {
    event.preventDefault();
    if (request.current || !eligible || !verified || phase === 'failed') return;
    if (password.length < 16 || password.length > 128) {
      setError(tr('Utilisez entre 16 et 128 caractères.', 'Use between 16 and 128 characters.', 'استخدم بين 16 و128 حرفاً.')); return;
    }
    if (reason.trim().length < 10) {
      setError(tr('Décrivez la demande vérifiée en au moins 10 caractères.', 'Describe the verified request using at least 10 characters.', 'صف الطلب الذي تحققت منه في 10 أحرف على الأقل.')); return;
    }
    if (reason.includes(password)) {
      setError(tr('Retirez le mot de passe du motif avant de continuer.', 'Remove the password from the reason before continuing.', 'احذف كلمة المرور من السبب قبل المتابعة.')); return;
    }
    const controller = new AbortController();
    const actor = identity;
    const body = submitted.current || { temporary_password: password, reason: reason.trim(), operation_id: operationId.current, identity_verified: true, ...(contact?.user_id && String(contact.user_id) === String(account.id) ? { contact_id: Number(contact.id) } : {}) };
    const temporaryPassword = body.temporary_password;
    submitted.current = body;
    request.current = controller; setBusy(true); setError('');
    try {
      const result = await api(`/admin/users/${account.id}/password-reset`, {
        method: 'POST', signal: controller.signal, timeout: 60000,
        body,
      });
      if (controller.signal.aborted || !alive.current || currentIdentity.current !== actor) return;
      if (result.ok !== true || result.must_change_password !== true) throw Object.assign(new Error(tr('La réinitialisation n’a pas été confirmée.', 'The password reset was not confirmed.', 'لم يتم تأكيد إعادة تعيين كلمة المرور.')), { code: 'PASSWORD_RESET_UNKNOWN' });
      submitted.current = null;
      setPhase('confirmed'); setReceipt(temporaryPassword); setPassword(''); setVisible(false); setCopied(false);
      setExpiresAt(result.expires_at || null);
      onSuccess?.(result);
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && currentIdentity.current === actor) {
        const code = failure.data?.code || failure.code;
        const pending = code === 'PASSWORD_RESET_PENDING';
        const definitive = ['AUTH_ADMIN_CONFIGURATION', 'AUTH_ADMIN_SESSION_EXPIRED', 'AUTH_OPERATION_FAILED'].includes(code);
        const uncertain = !definitive && (pending || code === 'PASSWORD_RESET_UNKNOWN' || !failure.status || failure.status >= 500);
        setPhase(pending ? 'pending' : uncertain ? 'unknown' : 'failed');
        setError(failure.message);
        if (!uncertain) { submitted.current = null; setPassword(''); setVerified(false); }
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current && currentIdentity.current === actor && !controller.signal.aborted) setBusy(false);
    }
  }
  async function copy() {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(receipt);
      if (alive.current) { setCopied(true); setError(''); }
    } catch {
      setError(tr('Copie indisponible. Affichez le mot de passe et copiez-le manuellement.', 'Copy is unavailable. Show the password and copy it manually.', 'النسخ غير متاح. أظهر كلمة المرور وانسخها يدوياً.'));
    }
  }

  if (!eligible) return null;
  return <Modal className="admin-password-reset" title={tr('Réinitialiser le mot de passe', 'Reset password', 'إعادة تعيين كلمة المرور')} onClose={close} footer={<>
    <Button className="close-control" onClick={close}>{receipt ? tr('Fermer et effacer', 'Close and clear', 'إغلاق ومسح') : tr('Annuler', 'Cancel', 'إلغاء')}</Button>
    {!receipt && (phase === 'failed' || phase === 'unknown') && <Button variant={phase === 'failed' ? 'primary' : 'secondary'} disabled={busy} onClick={newAttempt}>{tr('Commencer une nouvelle tentative', 'Start a new attempt', 'بدء محاولة جديدة')}</Button>}
    {!receipt && phase !== 'failed' && <Button variant="primary" icon={KeyRound} type="submit" form={formId} disabled={busy || !verified || password.length < 16 || reason.trim().length < 10}>{busy ? tr('Réinitialisation…', 'Resetting…', 'جارٍ إعادة التعيين…') : unresolved ? tr('Vérifier cette tentative', 'Check this attempt', 'التحقق من هذه المحاولة') : tr('Créer le mot de passe temporaire', 'Set temporary password', 'إنشاء كلمة مرور مؤقتة')}</Button>}
  </>}>
    <div className="admin-password-person"><KeyRound size={22} /><div><strong dir="auto">{account.name}</strong><span dir="ltr">@{account.username}</span></div></div>
    {receipt ? <div className="stack">
      <p className="admin-password-confirmed" role="status"><Check size={17} />{tr('Le mot de passe temporaire est actif.', 'The temporary password is active.', 'كلمة المرور المؤقتة مفعّلة.')} </p>
      <Field label={tr('Mot de passe temporaire', 'Temporary password', 'كلمة المرور المؤقتة')}><input className="input admin-password-secret" type={visible ? 'text' : 'password'} value={receipt} readOnly autoComplete="off" spellCheck={false} dir="ltr" /></Field>
      <div className="admin-password-tools"><Button icon={visible ? EyeOff : Eye} onClick={() => setVisible(value => !value)}>{visible ? tr('Masquer', 'Hide', 'إخفاء') : tr('Afficher', 'Show', 'إظهار')}</Button><Button icon={copied ? Check : Copy} onClick={copy}>{copied ? tr('Copié', 'Copied', 'تم النسخ') : tr('Copier', 'Copy', 'نسخ')}</Button></div>
      <p className="muted admin-password-note">{tr('Transmettez-le directement à l’étudiant après vérification de son identité. Il devra choisir son propre mot de passe à sa prochaine connexion. Le fermer efface cette copie.', 'Give it directly to the student after verifying their identity. They must choose their own password at the next sign-in. Closing clears this copy.', 'سلّمها مباشرة للطالب بعد التحقق من هويته. يجب عليه اختيار كلمة مرور خاصة عند الدخول القادم. الإغلاق يمسح هذه النسخة.')}</p>
      {expiresAt && Number.isFinite(Date.parse(expiresAt)) && <p className="muted admin-password-note">{tr('Accès temporaire valable jusqu’au', 'Temporary access expires at', 'تنتهي صلاحية الوصول المؤقت في')} <bdi>{new Date(expiresAt).toLocaleString({ fr: 'fr-FR', en: 'en-GB', ar: 'ar-MA' }[language] || 'fr-FR', { timeZone: 'Africa/Casablanca' })}</bdi>.</p>}
    </div> : <form id={formId} className="stack" onSubmit={submit}>
      <p className="muted admin-password-note">{tr('Créez un accès temporaire pour une demande vérifiée. Les sessions de ce compte seront révoquées et l’étudiant devra changer son mot de passe.', 'Create temporary access for a verified request. This account’s sessions will be revoked and the student must change their password.', 'أنشئ وصولاً مؤقتاً لطلب تم التحقق منه. ستُلغى جلسات الحساب ويجب على الطالب تغيير كلمة مروره.')}</p>
      {contact && <p className="admin-password-ticket">{tr('Demande liée', 'Linked request', 'الطلب المرتبط')} #{contact.id} · <bdi>{contact.subject || contact.reason}</bdi></p>}
      <Field label={tr('Nouveau mot de passe temporaire', 'New temporary password', 'كلمة المرور المؤقتة الجديدة')} hint={tr('16 à 128 caractères. Il sera disponible après confirmation du serveur.', '16–128 characters. It becomes available after server confirmation.', 'بين 16 و128 حرفاً. ستتوفر بعد تأكيد الخادم.')}><input className="input admin-password-secret" type="password" value={password} onChange={event => editPassword(event.target.value)} disabled={locked} autoComplete="new-password" minLength={16} maxLength={128} required spellCheck={false} dir="ltr" /></Field>
      <Button type="button" icon={RefreshCw} disabled={locked} onClick={generate}>{tr('Générer un mot de passe sécurisé', 'Generate a secure password', 'توليد كلمة مرور آمنة')}</Button>
      <Field label={tr('Motif de la réinitialisation', 'Reason for reset', 'سبب إعادة التعيين')} hint={tr('Décrivez la demande, sans écrire le mot de passe.', 'Describe the request without including the password.', 'صف الطلب دون كتابة كلمة المرور.')}><textarea className="input" rows={3} value={reason} onChange={event => { setReason(event.target.value); operationId.current = newOperationId(); }} minLength={10} maxLength={500} required disabled={locked} /></Field>
      <label className="admin-password-verification"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} disabled={locked} /><span>{tr('J’ai vérifié la demande et l’identité du titulaire de ce compte.', 'I verified the request and the identity of this account’s owner.', 'تحققت من الطلب وهوية صاحب هذا الحساب.')}</span></label>
      {unresolved && <p className="admin-password-pending" role="status">{tr('Le résultat reste à confirmer. Ne transmettez aucun mot de passe. Vérifiez cette même tentative avant de poursuivre.', 'The result still needs confirmation. Do not share a password. Check this same attempt before continuing.', 'ما تزال النتيجة بحاجة إلى تأكيد. لا تسلّم أي كلمة مرور. تحقّق من هذه المحاولة قبل المتابعة.')}</p>}
      {phase === 'unknown' && <p className="muted admin-password-note">{tr('Une nouvelle tentative remplace l’accès précédent après confirmation et efface cette saisie. Le résultat de la précédente reste inconnu.', 'A new attempt replaces the previous access after confirmation and clears this entry. The previous result remains unknown.', 'تستبدل المحاولة الجديدة الوصول السابق بعد التأكيد وتمسح هذا الإدخال. تظل نتيجة المحاولة السابقة غير معروفة.')}</p>}
      {phase === 'failed' && <p className="admin-password-pending" role="status">{tr('Cette tentative a été refusée. Aucun mot de passe à transmettre. Corrigez la cause puis commencez une nouvelle tentative.', 'This attempt was rejected. There is no password to share. Address the cause, then start a new attempt.', 'تم رفض هذه المحاولة. لا توجد كلمة مرور لتسليمها. عالج السبب ثم ابدأ محاولة جديدة.')}</p>}
      {busy && <p className="muted admin-password-note" role="status">{tr('Gardez ce formulaire ouvert pour récupérer le mot de passe après confirmation.', 'Keep this form open to receive the password after confirmation.', 'أبقِ هذا النموذج مفتوحاً لاستلام كلمة المرور بعد التأكيد.')}</p>}
    </form>}
    {error && <p className="admin-form-error" role="alert">{error}</p>}
  </Modal>;
}
