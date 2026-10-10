import React,{useEffect} from 'react';
import {Navigate,Route,Routes,useLocation} from 'react-router-dom';
import {AlertCircle,Check,X} from 'lucide-react';
import {useApp} from './context';
import AppShell from './components/AppShell';
import Dialogs from './components/Modals';
import {LandingPage,LoginPage,OnboardingPage,RegisterPage,AccountReviewPage} from './pages/PublicPages';
import LibraryPage from './pages/LibraryPage';
import CommunityPage from './pages/CommunityPage';
import AdminPage from './pages/AdminPage';
import {HomePage,AnnouncementsPage,NotificationsPage,SavedPage,ProfilePage} from './pages/StudentPages';
import './styles/interaction-overrides.css';

function SessionStatus(){
 const {loading,connectionError,refreshAccount,tr}=useApp();
 return <main className="public-page" style={{minHeight:'100dvh',display:'grid',placeItems:'center',padding:24}}><div className="panel" style={{padding:28,maxWidth:420,textAlign:'center'}} role="status" aria-live="polite"><strong>CampusLink Taza</strong><p className="muted" style={{margin:'12px 0'}}>{loading?tr('Connexion à votre campus…','Connecting to your campus…','جارٍ الاتصال بحرمك الجامعي…'):connectionError}</p>{!loading&&<button className="btn btn-primary" onClick={()=>refreshAccount().catch(()=>{})}>{tr('Réessayer','Retry','إعادة المحاولة')}</button>}</div></main>;
}
function accountDestination(user,selection,isAdmin){return user?.accountStatus!=='approved'?'/account-review':!selection?'/onboarding':isAdmin?'/app/admin':'/app';}
function Protected(){
 const {user,selection,loading,connectionError}=useApp();
 if(loading||(!user&&connectionError))return <SessionStatus/>;
 if(!user)return <Navigate to="/login" replace/>;
 if(user.accountStatus!=='approved')return <Navigate to="/account-review" replace/>;
 if(!selection)return <Navigate to="/onboarding" replace/>;
 return <AppShell/>;
}
function ScrollReset(){const location=useLocation();useEffect(()=>{if(location.hash){requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView({behavior:'auto',block:'start'}));}else{window.scrollTo({top:0,behavior:'auto'});}},[location.pathname,location.hash]);return null;}
export default function App(){
 const {user,selection,isAdmin,loading,toast,setToast,t}=useApp(),destination=accountDestination(user,selection,isAdmin);
 return <><ScrollReset/><Routes>
  <Route path="/" element={<LandingPage/>}/>
  <Route path="/login" element={loading?<SessionStatus/>:user?<Navigate to={destination} replace/>:<LoginPage/>}/>
  <Route path="/register" element={loading?<SessionStatus/>:user?<Navigate to={destination} replace/>:<RegisterPage/>}/>
  <Route path="/account-review" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:user.accountStatus==='approved'?<Navigate to={destination} replace/>:<AccountReviewPage/>}/>
  <Route path="/onboarding" element={loading?<SessionStatus/>:!user?<Navigate to="/login" replace/>:user.accountStatus!=='approved'?<Navigate to="/account-review" replace/>:selection?<Navigate to={destination} replace/>:<OnboardingPage/>}/>
  <Route path="/app" element={<Protected/>}>
   <Route index element={<HomePage/>}/><Route path="library" element={<LibraryPage/>}/><Route path="community" element={<CommunityPage/>}/><Route path="announcements" element={<AnnouncementsPage/>}/><Route path="notifications" element={<NotificationsPage/>}/><Route path="saved" element={<SavedPage/>}/><Route path="profile" element={<ProfilePage/>}/><Route path="admin" element={isAdmin?<AdminPage/>:<Navigate to="/app" replace/>}/><Route path="*" element={<Navigate to="/app" replace/>}/>
  </Route><Route path="*" element={<Navigate to="/" replace/>}/>
 </Routes><Dialogs/>{toast&&<div className="toast" role={toast.type==='error'?'alert':'status'} aria-live="polite">{toast.type==='error'?<AlertCircle size={17}/>:<Check size={17}/>}<span>{toast.message}</span><button className="icon-btn" aria-label={t('close')} onClick={()=>setToast(null)}><X size={15}/></button></div>}</>;
}
