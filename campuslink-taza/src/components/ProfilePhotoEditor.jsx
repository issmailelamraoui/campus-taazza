import React,{useEffect,useRef,useState} from 'react';
import {Trash2,Upload} from 'lucide-react';
import {useApp} from '../context';
import {Avatar,Badge,Button} from './ui';
import './profile-photo.css';

export default function ProfilePhotoEditor({name,value,onChange,disabled,onReadingChange}){
 const {user,tr}=useApp();
 const input=useRef(null),reader=useRef(null);
 const [reading,setReading]=useState(false),[error,setError]=useState('');
 const saved=user.avatar||'',photo=value===null?saved:value,changed=value!==null&&value!==saved;
 const unavailable=disabled||reading;
 function stopReading(){
  const current=reader.current;reader.current=null;
  if(current){current.onload=current.onerror=null;if(current.readyState===1)current.abort();}
 }
 useEffect(()=>()=>stopReading(),[]);
 function finishReading(){reader.current=null;setReading(false);onReadingChange(false);}
 function pick(event){
  const file=event.target.files?.[0];event.target.value='';if(!file)return;
  stopReading();setError('');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024){
   setReading(false);onReadingChange(false);
   setError(tr('Choisissez une image PNG, JPEG ou WebP de moins de 2 Mo.','Choose a PNG, JPEG, or WebP image under 2 MB.','اختر صورة PNG أو JPEG أو WebP أصغر من 2 ميغابايت.'));return;
  }
  const current=new FileReader();reader.current=current;setReading(true);onReadingChange(true);
  current.onload=()=>{if(reader.current!==current)return;onChange(current.result);finishReading();};
  current.onerror=()=>{if(reader.current!==current)return;setError(tr('Impossible de lire cette image. Réessayez avec une autre photo.','Unable to read this image. Try another photo.','تعذرت قراءة الصورة. جرّب صورة أخرى.'));finishReading();};
  current.readAsDataURL(file);
 }
 function change(next){setError('');onChange(next);}
 return <section className="profile-photo-editor" aria-label={tr('Photo de profil','Profile photo','الصورة الشخصية')} aria-busy={unavailable}>
  <div className="profile-intro"><Avatar name={name} size="lg" src={photo} preview/><div><h2 dir="auto">{user.name}</h2><p dir="ltr">@{user.username}</p><Badge>{tr('Étudiant','Student','طالب')}</Badge></div></div>
  <div className="profile-photo-actions">
   <Button icon={Upload} disabled={unavailable} onClick={()=>input.current?.click()}>{tr('Modifier la photo','Change photo','تغيير الصورة')}</Button>
   {photo&&<Button variant="ghost" icon={Trash2} disabled={unavailable} onClick={()=>change('')}>{tr('Supprimer la photo','Remove photo','حذف الصورة')}</Button>}
  </div>
  <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label={tr('Choisir une photo de profil','Choose a profile photo','اختيار صورة شخصية')} onChange={pick} disabled={unavailable} hidden/>
  <p className="profile-photo-hint">{tr('PNG, JPEG ou WebP · 2 Mo maximum.','PNG, JPEG or WebP · Up to 2 MB.','PNG أو JPEG أو WebP · بحد أقصى 2 ميغابايت.')}</p>
  {reading&&<p className="profile-photo-status" role="status">{tr('Préparation de la photo…','Preparing photo…','جارٍ تجهيز الصورة…')}</p>}
  {changed&&<div className="profile-photo-pending"><p role="status">{photo?tr('Photo prête. Enregistrez les modifications pour la conserver.','Photo ready. Save your changes to keep it.','الصورة جاهزة. احفظ التغييرات للاحتفاظ بها.'):tr('Photo retirée. Enregistrez les modifications pour confirmer.','Photo removed. Save your changes to confirm.','تمت إزالة الصورة. احفظ التغييرات للتأكيد.')}</p><button type="button" className="text-link" disabled={unavailable} onClick={()=>change(null)}>{tr('Annuler','Undo','تراجع')}</button></div>}
  {error&&<p className="field-error" role="alert">{error}</p>}
 </section>;
}
