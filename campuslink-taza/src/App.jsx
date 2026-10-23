import ConnectionStatus from './components/ConnectionStatus';
import React,{useEffect} from 'react';
import {Navigate,Route,Routes,useLocation} from 'react-router-dom';
import NotificationCenter from './components/NotificationCenter';
import {useApp} from './context';
import PageLoading from './components/PageLoading';
import {accountDestination,requiresPasswordChange} from './lib/backend';
import {documentOpenRequest} from './lib/document-open';
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
const AccessSupportPage=React.lazy(()=>import('./pages/AccessSupportPage'));
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

function SessionStatus(){return <main className="public-page" style={{minHeight:'100dvh',display:'grid',placeItems:'center',padding:24}}><ConnectionStatus initial/></main>;}
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
 const location=useLocation();const {user,dialog,resources,announcements,messages,openDocument,openAnnouncement,notificationDestinationViewed,leaveNotificationDestination,activeNotificationId,notificationVisitRevision,tr}=useApp();
 const previous=React.useRef(null);const handled=React.useRef('');const handledDocument=React.useRef('');
 useEffect(()=>{
  if(!user||requiresPasswordChange(user)){previous.current=null;handled.current='';handledDocument.current='';return;}
  const href=location.pathname+location.search+location.hash;
  const params=new URLSearchParams(location.search),documentId=params.get('document');
  const documentRequest=documentOpenRequest(location);
  if(!documentRequest)handledDocument.current='';
  const announcementId=/^#announcement-(\d+)$/.exec(location.hash)?.[1];
  const identity=dialog?dialog.type+':'+dialog.item?.id:href;
  const openingLinkedDialog=previous.current?.identity===href&&((dialog?.type==='document'&&String(dialog.item?.id)===documentId)||(dialog?.type==='announcement'&&String(dialog.item?.id)===announcementId));
  if(previous.current&&previous.current.identity!==identity&&!openingLinkedDialog)leaveNotificationDestination(previous.current.identity);
  previous.current={identity};
  if(documentRequest&&handledDocument.current!==documentRequest){const item=resources.find(r=>r.id===documentId)||{id:documentId,title:tr('Document source','Source document','المستند المصدر'),fileType:'PDF',filename:'source.pdf',downloadUrl:'/api/files/'+documentId+'?download=1'};handledDocument.current=documentRequest;openDocument({...item,initialPage:params.has('page')?Math.max(1,Number(params.get('page'))||1):undefined,initialVersion:Number(params.get('version'))||undefined},{inPlace:true,study:params.get('mode')==='study',linkedRequest:documentRequest});}
  if(announcementId&&!dialog&&handled.current!==href){const item=announcements.find(a=>a.id===announcementId);if(item){handled.current=href;openAnnouncement(item);}}
  if(!activeNotificationId)return;
  function visible(node){if(!node?.getClientRects().length)return false;const rect=node.getBoundingClientRect();return rect.bottom>0&&rect.top<window.innerHeight&&rect.right>0&&rect.left<window.innerWidth;}
  const started=Date.now();
  const viewed=(kind,target)=>notificationDestinationViewed(kind,target).then(done=>{if(done)clearInterval(timer);});
  const timer=setInterval(()=>{
   if(Date.now()-started>45000){clearInterval(timer);return;}
   if(document.visibilityState==='hidden'||dialog)return;
   const messageId=params.get('message');
   if(messageId&&messages.some(m=>m.id===messageId)&&visible(document.getElementById('message-'+messageId)))viewed('message',messageId);
   if(location.pathname==='/app/admin'&&visible(document.querySelector('[data-notification-target-ready="true"]')))viewed('page',href);
   if(location.pathname==='/app')viewed('page',href);
  },400);
  return()=>clearInterval(timer);
 },[user?.id,user?.mustChangePassword,location.pathname,location.search,location.hash,dialog?.type,dialog?.item?.id,resources,announcements,messages,activeNotificationId,notificationVisitRevision]);
 return null;
}
export default function App(){
 const {user,selection,isAdmin,loading,dialog}=useApp(),destination=accountDestination(user,selection,isAdmin);
 return <><ScrollReset/><NotificationLifecycle/><React.Suspense fallback={<PageLoading fullPage/>}><Routes>
  <Route path="/" element={<LandingPage/>}/>
  <Route path="/support" element={<AccessSupportPage/>}/>
  <Route path="/login" element={loading?<SessionStatus/>:user?<Navigate to={destination} replace/>:<LoginPage/>}/>
  <Route path="/register" element={loading?<SessionStatus/>:user?<Navigate to={destination} replace/>:<RegisterPage/>}/>
  <Route path="/change-password" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:!requiresPasswordChange(user)?<Navigate to={destination} replace/>:<PasswordChangePage/>}/>
  <Route path="/account-review" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:user.accountStatus==='approved'?<Navigate to={destination} replace/>:<AccountReviewPage/>}/>
  <Route path="/onboarding" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:requiresPasswordChange(user)?<Navigate to="/change-password" replace/>:user.accountStatus!=='approved'?<Navigate to="/account-review" replace/>:selection?<Navigate to={destination} replace/>:<OnboardingPage/>}/>
  <Route path="/app" element={<Protected/>}>
   <Route index element={<HomePage/>}/><Route path="library" element={<LibraryPage/>}/><Route path="community" element={<CommunityPage/>}/><Route path="study" element={<StudyPage/>}/><Route path="scanner" element={<ScannerPage/>}/><Route path="campus" element={<CampusPage/>}/><Route path="labs" element={<CampusLabs/>}/><Route path="feedback" element={<FeedbackPage/>}/><Route path="xp" element={<XPPage/>}/><Route path="permissions" element={user?.role==='global_admin'?<PermissionsPage/>:<Navigate to="/app" replace/>}/><Route path="announcements" element={<AnnouncementsPage/>}/><Route path="notifications" element={<NotificationsPage/>}/><Route path="saved" element={<SavedPage/>}/><Route path="profile" element={<ProfilePage/>}/><Route path="admin" element={isAdmin?<AdminPage/>:<Navigate to="/app" replace/>}/><Route path="*" element={<Navigate to="/app" replace/>}/>
  </Route><Route path="*" element={<Navigate to="/" replace/>}/>
 </Routes></React.Suspense>{dialog&&<React.Suspense fallback={null}><Dialogs/></React.Suspense>}<NotificationCenter/></>;
}
