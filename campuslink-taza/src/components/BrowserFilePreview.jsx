import React,{useEffect,useState} from 'react';
import {FileText,RotateCcw} from 'lucide-react';
import {useApp} from '../context';
import {isPDFDocument} from '../lib/document-open';
import {fetchSafeText} from '../lib/reading';
import {Button,EmptyState} from './ui';
import PageLoading from './PageLoading';
import './native-document-preview.css';

const TEXT_TYPES=new Set('TXT MD TEX RTF PY IPYNB C CPP H HPP JS JSX TS TSX HTML CSS XML SVG JSON CSV SQL JAVA SH R YAML YML'.split(' '));
const IMAGE_TYPES=new Set(['JPG','JPEG','PNG','WEBP','GIF']);

export default function BrowserFilePreview({item,url,onLoaded}){
 const {tr}=useApp();
 const extension=String(item.originalName||item.filename||item.name||'').split('.').pop().toUpperCase();
 const type=extension||String(item.fileType||'').toUpperCase();
 const text=TEXT_TYPES.has(type)||String(item.mime||'').startsWith('text/');
 const supported=isPDFDocument(item)||IMAGE_TYPES.has(type)||text;
 const [source,setSource]=useState(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();let objectURL;
  setSource(null);setError('');
  if(text&&url)fetchSafeText(url,controller.signal).then(value=>{
   if(controller.signal.aborted)return;
   // Source files are always inert, including HTML and SVG uploads.
   objectURL=URL.createObjectURL(new Blob([value],{type:'text/plain;charset=utf-8'}));
   setSource({url,href:objectURL});
  }).catch(failure=>{if(!controller.signal.aborted)setError(failure.message);});
  return()=>{controller.abort();if(objectURL)URL.revokeObjectURL(objectURL);};
 },[url,text,attempt]);
 const frameURL=text?(source?.url===url?source.href:null):url;
 const title=item.originalName||item.filename||item.name||item.title||tr('Aperçu du fichier','File preview','معاينة الملف');
 return <div className="browser-file-preview">
  {!supported||!url?<EmptyState icon={FileText} title={title} description={tr('Ouvrez ou téléchargez ce fichier avec une application compatible.','Open or download this file with a compatible application.','افتح هذا الملف أو نزّله باستعمال تطبيق متوافق.')}/>:
   error?<EmptyState icon={FileText} title={tr('Aperçu indisponible','Preview unavailable','المعاينة غير متاحة')} description={error} action={<Button icon={RotateCcw} onClick={()=>setAttempt(value=>value+1)}>{tr('Réessayer','Retry','إعادة المحاولة')}</Button>}/>:
   !frameURL?<PageLoading label={tr('Ouverture du fichier…','Opening file…','جارٍ فتح الملف…')}/>:
   <iframe key={`${frameURL}:${attempt}`} className="native-document-frame" title={title} src={frameURL} sandbox={text?'':undefined} onLoad={onLoaded} onError={()=>setError(tr('Ouvrez le fichier dans un nouvel onglet pour réessayer.','Open the file in a new tab to retry.','افتح الملف في تبويب جديد لإعادة المحاولة.'))}/>
  }
 </div>;
}
