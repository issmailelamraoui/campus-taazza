import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, ArrowRight, Ban, Bell, BellRing, Bookmark, BookOpen, CalendarDays, Check, CheckCheck, ChevronLeft, ChevronRight, Clock3, Download, FileText, Filter, GraduationCap, Hash, History, ImagePlus, Library, Loader2, LockKeyhole, Mail, MessageSquare, Moon, Search, Settings2, ShieldCheck, Sparkles, Sun, Users, X } from 'lucide-react';
import { useApp } from '../context.jsx';
import { api } from '../api.js';
import { readNotifications } from '../optimistic.js';
import { resourcePath, messagePath, slug } from '../utils.js';
import { ResourceCard, EmptyState, Avatar, PageHeading, CategoryIcon, Badge } from '../components/ui.jsx';
import InstallApp from '../components/InstallApp.jsx';
import './study.css';

const categories = ['courses', 'exercises', 'exams', 'rattrapage'];
const currentDateParts = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
const currentPart = type => Number(currentDateParts.find(part => part.type === type)?.value);
const today = new Date(currentPart('year'), currentPart('month') - 1, currentPart('day'), 12);
const categoryLabels = { courses: 'Cours', exercises: 'Exercices', exams: 'Anciens examens', rattrapage: 'Rattrapage', general: 'Documents' };
const resourceTypeOrder = ['courses','exercises','td','tp','correction','exams','rattrapage','pdf','document','image','other'];
const resourceTypeLabels = {
  courses: ['courses','Cours'],
  exercises: ['exercises','Exercices'],
  td: ['resourceTD','TD'],
  tp: ['resourceTP','TP'],
  correction: ['resourceCorrection','Corrections'],
  exams: ['exams','Anciens examens'],
  rattrapage: ['rattrapage','Rattrapage'],
  pdf: ['resourcePDF','PDF'],
  document: ['resourceDocument','Documents'],
  image: ['resourceImage','Images'],
  other: ['resourceOther','Autres ressources'],
};
const resourceTypeLabel = (t, type) => {
  const [key, fallback] = resourceTypeLabels[type] || resourceTypeLabels.other;
  return t(key, fallback);
};
const resourceTypeOf = resource => resource.resource_type || resource.category || 'other';
const localeFor = (lang) => lang === 'ar' ? 'ar-MA' : lang === 'en' ? 'en-GB' : 'fr-FR';
const label = (t, category) => t(`category.${category}`, categoryLabels[category] || category);
const dateLabel = (value, lang, options = {}) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(localeFor(lang), { timeZone: 'Africa/Casablanca', day: 'numeric', month: 'short', ...options });
};
const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const validDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.getTime()) && dateKey(parsed) === value;
};

function LoadingContent() {
  return <div className="study-loading" aria-busy="true" role="status"><div className="study-skeleton study-skeleton-heading" /><div className="study-skeleton study-skeleton-banner" /><div className="study-skeleton-grid">{[1, 2, 3].map(i => <div key={i} className="study-skeleton study-skeleton-card" />)}</div></div>;
}

function DataGate({ children }) {
  const { data, loading, error, refresh, t } = useApp();
  if (!data && loading) return <LoadingContent />;
  if (!data && error) return <EmptyState icon={Library} title={t('study.loadError', 'Impossible de charger votre espace')} description={t(error,error)} action={<button className="btn gold-btn" onClick={() => refresh().catch(() => {})}>{t('common.retry', 'Réessayer')}</button>} />;
  if (!data) return <LoadingContent />;
  return children;
}

function SectionHeader({ icon: Icon, title, description, to, action }) {
  const { t } = useApp();
  return <div className="study-section-heading"><div><h2>{Icon && <Icon size={17} />}{title}</h2>{description && <p>{description}</p>}</div>{to && <Link className="subtle-link study-view-all" to={to}>{t('common.seeAll', 'Voir tout')} <ArrowRight size={14} /></Link>}{action}</div>;
}

function useAnchorFocus(items) {
  const location = useLocation();
  const [target, setTarget] = useState('');
  useEffect(() => {
    if (!location.hash) { setTarget(''); return; }
    const id = decodeURIComponent(location.hash.slice(1));
    setTarget(id);
    const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }));
    const timer = setTimeout(() => setTarget(''), 4200);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [location.hash, items]);
  return target;
}

function AnnouncementSummary({ announcement }) {
  const { t, lang, toggleSave, saved: records, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const saved = records.some(r => r.type === 'announcement' && String(r.id) === String(announcement.id));
  const save = async () => { setBusy(true); try { await toggleSave('announcement', announcement.id); } catch (error) { toast(error.message, 'error'); } finally { setBusy(false); } };
  return <article className="study-announcement" id={`announcement-${announcement.id}`}><div className="study-announcement-icon"><BellRing size={19} /></div><div className="study-announcement-content"><div className="study-meta"><span>{announcement.author?.name || t('student', 'Étudiant')}</span><time dateTime={announcement.created_at}>{dateLabel(announcement.created_at, lang)}</time></div><Link to={announcement.message_id ? messagePath(announcement) : `/app/announcements#announcement-${announcement.id}`}>{announcement.content}</Link><div className="study-announcement-bottom"><Link to={`/app/announcements#announcement-${announcement.id}`} className="subtle-link">{t('study.readAnnouncement', "Lire l'annonce")} <ArrowUpRight size={12} /></Link><button className={`icon-button ${saved ? 'is-saved' : ''}`} disabled={busy||Boolean(announcement._status)} onClick={save} aria-label={saved ? t('study.removeSaved', 'Retirer des enregistrés') : t('common.save', 'Enregistrer')}>{busy ? <Loader2 size={15} className="spin" /> : <Bookmark size={15} fill={saved ? 'currentColor' : 'none'} />}</button></div></div></article>;
}

export function HomePage() {
  return <DataGate><HomeContent /></DataGate>;
}

function HomeContent() {
  const { user, data, t, lang, openModal } = useApp();
  const resources = data.resources || [];
  const announcements = data.announcements || [];
  const recent = [...resources].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const continued = (data.history || []).map(h => ({ ...h, resource: resources.find(r => String(r.id) === String(h.resource_id)) })).filter(h => h.resource).slice(0, 2);
  const upcoming = (data.events || []).filter(e => e.date >= dateKey(today)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2);
  const important = (data.messages || []).filter(m => m.channel === 'important').slice(-2).reverse();
  const activity = [...resources.map(r => ({ id: `r-${r.id}`, type: 'resource', date: r.created_at, item: r })), ...announcements.map(a => ({ id: `a-${a.id}`, type: 'announcement', date: a.created_at, item: a }))].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 4);
  const newCount = resources.filter(r => new Date(r.created_at) >= new Date(today.getTime() - 7 * 86400000)).length;
  return <div className="study-page study-home">
    <div className="study-welcome"><div><div className="study-eyebrow"><span className="study-live-dot" />{t('study.privateSpace', 'Votre espace privé')} <span>·</span> {data.faculty?.code}</div><h1>{t('study.hello', 'Bonjour')} {user?.name?.split(' ')[0] || user?.username}<span className="gold">.</span></h1><p>{t('study.homeIntro', "Un nouveau jour pour apprendre, échanger et avancer ensemble.")}</p></div><div className="study-welcome-date"><CalendarDays size={18} /><span>{today.toLocaleDateString(localeFor(lang), { day: 'numeric', month: 'long', year: 'numeric' })}</span></div></div>
    <section className="study-home-hero"><div className="study-home-hero-copy"><div className="study-eyebrow">{t('study.workspace', 'Votre espace de travail')}</div><h2>{t('study.essentials', "L'essentiel de votre faculté.")}</h2><p>{t('study.homeHero', 'Des ressources bien organisées. Une communauté pour vous accompagner. Tout ce dont vous avez besoin, au même endroit.')}</p><Link className="btn gold-btn study-hero-button" to="/app/chat/general"><MessageSquare size={16} />{t('study.seeCommunity', 'Voir la communauté')}<ArrowUpRight size={16} /></Link></div><div className="study-hero-emblem" aria-hidden="true"><GraduationCap size={52} strokeWidth={1} /><span>USMBA</span><small>TAZA</small></div></section>
    <div className="study-stat-grid"><div className="study-stat"><Library size={18} /><strong>{resources.length}</strong><span>{t('study.sharedResources', 'Ressources partagées')}</span></div><div className="study-stat"><Users size={18} /><strong>{data.members?.length || data.faculty?.members || 0}</strong><span>{t('study.communityMembers', 'Membres de la communauté')}</span></div><div className="study-stat"><Sparkles size={18} /><strong>{newCount}</strong><span>{t('study.newThisWeek', 'Nouveautés cette semaine')}</span></div></div>
    <section className="study-section"><SectionHeader title={t('study.closeAtHand', 'À portée de main')} icon={BookOpen} to="/app/resources" /><div className="study-category-grid">{categories.map(category => <Link key={category} className={`study-category-card category-${category}`} to={`/app/resources/${category}`}><CategoryIcon category={category} size={24} /><div><h3>{label(t, category)}</h3><p>{resources.filter(r => r.category === category).length} {t('study.documents', 'documents')}</p></div><ChevronRight size={15} /></Link>)}</div></section>
    <section className="study-section"><SectionHeader title={t('study.resume', 'Reprendre')} description={t('study.recentReading', 'Derniers documents consultés')} icon={History} /><div className="study-continue-grid">{continued.length ? continued.map(({ resource, opened_at }) => <button key={resource.id} className="study-continue-card" onClick={() => openModal('preview', resource)}><div className={`study-file-symbol category-${resource.category}`}><FileText size={25} /></div><div><span className="study-meta">{label(t, resource.category)} · S{resource.semester}{resource.module ? ` · ${resource.module}` : ''}</span><h3>{resource.title}</h3><p><Clock3 size={12} />{t('study.openedOn', 'Consulté le')} {dateLabel(opened_at, lang)}</p></div><ArrowUpRight size={17} /></button>) : <div className="study-inline-empty"><History size={22} /><div><strong>{t('study.noReading', 'Aucun document consulté')}</strong><p>{t('study.readingEmpty', 'Vos lectures récentes apparaîtront ici.')}</p></div><Link to="/app/resources" className="subtle-link">{t('study.exploreLibrary', 'Explorer la bibliothèque')} <ArrowRight size={14} /></Link></div>}</div></section>
    <section className="study-section"><SectionHeader title={t('study.latestResources', 'Nouvelles ressources')} icon={Library} to="/app/resources" /><div className="study-resource-grid">{recent.slice(0, 3).map(resource => <ResourceCard key={resource.id} resource={resource} />)}</div>{!recent.length && <EmptyState icon={Library} title={t('study.noResources', 'Votre bibliothèque attend ses premières ressources')} description={t('study.shareFirst', 'Partagez un cours ou un exercice avec votre communauté.')} action={<button className="btn gold-btn" onClick={() => openModal('upload', {})}>{t('study.shareResource', 'Partager une ressource')}</button>} />}</section>
    <div className="study-home-columns"><section className="study-section"><SectionHeader title={t('study.importantAnnouncements', 'Annonces importantes')} icon={BellRing} to="/app/announcements" />{announcements.slice(0, 2).map(a => <AnnouncementSummary key={a.id} announcement={a} />)}{!announcements.length && <p className="study-small-empty">{t('study.noAnnouncements', 'Aucune annonce pour le moment.')}</p>}<SectionHeader title={t('study.importantDiscussions', 'Discussions importantes')} icon={Hash} to="/app/chat/important" />{important.map(m => <Link key={m.id} className="study-discussion-preview" to={messagePath(m)}><Avatar user={m.author} size={30} /><div><strong>{m.author?.name}</strong><p>{m.content}</p></div><ArrowUpRight size={14} /></Link>)}{!important.length && <p className="study-small-empty">{t('study.noImportantDiscussions', 'Les discussions importantes apparaîtront ici.')}</p>}</section><section className="study-section"><SectionHeader title={t('study.nextAppointments', 'Vos prochains rendez-vous')} icon={CalendarDays} to="/app/calendar" />{upcoming.map(e => <Link key={e.id} className="study-event-preview" to={`/app/calendar?date=${e.date}#event-${e.id}`}><div className="study-event-date"><strong>{e.date.split('-')[2]}</strong><span>{dateLabel(e.date, lang, { day: undefined }).replace('.', '')}</span></div><div><h3>{e.title}</h3><p>{e.time || t('study.allDay', 'Toute la journée')}</p></div><ChevronRight size={14} /></Link>)}{!upcoming.length && <p className="study-small-empty">{t('study.noEvents', 'Aucun événement à venir.')}</p>}<SectionHeader title={t('study.recentActivity', 'Activité récente')} icon={Clock3} /><div className="study-activity-list">{activity.map(a => <Link key={a.id} to={a.type === 'resource' ? resourcePath(a.item) : `/app/announcements#announcement-${a.item.id}`}><span className={`study-activity-dot ${a.type}`} /><div><p>{a.type === 'resource' ? `${t('study.added', 'Ajouté')} · ${label(t, a.item.category)} · S${a.item.semester}` : t('study.announcementPublished', 'Annonce publiée')}<strong>{a.item.title || a.item.content}</strong></p><time>{dateLabel(a.date, lang)}</time></div></Link>)}</div>{!activity.length && <p className="study-small-empty">{t('study.activityEmpty', "L'activité de votre communauté apparaîtra ici.")}</p>}</section></div>
  </div>;
}

export function ResourcesPage() { return <DataGate><ResourcesContent /></DataGate>; }

function ResourcesContent() {
  const { data, t, openModal } = useApp();
  const { category, semester: semesterParam, module: moduleParam } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const sort = searchParams.get('sort') || 'newest';
  const semester = Number(String(semesterParam || searchParams.get('semester') || '').replace(/^s/i, '')) || '';
  const resources = data.resources || [];
  const modules = [...new Set(resources.filter(r => (!category || r.category === category) && (!semester || Number(r.semester) === semester)).map(r => r.module).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const requestedModule = moduleParam || searchParams.get('module') || '';
  const moduleName = requestedModule ? modules.find(m => slug(m) === requestedModule || m === requestedModule) || requestedModule : '';
  const filtered = useMemo(() => resources.filter(r => (!category || r.category === category) && (!semester || Number(r.semester) === semester) && (!moduleName || r.module === moduleName) && (!query || `${r.title} ${r.filename} ${r.module || ''} ${r.author?.name || ''}`.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => sort === 'oldest' ? new Date(a.created_at) - new Date(b.created_at) : sort === 'popular' ? b.downloads - a.downloads : new Date(b.created_at) - new Date(a.created_at)), [resources, category, semester, moduleName, query, sort]);
  const target = useAnchorFocus(filtered.length);
  const selectedResource = resources.find(r => `resource-${r.id}` === decodeURIComponent(useLocation().hash.slice(1)));
  const routeFilters = (nextCategory, nextSemester, nextModule = '') => {
    const nextParams = new URLSearchParams();
    if (query) nextParams.set('q', query);
    if (sort !== 'newest') nextParams.set('sort', sort);
    const path = `/app/resources${nextCategory ? `/${nextCategory}` : ''}${nextCategory && nextSemester ? `/s${nextSemester}` : ''}${nextCategory && nextSemester && nextModule ? `/${slug(nextModule)}` : ''}`;
    if (!nextCategory && nextSemester) nextParams.set('semester', nextSemester);
    if ((!nextCategory || !nextSemester) && nextModule) nextParams.set('module', nextModule);
    navigate(`${path}${nextParams.size ? `?${nextParams}` : ''}`);
  };
  const setQueryParam = (key, value) => setSearchParams(prev => { const next = new URLSearchParams(prev); value ? next.set(key, value) : next.delete(key); return next; }, { replace: true });
  const grouped = semester ? [{ id: semester, resources: filtered }] : [1, 2, 3, 4, 5, 6].map(id => ({ id, resources: filtered.filter(r => Number(r.semester) === id) })).filter(g => g.resources.length);
  const general = filtered.filter(r => !r.semester);
  const renderResourceGroups = rows => {
    const moduleNames = [...new Set(rows.map(r => r.module || ''))];
    return moduleNames.map(module => {
      const moduleRows = rows.filter(r => (r.module || '') === module);
      const types = [...new Set(moduleRows.map(resourceTypeOf))].sort((a,b) => {
        const ai=resourceTypeOrder.indexOf(a), bi=resourceTypeOrder.indexOf(b);
        return (ai<0?999:ai)-(bi<0?999:bi);
      });
      return <div className="study-module-group" key={module || 'other'}>
        <div className="study-module-heading"><BookOpen size={14} /><h3>{module || t('study.otherDocuments', 'Autres documents')}</h3><span>{moduleRows.length}</span></div>
        <div className="study-resource-type-groups">
          {types.map(type => {
            const typeRows=moduleRows.filter(r => resourceTypeOf(r)===type);
            return <section className={`study-resource-type-group resource-type-${type}`} key={type}>
              <div className="study-resource-type-heading"><CategoryIcon category={typeRows[0]?.category} size={16}/><strong>{resourceTypeLabel(t,type)}</strong><span>{typeRows.length}</span></div>
              <div className="study-resource-grid">{typeRows.map(r => <div className={`study-library-resource category-${r.category} ${target === `resource-${r.id}` ? 'study-resource-focus' : ''}`} key={r.id}><ResourceCard resource={r} /></div>)}</div>
            </section>;
          })}
        </div>
      </div>;
    });
  };
  return <div className="study-page study-library">
    <nav className="study-breadcrumbs" aria-label={t('study.breadcrumbs', "Fil d'Ariane")}><Link to="/app/resources">{t('nav.library', 'Bibliothèque')}</Link>{category && <><ChevronRight size={12} /><Link to={`/app/resources/${category}`}>{label(t, category)}</Link></>}{semester && <><ChevronRight size={12} /><Link to={category ? `/app/resources/${category}/s${semester}` : `/app/resources?semester=${semester}`}>S{semester}</Link></>}{moduleName && <><ChevronRight size={12} /><span>{moduleName}</span></>}{selectedResource && <><ChevronRight size={12} /><span className="study-breadcrumb-current">{selectedResource.title}</span></>}</nav>
    <PageHeading eyebrow={t('study.academicResources', 'Ressources académiques')} title={category ? label(t, category) : t('nav.library', 'Bibliothèque')} description={t('study.libraryIntro', 'Un savoir partagé, organisé pour vos études.')}><button className="btn gold-btn" onClick={() => openModal('upload', { category: category || 'courses', semester: semester || 1, module: moduleName })}><ImagePlus size={16} />{t('study.shareResource', 'Partager une ressource')}</button></PageHeading>
    <div className="study-resource-tabs" role="navigation" aria-label={t('study.resourceType', 'Type de ressource')}><Link className={`study-library-category ${!category ? 'active' : ''}`} aria-current={!category ? 'page' : undefined} to="/app/resources"><Library size={19} /><span>{t('common.all', 'Tout')}</span><span className="study-library-category-count" aria-hidden="true">{resources.length}</span></Link>{categories.map(c => <Link key={c} className={`study-library-category category-${c} ${category === c ? 'active' : ''}`} aria-current={category === c ? 'page' : undefined} to={`/app/resources/${c}`}><CategoryIcon category={c} size={19} /><span>{label(t, c)}</span><span className="study-library-category-count" aria-hidden="true">{resources.filter(r => r.category === c).length}</span></Link>)}</div>
    <section className="study-semester-strip" aria-label={t('study.chooseSemester', 'Choisir un semestre')}><button className={`study-all-semesters ${!semester ? 'active' : ''}`} onClick={() => routeFilters(category, '')}>{t('study.allSemesters', 'Tous les semestres')}</button>{[[1, 2], [3, 4], [5, 6]].map((group, index) => <div className="study-semester-group" data-study-year={index + 1} key={index}><span>{t('study.year', 'Année')} {index + 1}</span><div>{group.map(s => <button key={s} className={semester === s ? 'active' : ''} onClick={() => routeFilters(category, s)}>S{s}</button>)}</div></div>)}</section>
    <div className="study-filters"><label className="study-search-input"><Search size={16} /><input value={query} onChange={e => setQueryParam('q', e.target.value)} placeholder={t('study.findResource', 'Retrouver une ressource…')} aria-label={t('study.findResource', 'Retrouver une ressource…')} />{query && <button className="icon-button" onClick={() => setQueryParam('q', '')} aria-label={t('common.clear', 'Effacer')}><X size={14} /></button>}</label><label className="study-select-field"><Filter size={14} /><select value={moduleName} aria-label={t('study.module', 'Module')} onChange={e => routeFilters(category, semester, e.target.value)}><option value="">{t('study.allModules', 'Tous les modules')}</option>{modules.map(m => <option key={m} value={m}>{m}</option>)}</select></label><label className="study-select-field"><select value={sort} aria-label={t('study.sort', 'Trier')} onChange={e => setQueryParam('sort', e.target.value)}><option value="newest">{t('study.newest', 'Plus récents')}</option><option value="oldest">{t('study.oldest', 'Plus anciens')}</option><option value="popular">{t('study.mostDownloaded', 'Plus téléchargés')}</option></select></label></div>
    <div className="study-results-meta"><span>{filtered.length} {t('study.resourcesFound', 'ressources trouvées')}{semester ? ` · S${semester}` : ''}{moduleName ? ` · ${moduleName}` : ''}</span>{(query || moduleName || semester) && <button className="subtle-link" onClick={() => navigate(`/app/resources${category ? `/${category}` : ''}`)}>{t('study.resetFilters', 'Réinitialiser les filtres')}<X size={12} /></button>}</div>
    {filtered.length ? <>{grouped.map(group => <section className="study-resource-section" data-study-year={Math.ceil(group.id / 2)} key={group.id}><SectionHeader title={`${t('study.semester', 'Semestre')} ${group.id}`} description={!semester ? `${group.resources.length} ${t('study.documents', 'documents')}` : moduleName || t('study.semesterOrganized', 'Vos documents, organisés par module et type')} to={!semester ? category ? `/app/resources/${category}/s${group.id}` : `/app/resources?semester=${group.id}` : undefined} />{renderResourceGroups(group.resources)}</section>)}{general.length > 0 && <section className="study-resource-section"><SectionHeader title={t('study.generalDocuments', 'Documents généraux')} />{renderResourceGroups(general)}</section>}</> : <EmptyState icon={BookOpen} title={semester ? `${t('study.noResourcesSemester', 'Aucune ressource disponible pour')} S${semester}.` : t('study.noResourceMatch', 'Aucune ressource ne correspond à votre recherche')} description={t('study.resourceEmptyHint', 'Essayez un autre filtre ou partagez le premier document.')} action={<button className="btn gold-btn" onClick={() => openModal('upload', { category: category || 'courses', semester: semester || 1 })}>{t('study.shareResource', 'Partager une ressource')}</button>} />}
    {moduleName && <section className="study-related"><BookOpen size={19} /><div><h3>{t('study.continueModule', 'Approfondir ce module')}</h3><p>{moduleName} · S{semester}</p></div>{categories.filter(c => c !== category && resources.some(r => r.category === c && Number(r.semester) === semester && r.module === moduleName)).map(c => <Link className="btn btn-secondary" key={c} to={`/app/resources/${c}/s${semester}/${slug(moduleName)}`}>{label(t, c)}<ArrowUpRight size={13} /></Link>)}</section>}
  </div>;
}

export function NotificationsPage() { return <DataGate><NotificationsContent /></DataGate>; }

function NotificationsContent() {
  const { data, t, lang, optimisticAction, toast } = useApp();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const all = data.notifications || [];
  const unread = all.filter(n => !n.read).length;
  const notifications = all.filter(n => (filter === 'all' || n.type === filter) && (!unreadOnly || !n.read)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const markRead = async (ids) => { setBusy(true); try { await optimisticAction({key: `notifications-${ids?.join(',') || 'all'}`, apply: base => readNotifications(base, ids), request: () => api('/notifications/read', { method: 'POST', body: ids ? { ids } : {} })}); } catch (error) { toast(error.message, 'error'); } finally { setBusy(false); } };
  const visit = notification => { if (!notification.read) markRead([notification.id]); navigate(notification.path || '/app'); };
  const icons = { resources: Library, announcements: BellRing, important: MessageSquare, admin: ShieldCheck, calendar: CalendarDays };
  return <div className="study-page"><PageHeading eyebrow={t('study.stayInformed', 'Rester informé')} title={t('nav.notifications', 'Notifications')} description={t('study.notificationsIntro', 'Seulement ce qui compte pour votre vie universitaire.')}><button className="btn btn-secondary" disabled={!unread || busy} onClick={() => markRead()}>{busy ? <Loader2 size={16} className="spin" /> : <CheckCheck size={16} />}{t('study.readAll', 'Marquer tout comme lu')}</button></PageHeading><div className="study-notification-top"><div className="study-filter-pills">{[['all', 'Tout'], ['resources', 'Ressources'], ['announcements', 'Annonces'], ['important', 'Discussions importantes'], ['admin', 'Administration'], ['calendar', 'Calendrier']].map(([value, text]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{t(`study.notificationFilter.${value}`, text)}{value === 'all' && unread > 0 && <span>{unread}</span>}</button>)}</div><label className="study-checkbox"><input type="checkbox" checked={unreadOnly} onChange={e => setUnreadOnly(e.target.checked)} />{t('study.unreadOnly', 'Non lues uniquement')}</label></div><div className="study-notifications">{notifications.map(n => { const Icon = icons[n.type] || Bell; return <button key={n.id} className={`study-notification ${n.read ? 'read' : 'unread'} type-${n.type}`} disabled={busy} onClick={() => visit(n)}><span className="study-notification-icon"><Icon size={20} /></span><span className="study-notification-copy"><strong>{n.title}</strong><span>{n.body}</span><time dateTime={n.created_at}>{dateLabel(n.created_at, lang, { hour: '2-digit', minute: '2-digit' })}</time></span>{!n.read && <span className="study-unread-dot" aria-label={t('study.unread', 'Non lu')} />}<ChevronRight size={16} /></button>; })}</div>{!notifications.length && <EmptyState icon={CheckCheck} title={t('study.allUpToDate', 'Tout est à jour')} description={unreadOnly ? t('study.noUnread', 'Vous avez lu toutes vos notifications.') : t('study.notificationsEmpty', 'Les nouvelles ressources et informations importantes apparaîtront ici.')} />}</div>;
}

function downloadCalendar(event) {
  const escape = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const date = event.date.replace(/-/g, '');
  const times = [...(event.time || '').matchAll(/(\d{1,2}):(\d{2})/g)];
  const startTime = times[0];
  const start = startTime ? `${date}T${startTime[1].padStart(2, '0')}${startTime[2]}00` : date;
  const end = times[1] ? `\r\nDTEND;TZID=Africa/Casablanca:${date}T${times[1][1].padStart(2, '0')}${times[1][2]}00` : '';
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CampusLink Taza//Academic Calendar//FR\r\nBEGIN:VEVENT\r\nUID:campuslink-${event.id}@taza\r\nDTSTAMP:${timestamp}\r\nDTSTART${startTime ? ';TZID=Africa/Casablanca' : ';VALUE=DATE'}:${start}${end}\r\nSUMMARY:${escape(event.title)}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const url = URL.createObjectURL(new Blob([body], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${slug(event.title) || 'campuslink-event'}.ics`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CalendarPage() { return <DataGate><CalendarContent /></DataGate>; }

function CalendarContent() {
  const { data, t, lang } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDate = searchParams.get('date');
  const validRequestedDate = validDay(requestedDate) ? requestedDate : dateKey(today);
  const [month, setMonth] = useState(() => new Date(`${validRequestedDate}T12:00:00`));
  const [selected, setSelected] = useState(validRequestedDate);
  useEffect(() => { if (validDay(requestedDate)) { setMonth(new Date(`${requestedDate}T12:00:00`)); setSelected(requestedDate); } }, [requestedDate]);
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + i));
  const events = [...(data.events || [])].sort((a, b) => a.date.localeCompare(b.date));
  const selectedEvents = events.filter(e => e.date === selected);
  const monthEvents = events.filter(e => e.date.startsWith(`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`));
  const target = useAnchorFocus(selectedEvents.length);
  const changeMonth = (direction) => setMonth(new Date(month.getFullYear(), month.getMonth() + direction, 1));
  const selectDay = (day) => { setSelected(dateKey(day)); setSearchParams({ date: dateKey(day) }, { replace: true }); };
  return <div className="study-page"><PageHeading eyebrow={t('study.academicLife', 'Vie académique')} title={t('nav.calendar', 'Calendrier')} description={t('study.calendarIntro', 'Examens, échéances et rendez-vous de votre faculté.')} /><div className="study-calendar-toolbar"><div><button className="icon-button" onClick={() => changeMonth(-1)} aria-label={t('study.previousMonth', 'Mois précédent')}><ChevronLeft size={20} /></button><h2>{month.toLocaleDateString(localeFor(lang), { month: 'long', year: 'numeric' })}</h2><button className="icon-button" onClick={() => changeMonth(1)} aria-label={t('study.nextMonth', 'Mois suivant')}><ChevronRight size={20} /></button></div><button className="btn btn-secondary" onClick={() => { setMonth(new Date(today)); selectDay(today); }}>{t('study.today', "Aujourd'hui")}</button></div><div className="study-calendar-layout"><section className="study-calendar" aria-label={month.toLocaleDateString(localeFor(lang), { month: 'long', year: 'numeric' })}><div className="study-calendar-weekdays">{Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 5 + i).toLocaleDateString(localeFor(lang), { weekday: 'short' })).map((day, i) => <span key={i}>{day}</span>)}</div><div className="study-calendar-grid">{days.map(day => { const key = dateKey(day); const dayEvents = events.filter(e => e.date === key); return <button key={key} className={`study-calendar-day ${day.getMonth() !== month.getMonth() ? 'outside' : ''} ${key === dateKey(today) ? 'today' : ''} ${key === selected ? 'selected' : ''}`} onClick={() => selectDay(day)} aria-label={`${day.toLocaleDateString(localeFor(lang), { day: 'numeric', month: 'long' })}, ${dayEvents.length} ${t('study.events', 'événements')}`} aria-pressed={key === selected}><span className="study-calendar-number">{day.getDate()}</span><div className="study-calendar-day-events">{dayEvents.slice(0, 2).map(e => <span key={e.id} className={`study-calendar-event ${e.type}`}>{e.title}</span>)}{dayEvents.length > 2 && <small>+{dayEvents.length - 2}</small>}</div>{dayEvents.length > 0 && <span className="study-calendar-mobile-dot" />}</button>; })}</div><div className="study-calendar-legend"><span><i className="study-legend-dot" />{t('study.deadlinesExams', 'Examens et échéances')}</span><span><i className="study-legend-dot today" />{t('study.today', "Aujourd'hui")}</span></div></section><aside className="study-day-agenda"><div className="study-eyebrow">{t('study.onTheAgenda', 'Au programme')}</div><h2>{dateLabel(selected, lang, { weekday: 'long', month: 'long' })}</h2>{selectedEvents.length ? selectedEvents.map(e => <article key={e.id} id={`event-${e.id}`} className={`study-agenda-event ${target === `event-${e.id}` ? 'study-resource-focus' : ''}`}><span className="study-meta"><CalendarDays size={13} />{e.time || t('study.allDay', 'Toute la journée')}</span><h3>{e.title}</h3><Badge tone="gold">{t(`study.eventType.${e.type}`, e.type === 'exam' ? 'Examen' : e.type === 'deadline' ? 'Échéance' : 'Événement')}</Badge><button className="subtle-link" onClick={() => downloadCalendar(e)}><Download size={13} />{t('study.addCalendar', 'Ajouter à mon calendrier')}</button></article>) : <div className="study-agenda-empty"><CalendarDays size={30} strokeWidth={1} /><p>{t('study.noDayEvents', 'Aucun événement ce jour.')}</p><small>{t('study.chooseAnotherDay', 'Choisissez une autre date pour consulter le programme.')}</small></div>}</aside></div><section className="study-section"><SectionHeader icon={CalendarDays} title={t('study.thisMonth', 'Ce mois-ci')} description={`${monthEvents.length} ${t('study.events', 'événements')}`} /><div className="study-month-events">{monthEvents.map(e => <div key={e.id} className="study-month-event"><button className="study-event-date" onClick={() => selectDay(new Date(`${e.date}T12:00:00`))}><strong>{e.date.slice(8)}</strong><span>{dateLabel(e.date, lang, { day: undefined })}</span></button><div><h3>{e.title}</h3><p>{e.time || t('study.allDay', 'Toute la journée')}</p></div><button className="icon-button" onClick={() => downloadCalendar(e)} aria-label={t('study.addCalendar', 'Ajouter à mon calendrier')}><Download size={16} /></button></div>)}</div>{!monthEvents.length && <p className="study-small-empty">{t('study.noMonthEvents', 'Aucun événement prévu pour ce mois.')}</p>}</section></div>;
}

export function SavedPage() { return <DataGate><SavedContent /></DataGate>; }

function SavedContent() {
  const { data, saved, t, lang, toggleSave, toast } = useApp();
  const [tab, setTab] = useState('all');
  const [savingId, setSavingId] = useState(null);
  const removeMessage = async (id) => { setSavingId(id); try { await toggleSave('message', id); } catch (error) { toast(error.message, 'error'); } finally { setSavingId(null); } };
  const records = Array.isArray(saved) ? saved : data.saved || [];
  const resources = (data.resources || []).filter(r => records.some(s => s.type === 'resource' && String(s.id) === String(r.id)));
  const messages = (data.messages || []).filter(m => records.some(s => s.type === 'message' && String(s.id) === String(m.id)));
  const announcements = (data.announcements || []).filter(a => records.some(s => s.type === 'announcement' && String(s.id) === String(a.id)));
  const count = resources.length + messages.length + announcements.length;
  return <div className="study-page"><PageHeading eyebrow={t('study.personalLibrary', 'Bibliothèque personnelle')} title={t('nav.saved', 'Enregistrés')} description={t('study.savedIntro', "Un espace pour retrouver l'essentiel, à votre rythme.")}><Badge tone="gold">{count} {t('study.items', 'éléments')}</Badge></PageHeading><div className="study-filter-pills study-saved-tabs">{[['all', 'Tous les éléments', count], ['resource', 'Ressources', resources.length], ['message', 'Messages', messages.length], ['announcement', 'Annonces', announcements.length]].map(([type, text, total]) => <button key={type} className={tab === type ? 'active' : ''} onClick={() => setTab(type)}>{t(`study.savedTab.${type}`, text)}<span>{total}</span></button>)}</div>{(tab === 'all' || tab === 'resource') && resources.length > 0 && <section className="study-section"><SectionHeader title={t('study.resources', 'Ressources')} icon={Library} /><div className="study-resource-grid">{resources.map(r => <ResourceCard key={r.id} resource={r} />)}</div></section>}{(tab === 'all' || tab === 'message') && messages.length > 0 && <section className="study-section"><SectionHeader title={t('study.messages', 'Messages')} icon={MessageSquare} /><div className="study-saved-messages">{messages.map(m => <article key={m.id} className="study-saved-message"><Avatar user={m.author} size={34} /><div><div className="study-meta"><strong>{m.author?.name}</strong><time>{dateLabel(m.created_at, lang)}</time><span>#{t(`channel.${m.channel}`, { general: 'chat-général', important: 'discussions-importantes', help: 'entraide', life: 'vie-étudiante' }[m.channel] || m.channel)}</span></div><p>{m.content}</p><Link className="subtle-link" to={messagePath(m)}>{t('study.backDiscussion', 'Voir la discussion')} <ArrowUpRight size={13} /></Link></div><button className="icon-button gold" disabled={savingId === m.id} onClick={() => removeMessage(m.id)} aria-label={t('study.removeSaved', 'Retirer des enregistrés')}>{savingId === m.id ? <Loader2 size={17} className="spin" /> : <Bookmark size={17} fill="currentColor" />}</button></article>)}</div></section>}{(tab === 'all' || tab === 'announcement') && announcements.length > 0 && <section className="study-section"><SectionHeader title={t('study.announcements', 'Annonces')} icon={BellRing} />{announcements.map(a => <AnnouncementSummary key={a.id} announcement={a} saved />)}</section>}{(tab === 'all' ? !count : tab === 'resource' ? !resources.length : tab === 'message' ? !messages.length : !announcements.length) && <EmptyState icon={Bookmark} title={t('study.savedEmpty', 'Gardez vos découvertes à portée de main')} description={t('study.savedEmptyHint', 'Enregistrez un document, un message ou une annonce pour le retrouver ici.')} action={<Link className="btn gold-btn" to="/app/resources">{t('study.exploreLibrary', 'Explorer la bibliothèque')}<ArrowRight size={15} /></Link>} />}</div>;
}

export function MembersPage() { return <DataGate><MembersContent /></DataGate>; }

function MembersContent() {
  const { data, user, t, toast, scheduleRefresh } = useApp();
  const [query, setQuery] = useState('');
  const [blocked, setBlocked] = useState(new Set());
  const [loadingBlocks, setLoadingBlocks] = useState(false);
  const [blocksError, setBlocksError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [retry, setRetry] = useState(0);
  const canManageChats = user.role === 'global_admin';
  useEffect(() => {
    if (!canManageChats) return;
    let active = true;
    setLoadingBlocks(true); setBlocksError('');
    api('/chat/blocks').then(result => {
      if (active) setBlocked(new Set((result.blocks || []).map(block => Number(typeof block === 'object' ? block.user_id : block))));
    }).catch(error => { if (active) setBlocksError(error.message); }).finally(() => { if (active) setLoadingBlocks(false); });
    return () => { active = false; };
  }, [canManageChats, user.id, data.faculty.id, retry]);
  const toggleChatAccess = async member => {
    const isBlocked = blocked.has(Number(member.id));
    setBusyId(member.id);
    setBlocked(previous => { const next = new Set(previous); isBlocked ? next.delete(Number(member.id)) : next.add(Number(member.id)); return next; });
    try {
      await api(isBlocked ? `/chat/blocks/${member.id}` : '/chat/blocks', { method: isBlocked ? 'DELETE' : 'POST', ...(isBlocked ? {} : { body: { user_id: member.id } }) });
      toast(t(isBlocked ? 'chatUserUnblocked' : 'chatUserBlocked', isBlocked ? 'L’accès aux chats a été rétabli.' : 'L’accès aux chats a été bloqué.'));
      scheduleRefresh();
    } catch (error) { setBlocked(previous => { const next = new Set(previous); isBlocked ? next.add(Number(member.id)) : next.delete(Number(member.id)); return next; });toast(t(error.message, error.message), 'error'); }
    finally { setBusyId(null); }
  };
  const members = (data.members || []).filter(m => !query || `${m.name} ${m.username}`.toLowerCase().includes(query.toLowerCase()));
  const target = useAnchorFocus(members.length);
  return <div className="study-page study-members">
    <PageHeading eyebrow={data.faculty?.code} title={t('nav.members', 'Membres')} description={t('study.membersIntro', 'Des étudiants, des idées et un campus qui avance ensemble.')}><Badge tone="gold"><Users size={12} />{data.members?.length || 0} {t('study.members', 'membres')}</Badge></PageHeading>
    <div className="study-member-overview"><div><span className="study-member-overview-icon"><Users size={23} /></span><div><strong>{data.members?.length || 0}</strong><span>{t('study.communityMembers', 'Membres de la communauté')}</span></div></div><div><span className="study-member-overview-icon online"><span className="study-live-dot" /></span><div><strong>{(data.members || []).filter(m => m.online).length}</strong><span>{t('online', 'En ligne')}</span></div></div></div>
    <div className="study-member-toolbar"><label className="study-search-input"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('study.findMember', 'Rechercher un membre…')} aria-label={t('study.findMember', 'Rechercher un membre…')} /></label></div>
    {canManageChats && loadingBlocks && <p role="status">{t('loading', 'Chargement…')}</p>}
    {canManageChats && blocksError && <div className="study-form-error" role="alert">{t(blocksError, blocksError)} <button type="button" className="subtle-link" onClick={() => setRetry(value => value + 1)}>{t('retry', 'Réessayer')}</button></div>}
    <div className="study-member-grid">{members.map(m => {
      const isBlocked = blocked.has(Number(m.id));
      return <article className={`study-member-card ${m.online ? 'is-online' : ''} ${m.id === user.id ? 'is-self' : ''} ${target === `member-${m.id}` ? 'study-resource-focus' : ''}`} id={`member-${m.id}`} key={m.id}>
        <div className="study-member-identity"><div className="study-member-avatar"><Avatar user={m} size={56} />{m.online && <span className="study-live-dot" aria-label={t('online', 'En ligne')} />}</div><div className="study-member-name"><h3 dir="auto">{m.name || m.username}{m.id === user.id && <span>{t('study.you', 'vous')}</span>}</h3><p dir="ltr">@{m.username}</p></div></div>
        <div className="study-member-details"><Badge tone="neutral"><GraduationCap size={14} />{t('student', 'Étudiant')}</Badge><span className={`study-member-presence ${m.online ? 'online' : ''}`}><i aria-hidden="true" />{t(m.online ? 'online' : 'offline', m.online ? 'En ligne' : 'Hors ligne')}</span></div>
        {m.id === user.id && <Link className="subtle-link" to="/app/profile">{t('study.editProfile', 'Modifier mon profil')}<ArrowUpRight size={12} /></Link>}
        {canManageChats && m.id !== user.id && !loadingBlocks && !blocksError && <button type="button" className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busyId !== null} onClick={() => toggleChatAccess(m)} aria-label={`${t(isBlocked ? 'unblockFromChat' : 'blockFromChat', isBlocked ? 'Débloquer les chats' : 'Bloquer les chats')} · ${m.name || m.username}`}>{busyId === m.id ? <Loader2 size={15} className="spin" /> : isBlocked ? <Check size={15} /> : <Ban size={15} />}{t(isBlocked ? 'unblockFromChat' : 'blockFromChat', isBlocked ? 'Débloquer les chats' : 'Bloquer les chats')}</button>}
      </article>;
    })}</div>
    {!members.length && <EmptyState icon={Users} title={t('study.noMember', 'Aucun membre trouvé')} description={t('study.memberEmptyHint', 'Essayez un autre nom.')} />}
  </div>;
}

export function AboutPage() { return <DataGate><AboutContent /></DataGate>; }

function AboutContent() {
  const { data, t, openModal } = useApp();
  const faculty = data.faculty || {};
  return <div className="study-page study-about"><PageHeading eyebrow="USMBA · TAZA" title={t('nav.about', 'À propos')} description={t('study.aboutIntro', 'Votre faculté, votre communauté.')} /><section className="study-about-hero"><div className="study-about-symbol"><GraduationCap size={48} strokeWidth={1} /></div><Badge tone="gold"><LockKeyhole size={11} />{t('study.privateCommunity', 'Communauté privée')}</Badge><h1>{t(`facultyName${faculty.code}`, faculty.name)}</h1><p className="study-arabic-name" lang="ar" dir="rtl">{faculty.arabic}</p><p className="study-about-description">{t(`facultyDescription${faculty.code}`, faculty.description) || t('study.facultyDescription', 'Un espace académique privé pour les étudiants de votre faculté. Retrouvez vos ressources, échangez avec votre communauté et restez informé des événements du campus.')}</p><div className="study-about-statistics"><span><Users size={18} /><strong>{data.members?.length || faculty.members || 0}</strong>{t('study.members', 'membres')}</span><span><BookOpen size={18} /><strong>{data.resources?.length || 0}</strong>{t('study.resourcesLower', 'ressources')}</span><span><CalendarDays size={18} /><strong>6</strong>{t('study.semesters', 'semestres')}</span></div><button className="btn gold-btn" onClick={() => openModal('contact')}><Mail size={16} />{t('common.contactAdmin', "Contacter l'admin")}</button></section><div className="study-about-values"><article><Library size={22} /><h3>{t('study.learnTogether', 'Apprendre ensemble')}</h3><p>{t('study.learnTogetherDesc', 'Cours, exercices et examens sont organisés par semestre et module pour vous aider à progresser.')}</p></article><article><MessageSquare size={22} /><h3>{t('study.exchangeRespect', 'Échanger avec respect')}</h3><p>{t('study.exchangeRespectDesc', 'Partagez vos questions, vos connaissances et la vie du campus dans un espace bienveillant.')}</p></article><article><ShieldCheck size={22} /><h3>{t('study.privateTrusted', 'Un espace de confiance')}</h3><p>{t('study.privateTrustedDesc', "Votre compte est rattaché à une seule faculté. L'équipe administrative accompagne et modère la communauté.")}</p></article></div><section className="study-community-rules"><SectionHeader title={t('study.communityRules', 'Notre charte de communauté')} icon={ShieldCheck} /><ol><li>{t('study.ruleRespect', 'Respectez les autres membres et leurs différences.')}</li><li>{t('study.ruleResources', 'Partagez des ressources utiles et correctement classées.')}</li><li>{t('study.rulePrivacy', 'Préservez la confidentialité des échanges et des documents.')}</li><li>{t('study.ruleReport', "Signalez les contenus inappropriés à l'équipe de modération.")}</li></ol><div className="study-faculty-lock"><LockKeyhole size={17} /><p>{t('study.facultyLocked', "Votre faculté est associée définitivement à votre compte. Pour toute modification, contactez l'administrateur.")}</p></div></section></div>;
}

export function SearchPage() { return <DataGate><SearchContent /></DataGate>; }

function SearchContent() {
  const { data, t, lang } = useApp();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const [retry, setRetry] = useState(0);
  const query = params.get('q') || '';
  const type = params.get('type') || '';
  const semester = params.get('semester') || '';
  const module = params.get('module') || '';
  const author = params.get('author') || '';
  const date = params.get('date') || '';
  const modules = [...new Set((data.resources || []).map(r => r.module).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const filterKey = params.toString();
  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true); setError('');
    const timer = setTimeout(async () => { try { const response = await api(`/search?${filterKey}`); if (id === requestId.current) { setResults(response.results || []); setLoading(false); } } catch (err) { if (id === requestId.current) { setError(err.message); setLoading(false); } } }, 240);
    return () => { clearTimeout(timer); requestId.current++; };
  }, [filterKey, retry]);
  const setFilter = (key, value) => setParams(prev => { const next = new URLSearchParams(prev); value ? next.set(key, value) : next.delete(key); return next; }, { replace: true });
  const typeLabels = { message: 'Message', announcement: 'Annonce', member: 'Membre', courses: 'Cours', exercises: 'Exercice', exams: 'Examen', rattrapage: 'Rattrapage', module: 'Module', resource: 'Document' };
  return <div className="study-page study-search-page"><PageHeading eyebrow={t('study.everythingInOnePlace', 'Tout votre campus, au même endroit')} title={t('study.searchTitle', 'Rechercher')} description={t('study.searchIntro', 'Un document, une discussion, un membre. Retrouvez précisément ce que vous cherchez.')} /><label className="study-central-search"><Search size={23} /><input autoFocus value={query} onChange={e => setFilter('q', e.target.value)} placeholder={t('study.searchPlaceholder', 'Rechercher dans votre faculté…')} aria-label={t('study.searchPlaceholder', 'Rechercher dans votre faculté…')} />{query && <button className="icon-button" onClick={() => setFilter('q', '')} aria-label={t('common.clear', 'Effacer')}><X size={17} /></button>}<kbd>⌘ K</kbd></label><div className="study-search-filter-grid"><label><span>{t('study.type', 'Type')}</span><select value={type} onChange={e => setFilter('type', e.target.value)}><option value="">{t('study.allTypes', 'Tous les types')}</option>{['message', 'announcement', 'courses', 'exercises', 'exams', 'rattrapage', 'member'].map(value => <option key={value} value={value}>{t(`study.resultType.${value}`, typeLabels[value])}</option>)}</select></label><label><span>{t('study.semester', 'Semestre')}</span><select value={semester} onChange={e => setFilter('semester', e.target.value)}><option value="">{t('common.all', 'Tout')}</option>{[1, 2, 3, 4, 5, 6].map(s => <option key={s} value={s}>S{s}</option>)}</select></label><label><span>{t('study.module', 'Module')}</span><select value={module} onChange={e => setFilter('module', e.target.value)}><option value="">{t('study.allModules', 'Tous les modules')}</option>{modules.map(m => <option key={m}>{m}</option>)}</select></label><label><span>{t('study.author', 'Auteur')}</span><select value={author} onChange={e => setFilter('author', e.target.value)}><option value="">{t('common.all', 'Tout')}</option>{(data.members || []).map(m => <option key={m.id} value={m.id}>{m.name || m.username}</option>)}</select></label><label><span>{t('study.date', 'Date')}</span><input type="date" value={date} onChange={e => setFilter('date', e.target.value)} /></label></div><div className="study-results-meta"><span>{loading ? t('study.searching', 'Recherche en cours…') : `${results.length} ${t('study.searchResults', 'résultats')}`}</span>{(type || semester || module || author || date) && <button className="subtle-link" onClick={() => setParams(query ? { q: query } : {}, { replace: true })}>{t('study.resetFilters', 'Réinitialiser les filtres')}<X size={12} /></button>}</div>{loading ? <div className="study-search-loading" role="status"><Loader2 size={23} className="spin" /><p>{t('study.searchingFaculty', 'Recherche dans votre faculté…')}</p></div> : error ? <EmptyState icon={Search} title={t('study.searchError', 'La recherche est indisponible')} description={t(error,error)} action={<button className="btn gold-btn" onClick={() => setRetry(r => r + 1)}>{t('common.retry', 'Réessayer')}</button>} /> : results.length ? <div className="study-search-results">{results.map((result, index) => <button className="study-search-result" key={`${result.type}-${result.id}-${index}`} onClick={() => navigate(result.path)}><span className={`study-result-icon category-${result.type}`}>{categories.includes(result.type) ? <CategoryIcon category={result.type} size={22} /> : result.type === 'member' ? <Users size={21} /> : result.type === 'message' ? <MessageSquare size={21} /> : result.type === 'announcement' ? <BellRing size={21} /> : <FileText size={21} />}</span><span className="study-result-copy"><span className="study-meta">{t(`study.resultType.${result.type}`, typeLabels[result.type] || 'Document')}{result.semester ? ` · S${result.semester}` : ''}{result.module ? ` · ${result.module}` : ''}</span><strong>{result.title}</strong>{result.context && <span className="study-result-context">{result.context}</span>}<span className="study-result-source">{typeof result.author === 'object' ? result.author?.name : result.author}{result.date && ` · ${dateLabel(result.date, lang)}`}</span></span><ArrowUpRight size={17} /></button>)}</div> : <EmptyState icon={Search} title={t('study.noSearchResult', 'Aucun résultat trouvé')} description={t('study.searchEmptyHint', 'Essayez un autre mot-clé ou élargissez vos filtres.')} />}</div>;
}

export function SettingsPage() { return <DataGate><SettingsContent /></DataGate>; }

function AppearanceSettings() {
  const { theme, toggleTheme, t } = useApp();
  const choices = [['dark', Moon, t('darkMode', 'Mode sombre')], ['light', Sun, t('lightMode', 'Mode clair')]];
  return <section className="study-settings-section study-appearance-section">
    <SectionHeader title={t('appearance', 'Apparence')} icon={Sun} />
    <div className="study-appearance-options" role="group" aria-label={t('appearance', 'Apparence')}>
      {choices.map(([value, Icon, title]) => <button key={value} type="button" data-theme-option={value} className={theme === value ? 'active' : ''} aria-pressed={theme === value} onClick={() => { if (theme !== value) toggleTheme(); }}>
        <Icon size={22} aria-hidden="true" /><strong>{title}</strong>{theme === value && <Check size={20} aria-hidden="true" />}
      </button>)}
    </div>
  </section>;
}

function SettingsContent() {
  const { user, data, t, lang, setLang, refresh, toast, openModal } = useApp();
  const [username, setUsername] = useState(user.username || '');
  const [avatar, setAvatar] = useState(user.avatar || '');
  const [language, setLanguage] = useState(user.language || lang || 'fr');
  const [preferences, setPreferences] = useState({ resources: true, announcements: true, important: true, admin: true, calendar: true, ...(user.preferences || {}) });
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const avatarInput = useRef(null);
  useEffect(() => { setLanguage(lang); }, [lang]);
  const previewUser = { ...user, avatar, username };
  const pickAvatar = async (file) => {
    setError(''); setSuccess(false);
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError(t('study.avatarTypeError', 'Choisissez une image JPG, PNG ou WebP.')); return; }
    if (file.size > 1024 * 1024) { setError(t('study.avatarSizeError', "L'image doit faire moins de 1 Mo.")); return; }
    try { const result = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); setAvatar(result); } catch { setError(t('study.avatarReadError', "Impossible de lire cette image.")); }
  };
  const save = async (event) => {
    event.preventDefault(); setError(''); setSuccess(false);
    if (password && password !== confirmation) { setError(t('study.passwordMismatch', 'Les mots de passe ne correspondent pas.')); return; }
    if (password && !currentPassword) { setError(t('study.currentPasswordRequired', 'Saisissez votre mot de passe actuel.')); return; }
    if (password && password.length < 10) { setError(t('study.passwordLength', 'Le nouveau mot de passe doit contenir au moins 10 caractères.')); return; }
    setBusy(true);
    try { await api('/profile', { method: 'PATCH', body: { username: username.trim(), ...(avatar !== (user.avatar || '') ? { avatar } : {}), language, preferences, ...(password ? { password, current_password: currentPassword } : {}) } }); setLang(language); await refresh(); setPassword(''); setCurrentPassword(''); setConfirmation(''); setSuccess(true); toast(t('study.profileSaved', 'Vos modifications ont été enregistrées.')); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="study-page study-settings"><PageHeading eyebrow={t('study.yourAccount', 'Votre compte')} title={t('study.profilePreferences', 'Profil & préférences')} description={t('study.settingsIntro', 'Un espace à votre image, pensé pour votre quotidien.')} /><form onSubmit={save}><AppearanceSettings /><InstallApp /><section className="study-settings-section"><SectionHeader title={t('study.languageInterface', "Langue de l'interface")} icon={Settings2} /><div className="study-language-options">{[['fr', 'Français', 'FR'], ['ar', 'العربية', 'AR'], ['en', 'English', 'EN']].map(([value, name, code]) => <label className={language === value ? 'active' : ''} key={value}><input type="radio" name="language" value={value} checked={language === value} onChange={() => { setLanguage(value); setLang(value); setSuccess(false); }} disabled={busy} /><span>{code}</span><strong>{name}</strong>{language === value && <Check size={16} />}</label>)}</div></section><section className="study-settings-section"><SectionHeader title={t('study.publicProfile', 'Profil dans la communauté')} icon={Users} /><div className="study-avatar-editor"><Avatar user={previewUser} size={76} /><div><button type="button" className="btn btn-secondary" onClick={() => avatarInput.current?.click()} disabled={busy}><ImagePlus size={15} />{t('study.changePhoto', 'Changer la photo')}</button><p>{t('study.avatarHint', 'JPG, PNG ou WebP · 1 Mo maximum')}</p>{avatar && <button type="button" className="subtle-link" onClick={() => { setAvatar(''); setSuccess(false); }} disabled={busy}>{t('study.removePhoto', 'Supprimer la photo')}</button>}</div><input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { pickAvatar(e.target.files?.[0]); e.target.value = ''; }} hidden /></div><div className="study-settings-fields"><label className="field"><span>{t('auth.username', "Nom d'utilisateur")}</span><input required minLength={3} maxLength={40} autoComplete="username" aria-label={t('auth.username', "Nom d'utilisateur")} aria-describedby="study-username-hint" value={username} disabled={busy} onChange={e => { setUsername(e.target.value); setSuccess(false); }} /><small id="study-username-hint">{t('study.usernameHint', '3 à 40 caractères. Votre identifiant de connexion.')}</small></label><div className="study-locked-field"><span>{t('study.associatedFaculty', 'Faculté associée')}<LockKeyhole size={14} /></span><div title={t('study.facultyTooltip', 'Contactez l’administrateur pour modifier votre faculté.')}><GraduationCap size={19} /><p>{t(`facultyName${data.faculty?.code}`, data.faculty?.name)}</p><LockKeyhole size={14} /></div><small>{t('study.facultyPermanent', "Ce choix est permanent. Contactez l'administrateur pour toute modification.")}</small><button type="button" className="subtle-link" onClick={() => openModal('contact')}><Mail size={12} />{t('common.contactAdmin', "Contacter l'admin")}</button></div></div></section><section className="study-settings-section"><SectionHeader title={t('study.notificationPreferences', 'Préférences de notification')} description={t('study.notificationPreferenceHint', 'Le chat général reste discret : aucun message courant ne déclenche de notification.')} icon={Bell} /><div className="study-preference-list">{[['resources', 'Nouvelles ressources', 'Cours, exercices et sujets partagés dans votre faculté.'], ['announcements', 'Annonces officielles', "Les communications de l'administration."], ['important', 'Discussions importantes', 'Les échanges qui méritent votre attention.'], ['admin', 'Messages administratifs', 'Les informations liées à votre compte et votre faculté.'], ['calendar', 'Rappels du calendrier', 'Examens, échéances et événements à venir.']].map(([key, title, description]) => <label className="study-preference" key={key}><div><strong>{t(`study.preference.${key}`, title)}</strong><p>{t(`study.preference.${key}Description`, description)}</p></div><input type="checkbox" className="study-switch" checked={preferences[key]} onChange={e => { setPreferences(prev => ({ ...prev, [key]: e.target.checked })); setSuccess(false); }} disabled={busy} /><span className="study-switch-track" aria-hidden="true" /></label>)}</div></section><section className="study-settings-section"><SectionHeader title={t('study.accountSecurity', 'Sécurité du compte')} description={t('study.passwordHint', 'Laissez ces champs vides pour conserver votre mot de passe.')} icon={LockKeyhole} /><div className="study-settings-fields study-password-fields"><label className="field"><span>{t('study.currentPassword', 'Mot de passe actuel')}</span><input type="password" autoComplete="current-password" aria-label={t('study.currentPassword', 'Mot de passe actuel')} value={currentPassword} onChange={e => { setCurrentPassword(e.target.value); setSuccess(false); }} disabled={busy} /></label><label className="field"><span>{t('study.newPassword', 'Nouveau mot de passe')}</span><input type="password" autoComplete="new-password" minLength={10} aria-label={t('study.newPassword', 'Nouveau mot de passe')} aria-describedby="study-password-hint" value={password} onChange={e => { setPassword(e.target.value); setSuccess(false); }} disabled={busy} /><small id="study-password-hint">{t('study.minimumPassword', '10 caractères minimum')}</small></label><label className="field"><span>{t('study.confirmPassword', 'Confirmer le mot de passe')}</span><input type="password" autoComplete="new-password" aria-label={t('study.confirmPassword', 'Confirmer le mot de passe')} value={confirmation} onChange={e => { setConfirmation(e.target.value); setSuccess(false); }} disabled={busy} /></label></div></section>{error && <div className="study-form-error" role="alert">{t(error,error)}</div>}{success && <div className="study-form-success" role="status"><CheckCheck size={16} />{t('study.profileSaved', 'Vos modifications ont été enregistrées.')}</div>}<div className="study-settings-footer"><p><ShieldCheck size={15} />{t('study.accountPrivate', 'Vos préférences sont liées à votre compte personnel.')}</p><button className="btn gold-btn" type="submit" disabled={busy}>{busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{busy ? t('study.saving', 'Enregistrement…') : t('study.saveChanges', 'Enregistrer les modifications')}</button></div></form></div>;
}
