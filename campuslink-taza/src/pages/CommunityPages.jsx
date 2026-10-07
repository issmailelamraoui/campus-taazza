import React,{useState,useEffect,useLayoutEffect,useRef} from 'react';
import {Link,useParams,useLocation,useNavigate,Navigate} from 'react-router-dom';
import {Hash,Users,Search,Pin,MoreHorizontal,Megaphone,X,ArrowUpRight,Reply,Bookmark,Flag,Link2,Heart,ThumbsUp,Send,Plus,Smile,FileText,Download,MessagesSquare,ShieldCheck,CornerUpLeft,GraduationCap,Trash2,Ban,Clock3,AlertCircle,RotateCcw} from 'lucide-react';
import {useApp} from '../context';
import {api} from '../api';
import {Avatar,CategoryIcon,EmptyState,PageHeading,VerifiedBadge} from '../components/ui';
import {resourcePath,messagePath,categoryNames,formatBytes,formatDate,fileLabel} from '../utils';
import {SEMESTER_CHAT_GROUPS,getChatSemester} from '../../shared/studies.js';
import {removeMessage,setPinned,setReaction,updateMessage} from '../optimistic';
import {createClientId} from '../client-id';
export function useDeepFocus(dependency){const location=useLocation();useEffect(()=>{if(!location.hash)return;const timer=setTimeout(()=>{const item=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(item){item.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});item.classList.remove('deep-focus');void item.offsetWidth;item.classList.add('deep-focus');}},150);return()=>clearTimeout(timer);},[location.hash,location.pathname,location.search,dependency]);}
export function Attachment({resource:r}){const{t,lang,openModal}=useApp();return <div className="chat-attachment">{r.mime?.startsWith('image/')&&<button className="attachment-image" onClick={()=>openModal('preview',r)}><img src={`/api/files/${r.id}`} alt={r.title}/></button>}<button className="attachment-file" onClick={()=>openModal('preview',r)}><span className={`file-icon ${r.category}`}><FileText size={24} strokeWidth={1.4}/><small>{fileLabel(r)}</small></span><span><b>{r.filename||r.title}</b><small>{formatBytes(r.size,lang)}</small></span><ArrowUpRight size={17}/></button>{r.category!=='general'&&<Link className={`attachment-location ${r.category}`} to={resourcePath(r)}><CategoryIcon category={r.category} size={12}/>{t(r.category,categoryNames[r.category])} <span>·</span> S{r.semester} <span>·</span> {r.module||t('noModule','Sans module')}<ArrowUpRight size={12}/></Link>}</div>}
export function ChatMessage({message:m,groupedWithPrevious=false,groupedWithNext=false,onReply,menuOpen,onMenuChange,onMessageRemoved,onChatBlock,chatBlocked,chatBlockBusy}){
  const{data,user,t,lang,saved,toggleSave,toast,openModal,optimisticAction,sendMessage,discardMessage}=useApp();
  const[busy,setBusy]=useState(false);
  const menu=menuOpen,setMenu=onMenuChange;
  const menuRef=useRef(null);
  const[menuPlacement,setMenuPlacement]=useState({up:false,maxHeight:undefined,left:undefined,maxWidth:undefined});
  const r=data.resources.find(r=>r.id===m.resource_id),isSaved=saved.some(s=>s.type==='message'&&s.id===m.id);
  const privileged=['global_admin','faculty_admin','moderator'].includes(user.role);
  const parent=data.messages.find(p=>p.id===m.reply_to);
  const own=m.author.id===user.id,canModerate=user.role==='global_admin';
  const local=Boolean(m._status);
  useLayoutEffect(()=>{
    if(!menu)return;
    const element=menuRef.current,scroll=element?.closest('.chat-scroll');
    if(!element||!scroll)return;
    const position=()=>{
      const bounds=scroll.getBoundingClientRect(),anchor=element.parentElement.getBoundingClientRect();
      const above=Math.max(0,anchor.top-bounds.top-8),below=Math.max(0,bounds.bottom-anchor.bottom-8);
      const up=below<element.scrollHeight+2&&above>below;
      const maxWidth=Math.max(0,bounds.width-16),width=Math.min(element.getBoundingClientRect().width,maxWidth);
      const start=lang==='ar'?anchor.left:anchor.right-width;
      const left=Math.min(Math.max(start,bounds.left+8),bounds.right-8-width)-anchor.left;
      setMenuPlacement({up,maxHeight:Math.max(44,Math.floor(up?above:below)),left,maxWidth});
    };
    position();
    scroll.addEventListener('scroll',position,{passive:true});
    window.addEventListener('resize',position);
    return()=>{scroll.removeEventListener('scroll',position);window.removeEventListener('resize',position);};
  },[menu,lang]);
  const action=async fn=>{if(busy||local)return;setBusy(true);setMenu(false);try{await fn();}catch(e){toast(e.message,'error');}finally{setBusy(false);}};
  const pin=()=>action(async()=>{
    await optimisticAction({key:`pin-${m.id}`,apply:base=>setPinned(base,m,!m.pinned),request:()=>api(`/messages/${m.id}/pin`,{method:'POST'}),commit:(base,result)=>setPinned(base,m,result.pinned,result.announcement)});
    toast(t(m.pinned?'messageUnpinned':'messagePinned',m.pinned?'Message retiré des annonces.':'Message épinglé dans les annonces.'));
  });
  const remove=()=>action(()=>{
    const pending=optimisticAction({key:`delete-${m.id}`,apply:base=>removeMessage(base,m.id),request:()=>api(`/messages/${m.id}`,{method:'DELETE'})});
    onMessageRemoved?.(m);
    return pending.then(()=>toast(t('messageDeleted','Message supprimé.')));
  });
  const react=reaction=>action(()=>optimisticAction({key:`reaction-${m.id}`,apply:base=>setReaction(base,m.id,reaction,!m.my_reactions?.includes(reaction)),request:()=>api(`/messages/${m.id}/reaction`,{method:'POST',body:{reaction}}),commit:(base,result)=>updateMessage(base,m.id,current=>({...current,reactions:result.message.reactions,my_reactions:result.message.my_reactions}))}));
  const copy=async()=>{try{await navigator.clipboard.writeText(location.origin+messagePath(m));toast(t('linkCopied','Lien copié.'));}catch{toast(t('copyFailed','Impossible de copier le lien.'),'error');}setMenu(false);};
  return <article className={`chat-message ${own?'own-message':''} ${groupedWithPrevious?'message-grouped-prev':''} ${groupedWithNext?'message-grouped-next':''} ${menu?'message-menu-open':''} ${m.pinned?'pinned-message':''} ${local?`message-${m._status}`:''}`} id={`message-${m.id}`} data-client-id={m.client_id||undefined} data-status={m._status||'sent'}>
    {groupedWithPrevious?<span className="message-avatar-spacer" aria-hidden="true"/>:<Avatar user={m.author} size={37}/>} 
    <div className="message-content">
      <div className="message-meta">
        <b>{m.author.name||m.author.username}</b>
        <span className="message-timestamp"><span className="message-calendar-date">{formatDate(m.created_at,lang)} · </span><time dateTime={m.created_at} title={formatDate(m.created_at,lang,{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}>{new Date(m.created_at).toLocaleTimeString(lang,{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Casablanca'})}</time></span>
        {m.pinned&&<Pin size={14} className="gold"/>}
        {!local&&<div className="message-hover-actions">
          <button type="button" className="icon-button message-reply-action" onClick={()=>{onReply?.(m);setMenu(false);}} aria-label={t('reply','Répondre')} title={t('reply','Répondre')}><Reply size={18}/></button>
          <button disabled={busy} className={'icon-button '+(isSaved?'is-saved':'')} onClick={()=>action(()=>toggleSave('message',m.id))} aria-label={t('save','Enregistrer')}><Bookmark size={17} fill={isSaved?'currentColor':'none'}/></button>
          <button className="icon-button" onClick={()=>setMenu(!menu)} aria-label={t('messageActions','Actions du message')} aria-expanded={menu} aria-controls={menu?`message-menu-${m.id}`:undefined}><MoreHorizontal size={20}/></button>
          {menu&&<div ref={menuRef} id={`message-menu-${m.id}`} className="message-menu panel" aria-label={t('messageActions','Actions du message')} data-side={menuPlacement.up?'up':'down'} style={{maxHeight:menuPlacement.maxHeight,maxWidth:menuPlacement.maxWidth,insetInlineEnd:'auto',left:menuPlacement.left}}>
            <button onClick={()=>{onReply?.(m);setMenu(false);}}><Reply size={16}/>{t('reply','Répondre')}</button>
            <button className="message-menu-save" disabled={busy} onClick={()=>action(()=>toggleSave('message',m.id))}><Bookmark size={16} fill={isSaved?'currentColor':'none'}/>{t('save','Enregistrer')}</button>
            {privileged&&<button onClick={pin} disabled={busy}><Pin size={16}/>{t(m.pinned?'unpinFromAnnouncements':'pinToAnnouncements',m.pinned?'Retirer des annonces':'Épingler dans les annonces')}</button>}
            <button onClick={copy}><Link2 size={16}/>{t('copyLink','Copier le lien')}</button>
            <button onClick={()=>{openModal('report',{target_type:'message',target_id:m.id});setMenu(false);}}><Flag size={16}/>{t('report','Signaler')}</button>
            {(own||canModerate)&&<button className="message-menu-danger" disabled={busy} onClick={remove}><Trash2 size={16}/>{t('deleteMessage','Supprimer le message')}</button>}
            {canModerate&&!own&&<button className="message-menu-danger" disabled={busy||chatBlockBusy} onClick={()=>action(()=>onChatBlock(m.author.id,!chatBlocked))}><Ban size={16}/>{t(chatBlocked?'unblockFromChat':'blockFromChat',chatBlocked?'Débloquer du chat':'Bloquer du chat')}</button>}
          </div>}
        </div>}
      </div>
      <div className="message-bubble">
        {parent&&<Link to={messagePath(parent)} className="reply-context"><CornerUpLeft size={15}/><b>{parent.author.name}</b><span>{parent.content.slice(0,80)}</span></Link>}
        <p className="message-text" dir="auto">{m.content}</p>
        {r&&<Attachment resource={r}/>}
      </div>
      {local?<div className={`message-delivery ${m._status}`} role="status">{m._status==='pending'?<><Clock3 size={13}/><span>{t('messageSending','Envoi en cours…')}</span></>:<><AlertCircle size={14}/><span>{t('messageSendFailed','Envoi échoué')}</span><button type="button" onClick={()=>sendMessage(m).catch(error=>toast(error.message,'error'))}><RotateCcw size={13}/>{t('retry','Réessayer')}</button><button type="button" onClick={()=>discardMessage(m)} aria-label={t('discardMessage','Retirer ce message')}><X size={14}/></button></>}</div>:<div className="message-reactions">
        {['like','heart'].map(reaction=>{
          const count=m.reactions?.[reaction]||0,reacted=m.my_reactions?.includes(reaction);
          const Icon=reaction==='like'?ThumbsUp:Heart;
          return <button key={reaction} className={`reaction ${reacted?'reacted':''} ${reaction}`} onClick={()=>react(reaction)} disabled={busy} aria-label={t(reaction,reaction==='like'?"J'aime":'Apprécier')} aria-pressed={reacted}><Icon size={15} fill={reacted?'currentColor':'none'}/><span>{count}</span></button>;
        })}
        {m.reply_to&&<span className="reply-label"><Reply size={14}/>{t('reply','Réponse')}</span>}
      </div>}
    </div>
  </article>;
}
export function ChatPage(){
  const{channel='general'}=useParams();
  const{data,user,t,lang,toast,openModal,sendMessage,scheduleRefresh}=useApp();
  const location=useLocation(),navigate=useNavigate();
  const filiereChat=channel==='filiere';
  const requestedSemester=Number(new URLSearchParams(location.search).get('semester'));
  const semester=getChatSemester(requestedSemester)||getChatSemester(user.current_semester)||1;
  const semesterGroup=SEMESTER_CHAT_GROUPS.find(group=>group.id===semester);
  const filiere=data.filieres?.find(f=>f.id===user.filiere_id);
  const[content,setContent]=useState(''),[reply,setReply]=useState(null),[hideWelcome,setHideWelcome]=useState(false);
  const[openMessageMenu,setOpenMessageMenu]=useState(null),[blockedUsers,setBlockedUsers]=useState([]);
  const[blocksReady,setBlocksReady]=useState(false),[blockingUsers,setBlockingUsers]=useState([]);
  const blockRequests=useRef(new Map());
  const scrollRef=useRef(null),inputRef=useRef(null),fileRef=useRef(null);
  const messages=data.messages.filter(m=>m.channel===channel&&(!filiereChat||(m.filiere_id===user.filiere_id&&getChatSemester(m.semester)===semester)));
  useDeepFocus(`${channel}-${semester}-${messages.length}`);
  const titles={general:['generalChat','Chat général'],filiere:['filiereChats','Chats de filière'],important:['importantDiscussions','Discussions importantes'],help:['help','Entraide'],life:['studentLife','Vie étudiante']};
  const info=data.channels?.find(c=>c.id===channel);
  const readOnly=info?.read_only&&user.role==='student';
  const baseTitle=t(...(titles[channel]||titles.general));
  const title=filiereChat?baseTitle:info?.name&&info.name!==(titles[channel]||titles.general)[1]?t(info.name,info.name):baseTitle;
  useEffect(()=>{
    if(!filiereChat||!user.filiere_id||requestedSemester===semester)return;
    const params=new URLSearchParams(location.search);params.set('semester',String(semester));
    navigate({pathname:location.pathname,search:`?${params}`,hash:location.hash},{replace:true});
  },[filiereChat,user.filiere_id,requestedSemester,semester,location.pathname,location.search,location.hash,navigate]);
  useEffect(()=>{
    if(channel!=='general'||!getChatSemester(requestedSemester))return;
    const match=location.hash.match(/^#message-(\d+)$/);
    const migrated=match&&data.messages.find(message=>message.id===Number(match[1])&&message.channel==='filiere');
    if(migrated)navigate(messagePath(migrated),{replace:true});
  },[channel,requestedSemester,location.hash,data.messages,navigate]);
  useEffect(()=>{setContent('');setReply(null);setOpenMessageMenu(null);},[channel,semester]);
  useEffect(()=>{
    if(user.role!=='global_admin')return;
    let active=true;
    setBlocksReady(false);
    api('/chat/blocks').then(({blocks})=>{if(active){setBlockedUsers(blocks.map(block=>block.user_id));setBlocksReady(true);}}).catch(err=>toast(err.message,'error'));
    return()=>{active=false;};
  },[user.id,user.role,data.faculty.id,toast]);
  useEffect(()=>{
    if(openMessageMenu===null)return;
    const actions=document.querySelector(`#message-${openMessageMenu} .message-hover-actions`);
    const dismiss=e=>{if(!actions?.contains(e.target))setOpenMessageMenu(null);};
    const key=e=>{
      if(e.key==='Escape'){e.preventDefault();setOpenMessageMenu(null);actions?.querySelector('[aria-expanded]')?.focus({preventScroll:true});}
      if(e.key==='Tab'){
        const items=[...(actions?.querySelectorAll('.message-menu button:not([disabled])')||[])].filter(el=>el.getClientRects().length);
        const first=items[0],last=items.at(-1);
        if(!first)return;
        if(e.shiftKey&&(document.activeElement===first||!items.includes(document.activeElement))){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&(document.activeElement===last||!items.includes(document.activeElement))){e.preventDefault();first.focus();}
      }
    };
    document.addEventListener('pointerdown',dismiss,true);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('keydown',key);};
  },[openMessageMenu]);
  useEffect(()=>{
    if(location.hash)return;
    const timer=setTimeout(()=>scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:'instant'}),80);
    return()=>clearTimeout(timer);
  },[channel,semester,messages.length,location.hash]);
  const switchSemester=next=>{
    if(next===semester)return;
    const params=new URLSearchParams(location.search);params.set('semester',String(next));
    navigate({pathname:location.pathname,search:`?${params}`,hash:''});
  };
  const send=e=>{
    e?.preventDefault();if(!content.trim()||readOnly)return;
    const client_id=createClientId();
    const draft={id:`pending-${client_id}`,client_id,content:content.trim(),channel,faculty_id:user.faculty_id,filiere_id:filiereChat?user.filiere_id:null,semester:filiereChat?semester:null,reply_to:reply?.id||null,author:{...user,role:'student'},created_at:new Date().toISOString(),pinned:false,reactions:{},my_reactions:[]};
    setContent('');setReply(null);inputRef.current?.focus();
    sendMessage(draft).catch(err=>toast(err.message,'error'));
  };
  const selectFile=e=>{
    const file=e.target.files?.[0];if(!file)return;
    openModal('upload',{file,channel,...(filiereChat?{chat_semester:semester}:{}),content,reply_to:reply?.id,onComplete:()=>{setContent('');setReply(null);}});e.target.value='';
  };
  const blockUser=(id,blocked)=>{
    if(blockRequests.current.has(id))return blockRequests.current.get(id);
    setBlockingUsers(ids=>[...ids,id]);
    setBlockedUsers(ids=>blocked?[...new Set([...ids,id])]:ids.filter(value=>value!==id));
    const pending=api(blocked?'/chat/blocks':`/chat/blocks/${id}`,{method:blocked?'POST':'DELETE',...(blocked?{body:{user_id:id}}:{})}).then(()=>{
      toast(t(blocked?'chatUserBlocked':'chatUserUnblocked',blocked?'Accès au chat bloqué.':'Accès au chat rétabli.'));scheduleRefresh();
    }).catch(error=>{setBlockedUsers(ids=>blocked?ids.filter(value=>value!==id):[...new Set([...ids,id])]);throw error;}).finally(()=>{blockRequests.current.delete(id);setBlockingUsers(ids=>ids.filter(value=>value!==id));});
    blockRequests.current.set(id,pending);return pending;
  };
  if(!titles[channel])return <Navigate to="/app/chat/general" replace/>;
  if(user.chat_blocked)return <div className="content-page chat-blocked-page"><EmptyState icon={Ban} title={t('chatAccessBlocked','Accès au chat bloqué')} description={t('chatBlockedDescription','Votre accès aux discussions est bloqué. Votre compte et votre bibliothèque restent disponibles.')} action={<Link className="btn gold-btn" to="/app/resources/courses">{t('library','Bibliothèque')}<ArrowUpRight size={16}/></Link>}/></div>;
  if(filiereChat&&!user.filiere_id)return <div className="content-page"><EmptyState icon={GraduationCap} title={t('chooseFiliere','Quelle est votre filière ?')} description={t('studiesSetupDescription','Sélectionnez votre filière pour retrouver ses discussions, semestre par semestre.')} action={<Link className="btn gold-btn" to="/onboarding/studies" state={{from:location.pathname+location.search+location.hash}}>{t('completeSetup','Terminer mon compte')}<ArrowUpRight size={16}/></Link>}/></div>;
  return <div className={`chat-page ${filiereChat?'filiere-chat':''} ${channel==='important'?'important-chat':''}`}>
    {openMessageMenu!==null&&<button type="button" className="chat-menu-backdrop" aria-label={t('closeMessageActions','Fermer les actions du message')} onClick={()=>setOpenMessageMenu(null)}/>}
    <header className="chat-header"><div className="chat-title-icon">{channel==='important'?<MessagesSquare size={28}/>:<Hash size={29}/>}</div><div className="chat-heading-copy"><h1>{title}{filiereChat&&<span className="chat-group-label"> · {semesterGroup.label}</span>}</h1>{filiereChat?<p className="chat-filiere-name" title={filiere?.name}>{filiere?.name}</p>:<p>{data.faculty.code}<i/> {t(channel==='important'?'importantCaption':'chatCaption',channel==='important'?'Les échanges qui méritent votre attention.':'Les idées se partagent. La réussite aussi.')}</p>}</div><div className="chat-header-actions">{filiereChat&&<select className="chat-group-selector" aria-label={t('semesterGroups','Semestres')} value={semester} onChange={e=>switchSemester(Number(e.target.value))}>{SEMESTER_CHAT_GROUPS.map(group=><option key={group.id} value={group.id}>{group.label}</option>)}</select>}<Link to="/app/members" className="online-count"><Users size={15}/>{(filiereChat?data.faculty.chat_online:data.faculty.online)||0}<i className="green-dot"/></Link><button className="icon-button" onClick={()=>openModal('search',{type:'message'})} aria-label={t('search','Rechercher')}><Search size={19}/></button><Link to="/app/announcements" className="icon-button" aria-label={t('pinnedMessages','Messages épinglés')}><Pin size={18}/></Link></div></header>
    {filiereChat&&<div className="chat-semester-tabs" role="tablist" aria-label={t('semesterGroups','Semestres')}>{SEMESTER_CHAT_GROUPS.map((group,index)=><button type="button" key={group.id} id={`chat-semester-${group.id}`} role="tab" aria-selected={semester===group.id} aria-controls="semester-chat-panel" tabIndex={semester===group.id?0:-1} onClick={()=>switchSemester(group.id)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?1:e.key==='End'?SEMESTER_CHAT_GROUPS.at(-1).id:SEMESTER_CHAT_GROUPS[(index+(e.key==='ArrowRight'?1:-1)*(lang==='ar'?-1:1)+SEMESTER_CHAT_GROUPS.length)%SEMESTER_CHAT_GROUPS.length].id;switchSemester(next);setTimeout(()=>document.getElementById(`chat-semester-${next}`)?.focus(),0);}}}>{group.label}</button>)}</div>}
    <div className="chat-scroll" ref={scrollRef} id={filiereChat?'semester-chat-panel':undefined} role={filiereChat?'tabpanel':undefined} aria-labelledby={filiereChat?`chat-semester-${semester}`:undefined}>{!hideWelcome&&<div className="chat-welcome"><Megaphone size={25} strokeWidth={1.4}/><div><b>{t('welcomeYourSpace','Bienvenue dans votre espace.')}<span>{t('community','Communauté')}</span></b><p>{t('chatWelcome','Un lieu pour échanger, apprendre et avancer ensemble. Retrouvez tous les cours et examens dans votre bibliothèque.')}</p></div><button className="icon-button" onClick={()=>setHideWelcome(true)} aria-label={t('close','Fermer')}><X size={16}/></button></div>}{messages.length?messages.map((m,i)=>{const previous=messages[i-1],next=messages[i+1];const closeTo=(a,b)=>{if(!a||!b||String(a.author?.id)!==String(b.author?.id))return false;const aDate=new Date(a.created_at),bDate=new Date(b.created_at);if(!Number.isFinite(aDate.getTime())||!Number.isFinite(bDate.getTime())||a.created_at.slice(0,10)!==b.created_at.slice(0,10))return false;return Math.abs(bDate-aDate)<=120000;};const groupedWithPrevious=closeTo(previous,m),groupedWithNext=closeTo(m,next);return <React.Fragment key={m.id}>{(i===0||m.created_at.slice(0,10)!==messages[i-1].created_at.slice(0,10))&&<div className="chat-date-divider"><span>{formatDate(m.created_at,lang,{day:'numeric',month:'long',year:'numeric'})}</span></div>}<ChatMessage message={m} groupedWithPrevious={groupedWithPrevious} groupedWithNext={groupedWithNext} menuOpen={openMessageMenu===m.id} onMenuChange={open=>setOpenMessageMenu(open?m.id:null)} chatBlocked={blockedUsers.includes(m.author.id)} chatBlockBusy={!blocksReady||blockingUsers.includes(m.author.id)} onChatBlock={blockUser} onMessageRemoved={removed=>{if(reply?.id===removed.id)setReply(null);setOpenMessageMenu(null);inputRef.current?.focus();}} onReply={m=>{setReply(m);inputRef.current?.focus();}}/></React.Fragment>}):<EmptyState icon={MessagesSquare} title={t('conversationStartsHere','La conversation commence ici.')} description={t('startConversation','Une question, une idée ? Partagez-la avec votre communauté.')}/>}<div className="chat-end"/></div>
    <div className="chat-composer-area">{reply&&<div className="composer-reply"><Reply size={15}/><span>{t('replyingTo','En réponse à')} <b>{reply.author.name}</b> · {reply.content.slice(0,70)}</span><button type="button" className="icon-button" onClick={()=>{setReply(null);inputRef.current?.focus();}} aria-label={t('cancelReply','Annuler la réponse')}><X size={16}/></button></div>}<form className="chat-composer" onSubmit={send}><button type="button" disabled={readOnly} className="composer-attach" onClick={()=>fileRef.current?.click()} aria-label={t('attachFile','Joindre un fichier')}><Plus size={22}/></button><input ref={fileRef} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.pptx,.xlsx,.odt,.txt" onChange={selectFile}/><textarea disabled={readOnly} ref={inputRef} rows={1} value={content} onChange={e=>setContent(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}} placeholder={`${t('sendMessage','Envoyer un message dans')} #${title.toLowerCase()}…`} aria-label={t('message','Message')} maxLength={8000}/><button type="button" className="icon-button composer-emoji" onClick={()=>{setContent(prev=>prev+' : )');inputRef.current?.focus();}} aria-label={t('addSmile','Ajouter un sourire')}><Smile size={20}/></button><button className="composer-send" disabled={!content.trim()||readOnly} aria-label={t('send','Envoyer')}><Send size={20}/></button></form><p className={`composer-caption ${readOnly?'composer-status':'composer-note'}`}><LockIcon/>{readOnly?t('readOnlyChannel','Cette discussion est en lecture seule.'):t(channel==='important'?'importantNotifies':'generalSilent',channel==='important'?'Les membres seront informés de cette discussion.':'Un échange tranquille. Les messages généraux ne génèrent pas de notifications.')}</p></div>
  </div>;
}

function LockIcon(){return <ShieldCheck size={10}/>}
export function AnnouncementsPage(){const{data,t,lang,openModal,user,saved,toggleSave,toast}=useApp();useDeepFocus(data.announcements.length);return <div className="content-page announcements-page"><PageHeading eyebrow={t('officialCommunications','COMMUNICATIONS OFFICIELLES')} title={t('announcements','Annonces')} description={t('announcementsSubtitle','Les informations essentielles de votre faculté, réunies ici.')}>{user.role.includes('admin')&&<Link className="btn gold-btn" to="/app/admin"><Plus size={15}/>{t('publish','Publier')}</Link>}</PageHeading><div className="announcement-intro"><Megaphone size={20}/><p>{t('announcementsIntro','Les annonces officielles et les messages épinglés par votre équipe de modération.')}</p></div><div className="announcements-list">{data.announcements.length?data.announcements.map(a=>{const r=data.resources.find(r=>r.id===a.resource_id);const isSaved=saved.some(s=>s.type==='announcement'&&s.id===a.id);return <article key={a.id} id={`announcement-${a.id}`} className="announcement-card panel"><div className="announcement-top"><Avatar user={a.author} size={36}/><div><b>{a.author.name}</b><span>{formatDate(a.created_at,lang,{year:'numeric'})}</span></div><VerifiedBadge/><button className={`icon-button ${isSaved?'is-saved':''}`} aria-label={t('save','Enregistrer')} disabled={Boolean(a._status)} onClick={()=>toggleSave('announcement',a.id).catch(e=>toast(e.message,'error'))}><Bookmark size={17} fill={isSaved?'currentColor':'none'}/></button></div><p>{a.content}</p>{r&&<Attachment resource={r}/>}<div className="announcement-footer">{a.message_id?<Link to={messagePath(a)}><Pin size={13}/>{t('pinnedFrom','Épinglé depuis')} #{t(a.channel==='general'?'generalChat':a.channel==='filiere'?'filiereChats':a.channel,a.channel==='general'?'chat-général':a.channel==='filiere'?'Chats de filière':a.channel)}<ArrowUpRight size={13}/></Link>:<span><Megaphone size={13}/>{t('communityPublication','Publication de la communauté')}</span>}<button className="subtle-link" disabled={Boolean(a._status)} onClick={()=>openModal('report',{target_type:'announcement',target_id:a.id})}>{t('report','Signaler')}<Flag size={12}/></button></div></article>}):<EmptyState icon={Megaphone} title={t('noAnnouncements','Aucune annonce pour le moment.')} description={t('announcementEmpty','Les nouvelles de votre faculté apparaîtront ici.')}/>}</div></div>}
