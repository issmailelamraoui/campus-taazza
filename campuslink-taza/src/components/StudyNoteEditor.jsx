import React,{useRef,useState} from 'react';
import {useApp} from '../context';
import {Button,Field} from './ui';
import {Select} from './Select';
import {NOTE_TEMPLATES} from '../lib/note-templates.js';
import {saveKnowledge} from '../lib/reading.js';
import PDFExcerpt from './PDFExcerpt';
export default function StudyNoteEditor({item={},source={},onSaved,onCancel}){
 const{user,tr}=useApp();const[title,setTitle]=useState(item.title||source.title||''),[content,setContent]=useState(item.content||''),[tags,setTags]=useState((item.tags||[]).join(', ')),[color,setColor]=useState(item.color||'yellow'),[author,setAuthor]=useState(item.source?.author||source.author||''),[year,setYear]=useState(item.source?.year||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef(false);
 async function save(event){event.preventDefault();if(request.current)return;request.current=true;setBusy(true);setError('');try{const result=await saveKnowledge(user.id,{...item,...source,title,content,tags:tags.split(',').map(value=>value.trim()).filter(Boolean),color,citationAuthor:author,citationYear:year});onSaved(result);}catch(error){setError(error.message);}finally{request.current=false;setBusy(false);}}
 return<form className="study-note-editor stack" onSubmit={save} aria-busy={busy}>
 <Field label={tr('Titre','Title','العنوان')}><input value={title} onChange={event=>setTitle(event.target.value)} required maxLength={180}/></Field>
 {!item.revision&&<Field label={tr('Modèle facultatif','Optional template','نموذج اختياري')}><Select defaultValue="" onChange={event=>{const template=NOTE_TEMPLATES.find(value=>value.id===event.target.value);if(template){setContent(template.content);if(!title)setTitle(template.name);}}}><option value="">{tr('Note libre','Blank note','ملاحظة حرة')}</option>{NOTE_TEMPLATES.map(template=><option value={template.id} key={template.id}>{template.name}</option>)}</Select></Field>}
 <PDFExcerpt item={{...source,...item}}/>
 <Field label={tr('Votre note','Your note','ملاحظتك')}><textarea className="pdf-math-text" value={content} onChange={event=>setContent(event.target.value)} maxLength={20000} rows={6}/></Field>
 <Field label={tr('Étiquettes, séparées par des virgules','Tags, separated by commas','وسوم مفصولة بفواصل')}><input value={tags} onChange={event=>setTags(event.target.value)} maxLength={400}/></Field>
 <Field label={tr('Couleur du repère','Highlight color','لون التحديد')}><Select value={color} onChange={event=>setColor(event.target.value)}><option value="yellow">{tr('Jaune · définition','Yellow · definition','أصفر · تعريف')}</option><option value="blue">{tr('Bleu · exemple','Blue · example','أزرق · مثال')}</option><option value="pink">{tr('Rose · à éclaircir','Pink · question','وردي · يحتاج توضيحاً')}</option><option value="green">{tr('Vert','Green','أخضر')}</option></Select></Field>
 {(item.kind||source.kind)==='reference'&&<><Field label={tr('Auteur, si connu','Author, if known','المؤلف إن كان معروفاً')}><input value={author} onChange={event=>setAuthor(event.target.value)} maxLength={180}/></Field><Field label={tr('Année, si connue','Year, if known','السنة إن كانت معروفة')}><input value={year} onChange={event=>setYear(event.target.value)} maxLength={20}/></Field></>}
 {error&&<p className="field-error" role="alert">{error}</p>}<div className="study-editor-actions"><Button type="button" disabled={busy} onClick={onCancel}>{tr('Annuler','Cancel','إلغاء')}</Button><Button type="submit" variant="primary" disabled={busy}>{busy?tr('Enregistrement…','Saving…','جارٍ الحفظ…'):tr('Enregistrer la note privée','Save private note','حفظ الملاحظة الخاصة')}</Button></div>
 </form>;
}
