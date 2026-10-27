import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, CheckCircle2, LoaderCircle, Share } from 'lucide-react';
import { useApp } from '../context';
import { Button } from './ui';
import { disablePushDevice, enablePushDevice, getPushCapability, getPushConfig, inspectPushDevice, setPushAccount } from '../lib/web-push';
import './push-settings.css';

export default function PushSettings() {
  const { user, tr } = useApp();
  const [state, setState] = useState({ checking: true, active: false, permission: 'default' });
  const [config, setConfig] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [instructions, setInstructions] = useState(false);
  const mounted = useRef(false), request = useRef(false), revision = useRef(0);
  const userId = user?.id;
  const currentUser = useRef(userId); currentUser.current = userId;
  const refresh = useCallback(async () => {
    if (!mounted.current || currentUser.current !== userId) return;
    const version = ++revision.current;
    setPushAccount(userId);
    const capability = getPushCapability();
    if (!capability.supported) { setState({ ...capability, checking: false, active: false }); return; }
    try {
      const settings = await getPushConfig();
      if (!mounted.current || version !== revision.current) return;
      setConfig(settings);
      const device = settings.enabled ? await inspectPushDevice(userId) : { ...capability, active: false, permission: Notification.permission };
      if (mounted.current && version === revision.current) setState({ ...device, checking: false });
    } catch (failure) {
      if (mounted.current && version === revision.current) { setState(previous => ({ ...previous, ...capability, checking: false })); setError(failure.message); }
    }
  }, [userId]);
  useEffect(() => {
    mounted.current = true;
    request.current = false; setBusy(false); setError('');
    setState({ checking: true, active: false, permission: 'default' });
    void refresh();
    const update = () => { if (!request.current) void refresh(); };
    window.addEventListener('focus', update); window.addEventListener('campus-push-changed', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      mounted.current = false; revision.current++;
      window.removeEventListener('focus', update); window.removeEventListener('campus-push-changed', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [refresh]);
  async function toggle() {
    if (request.current) return;
    request.current = true; setBusy(true); setError(''); revision.current++;
    // Keep the browser's gesture: this call happens synchronously on click.
    let permissionPromise;
    const owner = userId, active = () => mounted.current && currentUser.current === owner;
    try {
      if (!state.active && Notification.permission === 'default') permissionPromise = Notification.requestPermission();
      const result = state.active ? await disablePushDevice() : await enablePushDevice({ userId, publicKey: config?.publicKey, permissionPromise });
      if (active()) setState(previous => ({ ...previous, ...result }));
    } catch (failure) {
      if (active()) {
        const permission = typeof Notification === 'undefined' ? 'default' : Notification.permission;
        setState(previous => ({ ...previous, permission, ...(permission !== 'granted' ? { active: false } : {}) }));
        setError(failure.code === 'PERMISSION_DISMISSED' ? tr('Vous pourrez activer ces notifications plus tard.', 'You can enable these notifications later.', 'يمكنك تفعيل هذه الإشعارات لاحقاً.') : failure.message);
      }
    } finally { if (active()) { request.current = false; setBusy(false); void refresh(); } }
  }
  let description = tr('Recevez les nouvelles questions de votre filière, vos réponses et les nouveaux documents, même lorsque CampusLink est fermé.', 'Get new questions from your programme, replies to you and new documents, even when CampusLink is closed.', 'توصّل بالأسئلة الجديدة ديال مسلكك، والردود الموجّهة ليك والوثائق الجديدة، حتى ملي يكون CampusLink مسدود.');
  if (state.reason === 'install') description = tr('Sur iPhone ou iPad, ajoutez CampusLink à l’écran d’accueil puis ouvrez cette application pour activer les notifications.', 'On iPhone or iPad, add CampusLink to your Home Screen, then open that app to enable notifications.', 'على iPhone أو iPad، زِد CampusLink للشاشة الرئيسية وحلّ التطبيق من تما باش تفعّل الإشعارات.');
  else if (state.reason === 'insecure') description = tr('Ouvrez l’adresse HTTPS de CampusLink pour activer les notifications sur cet appareil.', 'Open CampusLink using HTTPS to enable notifications on this device.', 'حلّ CampusLink بالرابط الآمن HTTPS باش تفعّل إشعارات هاد الجهاز.');
  else if (state.reason === 'unsupported') description = tr('Ce navigateur ne propose pas les notifications en arrière-plan. Vos notifications restent disponibles dans CampusLink.', 'This browser does not support background notifications. Your notifications remain available in CampusLink.', 'هاد المتصفح ما كيدعمش الإشعارات فالخلفية. الإشعارات ديالك كتبقى متاحة داخل CampusLink.');
  else if (state.permission === 'denied') description = tr('Les notifications sont bloquées dans les réglages de ce navigateur. Autorisez-les pour CampusLink, puis revenez ici.', 'Notifications are blocked in this browser’s settings. Allow them for CampusLink, then return here.', 'الإشعارات محظورة فإعدادات المتصفح. سمح بها لـCampusLink ومن بعد رجع لهنا.');
  else if (config?.enabled === false) description = tr('Les notifications sur téléphone sont en préparation. Vos notifications dans CampusLink continuent de fonctionner.', 'Phone notifications are being prepared. Your notifications inside CampusLink continue to work.', 'إشعارات الهاتف مازال كتوجد. الإشعارات داخل CampusLink خدامة.');
  const canToggle = state.supported && config?.enabled && state.permission !== 'denied' && !state.checking;
  return <div className="push-settings" data-push-state={state.checking ? 'checking' : state.active ? 'active' : state.reason || (config?.enabled === false ? 'unconfigured' : state.permission || 'inactive')}>
    <div className="push-settings-heading"><Bell size={18} aria-hidden="true"/><h4>{tr('Notifications sur cet appareil', 'Notifications on this device', 'الإشعارات على هاد الجهاز')}</h4>{state.active && <span className="push-settings-active"><CheckCircle2 size={14}/>{tr('Activées', 'On', 'مفعّلة')}</span>}</div>
    <p className="muted">{description}</p>
    {state.checking ? <p className="push-settings-status" role="status"><LoaderCircle size={15}/>{tr('Vérification de cet appareil…', 'Checking this device…', 'كنتحققو من هاد الجهاز…')}</p> : canToggle ? <Button className="push-settings-toggle" variant={state.active ? 'secondary' : 'primary'} icon={state.active ? BellOff : Bell} disabled={busy} aria-busy={busy} onClick={toggle}>{busy ? tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : state.active ? tr('Désactiver sur cet appareil', 'Turn off on this device', 'إيقافها على هاد الجهاز') : tr('Activer les notifications', 'Enable notifications', 'تفعيل الإشعارات')}</Button> : state.reason === 'install' ? <Button icon={Share} onClick={() => setInstructions(value => !value)} aria-expanded={instructions}>{tr('Comment installer', 'How to install', 'طريقة التثبيت')}</Button> : null}
    {instructions && state.reason === 'install' && <ol className="push-settings-instructions"><li>{tr('Dans Safari, ouvrez le menu Partager.', 'In Safari, open the Share menu.', 'فـSafari، حلّ قائمة المشاركة.')}</li><li>{tr('Choisissez « Sur l’écran d’accueil », puis « Ajouter ».', 'Choose “Add to Home Screen”, then “Add”.', 'اختار «إضافة للشاشة الرئيسية» ومن بعد «إضافة».')}</li><li>{tr('Ouvrez CampusLink depuis cette icône et revenez aux préférences de notifications.', 'Open CampusLink from that icon and return to notification preferences.', 'حلّ CampusLink من الأيقونة ورجع لتفضيلات الإشعارات.')}</li></ol>}
    {error && <p className="push-settings-error" role="alert">{error}</p>}
    {error && !canToggle && state.supported && <Button disabled={busy} onClick={() => { setError(''); void getPushConfig({ refresh: true }).then(refresh).catch(failure => setError(failure.message)); }}>{tr('Réessayer', 'Retry', 'إعادة المحاولة')}</Button>}
  </div>;
}
