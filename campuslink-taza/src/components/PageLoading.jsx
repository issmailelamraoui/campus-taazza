import React from 'react';
import {useApp} from '../context';
import './page-loading.css';

export default function PageLoading({fullPage=false}){
 const {tr}=useApp();
 return <div className={`page-loading${fullPage?' page-loading-full':''}`} role="status" aria-live="polite"><span className="page-loading-indicator" aria-hidden="true"/><span>{tr('Chargement de la page…','Loading page…','جارٍ تحميل الصفحة…')}</span></div>;
}
