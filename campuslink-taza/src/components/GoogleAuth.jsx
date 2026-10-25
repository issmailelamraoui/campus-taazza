import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { Button, Field } from './ui';
import './google-auth.css';

let configuration;
function googleConfiguration() {
  // Only public availability, academic domains and the provider init endpoint are returned.
  if (!configuration) configuration = api('/auth/google/config').catch(() => ({ enabled: false, domains: [] }));
  return configuration;
}

function useGoogleConfiguration() {
  const [config, setConfig] = useState(null);
  useEffect(() => {
    let live = true;
    googleConfiguration().then(value => { if (live) setConfig(value); });
    return () => { live = false; };
  }, []);
  return config;
}

export function googleErrorMessage(code, tr) {
  switch (code) {
    case 'GOOGLE_EMAIL_NOT_ALLOWED':
    case 'GOOGLE_DOMAIN_NOT_ALLOWED':
    case 'GOOGLE_DOMAIN_REJECTED':
    case 'GOOGLE_ACADEMIC_EMAIL_REQUIRED':
      return tr('Utilisez une adresse académique autorisée. Les adresses personnelles ne sont pas acceptées.', 'Use an authorised academic email address. Personal email addresses are not accepted.', 'استعمل بريدًا جامعيًا مسموحًا به. لا تُقبل عناوين البريد الشخصية.');
    case 'GOOGLE_EMAIL_NOT_VERIFIED':
    case 'GOOGLE_EMAIL_UNVERIFIED':
      return tr('Google doit confirmer votre adresse e-mail avant la connexion.', 'Google must verify your email address before you can sign in.', 'يجب أن تؤكد Google بريدك الإلكتروني قبل تسجيل الدخول.');
    case 'GOOGLE_LINK_REQUIRED':
      return tr('Votre compte CampusLink n’a pas encore pu être associé à Google. Vous pouvez confirmer l’adresse de votre compte existant ci-dessous, puis reprendre la connexion Google.', 'Your CampusLink account could not yet be linked to Google. You can confirm your existing account’s email address below, then try Google sign-in again.', 'لم يُربط حساب CampusLink الخاص بك بـ Google بعد. يمكنك تأكيد بريد حسابك الموجود أدناه ثم إعادة محاولة الدخول عبر Google.');
    case 'GOOGLE_VERIFICATION_INVALID':
      return tr('Vérifiez votre adresse universitaire et le code reçu, puis réessayez.', 'Check your academic email address and the code you received, then try again.', 'تحقق من بريدك الجامعي والرمز الذي وصلك ثم أعد المحاولة.');
    case 'GOOGLE_VERIFICATION_RATE_LIMITED':
      return tr('Trop de tentatives. Patientez avant de réessayer.', 'Too many attempts. Wait before trying again.', 'محاولات كثيرة. انتظر قبل إعادة المحاولة.');
    case 'GOOGLE_VERIFICATION_UNAVAILABLE':
      return tr('La confirmation par e-mail est momentanément indisponible. Réessayez plus tard.', 'Email confirmation is currently unavailable. Try again later.', 'تأكيد البريد الإلكتروني غير متاح حاليًا. أعد المحاولة لاحقًا.');
    case 'GOOGLE_CANCELLED':
    case 'GOOGLE_ACCESS_DENIED':
    case 'access_denied':
      return tr('La connexion Google a été annulée. Vous pouvez réessayer.', 'Google sign-in was cancelled. You can try again.', 'تم إلغاء تسجيل الدخول عبر Google. يمكنك المحاولة مجددًا.');
    case 'GOOGLE_DISABLED':
    case 'GOOGLE_NOT_CONFIGURED':
    case 'GOOGLE_CONFIGURATION':
      return tr('La connexion Google est momentanément indisponible.', 'Google sign-in is currently unavailable.', 'الدخول عبر Google غير متاح حاليًا.');
    case 'GOOGLE_STATE_INVALID':
    case 'GOOGLE_INVALID_STATE':
    case 'GOOGLE_ATTEMPT_INVALID':
    case 'GOOGLE_SESSION_INVALID':
    case 'GOOGLE_FLOW_EXPIRED':
    case 'GOOGLE_SESSION_EXPIRED':
    case 'GOOGLE_PENDING_EXPIRED':
      return tr('Cette tentative Google a expiré. Recommencez la connexion.', 'This Google attempt has expired. Start sign-in again.', 'انتهت صلاحية محاولة Google. ابدأ تسجيل الدخول من جديد.');
    case 'GOOGLE_LINK_MISMATCH':
    case 'GOOGLE_ACCOUNT_MISMATCH':
    case 'GOOGLE_ACCOUNT_ALREADY_LINKED':
    case 'GOOGLE_LINK_CONFLICT':
      return tr('Ce compte Google ne peut pas être associé à votre compte CampusLink. Vérifiez le compte sélectionné.', 'This Google account cannot be linked to your CampusLink account. Check the account you selected.', 'لا يمكن ربط حساب Google هذا بحسابك في CampusLink. تحقق من الحساب المختار.');
    case 'GOOGLE_PASSWORD_REQUIRED':
      return tr('Confirmez votre mot de passe actuel pour associer Google.', 'Confirm your current password to link Google.', 'أكد كلمة مرورك الحالية لربط Google.');
    case 'GOOGLE_PASSWORD_INVALID':
      return tr('Le mot de passe actuel est incorrect. Réessayez.', 'The current password is incorrect. Try again.', 'كلمة المرور الحالية غير صحيحة. حاول مجددًا.');
    case 'GOOGLE_ACCOUNT_DISABLED':
      return tr('Ce compte est désactivé. Contactez l’administration.', 'This account is disabled. Contact administration.', 'هذا الحساب معطّل. تواصل مع الإدارة.');
    case 'GOOGLE_PROFILE_INVALID':
      return tr('Vérifiez le nom d’utilisateur et vos informations universitaires. Ce nom d’utilisateur peut déjà être utilisé.', 'Check your username and academic information. This username may already be in use.', 'تحقق من اسم المستخدم ومعلوماتك الجامعية. قد يكون اسم المستخدم مستعملًا مسبقًا.');
    default:
      return tr('La connexion Google n’a pas abouti. Vous pouvez réessayer.', 'Google sign-in could not be completed. You can try again.', 'تعذر إكمال الدخول عبر Google. يمكنك إعادة المحاولة.');
  }
}

const callbackErrorCodes = new Set([
  'GOOGLE_EMAIL_NOT_ALLOWED', 'GOOGLE_DOMAIN_NOT_ALLOWED', 'GOOGLE_DOMAIN_REJECTED', 'GOOGLE_ACADEMIC_EMAIL_REQUIRED',
  'GOOGLE_EMAIL_NOT_VERIFIED', 'GOOGLE_EMAIL_UNVERIFIED', 'GOOGLE_LINK_REQUIRED', 'GOOGLE_CANCELLED',
  'GOOGLE_ACCESS_DENIED', 'access_denied', 'GOOGLE_DISABLED', 'GOOGLE_NOT_CONFIGURED',
  'GOOGLE_CONFIGURATION', 'GOOGLE_STATE_INVALID', 'GOOGLE_INVALID_STATE', 'GOOGLE_ATTEMPT_INVALID',
  'GOOGLE_SESSION_INVALID', 'GOOGLE_FLOW_EXPIRED', 'GOOGLE_SESSION_EXPIRED', 'GOOGLE_PENDING_EXPIRED',
  'GOOGLE_LINK_MISMATCH', 'GOOGLE_ACCOUNT_MISMATCH', 'GOOGLE_ACCOUNT_ALREADY_LINKED', 'GOOGLE_LINK_CONFLICT',
  'GOOGLE_PASSWORD_REQUIRED', 'GOOGLE_PASSWORD_INVALID', 'GOOGLE_ACCOUNT_DISABLED', 'GOOGLE_PROFILE_INVALID',
  'GOOGLE_OAUTH_FAILED',
]);
const callbackErrorCode = value => typeof value === 'string' && value ? callbackErrorCodes.has(value) ? value : 'GOOGLE_OAUTH_FAILED' : null;

export function useGoogleCallbackError() {
  const location = useLocation(), navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const routeState = location.state && typeof location.state === 'object' && !Array.isArray(location.state) ? location.state : {};
  const code = callbackErrorCode(params.has('google_error') ? params.get('google_error') : routeState.campusGoogleError);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (!query.has('google_error')) return;
    query.delete('google_error');
    // Persist only a known, nonsecret error code on this history entry. It
    // survives reload/back without affecting a fresh visit to /login.
    const state = { ...routeState };
    if (code) state.campusGoogleError = code;
    else delete state.campusGoogleError;
    navigate({ pathname: location.pathname, search: query.toString() ? `?${query}` : '', hash: location.hash }, { replace: true, state });
  }, [location.pathname, location.search, location.hash, location.state, code, navigate]);
  const clear = () => {
    const state = { ...routeState }, query = new URLSearchParams(location.search);
    delete state.campusGoogleError; query.delete('google_error');
    navigate({ pathname: location.pathname, search: query.toString() ? `?${query}` : '', hash: location.hash }, { replace: true, state });
  };
  return [code, clear];
}

export function GoogleAuthNotice({ code }) {
  const { tr } = useApp();
  return code ? <p className={code === 'GOOGLE_LINK_REQUIRED' ? 'google-auth-status' : 'public-form-error google-auth-error'} role={code === 'GOOGLE_LINK_REQUIRED' ? 'status' : 'alert'}>{googleErrorMessage(code, tr)}</p> : null;
}

export function GoogleAuthError() {
  const [code] = useGoogleCallbackError();
  return <GoogleAuthNotice code={code}/>;
}

function GoogleMark() {
  return <svg className="google-auth-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.1 3.6l6.8-6.8C35.7 2.4 30.3 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.9 6.1C12.2 13.7 17.6 9.5 24 9.5Z"/><path fill="#4285F4" d="M47 24.6c0-1.6-.2-3.2-.5-4.6H24v9h12.9c-.6 3-2.3 5.6-4.8 7.3l7.7 6C44.3 38.1 47 32 47 24.6Z"/><path fill="#FBBC05" d="M10.4 28.7A14.4 14.4 0 0 1 9.6 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.5 10.8l7.9-6.1Z"/><path fill="#34A853" d="M24 48c6.5 0 12-2.1 16-5.7l-7.8-6c-2.1 1.5-4.9 2.3-8.2 2.3-6.4 0-11.8-4.3-13.6-9.9l-7.9 6.1A24 24 0 0 0 24 48Z"/></svg>;
}

function redirectToGoogle(value, config) {
  // The server creates the OAuth request. The managed provider can first send
  // the browser through its exact configured init endpoint before Google.
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw new Error('Invalid Google destination');
  if (url.hostname !== 'accounts.google.com') {
    const endpoint = new URL(config?.authorizationEndpoint);
    const entries = [...url.searchParams], token = entries[0]?.[1];
    if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash || endpoint.search
      || url.origin !== endpoint.origin || url.pathname !== endpoint.pathname
      || entries.length !== 1 || entries[0][0] !== 'token' || !token || token.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error('Invalid Google destination');
  }
  // Replacing the entry prevents Back from restoring an obsolete Google
  // failure or email-confirmation form after a successful sign-in.
  window.location.replace(url.href);
}

export function GoogleSignIn({ disabled = false, onBusyChange, showDivider = true }) {
  const { tr } = useApp(), config = useGoogleConfiguration();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(false);
  const start = async () => {
    if (request.current || disabled) return;
    request.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    try {
      const result = await api('/auth/google/start', { method: 'POST', body: { intent: 'login' } });
      redirectToGoogle(result.url, config);
    } catch (error) {
      setError(error.data?.code ? googleErrorMessage(error.data.code, tr) : googleErrorMessage('', tr));
      request.current = false; setBusy(false); onBusyChange?.(false);
    }
  };
  if (config?.enabled !== true) return null;
  return <div className="google-auth-section">{showDivider && <div className="google-auth-divider"><span>{tr('ou', 'or', 'أو')}</span></div>}<button type="button" className="google-auth-button" disabled={disabled || busy} aria-busy={busy} onClick={start}>{busy ? <LoaderCircle className="google-auth-spinner" size={20} aria-hidden="true" /> : <GoogleMark />}<span>{busy ? tr('Connexion à Google…', 'Connecting to Google…', 'جارٍ الاتصال بـ Google…') : tr('Continuer avec Google', 'Continue with Google', 'المتابعة باستخدام Google')}</span></button><p className="google-auth-note">{tr('Votre compte universitaire', 'Your academic account', 'حسابك الجامعي')}{Array.isArray(config.domains) && config.domains.length > 0 && <> · <bdi dir="ltr">{config.domains.map(domain => `@${domain}`).join(', ')}</bdi></>}</p>{error && <p className="public-form-error" role="alert">{error}</p>}</div>;
}

export function GoogleEmailVerification({ disabled = false, onBusyChange }) {
  const { tr } = useApp(), config = useGoogleConfiguration();
  const [email, setEmail] = useState(''), [code, setCode] = useState('');
  const [sent, setSent] = useState(false), [verified, setVerified] = useState(false);
  const [phase, setPhase] = useState(''), [error, setError] = useState(''), [retryAfter, setRetryAfter] = useState(0);
  const request = useRef(false);
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);
  if (config?.enabled !== true) return null;
  const busy = Boolean(phase), locked = disabled || busy;
  const verificationError = failure => {
    const key = ['GOOGLE_VERIFICATION_INVALID', 'GOOGLE_VERIFICATION_RATE_LIMITED', 'GOOGLE_VERIFICATION_UNAVAILABLE'].includes(failure.data?.code) ? failure.data.code : 'GOOGLE_VERIFICATION_UNAVAILABLE';
    setError(googleErrorMessage(key, tr));
    if (key === 'GOOGLE_VERIFICATION_RATE_LIMITED') setRetryAfter(Math.min(900, Math.max(1, Number(failure.data?.retryAfter) || 60)));
  };
  const address = () => {
    const value = email.trim().toLowerCase(), domain = value.split('@')[1];
    return /^[^\s@]+@[^\s@]+$/.test(value) && (!Array.isArray(config.domains) || !config.domains.length || config.domains.includes(domain)) ? value : null;
  };
  const send = async () => {
    if (request.current || locked || retryAfter) return;
    const value = address();
    if (!value) { setError(googleErrorMessage('GOOGLE_DOMAIN_REJECTED', tr)); return; }
    request.current = true; setPhase('sending'); setCode(''); setError(''); onBusyChange?.(true);
    try {
      const result = await api('/auth/google/email-verification/start', { method: 'POST', body: { email: value } });
      if (result.success !== true) throw new Error('Verification unavailable');
      setEmail(value); setSent(true);
    } catch (failure) { verificationError(failure); }
    finally { request.current = false; setPhase(''); onBusyChange?.(false); }
  };
  const confirm = async () => {
    if (request.current || locked || retryAfter) return;
    const value = address(), confirmation = code;
    if (!value || !/^\d{6}$/.test(confirmation)) { setError(googleErrorMessage(value ? 'GOOGLE_VERIFICATION_INVALID' : 'GOOGLE_DOMAIN_REJECTED', tr)); return; }
    request.current = true; setPhase('confirming'); setCode(''); setError(''); onBusyChange?.(true);
    let navigating = false;
    try {
      const result = await api('/auth/google/email-verification/confirm', { method: 'POST', body: { email: value, code: confirmation } });
      if (result.verified !== true) throw new Error('Verification unavailable');
      setVerified(true); setPhase('google');
      try {
        const attempt = await api('/auth/google/start', { method: 'POST', body: { intent: 'login' } });
        redirectToGoogle(attempt.url, config); navigating = true;
      } catch (failure) { setError(googleErrorMessage(failure.data?.code, tr)); }
    } catch (failure) { verificationError(failure); }
    finally { if (!navigating) { request.current = false; setPhase(''); onBusyChange?.(false); } }
  };
  return <section className="google-email-verification" aria-busy={busy}>
    <h3>{tr('Confirmer l’adresse de mon compte', 'Confirm my account’s email', 'تأكيد بريد حسابي')}</h3>
    {verified ? <p role="status">{tr('Adresse confirmée. La connexion Google doit encore aboutir pour continuer.', 'Email confirmed. Google sign-in still needs to succeed before you can continue.', 'تم تأكيد البريد. يجب إتمام الدخول عبر Google بنجاح للمتابعة.')}</p> : <>
      <p>{tr('Pour confirmer votre compte CampusLink existant, utilisez la même adresse universitaire que le compte Google choisi. Cette étape par e-mail est facultative.', 'To confirm your existing CampusLink account, use the same academic email as the Google account you selected. This email confirmation is optional.', 'لتأكيد حسابك الموجود في CampusLink، استعمل نفس البريد الجامعي لحساب Google الذي اخترته. هذا التأكيد عبر البريد اختياري.')}</p>
      <form autoComplete="off" onSubmit={event => { event.preventDefault(); if (sent) confirm(); else send(); }}>
        <Field label={tr('Adresse universitaire', 'Academic email address', 'البريد الجامعي')}><input type="email" name="google-verification-email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" required maxLength={160} value={email} readOnly={sent} disabled={locked} onChange={event => { setEmail(event.target.value); setError(''); }} placeholder="vous@usmba.ac.ma"/></Field>
        {sent && <><p className="google-verification-sent" role="status">{tr('Si cette adresse peut être confirmée, un code lui a été envoyé. Consultez aussi vos courriers indésirables.', 'If this address can be confirmed, a code has been sent to it. Check your spam folder too.', 'إذا كان هذا البريد قابلًا للتأكيد، فقد أُرسل إليه رمز. تحقق أيضًا من البريد غير المرغوب فيه.')}</p><Field label={tr('Code à 6 chiffres', '6-digit code', 'الرمز المكوّن من 6 أرقام')}><input name="google-verification-code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" required pattern="[0-9]{6}" minLength={6} maxLength={6} value={code} disabled={locked} onChange={event => { setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6)); setError(''); }}/></Field></>}
        <Button type="submit" disabled={locked || retryAfter > 0 || (sent && code.length !== 6)}>{phase === 'sending' ? tr('Envoi du code…', 'Sending code…', 'جارٍ إرسال الرمز…') : phase === 'confirming' ? tr('Vérification…', 'Verifying…', 'جارٍ التحقق…') : sent ? tr('Confirmer et continuer avec Google', 'Confirm and continue with Google', 'التأكيد والمتابعة باستخدام Google') : tr('Envoyer un code', 'Send a code', 'إرسال رمز')}</Button>
        {sent && <div className="google-verification-actions"><Button type="button" variant="ghost" disabled={locked || retryAfter > 0} onClick={send}>{tr('Renvoyer un code', 'Resend a code', 'إعادة إرسال الرمز')}</Button><Button type="button" variant="ghost" disabled={locked} onClick={() => { setSent(false); setCode(''); setError(''); }}>{tr('Modifier l’adresse', 'Change email address', 'تغيير البريد')}</Button></div>}
      </form>
    </>}
    {retryAfter > 0 && <p role="status">{tr(`Réessayez dans ${retryAfter} s.`, `Try again in ${retryAfter}s.`, `أعد المحاولة بعد ${retryAfter} ثانية.`)}</p>}
    {error && <p className="public-form-error" role="alert">{error}</p>}
  </section>;
}

export function GoogleLinkAccount() {
  const { tr } = useApp(), config = useGoogleConfiguration();
  const [status, setStatus] = useState(null), [editing, setEditing] = useState(false), [password, setPassword] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const request = useRef(false);
  useEffect(() => {
    if (config?.enabled !== true) return;
    let live = true;
    setStatus(null); setError('');
    api('/auth/google/link').then(value => { if (live) setStatus(value); }).catch(() => { if (live) { setStatus({ failed: true }); setError(tr('Impossible de vérifier l’association Google. Réessayez.', 'Unable to check the Google link. Try again.', 'تعذر التحقق من ربط Google. حاول مجددًا.')); } });
    return () => { live = false; };
  }, [config, revision]);
  if (config?.enabled !== true) return null;
  const submit = async event => {
    event.preventDefault();
    if (request.current || !password) return;
    request.current = true; setBusy(true); setError('');
    const confirmation = password; setPassword('');
    try {
      const result = await api('/auth/google/start', { method: 'POST', body: { intent: 'link', password: confirmation } });
      redirectToGoogle(result.url, config);
    } catch (error) {
      setError(googleErrorMessage(error.data?.code, tr));
      request.current = false; setBusy(false);
    }
  };
  return <section className="card settings-card google-link-card"><h3><GoogleMark />{tr('Connexion Google', 'Google sign-in', 'الدخول عبر Google')}</h3>{!status ? <p className="muted" role="status">{tr('Vérification…', 'Checking…', 'جارٍ التحقق…')}</p> : status.linked ? <p className="google-linked" role="status">{tr('Votre compte Google est associé.', 'Your Google account is linked.', 'تم ربط حسابك في Google.')}{status.email && <> <bdi>{status.email}</bdi></>}</p> : status.failed ? <Button onClick={() => setRevision(value => value + 1)}>{tr('Réessayer', 'Retry', 'إعادة المحاولة')}</Button> : <><p className="muted">{tr('Associez votre compte Google académique pour vous connecter plus facilement. Votre mot de passe et la validation administrative restent nécessaires.', 'Link your academic Google account for easier sign-in. Password confirmation and administrative approval still apply.', 'اربط حساب Google الجامعي لتسهيل الدخول. يبقى تأكيد كلمة المرور وموافقة الإدارة مطلوبين.')}</p>{editing ? <form onSubmit={submit} className="google-link-form" aria-busy={busy}><Field label={tr('Mot de passe actuel', 'Current password', 'كلمة المرور الحالية')}><input type="password" name="google-link-password" required autoComplete="current-password" maxLength={256} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /></Field><div className="google-link-actions"><Button type="submit" disabled={busy || !password} aria-busy={busy}>{busy ? tr('Connexion à Google…', 'Connecting to Google…', 'جارٍ الاتصال بـ Google…') : tr('Confirmer et continuer', 'Confirm and continue', 'التأكيد والمتابعة')}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setPassword(''); setError(''); }}>{tr('Annuler', 'Cancel', 'إلغاء')}</Button></div></form> : <Button onClick={() => setEditing(true)}>{tr('Associer Google', 'Link Google', 'ربط Google')}</Button>}</>}{error && <p className="public-form-error" role="alert">{error}</p>}</section>;
}
