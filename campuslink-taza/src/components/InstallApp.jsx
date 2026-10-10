import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, Download, Share, Smartphone } from 'lucide-react';
import { useApp } from '../context';
import { Button, Modal } from './ui';
import { getInstallSnapshot, hasSeenInstallPrompt, INSTALL_SEEN_KEY, markInstallPromptSeen, subscribeInstall, takeInstallPrompt } from '../lib/install';
import './install-app.css';

const InstallContext = createContext(null);

function InstallInstructions({ tr }) {
  const heading = useRef(null);
  // The install button disappears when these steps replace it. Keep keyboard
  // focus inside the dialog, so Escape and its focus trap continue to work.
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const macSafari = !ios && /Mac/.test(navigator.platform) && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
  const android = /Android/.test(navigator.userAgent);
  const steps = ios ? [
    tr('Ouvrez le menu Partager de votre navigateur.', 'Open your browser’s Share menu.', 'افتح قائمة المشاركة في متصفحك.'),
    tr('Choisissez « Sur l’écran d’accueil ».', 'Choose “Add to Home Screen”.', 'اختر «إضافة إلى الشاشة الرئيسية».'),
    tr('Confirmez avec « Ajouter ».', 'Confirm with “Add”.', 'أكّد بالضغط على «إضافة».'),
  ] : macSafari ? [
    tr('Ouvrez le menu « Fichier » de Safari.', 'Open Safari’s “File” menu.', 'افتح قائمة «ملف» في Safari.'),
    tr('Choisissez « Ajouter au Dock », puis confirmez.', 'Choose “Add to Dock”, then confirm.', 'اختر «إضافة إلى Dock»، ثم أكّد.'),
  ] : [
    android ? tr('Ouvrez le menu ⋮ de votre navigateur.', 'Open your browser’s ⋮ menu.', 'افتح قائمة ⋮ في متصفحك.') : tr('Cherchez l’icône d’installation dans la barre d’adresse ou ouvrez le menu du navigateur.', 'Look for the install icon in the address bar or open your browser menu.', 'ابحث عن أيقونة التثبيت في شريط العنوان أو افتح قائمة المتصفح.'),
    tr('Choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ».', 'Choose “Install app” or “Add to Home screen”.', 'اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».'),
    tr('Confirmez l’installation de CampusLink.', 'Confirm the installation of CampusLink.', 'أكّد تثبيت CampusLink.'),
  ];
  return <div className="install-instructions">
    <h3 ref={heading} tabIndex={-1}>{tr('Comment installer', 'How to install', 'طريقة التثبيت')}{ios && <Share size={17} aria-hidden="true"/>}</h3>
    <ol>{steps.map(step => <li key={step}>{step}</li>)}</ol>
    {ios && <p className="muted">{tr('Si ce choix n’apparaît pas, ouvrez CampusLink dans Safari.', 'If this option is missing, open CampusLink in Safari.', 'إذا لم يظهر هذا الخيار، افتح CampusLink في Safari.')}</p>}
    {!ios && !macSafari && <p className="muted">{window.isSecureContext ? tr('Si cette option n’apparaît pas, ouvrez CampusLink dans Chrome ou Edge.', 'If this option is missing, open CampusLink in Chrome or Edge.', 'إذا لم يظهر هذا الخيار، افتح CampusLink في Chrome أو Edge.') : tr('L’installation directe nécessite l’adresse sécurisée (HTTPS) de CampusLink.', 'Direct installation requires CampusLink’s secure (HTTPS) address.', 'يتطلب التثبيت المباشر عنوان CampusLink الآمن (HTTPS).')}</p>}
  </div>;
}

export function InstallAppProvider({ children }) {
  const { tr, loading, dialog } = useApp();
  const { installed, prompt } = useSyncExternalStore(subscribeInstall, getInstallSnapshot);
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback(() => {
    if (getInstallSnapshot().installed) return;
    markInstallPromptSeen();
    setInstructions(false);
    setStatus('');
    setOpen(true);
  }, []);

  useEffect(() => {
    if (loading || dialog || installed || hasSeenInstallPrompt()) return;
    let timer;
    const welcome = () => {
      if (hasSeenInstallPrompt() || getInstallSnapshot().installed) return;
      // Other pages also have local dialogs: never stack two focus traps.
      if (document.visibilityState === 'hidden' || document.querySelector('[role="dialog"][aria-modal="true"]')) {
        timer = setTimeout(welcome, 700);
        return;
      }
      show();
    };
    timer = setTimeout(welcome, 700);
    return () => clearTimeout(timer);
  }, [loading, dialog, installed, show]);

  useEffect(() => {
    if (installed) close();
  }, [installed, close]);
  useEffect(() => {
    const seenInAnotherTab = event => {
      if (event.key === INSTALL_SEEN_KEY && event.newValue === 'true') close();
    };
    window.addEventListener('storage', seenInAnotherTab);
    return () => window.removeEventListener('storage', seenInAnotherTab);
  }, [close]);

  async function install() {
    if (busy) return;
    const event = takeInstallPrompt();
    if (!event) { setInstructions(true); return; }
    setBusy(true);
    setStatus('');
    try {
      const result = await event.prompt();
      const choice = event.userChoice ? await event.userChoice : result;
      if (choice?.outcome === 'accepted') close();
      else {
        setInstructions(true);
        setStatus(tr('Vous pourrez réessayer depuis votre profil.', 'You can try again from your profile.', 'يمكنك إعادة المحاولة من ملفك الشخصي.'));
      }
    } catch {
      setInstructions(true);
      setStatus(tr('Utilisez le menu de votre navigateur pour installer CampusLink.', 'Use your browser menu to install CampusLink.', 'استخدم قائمة المتصفح لتثبيت CampusLink.'));
    } finally { setBusy(false); }
  }

  return <InstallContext.Provider value={{ installed, show }}>
    {children}
    {open && !dialog && <Modal title={tr('Installer CampusLink', 'Install CampusLink', 'تثبيت CampusLink')} className="install-modal" onClose={close} footer={<>
      <Button onClick={close}>{instructions ? tr('Fermer', 'Close', 'إغلاق') : tr('Plus tard', 'Later', 'لاحقاً')}</Button>
      {(prompt || !instructions) && <Button variant="primary" icon={prompt ? Download : Smartphone} disabled={busy} aria-busy={busy} onClick={install}>{busy ? tr('Ouverture…', 'Opening…', 'جارٍ الفتح…') : prompt ? tr('Installer maintenant', 'Install now', 'التثبيت الآن') : tr('Comment installer', 'How to install', 'طريقة التثبيت')}</Button>}
    </>}>
      <div className="install-intro"><img src="/icons/app-192.png" alt="" width="60" height="60"/><div><h3>{tr('Votre campus, à portée de main.', 'Your campus, within reach.', 'جامعتك في متناول يدك.')}</h3><p>{tr('Ajoutez CampusLink à votre écran d’accueil pour retrouver vos cours et discussions en un geste.', 'Add CampusLink to your home screen to open your courses and discussions with a tap.', 'أضف CampusLink إلى شاشتك الرئيسية للوصول إلى دروسك ونقاشاتك بلمسة واحدة.')}</p></div></div>
      {instructions ? <InstallInstructions tr={tr}/> : <p className="install-profile-hint">{tr('Vous retrouverez aussi cette option dans votre profil.', 'This option is also available in your profile.', 'ستجد هذا الخيار أيضاً في ملفك الشخصي.')}</p>}
      {status && <p className="install-status" role="status">{status}</p>}
    </Modal>}
  </InstallContext.Provider>;
}

export function InstallAppCard() {
  const { tr } = useApp();
  const { installed, show } = useContext(InstallContext);
  return <section className="card settings-card install-settings-card">
    <h3><Smartphone size={18} aria-hidden="true"/>{tr('L’application CampusLink', 'The CampusLink app', 'تطبيق CampusLink')}</h3>
    <p className="muted">{installed ? tr('CampusLink est installé sur cet appareil.', 'CampusLink is installed on this device.', 'CampusLink مثبت على هذا الجهاز.') : tr('Gardez votre campus sur votre écran d’accueil.', 'Keep your campus on your home screen.', 'ضع جامعتك على شاشتك الرئيسية.')}</p>
    <Button icon={installed ? CheckCircle2 : Download} disabled={installed} onClick={show}>{installed ? tr('Application installée', 'App installed', 'التطبيق مثبت') : tr('Installer l’application', 'Install app', 'تثبيت التطبيق')}</Button>
  </section>;
}
