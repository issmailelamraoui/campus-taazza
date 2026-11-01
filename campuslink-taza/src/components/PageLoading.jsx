import React from 'react';
import {useApp} from '../context';
import './page-loading.css';

export default function PageLoading({fullPage=false,label,kind="page"}){
 const {tr}=useApp();
 return <div className={`page-loading${fullPage?' page-loading-full':''}`} data-kind={kind} role="status" aria-live="polite"><span className="page-loading-indicator" aria-hidden="true"/><span>{label||tr('Chargement de la page…','Loading page…','جارٍ تحميل الصفحة…')}</span><div className="loading-placeholders" aria-hidden="true"><i/><i/><i/></div></div>;
}
