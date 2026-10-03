import React,{useEffect} from 'react';
import {Routes,Route,Navigate,useNavigate,Link,useLocation} from 'react-router-dom';
import {AlertCircle,ArrowRight,CheckCircle2,X} from 'lucide-react';
import {useApp} from './context';
import AppShell from './components/AppShell';
import {ModalHost} from './components/Modals';
import {BrandMark,EmptyState} from './components/ui';
import {LandingPage,LoginPage,FacultySelectionPage,StudiesSelectionPage} from './pages/PublicPages';
import {ChatPage,AnnouncementsPage} from './pages/CommunityPages';
import {HomePage,ResourcesPage,CalendarPage,NotificationsPage,SavedPage,MembersPage,AboutPage,SearchPage,SettingsPage} from './pages/StudyPages';
import AdminPage from './pages/AdminPage';
function LoadingScreen(){const{t}=useApp();return <div className="loading-screen" role="status"><BrandMark size={48}/><span className="loader"/><p>{t('loadingCampus','Votre campus se prépare…')}</p></div>}
function accountDestination(user){return !user.faculty_id?'/onboarding/faculty':user.role==='student'&&!user.filiere_id?'/onboarding/studies':'/app';}
function Protected({children,onboarding=false}){
  const{user,loading,data,error,refresh,t}=useApp();const location=useLocation();
  if(loading)return <LoadingScreen/>;
  if(!user)return <Navigate to="/login" replace state={{from:location.pathname+location.search+location.hash}}/>;
  if(!user.faculty_id&&onboarding!=='faculty')return <Navigate to="/onboarding/faculty" replace state={location.state}/>;
  if(user.faculty_id&&onboarding==='faculty')return <Navigate to={accountDestination(user)} replace state={location.state}/>;
  if(user.faculty_id&&user.role==='student'&&!user.filiere_id&&!onboarding)return <Navigate to="/onboarding/studies" replace state={{from:location.pathname+location.search+location.hash}}/>;
  if(onboarding==='studies'&&user.filiere_id)return <Navigate to={location.state?.from?.startsWith('/app')?location.state.from:'/app'} replace/>;
  if(!onboarding&&!data)return error?<div className="loading-screen"><EmptyState icon={AlertCircle} title={t('connectionError','Connexion interrompue')} description={t(error,error)} action={<button className="btn gold-btn" onClick={()=>refresh().catch(()=>{})}>{t('retry','Réessayer')}</button>}/></div>:<LoadingScreen/>;
  return children;
}
function LoginRoute(){const{user,loading}=useApp();const location=useLocation();const destination=user?accountDestination(user):null;return loading?<LoadingScreen/>:user?<Navigate to={destination==='/app'&&location.state?.from?.startsWith('/app')?location.state.from:destination} replace state={location.state}/>:<LoginPage/>}
class ErrorBoundary extends React.Component{constructor(props){super(props);this.state={error:null};}static getDerivedStateFromError(error){return{error};}render(){const t=this.props.t;return this.state.error?<div className="loading-screen"><h1>CampusLink Taza</h1><p>{t('unexpectedError','Une erreur est survenue. Rechargez votre espace pour continuer.')}</p><button className="btn gold-btn" onClick={()=>window.location.reload()}>{t('reload','Recharger')}</button></div>:this.props.children;}}
function AppRoutes(){const{openModal,user,t,toasts}=useApp();const navigate=useNavigate();useEffect(()=>{const key=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(user?.faculty_id)openModal('search');else navigate('/login');}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[user?.faculty_id,openModal,navigate]);return <><a className="skip-link" href="#main-content">{t('skipToContent','Aller au contenu')}</a><Routes><Route path="/" element={<LandingPage/>}/><Route path="/login" element={<LoginRoute/>}/><Route path="/onboarding/faculty" element={<Protected onboarding="faculty"><FacultySelectionPage/></Protected>}/><Route path="/onboarding/studies" element={<Protected onboarding="studies"><StudiesSelectionPage/></Protected>}/><Route path="/app" element={<Protected><AppShell/></Protected>}><Route index element={<HomePage/>}/><Route path="chat/:channel" element={<ChatPage/>}/><Route path="announcements" element={<AnnouncementsPage/>}/><Route path="resources/:category?/:semester?/:module?" element={<ResourcesPage/>}/><Route path="calendar" element={<CalendarPage/>}/><Route path="notifications" element={<NotificationsPage/>}/><Route path="saved" element={<SavedPage/>}/><Route path="members" element={<MembersPage/>}/><Route path="about" element={<AboutPage/>}/><Route path="search" element={<SearchPage/>}/><Route path="profile" element={<SettingsPage/>}/><Route path="settings" element={<SettingsPage/>}/><Route path="admin" element={<AdminPage/>}/><Route path="*" element={<NotFound/>}/></Route><Route path="*" element={<NotFound/>}/></Routes><ModalHost/><div className="toast-container" aria-live="polite">{toasts.map(item=><div key={item.id} className={`toast ${item.type}`}>{item.type==='error'?<AlertCircle size={17}/>:<CheckCircle2 size={17}/>}<span>{t(item.message,item.message)}</span></div>)}</div></>}
function NotFound(){const{t}=useApp();return <div className="not-found"><BrandMark size={52}/><span className="section-label">404</span><h1>{t('pageNotFound','Cette page ne fait pas partie du campus.')}</h1><Link className="btn gold-btn" to="/app">{t('backHome',"Retour à l'accueil")}<ArrowRight size={16}/></Link></div>}
export default function App(){const{t}=useApp();return <ErrorBoundary t={t}><AppRoutes/></ErrorBoundary>}
