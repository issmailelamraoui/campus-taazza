import React from 'react';
import {Link} from 'react-router-dom';
import {BookOpen,StickyNote,ClipboardList} from 'lucide-react';
import {useApp} from '../context';
import {sourcePath} from '../lib/reading';

export default function BackOnTrack({positions,knowledge,tools,onNote,onChecklist}){
 const {tr,resources}=useApp();
 const available=positions.filter(position=>resources.some(resource=>String(resource.id)===String(position.resourceId))).slice(0,3);
 const recent=available[0],document=recent&&resources.find(resource=>String(resource.id)===String(recent.resourceId));
 const notes=knowledge.filter(note=>document&&(String(note.resourceId)===String(document.id)||!note.resourceId&&note.source?.module===document.module)).slice(0,3);
 const list=tools.find(item=>item.kind==='checklist'&&item.data.items.some(task=>!task.done)&&(!document||item.data.module===document.module));
 if(!available.length&&!list)return null;
 return <section className="study-resume" aria-label={tr('Reprendre mon étude','Back on Track','استئناف دراستي')}><h2>{tr('Reprendre mon étude','Back on Track','استئناف دراستي')}</h2><div>{available.map(position=>{const resource=resources.find(value=>String(value.id)===String(position.resourceId));return <Link key={`${position.resourceId}:${position.version}`} to={sourcePath(position.resourceId,position.page,position.version)}><BookOpen size={18}/><span>{resource.title}<small>{tr('Dernière page enregistrée','Last saved page','آخر صفحة محفوظة')} · p. {position.page} · v{position.version}</small></span></Link>;})}{notes.map(note=><button key={note.id} onClick={()=>onNote(note)}><StickyNote size={18}/><span>{note.title}<small>{tr('Note liée à cette lecture','Note linked to this reading','ملاحظة مرتبطة بهذه القراءة')}</small></span></button>)}{list&&<button onClick={()=>onChecklist(list)}><ClipboardList size={18}/><span>{list.title}<small>{list.data.items.filter(task=>!task.done).length} {tr('tâches personnelles en attente','pending personal tasks','مهام شخصية معلقة')}</small></span></button>}</div></section>;
}
