import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, Eye, EyeOff, Mail, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { Button, Field } from './ui';
import './password-recovery.css';

export default function PasswordRecovery({ email: accountEmail = '', disabled = false, onBusyChange }) {
  const { tr } = useApp(), id = useId();
  const [email, setEmail] = useState(accountEmail), [code, setCode] = useState('');
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [visible, setVisible] = useState(false);
  const [step, setStep] = useState('email'), [phase, setPhase] = useState(''), [error, setError] = useState(''), [invalid, setInvalid] = useState('');
  const [retryAt, setRetryAt] = useState(0), [blockedUntil, setBlockedUntil] = useState(0), [seconds, setSeconds] = useState(0), [blockedSeconds, setBlockedSeconds] = useState(0), [uncertain, setUncertain] = useState(false);
  const request = useRef(false), alive = useRef(true), codeInput = useRef(null), errorBox = useRef(null), emailInput = useRef(null), passwordInput = useRef(null), confirmationInput = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (step === 'code') codeInput.current?.focus(); }, [step]);
  useEffect(() => {
    if (!retryAt && !blockedUntil) { setSeconds(0); setBlockedSeconds(0); return; }
    const update = () => { setSeconds(Math.max(0, Math.ceil((Math.max(retryAt, blockedUntil) - Date.now()) / 1000))); setBlockedSeconds(Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000))); };
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [retryAt, blockedUntil]);
  const busy = Boolean(phase), locked = busy || disabled;
  const text = {
    email: tr('Adresse universitaire', 'Academic email address', 'البريد الجامعي'),
    code: tr('Code à 6 chiffres', '6-digit code', 'الرمز المكوّن من 6 أرقام'),
    password: tr('Nouveau mot de passe', 'New password', 'كلمة المرور الجديدة'),
    confirmation: tr('Confirmer le nouveau mot de passe', 'Confirm new password', 'تأكيد كلمة المرور الجديدة'),
  };
  function clearError() { setError(''); setInvalid(''); }
  function validation(message, field, ref) { setError(message); setInvalid(field); ref.current?.focus(); }
  function failureMessage(failure) {
    const key = failure.data?.code;
    if (key === 'PASSWORD_RECOVERY_RATE_LIMITED') {
      setBlockedUntil(Date.now() + Math.min(900, Math.max(1, Number(failure.data?.retryAfter) || 60)) * 1000);
      return tr('Trop de tentatives. Patientez avant de réessayer.', 'Too many attempts. Wait before trying again.', 'محاولات كثيرة. انتظر قبل إعادة المحاولة.');
    }
    if (key === 'PASSWORD_RECOVERY_INVALID') return step === 'email'
      ? tr('Utilisez votre adresse universitaire autorisée.', 'Use your authorised academic email address.', 'استعمل بريدك الجامعي المسموح به.')
      : tr('Le code est incorrect ou a expiré. Vérifiez-le ou demandez-en un nouveau.', 'The code is incorrect or expired. Check it or request a new one.', 'الرمز غير صحيح أو انتهت صلاحيته. تحقّق منه أو اطلب رمزًا جديدًا.');
    if (key === 'PASSWORD_RECOVERY_UNKNOWN') {
      setUncertain(true);
      return tr('Le résultat du changement n’a pas pu être confirmé. Essayez de vous connecter avec votre nouveau mot de passe avant de recommencer.', 'The password change could not be confirmed. Try signing in with your new password before starting again.', 'تعذّر تأكيد نتيجة التغيير. جرّب الدخول بكلمة المرور الجديدة قبل إعادة المحاولة.');
    }
    return tr('La récupération est momentanément indisponible. Réessayez dans un instant.', 'Password recovery is currently unavailable. Try again shortly.', 'استرجاع كلمة المرور غير متاح حاليًا. أعد المحاولة بعد قليل.');
  }
  async function send(event) {
    event?.preventDefault();
    if (request.current || locked || seconds > 0) return;
    const address = (accountEmail || email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return validation(tr('Indiquez votre adresse universitaire complète.', 'Enter your complete academic email address.', 'أدخل بريدك الجامعي كاملًا.'), 'email', emailInput);
    request.current = true; setPhase('sending'); setCode(''); setPassword(''); setConfirmation(''); setVisible(false); clearError(); onBusyChange?.(true);
    try {
      const result = await api('/auth/password-recovery/start', { method: 'POST', body: { email: address } });
      if (result.success !== true) throw new Error('Unconfirmed recovery');
      if (alive.current) { setEmail(address); setCode(''); setStep('code'); setRetryAt(Date.now() + 60000); }
    } catch (failure) { if (alive.current) { setError(failureMessage(failure)); setTimeout(() => errorBox.current?.focus(), 0); } }
    finally { request.current = false; if (alive.current) setPhase(''); onBusyChange?.(false); }
  }
  async function complete(event) {
    event.preventDefault();
    if (request.current || locked || uncertain || blockedSeconds > 0) return;
    if (!/^\d{6}$/.test(code)) return validation(tr('Saisissez les 6 chiffres du code reçu.', 'Enter all 6 digits of the code you received.', 'أدخل أرقام الرمز الستة التي وصلتك.'), 'code', codeInput);
    if (password.length < 8 || password.length > 128) return validation(tr('Choisissez un mot de passe de 8 à 128 caractères.', 'Choose a password of 8–128 characters.', 'اختر كلمة مرور من 8 إلى 128 حرفًا.'), 'password', passwordInput);
    if (password !== confirmation) return validation(tr('Les mots de passe ne correspondent pas.', 'The passwords do not match.', 'كلمتا المرور غير متطابقتين.'), 'confirmation', confirmationInput);
    request.current = true; setPhase('saving'); clearError(); onBusyChange?.(true);
    try {
      const result = await api('/auth/password-recovery/complete', { method: 'POST', timeout: 60000, body: { email, code, newPassword: password } });
      if (result.success !== true) throw Object.assign(new Error('Unconfirmed recovery'), { data: { code: 'PASSWORD_RECOVERY_UNKNOWN' } });
      if (alive.current) { setPassword(''); setConfirmation(''); setCode(''); setVisible(false); setStep('done'); }
    } catch (failure) {
      // A lost response can follow a committed password change. Never invite
      // another mutation until the user has tried the new password.
      const outcome = failure.data?.code ? failure : { data: { code: 'PASSWORD_RECOVERY_UNKNOWN' } };
      if (alive.current) { setError(failureMessage(outcome)); setCode(''); setPassword(''); setConfirmation(''); setVisible(false); setTimeout(() => errorBox.current?.focus(), 0); }
    } finally { request.current = false; if (alive.current) setPhase(''); onBusyChange?.(false); }
  }
  if (step === 'done') return <div className="password-recovery-done" role="status"><span className="password-recovery-check"><Check size={25} aria-hidden="true"/></span><h2>{tr('Votre mot de passe est prêt.', 'Your password is ready.', 'كلمة المرور الجديدة جاهزة.')}</h2><p>{tr('Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.', 'You can now sign in with your new password.', 'يمكنك الآن الدخول بكلمة المرور الجديدة.')}</p><a className="btn btn-primary" href="/login">{tr('Se connecter', 'Sign in', 'تسجيل الدخول')}<ArrowRight size={17} aria-hidden="true"/></a></div>;
  return <div className="password-recovery" aria-busy={busy}>
    <ol className="password-recovery-steps" aria-label={tr('Étapes de récupération', 'Recovery steps', 'خطوات الاسترجاع')}><li className={step === 'email' ? 'current' : 'complete'} aria-current={step === 'email' ? 'step' : undefined}><span>{step === 'email' ? '1' : <Check size={13} aria-hidden="true"/>}</span>{tr('Votre e-mail', 'Your email', 'بريدك الجامعي')}</li><li className={step === 'code' ? 'current' : ''} aria-current={step === 'code' ? 'step' : undefined}><span>2</span>{tr('Votre nouveau mot de passe', 'Your new password', 'كلمة المرور الجديدة')}</li></ol>
    <form noValidate onSubmit={step === 'email' ? send : complete} className="password-recovery-form">
      {step === 'email' ? <><p className="password-recovery-intro">{tr('Recevez un code dans votre boîte universitaire pour choisir un nouveau mot de passe.', 'Receive a code in your academic inbox to choose a new password.', 'توصّل برمز في بريدك الجامعي لاختيار كلمة مرور جديدة.')}</p><Field label={text.email}><input id={`${id}-email`} ref={emailInput} className="input" type="email" name="recoveryEmail" autoComplete="email" autoCapitalize="none" spellCheck={false} dir="ltr" placeholder="vous@usmba.ac.ma" maxLength={160} value={accountEmail || email} readOnly={Boolean(accountEmail)} required disabled={locked} aria-invalid={invalid === 'email'} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setEmail(event.target.value); clearError(); }}/></Field></> : <><div className="password-recovery-delivery"><Mail size={20} aria-hidden="true"/><div><strong>{tr('Consultez votre boîte universitaire', 'Check your academic inbox', 'راجع بريدك الجامعي')}</strong><bdi dir="ltr">{email}</bdi><p role="status">{tr('Si cette adresse correspond à un compte, un code lui a été envoyé. Pensez aux courriers indésirables.', 'If this address matches an account, a code has been sent. Check your spam folder too.', 'إذا كان هذا البريد مرتبطًا بحساب، فقد أُرسل إليه رمز. تحقّق أيضًا من البريد غير المرغوب فيه.')}</p></div></div><Field label={text.code}><input id={`${id}-code`} ref={codeInput} className="input password-recovery-code" name="recoveryCode" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} pattern="[0-9]{6}" value={code} required disabled={locked || uncertain} aria-invalid={invalid === 'code'} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6)); clearError(); }}/></Field><Field label={text.password} hint={tr('8 caractères minimum. Les chiffres seuls sont acceptés.', 'At least 8 characters. Digits only are accepted.', '8 أحرف على الأقل. يمكن استعمال الأرقام فقط.')}><div className="password-recovery-password"><input id={`${id}-password`} ref={passwordInput} className="input" type={visible ? 'text' : 'password'} name="newPassword" autoComplete="new-password" minLength={8} maxLength={128} value={password} required disabled={locked || uncertain} aria-invalid={invalid === 'password'} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setPassword(event.target.value); clearError(); }}/><button type="button" disabled={locked || uncertain} aria-pressed={visible} aria-label={visible ? tr('Masquer le mot de passe', 'Hide password', 'إخفاء كلمة المرور') : tr('Afficher le mot de passe', 'Show password', 'عرض كلمة المرور')} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></Field><Field label={text.confirmation}><input id={`${id}-confirmation`} ref={confirmationInput} className="input" type={visible ? 'text' : 'password'} name="confirmation" autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} required disabled={locked || uncertain} aria-invalid={invalid === 'confirmation'} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setConfirmation(event.target.value); clearError(); }}/></Field></>}
      {error && <p id={`${id}-error`} className="public-form-error" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}
      {uncertain ? <a className="btn btn-primary" href="/login">{tr('Essayer de me connecter', 'Try signing in', 'محاولة الدخول')}</a> : <Button variant="primary" type="submit" icon={step === 'email' ? Mail : Check} disabled={locked || blockedSeconds > 0 || (step === 'email' && seconds > 0)}>{phase === 'sending' ? tr('Envoi du code…', 'Sending code…', 'جارٍ إرسال الرمز…') : phase === 'saving' ? tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : step === 'email' ? tr('Recevoir le code', 'Send me the code', 'إرسال الرمز') : tr('Enregistrer mon mot de passe', 'Save my password', 'حفظ كلمة المرور')}</Button>}
      {step === 'code' && !uncertain && <div className="password-recovery-actions"><Button type="button" variant="ghost" icon={RefreshCw} disabled={locked || seconds > 0} onClick={send}>{seconds > 0 ? tr(`Renvoyer dans ${seconds} s`, `Resend in ${seconds}s`, `إرسال بعد ${seconds}ث`) : tr('Renvoyer le code', 'Resend code', 'إعادة إرسال الرمز')}</Button>{!accountEmail && <Button type="button" variant="ghost" disabled={locked} onClick={() => { setStep('email'); setCode(''); setPassword(''); setConfirmation(''); setVisible(false); clearError(); setTimeout(() => emailInput.current?.focus(), 0); }}>{tr('Modifier l’adresse', 'Change email', 'تغيير البريد')}</Button>}</div>}
      {step === 'email' && seconds > 0 && <p className="password-recovery-intro" role="status">{tr(`Vous pourrez demander un autre code dans ${seconds} s.`, `You can request another code in ${seconds}s.`, `يمكنك طلب رمز آخر بعد ${seconds} ثانية.`)}</p>}
      {step === 'code' && blockedSeconds > 0 && <p className="password-recovery-intro" role="status">{tr(`Réessayez dans ${blockedSeconds} s.`, `Try again in ${blockedSeconds}s.`, `أعد المحاولة بعد ${blockedSeconds} ثانية.`)}</p>}
    </form>
  </div>;
}
