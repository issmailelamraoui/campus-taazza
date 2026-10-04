import React, { useState, useSyncExternalStore } from 'react';
import { CheckCircle2, Download, Smartphone, Share2, ChevronDown } from 'lucide-react';
import { useApp } from '../context';
import { getInstallState, promptInstall, subscribeInstall } from '../pwa';
import './install-app.css';

export default function InstallApp() {
  const { t } = useApp();
  const { prompt, installed } = useSyncExternalStore(subscribeInstall, getInstallState, getInstallState);
  const [instructions, setInstructions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);
  const install = async () => {
    setBusy(true); setError(false);
    try { await promptInstall(); }
    catch { setError(true); setInstructions(true); }
    finally { setBusy(false); }
  };
  return <section className="study-settings-section pwa-install-section" aria-labelledby="install-app-title">
    <div className="study-section-heading"><div><h2 id="install-app-title"><Smartphone size={18} aria-hidden="true" />{t('installAppTitle', 'Application')}</h2></div></div>
    <div className="pwa-install-card">
      <img className="pwa-install-icon" src="/icons/app-192.png" alt="" width="56" height="56" />
      <div className="pwa-install-copy"><strong>CampusLink Taza</strong><p>{installed ? t('installAppReady', 'Ouvrez CampusLink depuis votre écran d’accueil.') : t('installAppDescription', 'Votre campus, accessible directement depuis votre écran d’accueil.')}</p></div>
      {installed ? <span className="pwa-installed" role="status"><CheckCircle2 size={18} />{t('installAppInstalled', 'Application installée')}</span> : prompt ? <button type="button" className="btn gold-btn pwa-install-button" disabled={busy} onClick={install}><Download size={17} />{t('installAppButton', 'Installer l’application')}</button> : <button type="button" className="btn btn-secondary pwa-install-button" aria-expanded={instructions} aria-controls="install-app-guide" onClick={() => setInstructions(value => !value)}><Smartphone size={17} />{t('installAppGuideButton', 'Ajouter à l’écran d’accueil')}<ChevronDown size={15} className={instructions ? 'pwa-guide-open' : ''} /></button>}
    </div>
    {!installed && !window.isSecureContext && <p className="pwa-install-note">{t('installAppLocalHttp', 'Sur cette adresse locale HTTP, vous pouvez ajouter un raccourci depuis le menu du navigateur. L’installation automatique nécessite HTTPS.')}</p>}
    {!installed && instructions && <div className="pwa-install-guide" id="install-app-guide" role="region" aria-label={t('installAppGuideTitle', 'Comment ajouter CampusLink')}>
      {ios ? <Share2 size={20} aria-hidden="true" /> : <Smartphone size={20} aria-hidden="true" />}
      <p>{ios ? t('installAppIos', 'Dans Safari, ouvrez le menu Partager puis « Ajouter à l’écran d’accueil ». Activez « Ouvrir comme app » si proposé, puis choisissez Ajouter.') : android ? t('installAppAndroid', 'Ouvrez le menu ⋮ de votre navigateur, puis choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ».') : t('installAppDesktop', 'Ouvrez le menu de Chrome ou Edge et choisissez « Installer CampusLink Taza ». Dans Safari sur Mac : Fichier → Ajouter au Dock.')}</p>
    </div>}
    {error && <p className="pwa-install-note" role="status">{t('installAppRetry', 'Utilisez le menu de votre navigateur pour ajouter CampusLink.')}</p>}
  </section>;
}
