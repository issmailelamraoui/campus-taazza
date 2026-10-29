import React from 'react';
import {useApp} from '../context';
import BrandMark from './BrandMark';
import './page-loading.css';

export default function PageLoading({fullPage=false,label,kind="page"}){
 const {tr}=useApp();
 return <div className={`page-loading${fullPage?' page-loading-full':''}`} data-kind={kind} role="status" aria-live="polite"><div className="page-loading-card"><BrandMark className="loading-brand-mark"/><div className="page-loading-copy"><span className="loading-brand-name">CampusLink Taza</span><strong>{label||tr('Chargement de la page…','Loading page…','جارٍ تحميل الصفحة…')}</strong><p>{tr('Votre espace est en cours de préparation.','Your space is getting ready.','جارٍ تجهيز فضائك.')}</p></div></div></div>;
}
