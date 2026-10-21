import React,{useEffect,useState} from 'react';
import {ArrowUpRight,FileText,RotateCcw} from 'lucide-react';
import {api} from '../api';
import {useApp} from '../context';
import {normalizeResource} from '../lib/backend';
import {documentFileUrl} from '../lib/document-open';
import {partLabel} from '../lib/resources';
import {Badge,Button,EmptyState,Modal} from './ui';
import BrowserFilePreview from './BrowserFilePreview';
import PageLoading from './PageLoading';

export default function NativeDocumentPreview({item,initialPage}){
 const {t,tr,language,closeDialog,notificationDestinationViewed}=useApp();
 const [resource,setResource]=useState(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 const version=Number(item.initialVersion||item.requestedVersion)||undefined;
 useEffect(()=>{
  const controller=new AbortController();setResource(null);setError('');
  api(`/reading/${item.id}${version?`?version=${version}`:''}`,{signal:controller.signal}).then(payload=>{
   if(!controller.signal.aborted)setResource({...normalizeResource(payload.document),version:payload.document.version});
  }).catch(failure=>{if(!controller.signal.aborted)setError(failure.message);});
  return()=>controller.abort();
 },[item.id,version,attempt]);
 const current={...item,...resource};
 const source=documentFileUrl({...current,initialVersion:resource?.version||version,initialPage:initialPage||item.initialPage});
 const externalLabel=tr('Ouvrir dans un nouvel onglet','Open in a new tab','فتح في تبويب جديد');
 return <Modal title={current.title||t('preview')} onClose={closeDialog} wide className="preview-modal native-document-preview">
  <div className="native-document-toolbar">
   <div className="native-document-context">{current.category&&<Badge className={`document-category-${current.category}`}>{t(current.category)}</Badge>}{current.semester>0&&<span>S{current.semester}</span>}<bdi title={current.module}>{current.module}</bdi>{current.part&&<span>{partLabel(current.part,language)}</span>}</div>
   {source&&<a className="btn btn-secondary reader-external-open" href={source} target="_blank" rel="noopener" title={externalLabel}><ArrowUpRight size={17}/><span>{externalLabel}</span></a>}
  </div>
  {error?<EmptyState icon={FileText} title={tr('Aperçu indisponible','Preview unavailable','المعاينة غير متاحة')} description={error} action={<Button icon={RotateCcw} onClick={()=>setAttempt(value=>value+1)}>{tr('Réessayer','Retry','إعادة المحاولة')}</Button>}/>:
   !resource?<PageLoading label={tr('Ouverture du fichier…','Opening file…','جارٍ فتح الملف…')}/>:
   <BrowserFilePreview item={current} url={source} onLoaded={()=>notificationDestinationViewed?.('resource',String(item.id))}/>
  }
 </Modal>;
}
