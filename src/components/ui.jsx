import React,{useEffect,useId,useRef,useState} from 'react';
import {Bookmark,BookmarkCheck,ArrowUpRight,FileText,X,GraduationCap,Inbox,ChevronRight,LoaderCircle,Edit3,Trash2} from 'lucide-react';
import {useApp} from '../context';
import {formatDate} from '../i18n';
import {getFiliere} from '../data/studies';
import {partLabel} from '../lib/resources';

export function Logo({compact=false}) {return <span className="brand"><span className="brand-mark"><GraduationCap size={23} strokeWidth={1.6}/></span>{!compact&&<span className="brand-name">CampusLink<span>TAZA · USMBA</span></span>}</span>;}
export function Button({variant='secondary',icon:Icon,children,className='',...props}){return <button className={`btn btn-${variant} ${className}`} {...props}>{Icon&&<Icon size={17} strokeWidth={1.7}/>}<span>{children}</span></button>;}
export function Badge({children,className=''}){return <span className={`badge ${className}`}>{children}</span>;}
export function Avatar({name='',size='md',className='',src}){const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return <span className={`avatar avatar-${size} ${className}`} aria-hidden="true">{src&&!failed?<img src={src} alt="" onError={()=>setFailed(true)}/>:name.split(' ').filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase()}</span>;}
export function PageHeader({eyebrow,title,description,actions}){return <div className="page-heading"><div>{eyebrow&&<div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description&&<p className="muted">{description}</p>}</div>{actions&&<div className="page-actions">{actions}</div>}</div>;}
export function EmptyState({icon:Icon=Inbox,title,description,action}){return <div className="empty-state"><span className="empty-icon"><Icon size={28} strokeWidth={1.5}/></span><h3>{title}</h3>{description&&<p className="muted">{description}</p>}{action}</div>;}
export function Field({label,children,error,hint}){
 const generated=useId();let existing;
 function find(nodes){React.Children.forEach(nodes,node=>{if(!React.isValidElement(node))return;if((['input','select','textarea'].includes(node.type)||node.type?.isFieldControl)&&!existing)existing=node;else if(node.props.children)find(node.props.children);});}find(children);
 const id=existing?.props.id||`field-${generated}`;const described=[existing?.props['aria-describedby'],hint?`${id}-hint`:null,error?`${id}-error`:null].filter(Boolean).join(' ')||undefined;
 function attach(nodes){return React.Children.map(nodes,node=>{if(!React.isValidElement(node))return node;if(node===existing)return React.cloneElement(node,{id,'aria-describedby':described,'aria-invalid':error?true:node.props['aria-invalid']});if(node.props.children)return React.cloneElement(node,{},attach(node.props.children));return node;});}
 return <div className="field"><label htmlFor={id} className="field-label">{label}</label>{attach(children)}{hint&&<span className="field-hint" id={`${id}-hint`}>{hint}</span>}{error&&<span className="field-error" id={`${id}-error`} role="alert">{error}</span>}</div>;
}
export function Tabs({items,value,onChange,className=''}){const {language,tr}=useApp();const ref=useRef(null);function move(event,index){let next=index;const reverse=language==='ar';if(event.key==='ArrowRight')next=(index+(reverse?-1:1)+items.length)%items.length;else if(event.key==='ArrowLeft')next=(index+(reverse?1:-1)+items.length)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else return;event.preventDefault();onChange(items[next].id);ref.current?.children[next]?.focus();}return <div ref={ref} className={`tabs ${className}`} role="tablist" aria-label={tr('Choisir une catégorie','Choose a category','اختيار فئة')}>{items.map((item,index)=><button type="button" role="tab" key={item.id} tabIndex={value===item.id?0:-1} aria-selected={value===item.id} className={value===item.id?'active':''} onKeyDown={e=>move(e,index)} onClick={()=>onChange(item.id)}>{item.label}{item.count!==undefined&&<span className="tab-count">{item.count}</span>}</button>)}</div>;}
export function Modal({title,children,onClose,footer,wide=false,className=''}){
 const ref=useRef(null);const id=useId();const {t}=useApp();
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{const previous=document.activeElement;const old=document.body.style.overflow;document.body.style.overflow='hidden';const node=ref.current;node?.focus();
  function key(e){if(e.key==='Escape'){e.preventDefault();closeRef.current();}if(e.key==='Tab'){const elements=[...node.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);if(!elements.length){e.preventDefault();return;}const first=elements[0],last=elements.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===node)){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
  node?.addEventListener('keydown',key);return()=>{document.body.style.overflow=old;node?.removeEventListener('keydown',key);previous?.focus();};
 },[]);
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section ref={ref} tabIndex={-1} className={`modal ${wide?'modal-wide':''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={id}><header className="modal-header"><h2 id={id}>{title}</h2><button className="icon-btn" aria-label={t('close')} onClick={onClose}><X size={20}/></button></header><div className="modal-body">{children}</div>{footer&&<footer className="modal-footer">{footer}</footer>}</section></div>;
}
export function DocumentCard({document:item}){
 const {t,tr,language,openDocument,saveItem,isSaved,isPending}=useApp();const saved=isSaved('document',item.id),pending=isPending('saved:document:'+item.id);
 const fileType=String(item.fileType||item.originalName?.split('.').pop()||'PDF').toUpperCase();
 const filename=item.originalName||item.title;const filiere=getFiliere(item.filiereId)?.name||item.filiereId;
 return <article id={`resource-${item.id}`} className="document-card" onClick={e=>{if(!e.target.closest('button'))openDocument(item);}}>
  <button className="document-main" onClick={()=>openDocument(item)}>
   <span className="document-heading">
    <span className="file-symbol"><FileText size={21} strokeWidth={1.4}/><span>{fileType}</span></span>
    <span className="document-copy"><h3 dir="auto">{item.title}</h3><span className="document-filename" dir="auto">{filename}</span></span>
    <ArrowUpRight size={16} className="document-arrow"/>
   </span>
   <span className="document-context">
    <span className="document-meta"><bdi>{item.module}</bdi><span className="document-semester">S{item.semester}</span></span>
    <span className="document-classification">{filiere&&<span className="document-filiere"><GraduationCap size={13} aria-hidden="true"/><bdi>{filiere}</bdi></span>}<span className="part-label">{partLabel(item.part,language)}</span></span>
   </span>
   {(item.author||item.uploader)&&<span className="document-credits">
    {item.author&&<span className="document-author"><span>{tr('Auteur','Author','المؤلف')}</span><bdi>{item.author}</bdi></span>}
    {item.uploader&&<span className="document-uploader"><span>{tr('Partagé par','Shared by','شارك بواسطة')}</span><bdi>{item.uploader}</bdi></span>}
   </span>}
  </button>
  <div className="document-footer"><span><span className={`document-category document-category-${item.category}`}>{t(item.category)}</span><span className="document-file-details">{fileType}{item.size&&` · ${item.size}`}</span>{item.date&&<span className="document-date muted">{formatDate(item.date,language)}</span>}</span><button className={`icon-btn save-btn ${saved?'is-saved':''}`} aria-label={t(saved?'unsave':'save')+': '+item.title} aria-pressed={saved} aria-busy={pending} disabled={pending} title={pending?tr('Enregistrement…','Saving…','جارٍ الحفظ…'):undefined} onClick={()=>saveItem('document',item.id)}>{pending?<LoaderCircle size={17} className="action-spinner"/>:saved?<BookmarkCheck size={17}/>:<Bookmark size={17}/>}</button></div>
 </article>;
}
export function AnnouncementCard({announcement:item,compact=false}){
 const {t,tr,language,user,openAnnouncement,isSaved,isPending,saveItem,setDialog}=useApp();
 const saved=isSaved('announcement',item.id),pending=isPending('saved:announcement:'+item.id);
 const canManage=user?.role==='global_admin'||user?.role==='faculty_admin'&&user.facultyId===item.facultyId;
 return <article id={`announcement-${item.id}`} className={`announcement-card ${compact?'compact':''}`}><div className="announcement-top"><span className="eyebrow">{item.kind==='administration'?tr('SCOLARITÉ','ACADEMIC OFFICE','مصلحة الدراسة'):item.kind==='community'?tr('VIE DU CAMPUS','CAMPUS LIFE','الحياة الجامعية'):tr('VOTRE ÉTABLISSEMENT','YOUR FACULTY','مؤسستك')}</span>{item.pinned&&<Badge>{tr('À retenir','Worth knowing','للتذكير')}</Badge>}</div><button className="announcement-body" onClick={()=>openAnnouncement(item)}><h3 dir="auto">{item.title}</h3><p dir="auto">{item.content.split('\n')[0]}</p></button><footer><span className="announcement-author"><span className="author-dot"/>{item.author}<span>·</span>{formatDate(item.date,language)}</span><span className="announcement-controls">{canManage&&<><button className="icon-btn" aria-label={tr('Modifier l’annonce','Edit announcement','تعديل الإعلان')+': '+item.title} onClick={()=>setDialog({type:'announcement-edit',item})}><Edit3 size={16}/></button><button className="icon-btn" aria-label={tr('Supprimer l’annonce','Delete announcement','حذف الإعلان')+': '+item.title} onClick={()=>setDialog({type:'announcement-delete',item})}><Trash2 size={16}/></button></>}{compact?<button className="icon-btn" aria-label={t('open')+': '+item.title} onClick={()=>openAnnouncement(item)}><ArrowUpRight size={19}/></button>:<button className={`icon-btn ${saved?'is-saved':''}`} aria-label={t(saved?'unsave':'save')+': '+item.title} aria-pressed={saved} aria-busy={pending} disabled={pending} onClick={()=>saveItem('announcement',item.id)}>{pending?<LoaderCircle size={17} className="action-spinner"/>:<Bookmark size={17}/>}</button>}</span></footer></article>;
}
