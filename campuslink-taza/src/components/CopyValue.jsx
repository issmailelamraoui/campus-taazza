import React,{useState} from 'react';
import {Copy,Check} from 'lucide-react';
import {copyText} from '../lib/clipboard';
import {useApp} from '../context';
export default function CopyValue({value,label}){
 const {tr,notify}=useApp();const [copied,setCopied]=useState(false);
 return <span className="copy-value"><bdi>{value||'—'}</bdi>{value&&<button type="button" className="icon-btn" aria-label={`${tr('Copier','Copy','نسخ')} ${label}`} onClick={async()=>{try{await copyText(value);setCopied(true);}catch(e){notify(e.message,'error');}}}>{copied?<Check size={15}/>:<Copy size={15}/>}</button>}{copied&&<small role="status">{tr('Copié','Copied','تم النسخ')}</small>}</span>;
}
