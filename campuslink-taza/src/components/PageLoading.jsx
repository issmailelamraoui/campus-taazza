import React from 'react';
import {useApp} from '../context';
import LoadingCap from './LoadingCap';
import './page-loading.css';

export default function PageLoading({fullPage=false,label,kind="page"}){
 const {tr}=useApp();
 return <div className={`page-loading${fullPage?' page-loading-full':''}`} data-kind={kind} role="status" aria-live="polite"><div className="page-loading-card"><LoadingCap/><span className="loading-status-text">{label||tr('Chargement de la page…','Loading page…','جارٍ تحميل الصفحة…')}</span></div></div>;
}
