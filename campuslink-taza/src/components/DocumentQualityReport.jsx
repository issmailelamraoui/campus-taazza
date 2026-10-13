import React,{useState} from 'react';
import {api} from '../api';
import {useApp} from '../context';
import {Button,Field} from './ui';
import {Select} from './Select';

export default function DocumentQualityReport({resourceId,page,version}){
 const {tr,notify}=useApp(),[reason,setReason]=useState('missing_pages'),[details,setDetails]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const reasons=[['missing_pages','Pages manquantes','Missing pages','صفحات مفقودة'],['rotated_pages','Pages tournées','Rotated pages','صفحات مدورة'],['corrupt','PDF endommagé','Corrupt PDF','ملف تالف'],['classification','Classement incorrect','Wrong classification','تصنيف خاطئ'],['illegible','Page illisible','Illegible page','صفحة غير مقروءة'],['other','Autre problème','Other problem','مشكلة أخرى']];
 return <details className="reader-quality-report"><summary>{tr('Signaler un problème de document','Report a document problem','الإبلاغ عن مشكلة في المستند')}</summary><form className="stack" onSubmit={async event=>{event.preventDefault();if(busy)return;setBusy(true);setError('');try{await api('/reports',{method:'POST',body:{target_type:'resource',target_id:resourceId,reason,details:`p. ${page} · v${version}\n${details}`}});setDetails('');notify(tr('Problème transmis aux responsables du document.','Problem sent to document reviewers.','أُرسلت المشكلة إلى مراجعي المستند.'));}catch(e){setError(e.message);}finally{setBusy(false);}}}><p>p. {page} · v{version}</p><Field label={tr('Type de problème','Problem type','نوع المشكلة')}><Select value={reason} onChange={e=>setReason(e.target.value)}>{reasons.map(([value,f,en,ar])=><option key={value} value={value}>{tr(f,en,ar)}</option>)}</Select></Field><Field label={tr('Précisions pour la vérification','Details for review','تفاصيل للمراجعة')}><textarea required maxLength={1800} rows={3} value={details} onChange={e=>setDetails(e.target.value)}/></Field>{error&&<p className="field-error" role="alert">{error}</p>}<Button type="submit" disabled={busy}>{tr('Transmettre le signalement','Send report','إرسال البلاغ')}</Button></form></details>;
}
