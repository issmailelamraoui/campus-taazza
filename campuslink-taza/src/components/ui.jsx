import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Bookmark,BookmarkCheck,ArrowUpRight,FileText,X,GraduationCap,Inbox,ChevronRight,LoaderCircle,Edit3,Trash2} from 'lucide-react';
import {useApp} from '../context';
import {formatDate} from '../i18n';
import './document-card.css';
import {partLabel,moduleDisplayName} from '../lib/resources';

export function Logo({compact=false}) {return <span className="brand"><span className="brand-mark"><GraduationCap size={23} strokeWidth={1.6}/></span>{!compact&&<span className="brand-name">CampusLink<span>TAZA · USMBA</span></span>}</span>;}
export function Button({variant='secondary',icon:Icon,children,className='',type='button',...props}){return <button type={type} className={`btn btn-${variant} ${className}`} {...props}>{Icon&&<Icon size={17} strokeWidth={1.7}/>}<span>{children}</span></button>;}
export function Badge({children,className=''}){return <span className={`badge ${className}`}>{children}</span>;}
export function Avatar({name='',size='md',className='',src,preview=false}){const {lowData}=useApp();const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return <span className={`avatar avatar-${size} ${className}`} aria-hidden="true">{src&&!failed&&(!lowData||preview)?<img loading={preview?'eager':'lazy'} src={src} alt="" onError={()=>setFailed(true)}/>:name.split(' ').filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase()}</span>;}
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
 const ref=useRef(null),backdropRef=useRef(null);const id=useId();const {t}=useApp();
 useLayoutEffect(()=>{
  const viewport=window.visualViewport;let frame;
  const update=()=>{
   if(viewport&&Math.abs(viewport.scale-1)>.01)return;
   const node=backdropRef.current;if(!node)return;
   node.style.setProperty('--modal-viewport-height',`${viewport?.height||window.innerHeight}px`);
   node.style.setProperty('--modal-viewport-top',`${viewport?.offsetTop||0}px`);
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
  update();viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);window.addEventListener('resize',schedule);
  return()=>{cancelAnimationFrame(frame);viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);};
 },[]);
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{const previous=document.activeElement;const old=document.body.style.overflow;document.body.style.overflow='hidden';const node=ref.current;node?.focus();
  function key(e){if(e.key==='Escape'){e.preventDefault();closeRef.current();}if(e.key==='Tab'){const elements=[...node.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);if(!elements.length){e.preventDefault();return;}const first=elements[0],last=elements.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===node)){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
  node?.addEventListener('keydown',key);return()=>{document.body.style.overflow=old;node?.removeEventListener('keydown',key);previous?.focus();};
 },[]);
 return <div ref={backdropRef} className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section ref={ref} tabIndex={-1} className={`modal ${wide?'modal-wide':''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={id}><header className="modal-header"><h2 id={id}>{title}</h2><button type="button" className="icon-btn close-control" aria-label={t('close')} onClick={onClose}><X size={20}/></button></header><div className="modal-body">{children}</div>{footer&&<footer className="modal-footer">{footer}</footer>}</section></div>;
}
export function DocumentCard({document:item,showOpenLabel=false,metadata="compact"}){
 const {t,tr,language,openDocument,saveItem,isSaved,isPending}=useApp();const saved=isSaved('document',item.id),pending=isPending('saved:document:'+item.id);
 const module=moduleDisplayName(item.module)||tr('Sans module','Unclassified','بدون وحدة');
 const detailed=metadata==='recent';
 const username=item.uploaderUsername||item.uploader_username||'';
 return <article id={`resource-${item.id}`} className={`document-card document-card-compact${detailed?' document-card-recent':''}`} onClick={event=>{if(!event.target.closest('button'))openDocument(item);}}>
  <button type="button" className="document-main" aria-label={`${tr('Ouvrir le document','Open document','فتح المستند')} : ${item.title||module}`} onClick={()=>openDocument(item)}>
   <span className="document-heading">
    <span className="file-symbol" aria-hidden="true"><FileText size={22} strokeWidth={1.5}/></span>
    <span className="document-copy"><h3 dir="auto">{detailed?(item.title||item.originalName||module):module}</h3></span>
    <ArrowUpRight size={17} className="document-arrow" aria-hidden="true"/>
   </span>
   {detailed&&<span className="document-program" dir="auto">{item.filiereName||item.filiereId||tr('Filière non renseignée','Program unavailable','المسلك غير محدد')}</span>}
   <span className="document-classification">{detailed&&item.category&&<span className="document-type">{t(item.category)}</span>}{(!detailed||item.part!==null&&item.part!==undefined)&&<span className="part-label">{partLabel(item.part,language)}</span>}{item.semester>0&&<span className="document-semester">S{item.semester}</span>}</span>
   <span className="document-uploader"><span>{tr('Partagé par','Shared by','شارك بواسطة')}</span><bdi>{username?`@${username.replace(/^@/,'')}`:tr('Compte non renseigné','Account unavailable','الحساب غير متوفر')}</bdi></span>
  </button>
  <div className="document-footer"><button type="button" className="document-open-label" onClick={()=>openDocument(item)}>{tr('Ouvrir le document','Open document','فتح المستند')}<ChevronRight size={15} aria-hidden="true"/></button><button type="button" className={`icon-btn save-btn ${saved?'is-saved':''}`} aria-label={t(saved?'unsave':'save')+': '+(item.title||module)} aria-pressed={saved} aria-busy={pending} disabled={pending} title={pending?tr('Enregistrement…','Saving…','جارٍ الحفظ…'):undefined} onClick={()=>saveItem('document',item.id)}>{pending?<LoaderCircle size={17} className="action-spinner"/>:saved?<BookmarkCheck size={17}/>:<Bookmark size={17}/>}</button></div>
 </article>;
}
export function AnnouncementCard({announcement:item,compact=false}){
 const {t,tr,language,user,openAnnouncement,isSaved,isPending,saveItem,setDialog}=useApp();
 const saved=isSaved('announcement',item.id),pending=isPending('saved:announcement:'+item.id);
 const canManage=user?.role==='global_admin'||user?.role==='faculty_admin'&&user.facultyId===item.facultyId;
 return <article id={`announcement-${item.id}`} className={`announcement-card ${compact?'compact':''}`}><div className="announcement-top"><span className="eyebrow">{item.kind==='administration'?tr('SCOLARITÉ','ACADEMIC OFFICE','مصلحة الدراسة'):item.kind==='community'?tr('VIE DU CAMPUS','CAMPUS LIFE','الحياة الجامعية'):tr('VOTRE ÉTABLISSEMENT','YOUR FACULTY','مؤسستك')}</span>{item.pinned&&<Badge>{tr('À retenir','Worth knowing','للتذكير')}</Badge>}</div><button className="announcement-body" onClick={()=>openAnnouncement(item)}><h3 dir="auto">{item.title}</h3><p dir="auto">{item.content.split('\n')[0]}</p></button><footer><span className="announcement-author"><span className="author-dot"/>{item.author}<span>·</span>{formatDate(item.date,language)}</span><span className="announcement-controls">{canManage&&<><button className="icon-btn" aria-label={tr('Modifier l’annonce','Edit announcement','تعديل الإعلان')+': '+item.title} onClick={()=>setDialog({type:'announcement-edit',item})}><Edit3 size={16}/></button><button className="icon-btn" aria-label={tr('Supprimer l’annonce','Delete announcement','حذف الإعلان')+': '+item.title} onClick={()=>setDialog({type:'announcement-delete',item})}><Trash2 size={16}/></button></>}{compact?<button className="icon-btn" aria-label={t('open')+': '+item.title} onClick={()=>openAnnouncement(item)}><ArrowUpRight size={19}/></button>:<button className={`icon-btn ${saved?'is-saved':''}`} aria-label={t(saved?'unsave':'save')+': '+item.title} aria-pressed={saved} aria-busy={pending} disabled={pending} onClick={()=>saveItem('announcement',item.id)}>{pending?<LoaderCircle size={17} className="action-spinner"/>:<Bookmark size={17}/>}</button>}</span></footer></article>;
}
