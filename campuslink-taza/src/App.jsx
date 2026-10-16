import React,{useEffect} from 'react';
import {Navigate,Route,Routes,useLocation} from 'react-router-dom';
import {AlertCircle,Check,X} from 'lucide-react';
import {useApp} from './context';
import PageLoading from './components/PageLoading';
import {accountDestination,requiresPasswordChange} from './lib/backend';
const AppShell=React.lazy(()=>import('./components/AppShell'));
const Dialogs=React.lazy(()=>import('./components/Modals'));
import {LandingPage,LoginPage,OnboardingPage,RegisterPage,AccountReviewPage} from './pages/PublicPages';
const LibraryPage=React.lazy(()=>import('./pages/LibraryPage'));
const CommunityPage=React.lazy(()=>import('./pages/CommunityPage'));
const AdminPage=React.lazy(()=>import('./pages/AdminPage'));
const StudyPage=React.lazy(()=>import('./pages/StudyPage'));
const ScannerPage=React.lazy(()=>import('./pages/ScannerPage'));
const CampusPage=React.lazy(()=>import('./pages/CampusPage'));
const CampusLabs=React.lazy(()=>import('./pages/CampusLabs'));
const FeedbackPage=React.lazy(()=>import('./pages/FeedbackPage'));
const XPPage=React.lazy(()=>import('./pages/XPPage'));
const PermissionsPage=React.lazy(()=>import('./pages/PermissionsPage'));
const PasswordChangePage=React.lazy(()=>import('./pages/PasswordChangePage'));
const studentPage=name=>React.lazy(()=>import('./pages/StudentPages').then(module=>({default:module[name]})));
const HomePage=studentPage('HomePage');
const AnnouncementsPage=studentPage('AnnouncementsPage');
const NotificationsPage=studentPage('NotificationsPage');
const SavedPage=studentPage('SavedPage');
const ProfilePage=studentPage('ProfilePage');
import './styles/interaction-overrides.css';

function SessionStatus(){
 const {loading,connectionError,refreshAccount,tr}=useApp();
 return <main className="public-page" style={{minHeight:'100dvh',display:'grid',placeItems:'center',padding:24}}><div className="panel" style={{padding:28,maxWidth:420,textAlign:'center'}} role="status" aria-live="polite"><strong>CampusLink Taza</strong><p className="muted" style={{margin:'12px 0'}}>{loading?tr('Connexion à votre campus…','Connecting to your campus…','جارٍ الاتصال بفضائك الجامعي…'):connectionError}</p>{!loading&&<button className="btn btn-primary" onClick={()=>refreshAccount().catch(()=>{})}>{tr('Réessayer','Retry','إعادة المحاولة')}</button>}</div></main>;
}
function Protected(){
 const {user,selection,loading,connectionError}=useApp();
 if(loading||(!user&&connectionError))return <SessionStatus/>;
 if(!user)return <Navigate to="/login" replace/>;
 if(requiresPasswordChange(user))return <Navigate to="/change-password" replace/>;
 if(user.accountStatus!=='approved')return <Navigate to="/account-review" replace/>;
 if(!selection)return <Navigate to="/onboarding" replace/>;
 return <AppShell/>;
}
function ScrollReset(){const location=useLocation();useEffect(()=>{if(location.hash){requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView({behavior:'auto',block:'start'}));}else{window.scrollTo({top:0,behavior:'auto'});}},[location.pathname,location.hash]);return null;}
function NotificationLifecycle(){
 const location=useLocation();const {user,dialog,resources,announcements,messages,openDocument,openAnnouncement,notificationDestinationViewed,leaveNotificationDestination,tr}=useApp();
 const previous=React.useRef(null);const handled=React.useRef('');
 useEffect(()=>{
  if(!user||requiresPasswordChange(user)){previous.current=null;handled.current='';return;}
  const href=location.pathname+location.search+location.hash;
  const identity=dialog?dialog.type+':'+dialog.item?.id:href;
  if(previous.current&&previous.current.identity!==identity)leaveNotificationDestination(previous.current.identity);
  const state={identity,viewed:false};previous.current=state;
  const params=new URLSearchParams(location.search),documentId=params.get('document');
  if(documentId&&/^[1-9][0-9]*$/.test(documentId)&&handled.current!==href){const item=resources.find(r=>r.id===documentId)||{id:documentId,title:tr('Document source','Source document','المستند المصدر'),fileType:'PDF',filename:'source.pdf',downloadUrl:'/api/files/'+documentId+'?download=1'};handled.current=href;openDocument({...item,initialPage:params.has('page')?Math.max(1,Number(params.get('page'))||1):undefined,initialVersion:Number(params.get('version'))||undefined});}
  const announcementId=/^#announcement-(\d+)$/.exec(location.hash)?.[1];
  if(announcementId&&!dialog&&handled.current!==href){const item=announcements.find(a=>a.id===announcementId);if(item){handled.current=href;openAnnouncement(item);}}
  const timer=setInterval(()=>{
   if(dialog){state.viewed=true;return;}
   const messageId=params.get('message');
   if(messageId&&messages.some(m=>m.id===messageId)&&document.getElementById('message-'+messageId)?.getClientRects().length){notificationDestinationViewed('message',messageId);state.viewed=true;}
   if(location.pathname==='/app/admin'&&document.querySelector('.admin-page[aria-busy="false"]')&&!document.querySelector('.admin-server-error')){notificationDestinationViewed('page',href);state.viewed=true;}
   if(location.pathname==='/app'){notificationDestinationViewed('page',href);state.viewed=true;}
  },400);
  return()=>clearInterval(timer);
 },[user?.id,user?.mustChangePassword,location.pathname,location.search,location.hash,dialog?.type,dialog?.item?.id,resources,announcements,messages]);
 return null;
}
export default function App(){
 const {user,selection,isAdmin,loading,dialog,toast,setToast,t}=useApp(),destination=accountDestination(user,selection,isAdmin);
 return <><ScrollReset/><NotificationLifecycle/><React.Suspense fallback={<PageLoading fullPage/>}><Routes>
  <Route path="/" element={<LandingPage/>}/>
  <Route path="/login" element={loading?<SessionStatus/>:user?<Navigate to={destination} replace/>:<LoginPage/>}/>
  <Route path="/register" element={loading?<SessionStatus/>:user?<Navigate to={destination} replace/>:<RegisterPage/>}/>
  <Route path="/change-password" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:!requiresPasswordChange(user)?<Navigate to={destination} replace/>:<PasswordChangePage/>}/>
  <Route path="/account-review" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:user.accountStatus==='approved'?<Navigate to={destination} replace/>:<AccountReviewPage/>}/>
  <Route path="/onboarding" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:requiresPasswordChange(user)?<Navigate to="/change-password" replace/>:user.accountStatus!=='approved'?<Navigate to="/account-review" replace/>:selection?<Navigate to={destination} replace/>:<OnboardingPage/>}/>
  <Route path="/app" element={<Protected/>}>
   <Route index element={<HomePage/>}/><Route path="library" element={<LibraryPage/>}/><Route path="community" element={<CommunityPage/>}/><Route path="study" element={<StudyPage/>}/><Route path="scanner" element={<ScannerPage/>}/><Route path="campus" element={<CampusPage/>}/><Route path="labs" element={<CampusLabs/>}/><Route path="feedback" element={<FeedbackPage/>}/><Route path="xp" element={<XPPage/>}/><Route path="permissions" element={user?.role==='global_admin'?<PermissionsPage/>:<Navigate to="/app" replace/>}/><Route path="announcements" element={<AnnouncementsPage/>}/><Route path="notifications" element={<NotificationsPage/>}/><Route path="saved" element={<SavedPage/>}/><Route path="profile" element={<ProfilePage/>}/><Route path="admin" element={isAdmin?<AdminPage/>:<Navigate to="/app" replace/>}/><Route path="*" element={<Navigate to="/app" replace/>}/>
  </Route><Route path="*" element={<Navigate to="/" replace/>}/>
 </Routes></React.Suspense>{dialog&&<React.Suspense fallback={null}><Dialogs/></React.Suspense>}{toast&&<div className="toast" role={toast.type==='error'?'alert':'status'} aria-live="polite">{toast.type==='error'?<AlertCircle size={17}/>:<Check size={17}/>}<span>{toast.message}</span><button className="icon-btn" aria-label={t('close')} onClick={()=>setToast(null)}><X size={15}/></button></div>}</>;
}
