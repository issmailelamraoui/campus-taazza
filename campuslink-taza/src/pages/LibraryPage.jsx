import { Select } from "../components/Select";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Filter,
  Folder,
  FolderOpen,
  Search,
  Upload,
  X,
  Pencil,
  Plus,
} from "lucide-react";
import { useApp } from "../context";
import {
  groupResourcesByModule,
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
import "./library.css";
const semesterNumber = (value) =>
  Number(String(value ?? "").replace(/^s/i, ""));
const categories = [
  "courses",
  "exercises",
  "tdtp",
  "corrections",
  "exams",
  "rattrapage",
];
const DOCUMENTS_PER_PAGE = 24;
const categoryMatches = (resource, category) =>
  category === "all" ||
  (category === "tdtp"
    ? ["td", "tp", "tdtp"].includes(resource.category)
    : resource.category === category);
export function orderLibraryResources(items, sort = "recent", currentYear = "", filterYear = "") {
  return orderResourcesByAcademicYear(items, sort, currentYear, filterYear);
}
export default function LibraryPage() {
  const { t, tr, language, user, selection, faculty, filiere, resources, updateResourceAcademicYears } = useApp();
  const currentAcademicYear = normalizeAcademicYear(user?.currentAcademicYear ?? user?.current_academic_year);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const handledResourceLink = useRef(null);
  const resultsHeading = useRef(null);
  const modulePicker = useRef(null);
  const pendingModuleScroll = useRef(false);
  // The URL is the single source of filter state, including native Back/Forward.
  const requestedSemester = semesterNumber(
    searchParams.get("semester") || selection?.semester || 1,
  );
  const semester = [1, 2, 3, 4, 5, 6].includes(requestedSemester)
    ? requestedSemester
    : 1;
  const module = searchParams.has("module") ? searchParams.get("module") : null;
  const requestedCategory = searchParams.get("category");
  const category = ["td", "tp"].includes(requestedCategory)
    ? "tdtp"
    : categories.includes(requestedCategory)
      ? requestedCategory
      : "all";
  const query = searchParams.get("q") || "";
  const [sort, setSort] = useState("recent");
  const author = searchParams.get("author") || "all";
  const part = searchParams.get("part") || "all";
  const date = searchParams.get("date") || "all";
  const requestedYear = searchParams.get("year");
  const year = requestedYear === "unknown" ? "unknown" : normalizeAcademicYear(requestedYear) || "all";
  const [showFilters, setShowFilters] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showModulePicker, setShowModulePicker] = useState(false);
  const [moduleQuery, setModuleQuery] = useState("");
  const [documentPage, setDocumentPage] = useState(0);
  const [yearEditor, setYearEditor] = useState(null);
  const [editedYears, setEditedYears] = useState([]);
  const [savingYears, setSavingYears] = useState(false);
  const [yearError, setYearError] = useState("");
  const semesterResources = useMemo(
    () =>
      resources.filter(
        (item) =>
          item.libraryVisible !== false &&
          semesterNumber(item.semester) === semester &&
          item.facultyId === selection?.facultyId &&
          item.filiereId === selection?.filiereId,
      ),
    [resources, semester, selection?.facultyId, selection?.filiereId],
  );
  const semesterFolders = useMemo(
    () => groupResourcesByModule(semesterResources),
    [semesterResources],
  );
  const matchingModuleFolders = useMemo(() => {
    const search = normalizeModule(moduleQuery);
    return semesterFolders.filter(
      (folder) =>
        folder.key.includes(search) ||
        normalizeModule(
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
    const frame = requestAnimationFrame(() =>
      modulePicker.current?.scrollIntoView({
        block: "nearest",
        behavior: "auto",
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [showModulePicker]);
  useEffect(() => {
    if (!pendingModuleScroll.current) return;
    const frame = requestAnimationFrame(() => {
      pendingModuleScroll.current = false;
      resultsHeading.current?.scrollIntoView({
        block: "start",
        behavior: "auto",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [module, showModulePicker]);
  const authors = useMemo(
    () =>
      [
        ...new Set(
          semesterResources.map((item) => item.author).filter(Boolean),
        ),
      ].sort(),
    [semesterResources],
  );
  const parts = useMemo(
    () =>
      [
        ...new Set(
          semesterResources
            .map((item) => normalizePart(item.part))
            .filter(Boolean),
        ),
      ].sort(compareParts),
    [semesterResources],
  );
  const availableYears = useMemo(() => [...new Set(semesterResources.flatMap(resourceAcademicYears))]
    .sort((a, b) => compareAcademicYears(a, b, currentAcademicYear)), [semesterResources, currentAcademicYear]);
  const filterCount = [author, part, date, year].filter(
    (value) => value !== "all",
  ).length;
  const filteredBase = useMemo(
    () =>
      semesterResources.filter((item) => {
        const haystack =
          `${item.title} ${item.originalName || ""} ${item.module} ${item.author || ""} ${item.uploader || ""} ${item.fileType || ""}`.toLocaleLowerCase();
        const age = Date.now() - new Date(item.date).getTime();
        return (
          (module === null ||
            normalizeModule(item.module) === normalizeModule(module)) &&
          (!query.trim() ||
            haystack.includes(query.trim().toLocaleLowerCase())) &&
          (author === "all" || item.author === author) &&
          (part === "all" || normalizePart(item.part) === part) &&
          (year === "all" || (year === "unknown" ? !resourceAcademicYears(item).length : resourceAcademicYears(item).includes(year))) &&
          (date === "all" || age <= Number(date) * 86400000)
        );
      }),
    [semesterResources, module, query, author, part, date, year],
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
  const folders = useMemo(() => groupResourcesByModule(visible), [visible]);
  const lastDocumentPage = Math.max(
    0,
    Math.ceil(visible.length / DOCUMENTS_PER_PAGE) - 1,
  );
  const pageNumber = Math.min(documentPage, lastDocumentPage);
  const pageStart = pageNumber * DOCUMENTS_PER_PAGE;
  const pageDocuments = visible.slice(
    pageStart,
    pageStart + DOCUMENTS_PER_PAGE,
  );
  const pageYearGroups = groupResourcesByAcademicYear(pageDocuments, currentAcademicYear, year);
  useEffect(
    () => setDocumentPage(0),
    [semester, module, category, query, sort, author, part, date, year],
  );
  useEffect(
    () => setDocumentPage((page) => Math.min(page, lastDocumentPage)),
    [lastDocumentPage],
  );
  useEffect(() => {
    const target = /^#resource-(.+)$/.exec(location.hash);
    const link = location.search + location.hash;
    if (!target) {
      handledResourceLink.current = null;
      return;
    }
    if (module === null || handledResourceLink.current === link) return;
    const index = visible.findIndex(
      (document) => String(document.id) === target[1],
    );
    if (index < 0) return;
    const targetPage = Math.floor(index / DOCUMENTS_PER_PAGE);
    if (pageNumber !== targetPage) {
      setDocumentPage(targetPage);
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
  }, [location.search, location.hash, module, visible, pageNumber]);
  const navigateLibrary = (patch, options = {}) => {
    const state = {
      semester,
      module,
      category,
      query,
      author,
      part,
      date,
      year,
      ...patch,
    };
    const params = new URLSearchParams(searchParams);
    params.set("semester", String(state.semester));
    if (state.module === null) params.delete("module");
    else params.set("module", state.module);
    for (const key of ["category", "author", "part", "date", "year"]) {
      if (state[key] === "all") params.delete(key);
      else params.set(key, state[key]);
    }
    if (state.query) params.set("q", state.query);
    else params.delete("q");
    setSearchParams(params, options);
  };
  const openModule = (name) => {
    pendingModuleScroll.current = true;
    setShowModulePicker(false);
    setModuleQuery("");
    navigateLibrary({ module: name });
  };
  const changeDocumentPage = (page) => {
    setDocumentPage(Math.max(0, Math.min(page, lastDocumentPage)));
    requestAnimationFrame(() =>
      resultsHeading.current?.scrollIntoView({
        block: "start",
        behavior: "auto",
      }),
    );
  };
  const clearFilters = () =>
    navigateLibrary({
      query: "",
      module: null,
      category: "all",
      author: "all",
      part: "all",
      date: "all",
      year: "all",
    });
  const changeSemester = (value) =>
    navigateLibrary({
      semester: value,
      module: null,
      author: "all",
      part: "all",
      date: "all",
      year: "all",
    });
  const folderLabel = (name) =>
    name || tr("Sans module", "Unclassified", "بدون وحدة");
  const categoryLabel = (key) => (key === "tdtp" ? "TD / TP" : t(key));
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
    ...categories.map((id) => ({
      id,
      label: categoryLabel(id),
      count: filteredBase.filter((item) => categoryMatches(item, id)).length,
    })),
  ];
  const resultsContext = (
    <div
      ref={resultsHeading}
      className={`library-results-heading ${module === null ? "is-overview" : "is-module"}`}
    >
      {module !== null && (
        <Button
          variant="ghost"
          icon={ArrowLeft}
          className="library-back-to-modules"
          onClick={() => openModule(null)}
        >
          {tr("Tous les modules", "All modules", "كل الوحدات")}
        </Button>
      )}
      <div className="library-results-context">
        <div
          className="library-results-body"
          style={{ width: "100%", minWidth: 0 }}
        >
          <div
            className="library-results-header"
            style={{ display: "flex", alignItems: "center", gap: "12px" }}
          >
            {module === null && (
              <span className="library-folder-symbol">
                <FolderOpen size={25} strokeWidth={1.6} />
              </span>
            )}
            <div className="library-results-title">
              <span className="library-section-label library-results-eyebrow">
                {module !== null && (
                  <FolderOpen size={17} strokeWidth={1.6} aria-hidden="true" />
                )}
                {module === null
                  ? tr(
                      "Dossiers du semestre",
                      "Semester folders",
                      "مجلدات الفصل الدراسي",
                    )
                  : tr(
                      "Vous êtes dans le module",
                      "You are in this module",
                      "أنت في هذه الوحدة",
                    )}
              </span>
              <h2 dir="auto">
                {module === null
                  ? tr("Modules", "Modules", "الوحدات")
                  : folderLabel(moduleDisplayName(module))}
              </h2>
              <span className="library-results-count muted">
                {visible.length}{" "}
                {tr(
                  visible.length === 1 ? "document" : "documents",
                  visible.length === 1 ? "document" : "documents",
                  "وثيقة",
                )}{" "}
                · S{semester}
              </span>
            </div>
          </div>
          {module === null && visible.length > 0 && (
            <div className="library-results-cards">
              <div className="library-document-grid library-module-grid">
                {folders.map((folder) => (
                  <button
                    type="button"
                    key={folder.key}
                    className="card library-module-folder"
                    aria-label={
                      tr("Ouvrir le module", "Open module", "فتح الوحدة") +
                      " " +
                      folderLabel(folder.name)
                    }
                    onClick={() => openModule(folder.key)}
                  >
                    <span className="library-folder-symbol">
                      <Folder size={23} strokeWidth={1.5} />
                    </span>
                    <span className="library-folder-copy">
                      <strong className="library-module-name" dir="auto">
                        {folderLabel(folder.name)}
                      </strong>
                      <span className="library-module-count muted">
                        {folder.documents.length}{" "}
                        {tr(
                          folder.documents.length === 1
                            ? "document"
                            : "documents",
                          folder.documents.length === 1
                            ? "document"
                            : "documents",
                          "وثيقة",
                        )}{" "}
                        · S{semester}
                      </span>
                    </span>
                    <ArrowRight size={16} className="library-folder-arrow" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
  return (
    <div className="library-page page-enter">
      <PageHeader
        eyebrow={`${faculty?.code || faculty?.name || ""} · ${filiere?.name || ""}`}
        title={t("library")}
        description={tr(
          "Vos cours et documents, au bon endroit.",
          "Your courses and documents, all in one place.",
          "دروسك ووثائقك، في مكان واحد.",
        )}
        actions={
          <Button
            variant="primary"
            icon={Upload}
            onClick={() => setShowUpload(true)}
          >
            {tr("Partager un document", "Share a document", "مشاركة وثيقة")}
          </Button>
        }
      />
      <details className="card library-pdf-search"><summary>{tr('Rechercher dans le texte des PDF','Search inside PDF text','البحث في نص ملفات PDF')}</summary><DocumentTextSearch/></details>
      <section
        className="library-navigation card"
        aria-label={tr(
          "Navigation académique",
          "Academic navigation",
          "التنقل الأكاديمي",
        )}
      >
        <div className="library-navigation-heading">
          <div>
            <span className="library-step">01</span>
            <span>
              {tr(
                "Choisissez un semestre",
                "Choose a semester",
                "اختر الفصل الدراسي",
              )}
            </span>
          </div>
          <span className="muted library-context">
            {tr(
              "Licence · 3 années",
              "Bachelor · 3 years",
              "الإجازة · 3 سنوات",
            )}
          </span>
        </div>
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
        <div className="library-module-heading">
          <span className="library-step">02</span>
          <span>
            {tr("Choisissez un module", "Choose a module", "اختر الوحدة")}
          </span>
          <span className="muted">
            {semesterFolders.length}{" "}
            {tr(
              semesterFolders.length === 1 ? "module" : "modules",
              semesterFolders.length === 1 ? "module" : "modules",
              "وحدات",
            )}
          </span>
        </div>
        <button
          type="button"
          className={`library-module-trigger ${showModulePicker ? "is-open" : ""}`}
          aria-label={
            module === null
              ? tr("Choisir un module", "Choose a module", "اختر الوحدة")
              : tr("Changer de module", "Change module", "تغيير الوحدة")
          }
          aria-expanded={showModulePicker}
          aria-controls="library-module-picker"
          onClick={() => setShowModulePicker((value) => !value)}
        >
          <span className="library-folder-symbol">
            <FolderOpen size={22} strokeWidth={1.6} />
          </span>
          <span className="library-module-trigger-copy">
            <span>
              {module === null
                ? tr(
                    "Parcourir les dossiers",
                    "Browse module folders",
                    "تصفح مجلدات الوحدات",
                  )
                : tr("Module ouvert", "Current module", "الوحدة المفتوحة")}
            </span>
            <strong dir="auto">
              {module === null
                ? tr("Tous les modules", "All modules", "كل الوحدات")
                : folderLabel(moduleDisplayName(module))}
            </strong>
            <span className="library-module-trigger-action">
              {module === null
                ? tr("Choisir un module", "Choose a module", "اختر الوحدة")
                : tr("Changer de module", "Change module", "تغيير الوحدة")}
            </span>
          </span>
          <ChevronDown
            size={19}
            className="library-module-trigger-chevron"
            aria-hidden="true"
          />
        </button>
        {showModulePicker && (
          <div
            ref={modulePicker}
            className="library-module-picker"
            id="library-module-picker"
          >
            <label className="library-search library-module-search">
              <Search size={17} aria-hidden="true" />
              <input
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
            <div className="library-modules" aria-label={t("module")}>
              <button
                type="button"
                className={`module-choice ${module === null ? "selected" : ""}`}
                aria-pressed={module === null}
                onClick={() => openModule(null)}
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
              </button>
              {matchingModuleFolders.map((folder) => (
                <button
                  type="button"
                  className={`module-choice ${module !== null && normalizeModule(module) === folder.key ? "selected" : ""}`}
                  key={folder.key}
                  aria-pressed={
                    module !== null && normalizeModule(module) === folder.key
                  }
                  onClick={() => openModule(folder.key)}
                >
                  <Folder size={17} aria-hidden="true" />
                  <span dir="auto">{folderLabel(folder.name)}</span>
                  <span
                    className="library-module-choice-count"
                    aria-hidden="true"
                  >
                    {folder.documents.length}
                  </span>
                  {module !== null &&
                    normalizeModule(module) === folder.key && (
                      <Check size={16} aria-hidden="true" />
                    )}
                </button>
              ))}
              {moduleQuery && !matchingModuleFolders.length && (
                <p className="library-module-empty muted">
                  {tr(
                    "Aucun module trouvé.",
                    "No matching modules.",
                    "لا توجد وحدات مطابقة.",
                  )}
                </p>
              )}
            </div>
          </div>
        )}
        {!semesterFolders.length && (
          <p className="library-no-modules muted">
            {tr(
              "Les modules apparaissent quand un document est ajouté à ce semestre.",
              "Modules appear when a document is added to this semester.",
              "تظهر الوحدات عند إضافة وثيقة إلى هذا الفصل.",
            )}
          </p>
        )}
      </section>
      {module !== null && resultsContext}
      <div className="library-academic-year-control">
        <Field label={tr("Année universitaire d’utilisation", "Academic year of use", "السنة الجامعية للاستخدام")}>
          <Select className="input" value={year} onChange={(event) => navigateLibrary({ year: event.target.value })}>
            <option value="all">{tr("Toutes les années", "All academic years", "كل السنوات الجامعية")}</option>
            {availableYears.map(value => <option key={value} value={value}>{value}{value === currentAcademicYear ? ` · ${tr("année actuelle", "current year", "السنة الحالية")}` : ""}</option>)}
            <option value="unknown">{tr("Année inconnue", "Unknown year", "سنة غير معروفة")}</option>
          </Select>
        </Field>
        <p className="muted">{tr(
          "L’année actuelle apparaît d’abord, puis les années précédentes. Les documents sans année restent à la fin.",
          "Current-year material comes first, followed by previous years. Documents with an unknown year appear last.",
          "تظهر وثائق السنة الحالية أولاً ثم السنوات السابقة. وتظهر الوثائق ذات السنة غير المعروفة أخيراً.",
        )}</p>
      </div>
      <div className="library-category-tabs">
        <span className="library-section-label">
          {tr("Type de document", "Document type", "نوع الوثيقة")}
        </span>
        <Tabs
          items={tabs}
          value={category}
          onChange={(value) => navigateLibrary({ category: value })}
        />
      </div>
      <div className="library-toolbar">
        <label className="library-search">
          <Search size={18} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) =>
              navigateLibrary({ query: event.target.value }, { replace: true })
            }
            placeholder={tr(
              "Rechercher un titre, un module…",
              "Search a title, a module…",
              "ابحث عن عنوان أو وحدة…",
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
          >
            {t("filters")}
            {filterCount > 0 && (
              <span className="filter-counter">{filterCount}</span>
            )}
          </Button>
          <label className="library-sort">
            <ArrowDownUp size={16} />
            <span className="sr-only">{t("sort")}</span>
            <Select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
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
                  "Ordre des Parts/Chapitres",
                  "Part/Chapitre order",
                  "ترتيب الأجزاء/الفصول",
                )}
              </option>
            </Select>
            <ChevronDown size={14} />
          </label>
        </div>
      </div>
      {showFilters && (
        <div className="library-filter-panel card" id="library-filters">
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
          </div>
          <Button variant="ghost" icon={X} onClick={clearFilters}>
            {tr(
              "Réinitialiser les filtres",
              "Reset filters",
              "إعادة ضبط المرشحات",
            )}
          </Button>
        </div>
      )}
      {module === null && resultsContext}
      {visible.length > 0 ? (
        module === null ? null : (
          <>
            <div className="library-year-groups">
              {pageYearGroups.map(group => (
                <section className="library-year-group" key={group.year || "unknown"} aria-label={group.year || tr("Année inconnue", "Unknown year", "سنة غير معروفة")}>
                  <div className="library-year-heading">
                    <h3>{group.year || tr("Année inconnue", "Unknown year", "سنة غير معروفة")}</h3>
                    {group.year && group.year === currentAcademicYear && <span className="library-current-year">{tr("Année actuelle", "Current year", "السنة الحالية")}</span>}
                  </div>
                  <div className="library-document-grid">
                    {group.documents.map(document => (
                      <div className="library-year-document" key={document.id}>
                        <DocumentCard document={document} />
                        <div className="library-document-year-meta">
                          {resourceAcademicYears(document).length > 1 && <span className="muted">{tr("Utilisé en", "Used in", "استُخدم في")} {resourceAcademicYears(document).join(" · ")}</span>}
                          {updateResourceAcademicYears && (document.can_manage_academic_years === true || document.canManageAcademicYears === true || String(document.author_id) === String(user?.id)) && (
                            <button className="library-edit-year" type="button" onClick={() => openYearEditor(document)} aria-label={tr(`Corriger l’année de ${document.originalName || document.title}`, `Correct the year for ${document.originalName || document.title}`, `تصحيح سنة ${document.originalName || document.title}`)}>
                              <Pencil size={12} aria-hidden="true" />{tr("Corriger l’année", "Correct year", "تصحيح السنة")}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            {visible.length > DOCUMENTS_PER_PAGE && (
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
                  {Math.min(pageStart + DOCUMENTS_PER_PAGE, visible.length)}{" "}
                  {tr("sur", "of", "من")} {visible.length}
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
          title={tr(
            "Aucun document ici pour le moment",
            "No documents here yet",
            "لا توجد وثائق هنا بعد",
          )}
          description={
            query || filterCount || module !== null || category !== "all"
              ? tr(
                  "Essayez un autre module ou ajustez vos filtres.",
                  "Try another module or adjust your filters.",
                  "جرّب وحدة أخرى أو عدّل المرشحات.",
                )
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
                query || filterCount || module !== null || category !== "all"
                  ? clearFilters
                  : () => setShowUpload(true)
              }
            >
              {query || filterCount || module !== null || category !== "all"
                ? tr("Effacer les filtres", "Clear filters", "مسح المرشحات")
                : tr(
                    "Partager un document",
                    "Share a document",
                    "مشاركة وثيقة",
                  )}
            </Button>
          }
        />
      )}
      <p className="library-demo-note muted">
        {tr(
          "Les documents partagés sont conservés dans votre bibliothèque de campus.",
          "Shared documents are saved in your campus library.",
          "تُحفظ الوثائق المشتركة في مكتبة حرمك الجامعي.",
        )}
      </p>
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
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
