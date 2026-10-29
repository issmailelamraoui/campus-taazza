import React from 'react';
import {Wifi, WifiOff, LoaderCircle, AlertCircle} from 'lucide-react';
import {useApp} from '../context';
import LoadingCap from './LoadingCap';
import './connection-status.css';
import './page-loading.css';
export default function ConnectionStatus({initial=false}) {
 const {tr,loading,connectionError,connectionState,refreshAccount,refresh}=useApp();
 const state=initial?(loading?'connecting':connectionError?'error':connectionState):connectionError?'error':connectionState;
 const labels={connecting:tr('Connexion à votre campus…','Connecting to your campus…','جارٍ الاتصال بفضائك الجامعي…'),connected:tr('Campus connecté','Connected to campus','متصل بالجامعة'),offline:tr('Connexion interrompue','Connection interrupted','انقطع الاتصال'),reconnecting:tr('Reconnexion en cours…','Reconnecting…','جارٍ إعادة الاتصال…'),error:tr('Connexion indisponible','Connection unavailable','الاتصال غير متاح')};
 const Icon=state==='connected'?Wifi:state==='offline'?WifiOff:state==='error'?AlertCircle:LoaderCircle;
 const iconOnly=initial&&['connecting','reconnecting'].includes(state);
 return <section className={`connection-status${initial?' connection-status-initial':''}${iconOnly?' connection-status-loading':''}`} data-state={state} role="status" aria-live="polite">{iconOnly?<><LoadingCap/><span className="loading-status-text">{labels[state]}</span></>:<><Icon size={initial?30:15} className={!initial&&['connecting','reconnecting'].includes(state)?'action-spinner':undefined}/><div><strong>{labels[state]||labels.connecting}</strong>{initial&&<p>{connectionError||tr('Votre session et vos ressources se chargent de façon sécurisée.','Loading your session and resources securely.','جارٍ تحميل جلستك ومواردك بأمان.')}</p>}</div></>}{state==='error'&&<button type="button" className="text-link" onClick={()=>{(initial?refreshAccount:refresh)().catch(()=>{});}}>{tr('Réessayer','Retry','إعادة المحاولة')}</button>}</section>;
}
