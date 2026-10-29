import LibraryReport from '../components/LibraryReport';
import { Select } from "../components/Select";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  LoaderCircle,
  RotateCw,
  Check,
  ChevronDown,
  Filter,
  Folder,
  FolderOpen,
  Search,
  Upload,
  X,
  Plus,
  Share2,
  FileText,
  ListChecks,
  FlaskConical,
  GraduationCap,
  Users,
  Layers,
} from "lucide-react";
import { useApp } from "../context";
import {
  moduleDisplayName,
  normalizeModule,
  normalizePart,
  compareParts,
  partLabel,
  normalizeAcademicYear,
  resourceAcademicYears,
  compareAcademicYears,
  orderResourcesByAcademicYear,
  groupResourcesByAcademicYear,
  academicYearOptions,
  browseResourceDirectory,
  resourceDirectory,
  resourceFolderOwner,
  UNKNOWN_CONTRIBUTOR,
} from "../lib/resources";
import {
  Button,
  DocumentCard,
  EmptyState,
  Field,
  PageHeader,
  Tabs,
  Modal,
} from "../components/ui";
import UploadModal from "../components/UploadModal";
import DocumentTextSearch from "../components/DocumentTextSearch";
import { ModuleShareDialog, useModuleLongPress } from "../components/ModuleShare";
import { normalizeLibrarySearch, matchesLibrarySearch, parseLibraryDocumentPage, normalizeLibraryDate, libraryModuleMatches, libraryContributors } from "../lib/library-browse";
import { useLibraryModules } from "../lib/use-library-modules";
import { RESOURCE_CATEGORIES, resourceCategory, normalizeResourceCategory } from '../../shared/resource-categories.js';
import "./library.css";
const semesterNumber = (value) =>
  Number(String(value ?? "").replace(/^s/i, ""));
const categories = RESOURCE_CATEGORIES;
const categoryIcons = { courses: BookOpen, exercises: ListChecks, td: FileText, tp: FlaskConical, corrections: Check, exams: GraduationCap, rattrapage: RotateCw };
const DOCUMENTS_PER_PAGE = 24;
const categoryMatches = (resource, category) =>
  category === "all" || resourceCategory(resource) === category;
const groupByCategory = (items) => {
  const groups = new Map();
  for (const item of items) {
    const key = item.category || "";
    if (!groups.has(key)) groups.set(key, { category: key, items: [] });
    groups.get(key).items.push(item);
  }
  const order = [...categories, "tdtp"];
  const rank = (key) => order.includes(key) ? order.indexOf(key) : order.length;
  return [...groups.values()].sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
};
function ModuleActions({ children, resource, label, onShare, choice = false }) {
  const { tr } = useApp();
  const share = () => onShare(resource);
  const longPress = useModuleLongPress(() => { if (resource) share(); });
  return <div className={`library-module-tile${choice ? ' is-choice' : ' card'}${!resource ? ' is-empty' : ''}`} {...(resource ? longPress : {})}>
    {children}
    {resource && <button className="library-module-share" type="button" onClick={share}
      aria-label={tr(`Partager le module ${label}`, `Share module ${label}`, `مشاركة وحدة ${label}`)} title={tr('Partager dans un chat', 'Share to chat', 'مشاركة في دردشة')}><Share2 size={17} aria-hidden="true" /></button>}
  </div>;
}
export function orderLibraryResources(items, sort = "recent", currentYear = "", filterYear = "") {
  return orderResourcesByAcademicYear(items, sort, currentYear, filterYear);
}
export default function LibraryPage() {
  const { t, tr, language, user, selection, loading, resources, updateResourceAcademicYears } = useApp();
  const currentAcademicYear = normalizeAcademicYear(user?.currentAcademicYear ?? user?.current_academic_year);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const handledResourceLink = useRef(null);
  const resultsHeading = useRef(null);
  const directoryHeading = useRef(null);
  const pendingFolderScroll = useRef(false);
  const modulePicker = useRef(null);
  const moduleOverlay = useRef(null);
  const filterChips = useRef(null);
  const searchInput = useRef(null);
  const pendingModuleScroll = useRef(false);
  const moduleTrigger = useRef(null);
  const moduleSearchInput = useRef(null);
  const pendingPickerFocus = useRef(false);
  const pendingModuleFocus = useRef(false);
  const pendingFolderFocus = useRef(false);
  // The URL is the single source of filter state, including native Back/Forward.
  const requestedSemester = semesterNumber(
    searchParams.get("semester") || selection?.semester || 1,
  );
  const semester = [1, 2, 3, 4, 5, 6].includes(requestedSemester)
    ? requestedSemester
    : 1;
  const module = searchParams.has("module") ? searchParams.get("module") : null;
  const requestedCategory = searchParams.get("category");
  const category = module !== null && requestedCategory && requestedCategory !== 'all' ? normalizeResourceCategory(requestedCategory) : 'all';
  const contributor = module !== null && category !== 'all' ? searchParams.get('contributor') || searchParams.get('folderOwner') || '' : '';
  const folderOwner = contributor;
  const folder = contributor ? searchParams.get('folder') || '' : '';
  const query = searchParams.get("q") || "";
  const requestedView = searchParams.get("view") === "documents" ? "documents" : "modules";
  const overviewView = 'modules';
  const showDocumentResults = module !== null && category !== 'all' && Boolean(contributor);
  const requestedSort = searchParams.get("sort");
  const sort = ["recent", "oldest", "title", "part"].includes(requestedSort) ? requestedSort : "recent";
  const author = searchParams.get("author") || "all";
  const part = searchParams.get("part") || "all";
  const date = normalizeLibraryDate(searchParams.get("date"));
  const requestedYear = searchParams.get("year");
  const year = requestedYear === "unknown" ? "unknown" : normalizeAcademicYear(requestedYear) || "all";
  const [showFilters, setShowFilters] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showModulePicker, setShowModulePicker] = useState(false);
  const [moduleQuery, setModuleQuery] = useState("");
  const documentPage = parseLibraryDocumentPage(searchParams.get("documentsPage"));
  const [yearEditor, setYearEditor] = useState(null);
  const [editedYears, setEditedYears] = useState([]);
  const [savingYears, setSavingYears] = useState(false);
  const [yearError, setYearError] = useState("");
  const [sharedResource, setSharedResource] = useState(null);
  const semesterResources = useMemo(
    () =>
      resources.filter(
        (item) =>
          item.libraryVisible !== false &&
          item.status !== "removed" &&
          semesterNumber(item.semester) === semester &&
          item.facultyId === selection?.facultyId &&
          item.filiereId === selection?.filiereId,
      ),
    [resources, semester, selection?.facultyId, selection?.filiereId],
  );
  const { folders: semesterFolders, status: moduleStatus, retry: retryModules } = useLibraryModules(
    semesterResources, user?.id, selection?.facultyId, selection?.filiereId, semester,
  );
  const selectedModuleFolder = semesterFolders.find(entry => entry.key === module)
    || (semesterFolders.filter(entry => normalizeModule(entry.rawName) === normalizeModule(module)).length === 1
      ? semesterFolders.find(entry => normalizeModule(entry.rawName) === normalizeModule(module)) : null);
  const selectedModuleKey = selectedModuleFolder?.key || module;
  const selectedModuleName = selectedModuleFolder?.name || moduleDisplayName(String(module || '').replace(/^legacy:/, ''));
  // Bootstrap contains the complete authorized library collection. Existing
  // folders must not depend on a separately deployed module endpoint.
  const moduleResources = useMemo(() => semesterResources.filter(item => libraryModuleMatches(item, selectedModuleKey, semesterFolders)),
    [selectedModuleKey, semesterResources, semesterFolders]);
  const browsingResources = module === null ? semesterResources : moduleResources;
  const scopedFilterResources = useMemo(() => browsingResources.filter(item => categoryMatches(item, category) && (!contributor || resourceFolderOwner(item) === contributor)), [browsingResources, category, contributor]);
  const matchingModuleFolders = useMemo(() => {
    const search = normalizeLibrarySearch(moduleQuery);
    return semesterFolders.filter(
      (folder) =>
        normalizeLibrarySearch(folder.key).includes(search) ||
        normalizeLibrarySearch(
          folder.name || tr("Sans module", "Unclassified", "بدون وحدة"),
        ).includes(search),
    );
  }, [semesterFolders, moduleQuery, language]);
  useEffect(() => {
    setShowModulePicker(false);
    setModuleQuery("");
  }, [semester, module]);
  useEffect(() => {
    if (!showModulePicker) return;
    const previousOverflow = document.body.style.overflow;
    const background = [...document.body.children].filter(node => node !== moduleOverlay.current && node instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName)).map(node => [node, node.inert]);
    document.body.style.overflow = 'hidden';
    background.forEach(([node]) => { node.inert = true; });
    const fitViewport = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height || window.innerHeight;
      const inset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0));
      modulePicker.current?.style.setProperty('--library-picker-keyboard', `${inset}px`);
      modulePicker.current?.style.setProperty('--library-picker-room', `${Math.max(100, height - (inset > 0 ? 32 : 100))}px`);
      moduleOverlay.current?.style.setProperty('--library-picker-height', `${height}px`);
      moduleOverlay.current?.style.setProperty('--library-picker-top', `${viewport?.offsetTop || 0}px`);
      moduleOverlay.current?.style.setProperty('--library-picker-bottom-space', inset > 0 ? '12px' : 'calc(68px + env(safe-area-inset-bottom, 0px))');
    };
    const frame = requestAnimationFrame(() => {
      fitViewport();
      if (pendingPickerFocus.current) moduleSearchInput.current?.focus({ preventScroll: true });
      else modulePicker.current?.focus({ preventScroll: true });
      pendingPickerFocus.current = false;
    });
    const outside = event => {
      if (!modulePicker.current?.contains(event.target) && !moduleTrigger.current?.contains(event.target)) setShowModulePicker(false);
    };
    const escape = event => {
      if (event.key === 'Tab') {
        const choices = [...modulePicker.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || []].filter(node => node.getClientRects().length);
        const first = choices[0], last = choices.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === modulePicker.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !modulePicker.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      setShowModulePicker(false);
      moduleTrigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", fitViewport);
    window.visualViewport?.addEventListener("resize", fitViewport);
    window.visualViewport?.addEventListener("scroll", fitViewport);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", fitViewport);
      window.visualViewport?.removeEventListener("resize", fitViewport);
      window.visualViewport?.removeEventListener("scroll", fitViewport);
      background.forEach(([node, inert]) => { node.inert = inert; });
      document.body.style.overflow = previousOverflow;
      moduleTrigger.current?.focus({ preventScroll: true });
    };
  }, [showModulePicker]);
  useEffect(() => {
    if (!pendingModuleScroll.current) return;
    const frame = requestAnimationFrame(() => {
      pendingModuleScroll.current = false;
      if (pendingModuleFocus.current) resultsHeading.current?.focus({ preventScroll: true });
      pendingModuleFocus.current = false;
      resultsHeading.current?.scrollIntoView({
        block: "start",
        behavior: "auto",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [module, folder, folderOwner, showModulePicker]);
  useEffect(() => {
    if (!pendingFolderScroll.current) return;
    const frame = requestAnimationFrame(() => {
      pendingFolderScroll.current = false;
      const heading = directoryHeading.current || resultsHeading.current;
      if (pendingFolderFocus.current) heading?.focus({ preventScroll: true });
      pendingFolderFocus.current = false;
      heading?.scrollIntoView({ block: "start", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [folder, folderOwner, category, contributor]);
  const authors = useMemo(
    () =>
      [
        ...new Set(
          scopedFilterResources.map((item) => item.author).filter(Boolean),
        ),
      ].sort(),
    [scopedFilterResources],
  );
  const parts = useMemo(
    () =>
      [
        ...new Set(
          scopedFilterResources
            .map((item) => normalizePart(item.part))
            .filter(Boolean),
        ),
      ].sort(compareParts),
    [scopedFilterResources],
  );
  const availableYears = useMemo(() => [...new Set(scopedFilterResources.flatMap(resourceAcademicYears))]
    .sort((a, b) => compareAcademicYears(a, b, currentAcademicYear)), [scopedFilterResources, currentAcademicYear]);
  const filterCount = [author, part, date, year].filter(
    (value) => value !== "all",
  ).length;
  const filteredBase = useMemo(
    () =>
      browsingResources.filter((item) => {
        const age = Date.now() - new Date(item.date).getTime();
        return (
          matchesLibrarySearch(item, query) &&
          (author === "all" || item.author === author) &&
          (part === "all" || normalizePart(item.part) === part) &&
          (year === "all" || (year === "unknown" ? !resourceAcademicYears(item).length : resourceAcademicYears(item).includes(year))) &&
          (date === "all" || age <= Number(date) * 86400000)
        );
      }),
    [browsingResources, query, author, part, date, year],
  );
  const visible = useMemo(
    () =>
      orderLibraryResources(
        filteredBase.filter((item) => categoryMatches(item, category)),
        sort,
        currentAcademicYear,
        year,
      ),
    [filteredBase, category, sort, currentAcademicYear, year],
  );
  const hasModuleRefinements = Boolean(query.trim() || category !== "all" || author !== "all" || part !== "all" || date !== "all" || year !== "all");
  const folders = useMemo(() => hasModuleRefinements ? semesterFolders.map(entry => ({ ...entry, documents: visible.filter(item => libraryModuleMatches(item, entry.key, semesterFolders)) })).filter(entry => entry.documents.length) : semesterFolders, [visible, semesterFolders, hasModuleRefinements]);
  const contributors = useMemo(() => category === 'all' ? [] : libraryContributors(visible, category), [visible, category]);
  const unknownContributorLabel = tr('Contributeur inconnu', 'Unknown contributor', 'مساهم غير معروف');
  const contributorName = contributor === UNKNOWN_CONTRIBUTOR ? unknownContributorLabel : libraryContributors(moduleResources, category).find(entry => entry.id === contributor)?.name || tr('Contributeur', 'Contributor', 'مساهم');
  const contributorResources = visible.filter(item => contributor && resourceFolderOwner(item) === contributor);
  const directory = useMemo(() => browseResourceDirectory(contributorResources, folder, contributor, category), [visible, folder, contributor, category]);
  const directoryDocuments = showDocumentResults ? query.trim() && !folder ? contributorResources : directory.documents : [];
  const lastDocumentPage = Math.max(
    0,
    Math.ceil(directoryDocuments.length / DOCUMENTS_PER_PAGE) - 1,
  );
  const pageNumber = Math.min(documentPage, lastDocumentPage);
  const pageStart = pageNumber * DOCUMENTS_PER_PAGE;
  const pageDocuments = directoryDocuments.slice(
    pageStart,
    pageStart + DOCUMENTS_PER_PAGE,
  );
  const pageYearGroups = groupResourcesByAcademicYear(pageDocuments, currentAcademicYear, year);
  useEffect(() => {
    if (loading) return;
    const canonicalPage = pageNumber ? String(pageNumber + 1) : null;
    const canonicalDate = date === "all" ? null : date;
    if (searchParams.get("documentsPage") === canonicalPage && searchParams.get("date") === canonicalDate) return;
    const params = new URLSearchParams(searchParams);
    if (canonicalPage) params.set("documentsPage", canonicalPage);
    else params.delete("documentsPage");
    if (canonicalDate) params.set("date", canonicalDate);
    else params.delete("date");
    navigate({ pathname: location.pathname, search: `?${params}`, hash: location.hash }, { replace: true });
  }, [loading, pageNumber, date, searchParams, navigate, location.pathname, location.hash]);
  useEffect(() => {
    const target = /^#resource-(.+)$/.exec(location.hash);
    const link = location.search + location.hash;
    if (!target) {
      handledResourceLink.current = null;
      return;
    }
    if ((module === null && !showDocumentResults) || handledResourceLink.current === link) return;
    const linkedDocument = moduleResources.find(document => String(document.id) === target[1]);
    if (!linkedDocument) return;
    const targetFolder = resourceDirectory(linkedDocument);
    const targetOwner = resourceFolderOwner(linkedDocument);
    const targetCategory = resourceCategory(linkedDocument);
    if (module !== null && (folder !== targetFolder || contributor !== targetOwner || category !== targetCategory)) {
      const params = new URLSearchParams(searchParams);
      params.set('category', targetCategory); params.set('contributor', targetOwner);
      if (targetFolder) params.set("folder", targetFolder);
      else params.delete("folder");
      params.delete('folderOwner');
      navigate({ pathname: location.pathname, search: `?${params}`, hash: location.hash }, { replace: true });
      return;
    }
    const index = directoryDocuments.findIndex(document => String(document.id) === target[1]);
    if (index < 0) return;
    const targetPage = Math.floor(index / DOCUMENTS_PER_PAGE);
    if (pageNumber !== targetPage) {
      const params = new URLSearchParams(searchParams);
      if (targetPage) params.set("documentsPage", String(targetPage + 1));
      else params.delete("documentsPage");
      navigate({ pathname: location.pathname, search: `?${params}`, hash: location.hash }, { replace: true });
      return;
    }
    const frame = requestAnimationFrame(() => {
      const node = document.getElementById(`resource-${target[1]}`);
      if (node) {
        node.scrollIntoView({ block: "center", behavior: "auto" });
        handledResourceLink.current = link;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [location.search, location.hash, location.pathname, module, folder, folderOwner, visible, directoryDocuments, pageNumber, showDocumentResults, navigate]);
  const navigateLibrary = (patch, options = {}) => {
    const state = {
      semester,
      module,
      folder,
      folderOwner,
      contributor,
      category,
      query,
      sort,
      author,
      part,
      date,
      year,
      view: requestedView,
      documentPage,
      ...patch,
    };
    const params = new URLSearchParams(searchParams);
    params.set("semester", String(state.semester));
    if (state.view === "documents") params.set("view", "documents");
    else params.delete("view");
    if (Object.hasOwn(patch, "documentPage") && state.documentPage > 0) params.set("documentsPage", String(state.documentPage + 1));
    else params.delete("documentsPage");
    if (state.module === null) params.delete("module");
    else params.set("module", state.module);
    params.delete('folderOwner');
    if (state.module === null || state.category === 'all' || !state.contributor) { params.delete('contributor'); params.delete('folder'); }
    else { params.set('contributor', state.contributor); if (state.folder) params.set('folder', state.folder); else params.delete('folder'); }
    for (const key of ["category", "author", "part", "date", "year"]) {
      if (state[key] === "all") params.delete(key);
      else params.set(key, state[key]);
    }
    if (state.sort === "recent") params.delete("sort");
    else params.set("sort", state.sort);
    if (state.query) params.set("q", state.query);
    else params.delete("q");
    setSearchParams(params, options);
  };
  const openModule = (name, event) => {
    pendingModuleScroll.current = true;
    pendingModuleFocus.current = event?.detail === 0;
    setShowModulePicker(false);
    setModuleQuery("");
    navigateLibrary({ module: name, category: 'all', contributor: '', folder: "", folderOwner: "", query: '', author: 'all', part: 'all', date: 'all', year: 'all', view: "modules" });
  };
  const openCategory = (value, event) => {
    pendingFolderScroll.current = true; pendingFolderFocus.current = event?.detail === 0;
    navigateLibrary({ category: value, contributor: '', folder: '', author: 'all', part: 'all', date: 'all', year: 'all' });
  };
  const openContributor = (owner, event) => {
    pendingFolderScroll.current = true; pendingFolderFocus.current = event?.detail === 0;
    navigateLibrary({ contributor: owner, folder: '' });
  };
  const openFolder = (path, owner = folderOwner, folderCategory = category, event) => {
    pendingFolderScroll.current = true;
    pendingFolderFocus.current = event?.detail === 0;
    navigateLibrary({ folder: path, contributor: owner || contributor, category: folderCategory });
  };
  const changeDocumentPage = (page) => {
    navigateLibrary({ documentPage: Math.max(0, Math.min(page, lastDocumentPage)) });
    requestAnimationFrame(() =>
      resultsHeading.current?.scrollIntoView({
        block: "start",
        behavior: "auto",
      }),
    );
  };
  const clearFilters = (event) => {
    navigateLibrary({ query: "", author: "all", part: "all", date: "all", year: "all" });
    if (event?.detail === 0) requestAnimationFrame(() => searchInput.current?.focus({ preventScroll: true }));
  };
  const removeFilter = (filter, index, event) => {
    navigateLibrary(filter.patch);
    if (event.detail === 0) requestAnimationFrame(() => {
      const buttons = filterChips.current?.querySelectorAll('button');
      const next = buttons?.[Math.min(index, buttons.length - 1)] || searchInput.current;
      next?.focus({ preventScroll: true });
    });
  };
  const changeSemester = (value) =>
    navigateLibrary({
      semester: value,
      module: null,
      category: 'all',
      contributor: '',
      folder: '',
      author: "all",
      part: "all",
      date: "all",
      year: "all",
    });
  const folderLabel = (name) =>
    name || tr("Sans module", "Unclassified", "بدون وحدة");
  const categoryLabel = (key) => key === "tdtp"
    ? tr("TD / TP (anciens)", "TD / TP (legacy)", "TD / TP (قديمة)")
    : key && key !== 'unclassified' ? t(key) : tr("Sans catégorie", "Unclassified", "بدون فئة");
  const openYearEditor = (document) => {
    setYearEditor(document);
    setEditedYears(resourceAcademicYears(document));
    setYearError("");
  };
  const saveYears = async () => {
    if (!yearEditor || savingYears || !updateResourceAcademicYears) return;
    setSavingYears(true);
    setYearError("");
    try {
      await updateResourceAcademicYears(yearEditor.id, [...new Set(editedYears.map(normalizeAcademicYear).filter(Boolean))]);
      setYearEditor(null);
    } catch (error) {
      setYearError(error.message || tr("L’année n’a pas pu être enregistrée.", "Could not save the academic year.", "تعذر حفظ السنة الجامعية."));
    } finally { setSavingYears(false); }
  };
  const tabs = [
    { id: "all", label: t("all"), count: filteredBase.length },
    ...[...categories, ...(category === "tdtp" || semesterResources.some(item => item.category === "tdtp") ? ["tdtp"] : [])].map((id) => ({
      id,
      label: categoryLabel(id),
      count: filteredBase.filter((item) => categoryMatches(item, id)).length,
    })),
  ];
  const dateLabels = {
    "7": tr("7 derniers jours", "Last 7 days", "آخر 7 أيام"),
    "30": tr("30 derniers jours", "Last 30 days", "آخر 30 يوماً"),
    "90": tr("3 derniers mois", "Last 3 months", "آخر 3 أشهر"),
  };
  const activeFilters = [
    query.trim() && { key: "query", label: `${t("search")} : ${query.trim()}`, patch: { query: "" } },
    year !== "all" && { key: "year", label: year === "unknown" ? tr("Année inconnue", "Unknown year", "سنة غير معروفة") : year, patch: { year: "all" } },
    author !== "all" && { key: "author", label: `${t("author")} : ${author}`, patch: { author: "all" } },
    part !== "all" && { key: "part", label: partLabel(part, language), patch: { part: "all" } },
    date !== "all" && { key: "date", label: dateLabels[date] || date, patch: { date: "all" } },
  ].filter(Boolean);
  const hasActiveFilters = activeFilters.length > 0;
  const isBrowsingModules = module === null && overviewView === "modules" && !hasActiveFilters && !showFilters;
  const resultsCount = contributor ? contributorResources.length : visible.length;
  const moduleCatalogueState = (moduleStatus === "loading" || moduleStatus === "error") && (
    <div className="library-module-picker-state" data-state={moduleStatus} role="status">
      {moduleStatus === "loading" ? <><LoaderCircle size={18} className="library-module-loading" aria-hidden="true" /><span>{tr("Chargement des modules…", "Loading modules…", "جارٍ تحميل الوحدات…")}</span></>
        : <><span>{tr("Impossible de charger les modules.", "Could not load modules.", "تعذر تحميل الوحدات.")}</span><button type="button" className="library-module-retry" onClick={retryModules}><RotateCw size={14} aria-hidden="true" />{tr("Réessayer", "Retry", "إعادة المحاولة")}</button></>}
    </div>
  );
  const handleModuleKeys = event => {
    const choices = [...modulePicker.current?.querySelectorAll('.module-choice') || []];
    const index = choices.indexOf(document.activeElement);
    let target;
    if (event.key === "ArrowDown") target = choices[Math.min(index + 1, choices.length - 1)];
    else if (event.key === "ArrowUp" && index >= 0) target = index === 0 ? moduleSearchInput.current : choices[index - 1];
    else if (index >= 0 && event.key === "Home") target = choices[0];
    else if (index >= 0 && event.key === "End") target = choices.at(-1);
    if (target) { event.preventDefault(); target.focus(); }
  };
  const resultsContext = (
    <div ref={resultsHeading} tabIndex={-1} className={`library-results-heading ${module === null ? "is-overview" : "is-module"}`}>
      {module !== null && <Button variant="ghost" icon={ArrowLeft} className="library-back-to-modules" onClick={event => openModule(null, event)}>{tr("Tous les modules", "All modules", "كل الوحدات")}</Button>}
      <div className="library-results-context">
        <div className="library-results-body">
          <div className="library-results-header">
            <div className="library-results-title">
              <h2 dir="auto">{module === null ? tr('Modules', 'Modules', 'الوحدات') : contributor ? contributorName : category !== 'all' ? categoryLabel(category) : folderLabel(selectedModuleName)}</h2>
              <span className="library-results-count muted" role="status" aria-live="polite" aria-atomic="true">
                {module === null && overviewView === "modules" && <>{folders.length} {tr(folders.length === 1 ? "module" : "modules", folders.length === 1 ? "module" : "modules", folders.length === 1 ? "وحدة" : "وحدات")} · </>}
                {resultsCount} {tr(resultsCount === 1 ? "document" : "documents", resultsCount === 1 ? "document" : "documents", "وثيقة")} · S{semester}
                {folder && directory.folders.length > 0 && <> · {directory.folders.length} {tr("dossiers", "folders", "مجلدات")}</>}
              </span>
            </div>
            {module !== null && moduleResources.length > 0 && <Button className="library-share-current-module" variant="ghost" icon={Share2} onClick={() => setSharedResource(moduleResources[0])}>{tr('Partager le module', 'Share module', 'مشاركة الوحدة')}</Button>}
          </div>
          {module === null && overviewView === "modules" && folders.length > 0 && <div className="library-results-cards"><div className="library-document-grid library-module-grid">
            {folders.map(folder => <ModuleActions key={folder.key} resource={folder.documents[0]} label={folderLabel(folder.name)} onShare={setSharedResource}>
              <button type="button" className="library-module-folder" aria-label={tr("Ouvrir le module", "Open module", "فتح الوحدة") + " " + folderLabel(folder.name)} onClick={event => openModule(folder.key, event)}>
                <span className="library-folder-symbol"><Folder size={23} strokeWidth={1.5}/></span>
                <span className="library-folder-copy"><strong className="library-module-name" dir="auto">{folderLabel(folder.name)}</strong><span className="library-module-count muted">{folder.documents.length} {tr(folder.documents.length === 1 ? "document" : "documents", folder.documents.length === 1 ? "document" : "documents", "وثيقة")} · S{semester}</span></span>
                <ArrowRight size={16} className="library-folder-arrow"/>
              </button>
            </ModuleActions>)}
          </div></div>}
          {module === null && overviewView === "modules" && !folders.length && moduleCatalogueState}
        </div>
      </div>
    </div>
  );
  return (
    <div className="library-page page-enter">
      <PageHeader
        title={t("library")}
        actions={
          <Button
            variant="primary"
            icon={Upload}
            onClick={() => setShowUpload(true)}
            aria-label={tr("Partager un document", "Share a document", "مشاركة وثيقة")}
          >
            <span className="library-upload-full">{tr("Partager un document", "Share a document", "مشاركة وثيقة")}</span>
            <span className="library-upload-short" aria-hidden="true">{tr("Ajouter", "Add", "إضافة")}</span>
          </Button>
        }
      />
      <section
        className="library-navigation card"
        aria-label={tr(
          "Navigation académique",
          "Academic navigation",
          "التنقل الأكاديمي",
        )}
      >
        <div className="library-semester-selector">
        <div className="library-navigation-heading"><span>{t("semester")}</span></div>
        <div className="semester-navigation" aria-label={t("semester")}>
          {[
            [1, 2],
            [3, 4],
            [5, 6],
          ].map((group, index) => (
            <div className="semester-group" key={index}>
              <span className="semester-year">
                {tr(
                  `Année ${index + 1}`,
                  `Year ${index + 1}`,
                  `السنة ${index + 1}`,
                )}
              </span>
              <div>
                {group.map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`semester-choice ${semester === value ? "selected" : ""}`}
                    aria-pressed={semester === value}
                    onClick={() => changeSemester(value)}
                  >
                    S{value}
                    {semester === value && <Check size={15} />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        </div>
        <div className="library-module-selector">
        <div className="library-navigation-heading"><span>{t("module")}</span><span className="library-module-available">{semesterFolders.length > 0 ? `${semesterFolders.length} ${tr(semesterFolders.length === 1 ? "disponible" : "disponibles", "available", "متاحة")}` : `S${semester}`}</span></div>
        <button
          type="button"
          ref={moduleTrigger}
          className={`library-module-trigger${module !== null ? " has-selection" : ""}${showModulePicker ? " is-open" : ""}`}
          aria-label={
            module === null
              ? tr("Choisir un module", "Choose a module", "اختر الوحدة")
              : tr("Changer de module", "Change module", "تغيير الوحدة")
          }
          aria-expanded={showModulePicker}
          aria-controls="library-module-picker"
          aria-haspopup="dialog"
          onClick={event => { pendingPickerFocus.current = event.detail === 0; setModuleQuery(""); setShowModulePicker(value => !value); }}
          onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); if (showModulePicker) moduleSearchInput.current?.focus(); else { pendingPickerFocus.current = true; setShowModulePicker(true); } } }}
        >
          <span className="library-folder-symbol" aria-hidden="true">
            <FolderOpen size={22} strokeWidth={1.6} />
          </span>
          <span className="library-module-trigger-copy">
            <span className="library-module-trigger-label">
              {module === null
                ? tr("Choisir un module", "Choose a module", "اختر الوحدة")
                : tr("Changer de module", "Change module", "تغيير الوحدة")}
            </span>
            <strong dir="auto">
              {module === null
                ? tr("Choisir un module", "Choose a module", "اختر الوحدة")
                : folderLabel(selectedModuleName)}
            </strong>

          </span>
          <span className="library-module-trigger-indicator" aria-hidden="true">
            <ChevronDown size={18} className="library-module-trigger-chevron" />
          </span>
        </button>
        {showModulePicker && createPortal(<div className="library-module-overlay" ref={moduleOverlay}>
          <div className="library-module-scrim" aria-hidden="true" />
          <div
            ref={modulePicker}
            className="library-module-picker"
            id="library-module-picker"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-busy={moduleStatus === "loading"}
            aria-label={tr(`Modules du semestre S${semester}`, `Modules for semester S${semester}`, `وحدات الفصل S${semester}`)}
            onKeyDown={handleModuleKeys}
          >
            <div className="library-module-picker-heading"><strong>{tr("Modules", "Modules", "الوحدات")}</strong><span dir="ltr">S{semester}</span><button type="button" onClick={() => { setShowModulePicker(false); moduleTrigger.current?.focus({ preventScroll: true }); }} aria-label={tr("Fermer", "Close", "إغلاق")}><X size={16} aria-hidden="true" /></button></div>
            <label className="library-search library-module-search">
              <Search size={17} aria-hidden="true" />
              <input
                ref={moduleSearchInput}
                value={moduleQuery}
                onChange={(event) => setModuleQuery(event.target.value)}
                placeholder={tr(
                  "Rechercher un module…",
                  "Search modules…",
                  "ابحث عن وحدة…",
                )}
                aria-label={tr(
                  "Rechercher un module",
                  "Search modules",
                  "البحث عن وحدة",
                )}
              />
              {moduleQuery && (
                <button
                  type="button"
                  onClick={() => setModuleQuery("")}
                  aria-label={t("clear")}
                >
                  <X size={16} />
                </button>
              )}
            </label>
            {moduleCatalogueState}
            <div className="library-modules" aria-label={t("module")}>
              {!moduleQuery && (semesterFolders.length > 0 || semesterResources.length > 0) && <button
                type="button"
                className={`module-choice ${module === null ? "selected" : ""}`}
                aria-pressed={module === null}
                onClick={event => openModule(null, event)}
              >
                <Folder size={17} aria-hidden="true" />
                <span>
                  {tr("Tous les modules", "All modules", "كل الوحدات")}
                </span>
                <span
                  className="library-module-choice-count"
                  aria-hidden="true"
                >
                  {semesterResources.length}
                </span>
                {module === null && <Check size={16} aria-hidden="true" />}
              </button>}
              {matchingModuleFolders.map((folder) => (
                <ModuleActions key={folder.key} resource={folder.documents[0]} label={folderLabel(folder.name)} onShare={resource => { setShowModulePicker(false); setSharedResource(resource); }} choice>
                <button
                  type="button"
                  className={`module-choice ${module !== null && selectedModuleKey === folder.key ? "selected" : ""}`}
                  aria-pressed={
                    module !== null && selectedModuleKey === folder.key
                  }
                  onClick={event => openModule(folder.key, event)}
                >
                  <Folder size={17} aria-hidden="true" />
                  <span className="library-module-option-copy"><span dir="auto">{folderLabel(folder.name)}</span><small>{folder.documents.length ? `${folder.documents.length} ${tr(folder.documents.length === 1 ? "document" : "documents", folder.documents.length === 1 ? "document" : "documents", "وثيقة")}` : tr("Aucun document partagé", "No shared documents", "لا توجد وثائق بعد")}</small></span>
                  <span className="library-module-option-mark" aria-hidden="true" />
                  {module !== null &&
                    selectedModuleKey === folder.key && (
                      <Check size={16} aria-hidden="true" />
                    )}
                </button>
                </ModuleActions>
              ))}
              {moduleStatus !== "loading" && moduleQuery && !matchingModuleFolders.length && (
                <p className="library-module-empty muted">
                  {tr(
                    "Aucun module trouvé.",
                    "No matching modules.",
                    "لا توجد وحدات مطابقة.",
                  )}
                </p>
              )}
            </div>
            {moduleStatus === "ready" && !semesterFolders.length && !moduleQuery && <p className="library-module-picker-state" data-state="empty">{tr(`Aucun module enregistré pour S${semester}.`, `No modules registered for S${semester}.`, `لا توجد وحدات مسجلة للفصل S${semester}.`)}</p>}
          </div>
        </div>, document.body)}
        </div>
      </section>
      <section className={`library-browse-controls card${isBrowsingModules ? " is-browsing-modules" : ""}`} aria-label={tr("Recherche et filtres", "Search and filters", "البحث والفلاتر")}>
      <div className="library-toolbar">
        <label className="library-search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchInput}
            value={query}
            onChange={(event) =>
              navigateLibrary({ query: event.target.value }, { replace: true })
            }
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); resultsHeading.current?.focus({ preventScroll: true }); resultsHeading.current?.scrollIntoView({ block: "start", behavior: "auto" }); } }}
            placeholder={tr(
              "Titre, module, auteur…",
              "Title, module, author…",
              "عنوان، وحدة، مؤلف…",
            )}
            aria-label={tr(
              "Rechercher des documents",
              "Search documents",
              "البحث في الوثائق",
            )}
          />
          {query && (
            <button
              type="button"
              onClick={() => navigateLibrary({ query: "" }, { replace: true })}
              aria-label={t("clear")}
            >
              <X size={16} />
            </button>
          )}
        </label>
        <div className="library-toolbar-actions">
          <Button
            variant={showFilters ? "secondary" : "ghost"}
            icon={Filter}
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters}
            aria-controls="library-filters"
            aria-label={t("filters")}
          >
            {t("filters")}
            {filterCount > 0 && (
              <span className="filter-counter">{filterCount}</span>
            )}
          </Button>
          <label className="library-sort" hidden={isBrowsingModules}>
            <ArrowDownUp size={16} />
            <span className="sr-only">{t("sort")}</span>
            <Select
              value={sort}
              onChange={(event) => navigateLibrary({ sort: event.target.value })}
              aria-label={t("sort")}
            >
              <option value="recent">
                {tr("Plus récents", "Newest first", "الأحدث أولاً")}
              </option>
              <option value="oldest">
                {tr("Plus anciens", "Oldest first", "الأقدم أولاً")}
              </option>
              <option value="title">
                {tr("Titre A–Z", "Title A–Z", "العنوان أ–ي")}
              </option>
              <option value="part">
                {tr(
                  "Par chapitre",
                  "By chapter",
                  "حسب الجزء",
                )}
              </option>
            </Select>
          </label>
        </div>
      </div>
        <div className="library-search-scope">
      <span>S{semester} · {module === null ? tr("Tous les modules", "All modules", "كل الوحدات") : <><bdi>{selectedModuleName}</bdi>{category !== 'all' && <> / {categoryLabel(category)}</>}{contributor && <> / <bdi>{contributorName}</bdi></>}</>}</span>
          {module !== null && folder && query.trim() && <Button className="library-search-whole-module" variant="ghost" onClick={event => openFolder("", contributor, category, event)}>{tr("Rechercher dans ce dossier étudiant", "Search this student folder", "البحث في مجلد هذا الطالب")}</Button>}
        </div>
        <div className="library-controls-options" hidden={module === null || category === 'all'}>
      <div className="library-category-tabs">
        <span className="library-section-label">
          {tr("Type de document", "Document type", "نوع الوثيقة")}
        </span>
        <Tabs
          items={tabs}
          value={category}
          onChange={(value) => openCategory(value)}
        />
      </div>

        </div>
      {showFilters && (
        <div className="library-filter-panel" id="library-filters">
          <div className="library-filter-heading"><h3>{tr("Affiner les résultats", "Refine results", "تصفية النتائج")}</h3><Button variant="ghost" icon={X} onClick={() => setShowFilters(false)} aria-label={tr("Masquer les filtres", "Hide filters", "إخفاء الفلاتر")}>{t("close")}</Button></div>
          <div className="form-grid">
            <Field label={t("author")}>
              <Select
                className="input"
                value={author}
                onChange={(event) =>
                  navigateLibrary({ author: event.target.value })
                }
              >
                <option value="all">
                  {tr("Tous les auteurs", "All authors", "كل المؤلفين")}
                </option>
                {authors.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("part")}>
              <Select
                className="input"
                value={part}
                onChange={(event) =>
                  navigateLibrary({ part: event.target.value })
                }
              >
                <option value="all">
                  {tr(
                    "Tous les Parts/Chapitres",
                    "All Parts/Chapitres",
                    "كل الأجزاء/الفصول",
                  )}
                </option>
                {parts.map((value) => (
                  <option key={value} value={value}>
                    {partLabel(value, language)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("date")}>
              <Select
                className="input"
                value={date}
                onChange={(event) =>
                  navigateLibrary({ date: event.target.value })
                }
              >
                <option value="all">
                  {tr("Toutes les dates", "All dates", "كل التواريخ")}
                </option>
                <option value="7">
                  {tr("7 derniers jours", "Last 7 days", "آخر 7 أيام")}
                </option>
                <option value="30">
                  {tr("30 derniers jours", "Last 30 days", "آخر 30 يوماً")}
                </option>
                <option value="90">
                  {tr("3 derniers mois", "Last 3 months", "آخر 3 أشهر")}
                </option>
              </Select>
            </Field>
      <div className="library-academic-year-control">
        <Field label={tr("Année universitaire d’utilisation", "Academic year of use", "السنة الجامعية للاستخدام")}>
          <Select className="input" value={year} aria-describedby="library-year-hint" onChange={(event) => navigateLibrary({ year: event.target.value })}>
            <option value="all">{tr("Toutes les années", "All academic years", "كل السنوات الجامعية")}</option>
            {availableYears.map(value => <option key={value} value={value}>{value}{value === currentAcademicYear ? ` · ${tr("année actuelle", "current year", "السنة الحالية")}` : ""}</option>)}
            <option value="unknown">{tr("Année inconnue", "Unknown year", "سنة غير معروفة")}</option>
          </Select>
        </Field>
        <p className="muted" id="library-year-hint">{tr("L’année actuelle apparaît d’abord.", "Current-year material appears first.", "تظهر وثائق السنة الحالية أولاً.")}</p>
      </div>
          </div>

        </div>
      )}
        {hasActiveFilters && <div className="library-active-filters" aria-label={tr("Filtres actifs", "Active filters", "الفلاتر المفعّلة")}>
          <span className="library-section-label">{tr("Filtres actifs", "Active filters", "الفلاتر المفعّلة")}</span>
          <div className="library-filter-chips" ref={filterChips}>{activeFilters.map((filter, index) => <button type="button" key={filter.key} data-filter={filter.key} className="library-filter-chip" onClick={event => removeFilter(filter, index, event)} aria-label={tr(`Retirer le filtre : ${filter.label}`, `Remove filter: ${filter.label}`, `إزالة الفلتر: ${filter.label}`)}><bdi>{filter.label}</bdi><X size={13} aria-hidden="true" /></button>)}</div>
          <Button className="library-clear-filters" variant="ghost" onClick={clearFilters}>{tr("Tout effacer", "Clear all", "مسح الكل")}</Button>
        </div>}
        <details className="library-pdf-search" hidden={!showDocumentResults}><summary>{tr('Rechercher dans le texte des PDF','Search inside PDF text','البحث في نص ملفات PDF')}</summary><DocumentTextSearch resourceIds={contributorResources.map(item => item.id)}/></details>
      </section>
      {resultsContext}
      {showDocumentResults && <LibraryReport resource={directoryDocuments[0] || contributorResources[0]} folder={folder} module={selectedModuleName} category={category}/>}
      {module !== null && <nav ref={directoryHeading} tabIndex={-1} className="library-folder-breadcrumbs" aria-label={tr("Chemin du dossier", "Folder path", "مسار المجلد")}>
        <button type="button" onClick={event => openModule(null, event)}>{t('library')}</button><span aria-hidden="true">/</span>
        <button type="button" onClick={() => changeSemester(semester)}>S{semester}</button><span aria-hidden="true">/</span>
        <button type="button" dir="auto" aria-current={category === 'all' ? 'page' : undefined} onClick={event => openCategory('all', event)}>{folderLabel(selectedModuleName)}</button>
        {category !== 'all' && <><span aria-hidden="true">/</span><button type="button" aria-current={!contributor ? 'page' : undefined} onClick={event => openCategory(category, event)}>{categoryLabel(category)}</button></>}
        {contributor && <><span aria-hidden="true">/</span><button type="button" dir="auto" aria-current={!folder ? 'page' : undefined} onClick={event => openContributor(contributor, event)}>{contributorName}</button></>}
        {folder.split("/").filter(Boolean).map((name, index, segments) => <React.Fragment key={index}><span aria-hidden="true">/</span><button type="button" dir="auto" aria-current={index === segments.length - 1 ? "page" : undefined} onClick={event => openFolder(segments.slice(0, index + 1).join("/"), contributor, category, event)}>{name}</button></React.Fragment>)}
        {category !== 'all' && <Button variant="ghost" icon={ArrowLeft} className="library-parent-folder" onClick={event => folder ? openFolder(folder.split('/').slice(0, -1).join('/'), contributor, category, event) : contributor ? openCategory(category, event) : openCategory('all', event)}>{tr("Dossier parent", "Parent folder", "المجلد الأب")}</Button>}
      </nav>}
      {module !== null && category === 'all' ? <section className="library-hierarchy-section" aria-label={tr('Catégories du module', 'Module categories', 'فئات الوحدة')}>
        <p className="library-hierarchy-hint muted">{tr('Choisissez une catégorie pour parcourir les dossiers des étudiants.', 'Choose a category to browse student folders.', 'اختر فئة لتصفح مجلدات الطلبة.')}</p>
        <div className="library-document-grid library-category-grid">{[...new Set([...categories, ...moduleResources.map(resourceCategory)])].map(key => {
          const Icon = categoryIcons[key] || Layers, count = filteredBase.filter(item => categoryMatches(item, key)).length;
          return <button type="button" className="library-category-folder library-uploaded-folder card" key={key || 'unknown'} data-category={key} onClick={event => openCategory(key || 'unclassified', event)}>
            <span className="library-folder-symbol" aria-hidden="true"><Icon size={23} strokeWidth={1.6}/></span>
            <span className="library-uploaded-folder-copy"><strong>{categoryLabel(key)}</strong><span>{count} {tr(count === 1 ? 'fichier' : 'fichiers', count === 1 ? 'file' : 'files', 'ملف')}</span></span><ArrowRight className="library-folder-arrow" size={17} aria-hidden="true"/>
          </button>;
        })}</div>
      </section> : module !== null && !contributor ? <section className="library-hierarchy-section" aria-label={tr('Dossiers des étudiants', 'Student folders', 'مجلدات الطلبة')}>
        <p className="library-hierarchy-hint muted">{tr('Chaque dossier contient uniquement les fichiers de cet étudiant dans cette catégorie.', 'Each folder contains only this student’s files in this category.', 'يحتوي كل مجلد على ملفات هذا الطالب ضمن هذه الفئة فقط.')}</p>
        {contributors.length ? <div className="library-document-grid library-contributor-grid">{contributors.map(entry => <button type="button" className="library-contributor-folder library-uploaded-folder card" data-contributor={entry.id} key={entry.id} onClick={event => openContributor(entry.id, event)}>
          <span className="library-folder-symbol" aria-hidden="true"><Folder size={24} strokeWidth={1.5}/></span>
          <span className="library-uploaded-folder-copy"><strong dir="auto">{entry.id === UNKNOWN_CONTRIBUTOR ? unknownContributorLabel : entry.name || tr('Contributeur', 'Contributor', 'مساهم')}</strong><span>{entry.count} {tr(entry.count === 1 ? 'fichier' : 'fichiers', entry.count === 1 ? 'file' : 'files', 'ملف')} · {categoryLabel(category)}</span></span><ArrowRight className="library-folder-arrow" size={17} aria-hidden="true"/>
        </button>)}</div> : <EmptyState icon={Users} title={tr('Aucun dossier dans cette catégorie', 'No folders in this category', 'لا توجد مجلدات في هذه الفئة')} description={hasActiveFilters ? tr('Modifiez la recherche ou les filtres.', 'Change the search or filters.', 'غيّر البحث أو المرشحات.') : tr('Les dossiers apparaîtront dès qu’un étudiant partagera un fichier dans cette catégorie.', 'Folders appear when a student shares a file in this category.', 'تظهر المجلدات عندما يشارك طالب ملفاً في هذه الفئة.')} action={hasActiveFilters ? <Button variant="secondary" onClick={clearFilters}>{tr('Effacer les filtres', 'Clear filters', 'مسح المرشحات')}</Button> : undefined}/>}
      </section> : !showDocumentResults && (folders.length > 0 || moduleStatus === "loading" || moduleStatus === "error") ? null : visible.length > 0 && (module === null || directory.folders.length > 0 || directoryDocuments.length > 0) ? (
        !showDocumentResults ? null : (
          <>
            {module !== null && (!query.trim() || folder) && directory.folders.length > 0 && <section className="library-uploaded-folders" aria-label={tr("Dossiers partagés", "Shared folders", "المجلدات المشتركة")}>
              <h3>{tr("Dossiers", "Folders", "المجلدات")}</h3>
              {groupByCategory(directory.folders).map(group => <section className="library-type-section" data-category={group.category} key={group.category} aria-label={categoryLabel(group.category)}>
                <h4 className="library-type-heading">{categoryLabel(group.category)}</h4>
                <div className="library-document-grid">{group.items.map(entry => <button type="button" key={entry.key} className="library-uploaded-folder card" onClick={event => openFolder(entry.path, entry.owner, entry.category||category, event)}>
                  <span className="library-folder-symbol" aria-hidden="true"><Folder size={23} strokeWidth={1.5}/></span>
                  <span className="library-uploaded-folder-copy"><strong dir="auto">{entry.name}</strong><span>{entry.count} {tr(entry.count === 1 ? "document" : "documents", entry.count === 1 ? "document" : "documents", "وثيقة")}</span>{entry.uploader && <bdi>{entry.uploader}</bdi>}</span>
                  <ArrowRight className="library-folder-arrow" size={17} aria-hidden="true"/>
                </button>)}</div>
              </section>)}
            </section>}
            <div className="library-year-groups">
              {pageYearGroups.map(group => (
                <section className="library-year-group" key={group.year || "unknown"} aria-label={group.year || tr("Année inconnue", "Unknown year", "سنة غير معروفة")}>
                  <div className="library-year-heading">
                    <h3>{group.year || tr("Année inconnue", "Unknown year", "سنة غير معروفة")}</h3>
                    {group.year && group.year === currentAcademicYear && <span className="library-current-year">{tr("Année actuelle", "Current year", "السنة الحالية")}</span>}
                  </div>
                  {groupByCategory(group.documents).map(typeGroup => <section className="library-type-section" data-category={typeGroup.category} key={typeGroup.category} aria-label={categoryLabel(typeGroup.category)}>
                    <h4 className="library-type-heading">{categoryLabel(typeGroup.category)}</h4>
                    <div className="library-document-grid">
                    {typeGroup.items.map(document => (
                      <div className="library-year-document" key={document.id}>
                        <DocumentCard document={document} showOpenLabel variant="library" onEditAcademicYears={updateResourceAcademicYears && (document.can_manage_academic_years === true || document.canManageAcademicYears === true || String(document.author_id) === String(user?.id)) ? () => openYearEditor(document) : undefined} />
                        <div className="library-document-year-meta">
                          {resourceAcademicYears(document).length > 1 && <span className="muted">{tr("Utilisé en", "Used in", "استُخدم في")} {resourceAcademicYears(document).join(" · ")}</span>}
                        </div>
                      </div>
                    ))}
                    </div>
                  </section>)}
                </section>
              ))}
            </div>
            {directoryDocuments.length > DOCUMENTS_PER_PAGE && (
              <nav
                className="library-pagination"
                aria-label={tr(
                  "Pages des documents",
                  "Document pages",
                  "صفحات الوثائق",
                )}
              >
                <Button
                  icon={ArrowLeft}
                  disabled={pageNumber === 0}
                  aria-label={tr(
                    "Documents précédents",
                    "Previous documents",
                    "الوثائق السابقة",
                  )}
                  onClick={() => changeDocumentPage(pageNumber - 1)}
                >
                  {tr("Précédent", "Previous", "السابق")}
                </Button>
                <span className="library-page-position muted" role="status">
                  {pageStart + 1}–
                  {Math.min(pageStart + DOCUMENTS_PER_PAGE, directoryDocuments.length)}{" "}
                  {tr("sur", "of", "من")} {directoryDocuments.length}
                </span>
                <Button
                  icon={ArrowRight}
                  disabled={pageNumber === lastDocumentPage}
                  aria-label={tr(
                    "Documents suivants",
                    "Next documents",
                    "الوثائق التالية",
                  )}
                  onClick={() => changeDocumentPage(pageNumber + 1)}
                >
                  {tr("Suivant", "Next", "التالي")}
                </Button>
              </nav>
            )}
          </>
        )
      ) : (
        <EmptyState
          icon={BookOpen}
          title={hasActiveFilters ? tr("Aucun résultat pour ces filtres", "No results for these filters", "لا توجد نتائج لهذه الفلاتر") : folder ? tr("Ce dossier est vide", "This folder is empty", "هذا المجلد فارغ") : module !== null ? tr("Aucun document dans ce module", "No documents in this module", "لا توجد وثائق في هذه الوحدة") : tr(`Aucun document pour S${semester}`, `No documents for S${semester}`, `لا توجد وثائق للفصل S${semester}`)}
          description={
            folder && query.trim() && visible.length > 0
              ? tr("Des documents correspondent ailleurs dans ce module.", "Matching documents exist elsewhere in this module.", "توجد وثائق مطابقة في مجلدات أخرى من هذه الوحدة.")
              : hasActiveFilters ? tr("Modifiez votre recherche ou retirez un filtre.", "Change your search or remove a filter.", "غيّر البحث أو أزل أحد الفلاتر.")
              : folder ? tr("Revenez au dossier parent pour retrouver les documents.", "Return to the parent folder to find documents.", "ارجع إلى المجلد الأب للعثور على الوثائق.")
              : module !== null ? tr("Les documents partagés dans ce module apparaîtront ici.", "Documents shared in this module will appear here.", "ستظهر هنا الوثائق المشتركة في هذه الوحدة.")
              : tr(
                  "Les documents de ce semestre apparaîtront ici. Vous pouvez en partager un.",
                  "Documents for this semester will appear here. You can share one.",
                  "ستظهر وثائق هذا الفصل هنا. يمكنك مشاركة وثيقة.",
                )
          }
          action={
            <Button
              variant="secondary"
              onClick={
                folder && query.trim() && visible.length > 0
                  ? event => openFolder("", "", category, event)
                  : hasActiveFilters ? clearFilters
                  : folder ? event => openFolder(folder.split("/").slice(0, -1).join("/"), folderOwner, category, event)
                  : module !== null ? event => openModule(null, event) : () => setShowUpload(true)
              }
            >
              {folder && query.trim() && visible.length > 0
                ? tr("Rechercher dans tout le module", "Search the whole module", "البحث في الوحدة كاملة")
                : hasActiveFilters ? tr("Effacer les filtres", "Clear filters", "مسح المرشحات")
                : folder ? tr("Dossier parent", "Parent folder", "المجلد الأب")
                : module !== null ? tr("Tous les modules", "All modules", "كل الوحدات") : tr(
                    "Partager un document",
                    "Share a document",
                    "مشاركة وثيقة",
                  )}
            </Button>
          }
        />
      )}

      {showUpload && <UploadModal initialClassification={{ semester, module: module === null ? "" : selectedModuleFolder?.rawName || selectedModuleName, moduleId: selectedModuleFolder?.catalogStatus === 'official' ? selectedModuleFolder.id : '', category }} onClose={() => setShowUpload(false)} />}
      {sharedResource && <ModuleShareDialog resource={sharedResource} onClose={() => setSharedResource(null)} />}
      {yearEditor && <Modal title={tr("Années d’utilisation du document", "Years the material was used", "سنوات استخدام الوثيقة")} onClose={() => { if (!savingYears) setYearEditor(null); }} footer={<div className="library-year-editor-footer"><Button variant="ghost" disabled={savingYears} onClick={() => setYearEditor(null)}>{t("cancel")}</Button><Button variant="primary" disabled={savingYears} onClick={saveYears}>{savingYears ? tr("Enregistrement…", "Saving…", "جارٍ الحفظ…") : tr("Enregistrer", "Save", "حفظ")}</Button></div>}>
        <p className="muted library-year-editor-note">{yearEditor.originalName || yearEditor.title}</p>
        <p className="muted library-year-editor-note">{tr("Corrigez le classement ou ajoutez une année de réutilisation. Le fichier reste conservé une seule fois.", "Correct the classification or add a year when the material was reused. The stored file is kept once.", "صحّح التصنيف أو أضف سنة أُعيد فيها استخدام الوثيقة. يبقى الملف مخزناً مرة واحدة.")}</p>
        {yearError && <div className="upload-error" role="alert">{yearError}</div>}
        {(editedYears.length ? editedYears : [""]).map((value, index) => <div className="library-year-editor-row" key={index}>
          <Field label={tr("Année universitaire", "Academic year", "السنة الجامعية")}><Select className="input" value={value} disabled={savingYears} onChange={(event) => setEditedYears(previous => {
            const next = [...previous]; next[index] = event.target.value; return next;
          })}>
            <option value="">{tr("Année inconnue", "Unknown year", "سنة غير معروفة")}</option>
            {academicYearOptions(currentAcademicYear, [...availableYears, ...editedYears]).map(option => <option key={option} value={option}>{option}</option>)}
          </Select></Field>
          {editedYears.length > 1 && <button className="icon-btn" disabled={savingYears} onClick={() => setEditedYears(previous => previous.filter((_, position) => position !== index))} aria-label={tr("Retirer cette année", "Remove this year", "إزالة هذه السنة")}><X size={16} /></button>}
        </div>)}
        <Button variant="ghost" icon={Plus} disabled={savingYears || !editedYears.some(Boolean) || editedYears.length >= 30} onClick={() => setEditedYears(previous => [...previous, academicYearOptions(currentAcademicYear, availableYears).find(option => !previous.includes(option)) || ""])}>{tr("Ajouter une année de réutilisation", "Add a year of reuse", "إضافة سنة إعادة استخدام")}</Button>
      </Modal>}
    </div>
  );
}
