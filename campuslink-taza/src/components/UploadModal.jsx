import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Plus,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useApp } from "../context";
import { api } from "../api.js";
import { getFiliere } from "../data/studies";
import { FACULTIES } from "../data/mock";
import {
  SUPPORTED_FILE_ACCEPT,
  fileTypeLabel,
  sizeLabel,
  filesFromDrop,
  fileKey,
  uploadFileIssue,
  MAX_UPLOAD_BATCH_FILES,
} from "../lib/files";
import {
  moduleSuggestions,
  moduleDisplayName,
  normalizePart,
  partLabel,
  findResourceConflicts,
  normalizeAcademicYear,
  academicYearOptions,
  resourceAcademicYears,
  uploadScopesForUser,
} from "../lib/resources";
import { Button, Field, Modal } from "./ui";
import { Select, Autocomplete } from "./Select";
import PartSelect from "./PartSelect";
import "../pages/library.css";
import "./upload-progress.css";

const categoryKeys = [
  "courses",
  "exercises",
  "td",
  "tp",
  "corrections",
  "exams",
  "rattrapage",
];
const semesterNumber = (value) =>
  Number(String(value ?? "").replace(/^s/i, ""));
export { collectDirectoryEntry } from "../lib/files";

function SuggestedField({
  label,
  value,
  onChange,
  options,
  required = false,
  hint,
  showOnEmpty = false,
  disabled = false,
}) {
  return (
    <Field label={label} hint={hint}>
      <Autocomplete
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        options={options}
        showOnEmpty={showOnEmpty}
        required={required}
        disabled={disabled}
      />
    </Field>
  );
}

export default function UploadModal({
  onClose,
  mode = "library",
  initialEntries = [],
  existingAttachments = [],
  onConfirm,
  supplementFor = null,
  supplementLimit = 20,
  onComplete,
}) {
  const {
    t,
    tr,
    language,
    user,
    selection: accountSelection,
    faculty: accountFaculty,
    resources,
    allResources,
    uploadResource,
    closeDialog,
  } = useApp();
  const isSupplement = !!supplementFor;
  const maximumFiles = isSupplement ? Math.max(1,Math.min(20,Number(supplementLimit)||20)) : MAX_UPLOAD_BATCH_FILES;
  const supplementCategory = ['td','tp'].includes(supplementFor?.resource_type) ? supplementFor.resource_type : ['correction','corrections'].includes(supplementFor?.resource_type) ? 'corrections' : supplementFor?.category;
  const supplementPart = normalizePart(supplementFor?.part ?? supplementFor?.part_number);
  const uploadScopes = uploadScopesForUser(user);
  const [program, setProgram] = useState(() => supplementFor?.filiereId || supplementFor?.filiere_id || uploadScopes.find(scope => scope.filiereId === accountSelection?.filiereId)?.filiereId || uploadScopes[0]?.filiereId || "");
  const authorizedScope = uploadScopes.find(scope => scope.filiereId === program);
  const allowedSemesters = authorizedScope?.semesters || [];
  const selection = { ...accountSelection, facultyId: authorizedScope?.facultyId, filiereId: authorizedScope?.filiereId };
  const faculty = FACULTIES.find(item => item.id === selection.facultyId) || accountFaculty;
  const canChooseProgram = !isSupplement && uploadScopes.length > 1;
  const filiere = getFiliere(selection.filiereId);
  const isChat = mode === "chat";
  const accountSemester = semesterNumber(supplementFor?.semester ?? accountSelection?.semester);
  const initialSemester = allowedSemesters.includes(accountSemester) ? accountSemester : allowedSemesters[0] || accountSemester || 1;
  const currentAcademicYear = normalizeAcademicYear(user?.currentAcademicYear ?? user?.current_academic_year);
  const initialAcademicYear = isSupplement ? normalizeAcademicYear(supplementFor.academicYear ?? supplementFor.academic_year) : currentAcademicYear;
  const yearOptions = academicYearOptions(currentAcademicYear, (allResources || []).flatMap(resourceAcademicYears));
  const modulesFor = (semester, query = "") =>
    moduleSuggestions(resources, { ...selection, semester }, query);
  const initialFiles = () =>
    initialEntries
      .filter((item) => !uploadFileIssue(item.file, item.path))
      .slice(0, maximumFiles)
      .map(({ file, path }) => ({
        file,
        path: path || file.name,
        key: fileKey(file, path),
        meta: {
          semester: initialSemester,
          module: supplementFor?.module || "",
          category: supplementCategory || "courses",
          author: "",
          academicYear: initialAcademicYear,
          part: isSupplement ? supplementPart : "",
          title: file.name.replace(/\.[^.]+$/, ""),
        },
      }));
  const [step, setStep] = useState(isChat && initialEntries.length ? 1 : 0);
  const [files, setFiles] = useState(initialFiles);
  const [batch, setBatch] = useState({
    semester: initialSemester,
    module: supplementFor?.module || "",
    category: supplementCategory || "courses",
    author: "",
    academicYear: initialAcademicYear,
    part: isSupplement ? supplementPart : "",
  });
  const [editing, setEditing] = useState(
    isChat && initialEntries.length
      ? fileKey(initialEntries[0].file, initialEntries[0].path)
      : null,
  );
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [currentUpload, setCurrentUpload] = useState(null);
  const uploaded = useRef(new Set());
  const supplementRequest = useRef(null);
  const [error, setError] = useState("");
  const [batchApplied, setBatchApplied] = useState(false);
  const fileInput = useRef(null);
  const directoryInput = useRef(null);
  const workflow = useRef(null);
  const closed = useRef(false);
  const dragDepth = useRef(0);
  const directorySupported =
    typeof document !== "undefined" &&
    "webkitdirectory" in document.createElement("input");
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      supplementRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    const body = workflow.current?.closest(".modal-body");
    if (body) body.scrollTop = 0;
  }, [step]);
  const close = () => {
    if (uploading) return;
    closed.current = true;
    (onClose || closeDialog)();
  };
  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  // The shared form is the single source of classification for pending files.
  // Keep each original/custom single-file title in state so removing files from
  // a batch restores it. Completed uploads keep the metadata actually sent.
  const classifiedFiles = files.map((item) =>
    uploaded.current.has(item.key)
      ? item
      : {
          ...item,
          meta: {
            ...item.meta,
            semester: batch.semester,
            module: batch.module,
            category: batch.category,
            author: batch.author,
            academicYear: batch.academicYear,
            ...(isSupplement ? {part: supplementPart} : {}),
            title: !isSupplement && files.length > 1 ? moduleDisplayName(batch.module) : item.meta.title,
          },
        },
  );
  const folderCount = new Set(
    files
      .map((item) => item.path.split("/").slice(0, -1).join("/"))
      .filter(Boolean),
  ).size;
  const steps = [
    tr("Documents", "Documents", "الوثائق"),
    tr("Classement", "Classification", "التصنيف"),
    tr("Confirmation", "Review", "التأكيد"),
  ];

  const addFiles = (selected) => {
    if (closed.current) return;
    const valid = selected.filter((item) => !uploadFileIssue(item.file, item.path)).slice(0, Math.max(0, maximumFiles - files.length));
    const skipped = selected.length - valid.length;
    setFiles((current) => {
      const existing = new Set(current.map((item) => item.key));
      const additions = valid
        .map(({ file, path }) => ({
          file,
          path: path || file.name,
          key: fileKey(file, path),
          meta: {
            ...batch,
            part: isSupplement ? supplementPart : "",
            title: file.name.replace(/\.[^.]+$/, ""),
          },
        }))
        .filter((item) => {
          if (existing.has(item.key)) return false;
          existing.add(item.key);
          return true;
        });
      return [...current, ...additions].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
    });
    setError(
      skipped
        ? tr(
            `${skipped} fichier(s) ignoré(s) : format, chemin ou taille invalide (20 Mo par fichier, ${maximumFiles.toLocaleString("fr-FR")} fichiers maximum).`,
            `${skipped} file(s) skipped: unsupported format, invalid path or size limit (20 MB per file, up to ${maximumFiles.toLocaleString("en-US")} files).`,
            `تم تجاهل ${skipped} ملف: صيغة أو مسار غير صالح أو تجاوز الحد (20 ميغابايت للملف، ${maximumFiles} ملف كحد أقصى).`,
          )
        : "",
    );
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    setReading(true);
    try {
      const selected = await filesFromDrop(event.dataTransfer);
      addFiles(selected);
    } catch {
      setError(
        tr(
          "Ce dossier ne peut pas être lu. Essayez le bouton « Choisir un dossier ».",
          "This folder could not be read. Try the “Choose folder” button.",
          "تعذرت قراءة المجلد. جرّب زر «اختيار مجلد».",
        ),
      );
    } finally {
      if (!closed.current) setReading(false);
    }
  };
  const pickFiles = (event) => {
    addFiles(
      Array.from(event.target.files || []).map((file) => ({
        file,
        path: file.webkitRelativePath || file.name,
      })),
    );
    event.target.value = "";
  };
  const updateFile = (key, field, value) => {
    if (uploaded.current.has(key)) return;
    setFiles((current) =>
      current.map((item) =>
        item.key !== key
          ? item
          : { ...item, meta: { ...item.meta, [field]: value } },
      ),
    );
    setError("");
  };
  const changeBatch = (field, value) => {
    if (isSupplement) return;
    setBatch((current) => ({ ...current, [field]: value }));
    setBatchApplied(false);
    setError("");
  };
  const applyBatch = () => {
    setError("");
    setBatchApplied(true);
  };
  const candidates = classifiedFiles.map((item) => ({
    ...item.meta,
    facultyId: selection?.facultyId,
    filiereId: selection?.filiereId,
    originalName: item.file.name,
  }));
  const conflicts = (isSupplement ? [] : findResourceConflicts(
    candidates,
    isChat ? existingAttachments : allResources,
  )).filter((item) => !uploaded.current.has(files[item.index]?.key));
  const conflictByIndex = new Map(conflicts.map((item) => [item.index, item]));
  const validate = () => {
    if (!authorizedScope || !allowedSemesters.includes(Number(batch.semester))) {
      setError(tr(
        "Ce classement dépasse vos autorisations d’envoi actuelles. Choisissez une filière et un semestre autorisés.",
        "This classification exceeds your current upload permissions. Choose an authorized program and semester.",
        "هذا التصنيف يتجاوز صلاحيات الرفع الحالية. اختر مسلكاً وفصلاً مسموحاً بهما.",
      ));
      return false;
    }
    const invalid = classifiedFiles.find(
      (item) =>
        !uploaded.current.has(item.key) && (
        !item.meta.title.trim() ||
        !item.meta.module.trim() ||
        !allowedSemesters.includes(Number(item.meta.semester)) ||
        (item.meta.academicYear && !normalizeAcademicYear(item.meta.academicYear)) ||
        uploadFileIssue(item.file, item.path) ||
        !categoryKeys.includes(item.meta.category) ||
        !normalizePart(item.meta.part)),
    );
    if (
      !selection?.facultyId ||
      !selection?.filiereId ||
      !files.length ||
      invalid
    ) {
      setError(
        tr(
          "Renseignez le classement commun, puis choisissez Complet ou un Part/Chapitre de 1 à 20 pour chaque fichier.",
          "Complete the shared classification and enter a positive Part/Chapitre or Complete for each file.",
          "أكمل التصنيف المشترك ثم أدخل جزءاً/فصلاً موجباً أو Complet لكل ملف.",
        ),
      );
      if (invalid) setEditing(invalid.key);
      return false;
    }
    if (conflicts.length) {
      const first = conflicts[0];
      setError(
        tr(
          `Conflit : ${first.resource.originalName} utilise le même ${partLabel(first.resource.part)} que ${first.conflict.originalName || first.conflict.title} dans ce module, semestre, catégorie et année universitaire.`,
          `Conflict: ${first.resource.originalName} shares ${partLabel(first.resource.part, "en")} with ${first.conflict.originalName || first.conflict.title} in this module, semester, category and academic year.`,
          `تعارض: ${first.resource.originalName} و${first.conflict.originalName || first.conflict.title} يستخدمان نفس ${partLabel(first.resource.part, "ar")} داخل نفس الوحدة والفصل والفئة والسنة الجامعية.`,
        ),
      );
      setEditing(files[first.index].key);
      return false;
    }
    setError("");
    return true;
  };
  const review = () => {
    if (validate()) setStep(2);
  };
  const confirmSharing = async () => {
    if (closed.current || uploading) return;
    if (!validate()) {
      setStep(1);
      return;
    }
    const now = new Date().toISOString();
    if (isChat) {
      onConfirm?.(
        classifiedFiles.map((item) => ({
          file: item.file,
          path: item.path,
          meta: {
            title: item.meta.title.trim(),
            semester: Number(item.meta.semester),
            module: item.meta.module.trim().replace(/\s+/g, " "),
            category: item.meta.category,
            part: normalizePart(item.meta.part),
            author: item.meta.author.trim(),
            academicYear: normalizeAcademicYear(item.meta.academicYear) || null,
            facultyId: selection.facultyId,
            filiereId: selection.filiereId,
            facultyName: faculty?.name || selection.facultyId,
            filiereName: filiere?.name || selection.filiereId,
            uploader: user?.displayName || user?.name || user?.username,
            date: now,
          },
        })),
      );
      close();
      return;
    }
    setUploading(true);
    setError("");
    setStep(3);
    try {
      // Send one file at a time to keep memory use bounded on phones. Retain
      // completed entries so retrying a partially failed folder sends only
      // the files that still need to be uploaded.
      for (const item of classifiedFiles) {
        if (closed.current) return;
        if (uploaded.current.has(item.key)) continue;
        setCurrentUpload(item);
        if (isSupplement) {
          const form = new FormData(); form.set('file',item.file); form.set('relative_path',item.path); form.set('title',item.meta.title.trim()); form.set('main_version',String(supplementFor.version || 1));
          const controller=new AbortController();supplementRequest.current=controller;
          await api('/resource-supplements/'+supplementFor.id+'/upload',{method:'POST',body:form,timeout:600000,signal:controller.signal});
        } else await uploadResource({
          file: item.file,
          path: item.path,
          meta: {
            title: item.meta.title.trim(),
            semester: Number(item.meta.semester),
            module: item.meta.module.trim().replace(/\s+/g, " "),
            category: item.meta.category,
            part: normalizePart(item.meta.part),
            author: item.meta.author.trim(),
            academicYear: normalizeAcademicYear(item.meta.academicYear) || null,
            facultyId: selection.facultyId,
            filiereId: selection.filiereId,
          },
        });
        if (closed.current) return;
        uploaded.current.add(item.key);
        setFiles((current) => current.map((file) =>
          file.key === item.key ? { ...file, meta: { ...item.meta } } : file,
        ));
        setUploadedCount(uploaded.current.size);
      }
      setStep(4);
      if (isSupplement) { window.dispatchEvent(new CustomEvent('campus-supplements-changed',{detail:{mainResourceId:String(supplementFor.id)}})); onComplete?.(); }
    } catch (error) {
      setError(error.message || tr("L’envoi a échoué. Réessayez.", "Upload failed. Try again.", "تعذر الرفع. حاول مجدداً."));
      setStep(2);
    } finally {
      setUploading(false);
      setCurrentUpload(null);
    }
  };

  const metadataFields = (meta, change, individual = false, disabled = false) => (
    individual ? (
      <Field label={tr("Part/Chapitre *", "Part/Chapter *", "جزء/فصل *")} hint={tr(
        isSupplement ? "Tous les compléments conservent la partie du document principal." : "Choisissez Complet ou une partie de 1 à 20. Un seul fichier par emplacement.",
        isSupplement ? "All supplements retain the main document’s part." : "Choose Complete or a part from 1 to 20. One file per slot.",
        isSupplement ? "تحتفظ جميع الملفات المكمّلة بجزء المستند الرئيسي." : "اختر كامل أو جزءاً من 1 إلى 20. ملف واحد لكل جزء.",
      )}>
        <PartSelect className="input" value={meta.part} onChange={event => change("part", event.target.value)} required disabled={disabled || isSupplement} />
      </Field>
    ) : (
      <div className="upload-metadata-grid">
        <Field label={`${t("semester")} *`}>
          <Select
            className="input"
            disabled={disabled || isSupplement}
            value={meta.semester}
            onChange={(event) => change("semester", Number(event.target.value))}
          >
            {allowedSemesters.map((value) => (
              <option value={value} key={value}>
                S{value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={tr("Année universitaire", "Academic year", "السنة الجامعية")} hint={tr(
          "Année d’utilisation du document, distincte de sa date d’envoi. Laissez inconnue si nécessaire.",
          "The year the material was used, separate from its upload date. Choose unknown when unsure.",
          "سنة استخدام الوثيقة وليست تاريخ رفعها. اختر غير معروفة عند عدم التأكد.",
        )}>
          <Select className="input" disabled={disabled || isSupplement} value={meta.academicYear} onChange={(event) => change("academicYear", event.target.value)}>
            <option value="">{tr("Année inconnue", "Unknown year", "سنة غير معروفة")}</option>
            {yearOptions.map(year => <option key={year} value={year}>{year}{year === currentAcademicYear ? ` · ${tr("année actuelle", "current year", "السنة الحالية")}` : ""}</option>)}
          </Select>
        </Field>
        <SuggestedField
          label={`${t("module")} *`}
          value={meta.module}
          onChange={(value) => change("module", value)}
          options={modulesFor(meta.semester, meta.module)}
          required
          disabled={disabled || isSupplement}
          hint={tr(
            "Tapez un nom librement ou choisissez une suggestion issue des fichiers existants.",
            "Type any name or choose a suggestion from existing files.",
            "اكتب أي اسم أو اختر اقتراحاً من الملفات الموجودة.",
          )}
        />
        <Field label={tr("Catégorie *", "Category *", "الفئة *")}>
          <Select
            className="input"
            disabled={disabled || isSupplement}
            value={meta.category}
            onChange={(event) => change("category", event.target.value)}
          >
            {categoryKeys.map((key) => (
              <option key={key} value={key}>
                {t(key)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={tr(
            "Professeur / auteur",
            "Professor / author",
            "الأستاذ / المؤلف",
          )}
        >
          <input
            className="input"
            value={meta.author}
            disabled={disabled || isSupplement}
            onChange={(event) => change("author", event.target.value)}
            placeholder={tr("Facultatif", "Optional", "اختياري")}
            maxLength={100}
          />
        </Field>
      </div>
    )
  );

  const classificationCopy = (meta) => (
    <span className="upload-file-classification">
      <span className="upload-classification-module">
        <bdi>
          {meta.module ||
            tr("Module à renseigner", "Module required", "الوحدة مطلوبة")}
        </bdi>
        <span>S{meta.semester}</span>
      </span>
      <span className="upload-classification-labels">
        <span>{t(meta.category)}</span>
        <span>{meta.academicYear || tr("Année inconnue", "Unknown year", "سنة غير معروفة")}</span>
        <bdi>
          {normalizePart(meta.part)
            ? partLabel(meta.part, language)
            : tr(
                "Part/Chapitre à choisir",
                "Choose Part/Chapitre",
                "اختر الجزء/الفصل",
              )}
        </bdi>
      </span>
      <bdi className="upload-classification-program">{filiere?.name}</bdi>
    </span>
  );

  const fileList = (individual) => (
    <div
      className="upload-file-list"
      aria-label={tr(
        "Documents sélectionnés",
        "Selected documents",
        "الوثائق المختارة",
      )}
    >
      {classifiedFiles.map((item, index) => {
        const pathParts = item.path.split("/");
        const depth = Math.min(4, pathParts.length - 1);
        return (
          <div
            className={`upload-file ${editing === item.key ? "expanded" : ""} ${individual && conflictByIndex.has(index) ? "has-conflict" : ""}`}
            key={item.key}
          >
            <div
              className="upload-file-row"
              style={{ "--folder-depth": depth }}
            >
              <div className="upload-file-symbol">
                <FileText size={19} />
              </div>
              <div className="upload-file-info">
                <strong dir="auto">{item.file.name}</strong>
                {pathParts.length > 1 && (
                  <span className="upload-file-path" dir="auto">
                    <Folder size={12} />
                    {pathParts.slice(0, -1).join(" / ")}
                  </span>
                )}
                <span className="muted">
                  {fileTypeLabel(item.file)} · {sizeLabel(item.file.size)}
                </span>
                {individual && (
                  <>
                    {classificationCopy(item.meta)}
                    {item.meta.author && (
                      <span className="muted" dir="auto">
                        {item.meta.author}
                      </span>
                    )}
                    {conflictByIndex.has(index) && (
                      <span className="upload-file-conflict" role="status">
                        {tr("Conflit avec", "Conflict with", "تعارض مع")}{" "}
                        {conflictByIndex.get(index).conflict.originalName ||
                          conflictByIndex.get(index).conflict.title}
                      </span>
                    )}
                  </>
                )}
              </div>
              {individual && (
                <button
                  type="button"
                  className="upload-icon-button"
                  onClick={() =>
                    setEditing(editing === item.key ? null : item.key)
                  }
                  aria-expanded={editing === item.key}
                  aria-label={tr(
                    `Modifier ${item.file.name}`,
                    `Edit ${item.file.name}`,
                    `تعديل ${item.file.name}`,
                  )}
                >
                  {editing === item.key ? (
                    <ChevronUp size={18} />
                  ) : (
                    <ChevronDown size={18} />
                  )}
                </button>
              )}
              <button
                type="button"
                className="upload-icon-button"
                aria-label={tr(
                  `Retirer ${item.file.name}`,
                  `Remove ${item.file.name}`,
                  `إزالة ${item.file.name}`,
                )}
                disabled={uploaded.current.has(item.key)}
                onClick={() => {
                  setFiles((current) =>
                    current.filter((file) => file.key !== item.key),
                  );
                  setError("");
                }}
              >
                <Trash2 size={17} />
              </button>
            </div>
            {individual && editing === item.key && (
              <div className="upload-file-editor">
                {metadataFields(
                  item.meta,
                  (field, value) => updateFile(item.key, field, value),
                  true,
                  uploaded.current.has(item.key),
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const footer = (
    <div className={`upload-footer${step === 3 ? " upload-footer-pending" : ""}`}>
      <span className="muted">
        {step === 3
          ? tr(
              "Gardez cette fenêtre ouverte pendant l’envoi.",
              "Keep this window open while your files upload.",
              "اترك هذه النافذة مفتوحة أثناء رفع الملفات.",
            )
          : tr(
              "Partage sécurisé dans votre faculté",
              "Secure sharing within your faculty",
              "مشاركة آمنة داخل كليتك",
            )}
      </span>
      {step !== 3 && <div>
        {step < 3 && (
          <Button variant="ghost" onClick={close}>
            {t("cancel")}
          </Button>
        )}
        {step === 0 && (
          <Button
            variant="primary"
            disabled={!files.length || reading}
            onClick={() => {
              setStep(1);
              setError("");
            }}
          >
            {tr("Classer les documents", "Classify documents", "تصنيف الوثائق")}{" "}
            {language === "ar" ? "←" : "→"}
          </Button>
        )}
        {step === 1 && (
          <>
            <Button
              variant="secondary"
              icon={language === "ar" ? ArrowRight : ArrowLeft}
              onClick={() => {
                setStep(0);
                setError("");
              }}
            >
              {tr("Retour", "Back", "رجوع")}
            </Button>
            <Button variant="primary" disabled={!files.length} onClick={review}>
              {tr("Vérifier", "Review", "مراجعة")}{" "}
              {language === "ar" ? "←" : "→"}
            </Button>
          </>
        )}
        {step === 2 && (
          <>
            <Button
              variant="secondary"
              icon={language === "ar" ? ArrowRight : ArrowLeft}
              onClick={() => setStep(1)}
            >
              {tr("Modifier", "Edit", "تعديل")}
            </Button>
            <Button variant="primary" icon={Check} disabled={uploading} onClick={confirmSharing}>
              {isChat
                ? tr(
                    "Joindre au message",
                    "Attach to message",
                    "إرفاق بالرسالة",
                  )
                : tr(
                    "Confirmer le partage",
                    "Confirm sharing",
                    "تأكيد المشاركة",
                  )}
            </Button>
          </>
        )}
        {step === 4 && (
          <Button variant="primary" onClick={close}>
            {tr("Terminer", "Done", "إنهاء")}
          </Button>
        )}
      </div>}
    </div>
  );

  return (
    <Modal
      title={
        isChat
          ? tr(
              "Classer les fichiers du message",
              "Classify message files",
              "تصنيف ملفات الرسالة",
            )
          : isSupplement ? tr("Ajouter des compléments", "Add supplemental files", "إضافة ملفات مكمّلة") : tr("Partager des documents", "Share documents", "مشاركة الوثائق")
      }
      onClose={close}
      wide
      className={`upload-modal${step >= 3 ? " upload-modal-status" : ""}${uploading ? " is-uploading" : ""}`}
      footer={footer}
    >
      <div className="upload-workflow" ref={workflow}>
        {isSupplement && <p className="notice">{tr('Compléments de','Supplements for','ملفات مكمّلة لـ')} <strong dir="auto">{supplementFor.title}</strong> · {partLabel(supplementPart,language)}. {tr('Le classement et la partie du document principal sont conservés. Ces fichiers apparaissent dans ses compléments.','The main document’s classification and part are preserved. These files appear in its supplements.','يُحفظ تصنيف المستند الرئيسي وجزؤه. تظهر هذه الملفات ضمن مكمّلاته.')}</p>}
        {step < 3 && (
          <ol className="upload-steps">
            {steps.map((label, index) => (
              <li
                key={label}
                className={
                  step === index ? "current" : step > index ? "complete" : ""
                }
              >
                <span>{step > index ? <Check size={14} /> : index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
        )}
        {error && (
          <div className="upload-error" role="alert">
            {error}
          </div>
        )}
        {step === 0 && (
          <>
            <p className="muted upload-intro">
              {tr(
                "Sélectionnez vos fichiers ou dossiers, puis vérifiez le classement de chaque document.",
                "Choose files or folders, then review each document’s classification.",
                "اختر الملفات أو المجلدات ثم راجع تصنيف كل وثيقة.",
              )}
            </p>
            <input
              ref={fileInput}
              type="file"
              accept={SUPPORTED_FILE_ACCEPT}
              multiple
              hidden
              onChange={pickFiles}
              aria-label={tr(
                "Sélectionner des fichiers",
                "Select files",
                "اختيار ملفات",
              )}
            />
            <input
              ref={directoryInput}
              type="file"
              accept={SUPPORTED_FILE_ACCEPT}
              multiple
              webkitdirectory=""
              directory=""
              hidden
              onChange={pickFiles}
              aria-label={tr(
                "Sélectionner un dossier",
                "Select a folder",
                "اختيار مجلد",
              )}
            />
            <div
              className={`upload-dropzone ${dragging ? "dragging" : ""} ${reading ? "reading" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) setDragging(false);
              }}
              onDrop={handleDrop}
            >
              {reading ? (
                <LoaderCircle size={32} className="upload-spinner" />
              ) : (
                <UploadCloud size={32} />
              )}
              <strong>
                {reading
                  ? tr(
                      "Lecture des dossiers…",
                      "Reading folders…",
                      "جارٍ قراءة المجلدات…",
                    )
                  : tr(
                      "Glissez vos fichiers ou dossiers ici",
                      "Drop files or folders here",
                      "اسحب الملفات أو المجلدات هنا",
                    )}
              </strong>
              <span className="muted">
                {tr(
                  "Documents · Images · Code · Tableaux · Archives · Sous-dossiers inclus · 20 Mo par fichier",
                  "Documents · Images · Code · Spreadsheets · Archives · Nested folders included · 20 MB per file",
                  "وثائق · صور · شيفرة · جداول · أرشيف · مجلدات متداخلة · 20 ميغابايت للملف",
                )}
              </span>
              <div>
                <Button
                  variant="secondary"
                  icon={Plus}
                  disabled={reading}
                  onClick={() => fileInput.current?.click()}
                >
                  {tr("Choisir des fichiers", "Choose files", "اختيار ملفات")}
                </Button>
                <Button
                  variant="ghost"
                  icon={FolderOpen}
                  disabled={reading}
                  onClick={() =>
                    (directorySupported
                      ? directoryInput
                      : fileInput
                    ).current?.click()
                  }
                >
                  {directorySupported
                    ? tr("Choisir un dossier", "Choose a folder", "اختيار مجلد")
                    : tr(
                        "Ajouter plusieurs fichiers",
                        "Add multiple files",
                        "إضافة عدة ملفات",
                      )}
                </Button>
              </div>
            </div>
            {!directorySupported && (
              <p className="muted upload-fallback">
                {tr(
                  "Votre navigateur ne propose pas la sélection de dossier. Sélectionnez plusieurs fichiers ou glissez un dossier si disponible.",
                  "Your browser does not support folder selection. Choose multiple files, or drop a folder if available.",
                  "لا يدعم المتصفح اختيار المجلدات. اختر عدة ملفات أو اسحب مجلداً إن أمكن.",
                )}
              </p>
            )}
            {files.length > 0 && (
              <>
                <div className="upload-list-heading">
                  <strong>
                    {files.length}{" "}
                    {tr(
                      "document(s) sélectionné(s)",
                      "document(s) selected",
                      "وثيقة مختارة",
                    )}
                  </strong>
                  <span className="muted">
                    {folderCount > 0 &&
                      `${folderCount} ${tr("dossier(s)", "folder(s)", "مجلد")} · `}
                    {sizeLabel(totalBytes)}
                  </span>
                  <button type="button" onClick={() => setFiles((current) => current.filter((item) => uploaded.current.has(item.key)))}>
                    {tr("Tout retirer", "Remove all", "إزالة الكل")}
                  </button>
                </div>
                {fileList(false)}
              </>
            )}
          </>
        )}
        {step === 1 && (
          <>
            <div className="upload-assignment">
              <Field
                label={tr(
                  "Faculté attribuée",
                  "Assigned faculty",
                  "الكلية المخصصة",
                )}
              >
                <input className="input" value={faculty?.name || ""} disabled />
              </Field>
              <Field
                label={tr(
                  canChooseProgram ? "Filière de destination" : "Filière attribuée",
                  canChooseProgram ? "Destination program" : "Assigned program",
                  canChooseProgram ? "المسلك المستهدف" : "المسلك المخصص",
                )}
                hint={
                  isChat
                    ? tr(
                        "Le classement accompagne le fichier dans cette discussion.",
                        "Classification stays with the file in this conversation.",
                        "يرافق التصنيف الملف في هذه المناقشة.",
                      )
                    : tr(
                        "Vos documents seront partagés uniquement dans votre filière.",
                        "Documents will be shared only within your program.",
                        "ستتم مشاركة وثائقك داخل مسلكك فقط.",
                      )
                }
              >
                {canChooseProgram ? <Select className="input" value={program} disabled={uploading || uploaded.current.size > 0} onChange={(event) => {
                  const scope = uploadScopes.find(item => item.filiereId === event.target.value);
                  setProgram(event.target.value);
                  setBatch(previous => ({ ...previous, semester: scope?.semesters.includes(previous.semester) ? previous.semester : scope?.semesters[0] || 1, module: "" }));
                  setError("");
                }} aria-label={tr("Filière de destination", "Destination program", "المسلك المستهدف")}>{uploadScopes.map(scope => <option key={scope.filiereId} value={scope.filiereId}>{getFiliere(scope.filiereId)?.name || scope.filiereId}</option>)}</Select> : <input className="input" value={filiere?.name || ""} disabled />}
              </Field>
            </div>
            <p className="muted upload-permission-note" role="status">
              {allowedSemesters.length ? tr(
                `Envoi autorisé en ${allowedSemesters.map(value => `S${value}`).join(" / ")} dans cette filière.`,
                `Uploads authorized to ${allowedSemesters.map(value => `S${value}`).join(" / ")} in this program.`,
                `الرفع مسموح إلى ${allowedSemesters.map(value => `S${value}`).join(" / ")} في هذا المسلك.`,
              ) : tr("Aucun classement autorisé pour ce compte.", "No upload scope is available for this account.", "لا يتوفر تصنيف مسموح لهذا الحساب.")}
            </p>
            <section className="upload-batch">
              <div className="upload-section-title">
                <div>
                  <h3>
                    {tr(
                      " 1) Classement commun",
                      " 1) Common classification",
                      "التصنيف المشترك (1",
                    )}
                  </h3>
                  <p className="muted">
                    {tr(
                      isSupplement ? "Ces fichiers reprennent le classement et la partie du document principal." : "Ces informations sont communes à tous les fichiers. Renseignez ensuite le Part/Chapitre de chacun.",
                      isSupplement ? "These files follow the main document’s classification and part." : "These details apply to every file. Then enter each file’s Part/Chapitre.",
                      isSupplement ? "تتبع هذه الملفات تصنيف المستند الرئيسي وجزءه." : "تُطبّق هذه المعلومات على جميع الملفات. أدخل بعدها الجزء/الفصل لكل ملف.",
                    )}
                  </p>
                </div>
              </div>
              {files.length === 1 && (
                <Field label={tr("Titre du document *", "Document title *", "عنوان الوثيقة *")}>
                  <input
                    className="input"
                    value={classifiedFiles[0].meta.title}
                    onChange={(event) => updateFile(files[0].key, "title", event.target.value)}
                    maxLength={180}
                    required
                    disabled={uploaded.current.has(files[0].key)}
                  />
                </Field>
              )}
              {metadataFields(batch, changeBatch)}
              {files.length > 1 && !isSupplement && (
                <p className="muted">
                  {tr(
                    "Le titre de chaque document reprend automatiquement le nom du module en MAJUSCULES.",
                    "Each document title automatically uses the module name in UPPERCASE.",
                    "يُستخدم اسم الوحدة بالأحرف الكبيرة تلقائياً عنواناً لكل وثيقة.",
                  )}
                  {batch.module.trim() && <> <strong dir="auto">{moduleDisplayName(batch.module)}</strong></>}
                </p>
              )}
              <Button
                variant="secondary"
                icon={Check}
                onClick={applyBatch}
                disabled={!files.length}
              >
                {tr(
                  `Appliquer aux ${files.length} documents`,
                  `Apply to ${files.length} documents`,
                  `تطبيق على ${files.length} وثيقة`,
                )}
              </Button>
              {batchApplied && (
                <p className="muted" role="status">
                  {tr(
                    isSupplement ? "Classement du document principal conservé." : "Classement appliqué. Choisissez le Part/Chapitre de chaque fichier.",
                    isSupplement ? "Main document classification retained." : "Classification applied. Choose each file’s Part/Chapitre.",
                    isSupplement ? "حُفظ تصنيف المستند الرئيسي." : "تم تطبيق التصنيف. اختر الجزء/الفصل لكل ملف.",
                  )}
                </p>
              )}
            </section>
            <div className="upload-section-title">
              <div>
                <h3>
                  {tr(
                    "2) Vérifier chaque document",
                    "2) Review each document",
                    "مراجعة كل وثيقة (2",
                  )}
                </h3>
                <p className="muted">
                  {tr(
                    isSupplement ? "Les noms et chemins des compléments sont conservés. Leur partie reprend celle du document principal." : "Ouvrez chaque ligne pour renseigner uniquement son Part/Chapitre obligatoire.",
                    isSupplement ? "Supplement names and paths are retained. Their part follows the main document." : "Expand each row to enter its required Part/Chapitre.",
                    isSupplement ? "تُحفظ أسماء الملفات المكمّلة ومساراتها. يتبع جزؤها المستند الرئيسي." : "افتح كل صف لإدخال الجزء/الفصل الإلزامي فقط.",
                  )}
                </p>
              </div>
              <span className="muted">
                {files.length} {tr("fichier(s)", "file(s)", "ملف")}
              </span>
            </div>
            {files.length ? (
              fileList(true)
            ) : (
              <p className="muted">
                {tr(
                  "Aucun document sélectionné. Revenez à la première étape.",
                  "No documents selected. Return to the first step.",
                  "لم يتم اختيار وثائق. عد إلى الخطوة الأولى.",
                )}
              </p>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <div className="upload-review-header">
              <CheckCircle2 size={26} />
              <div>
                <h3>
                  {tr(
                    "Prêt à partager ?",
                    "Ready to share?",
                    "هل أنت مستعد للمشاركة؟",
                  )}
                </h3>
                <p className="muted">
                  {tr(
                    "Vérifiez le classement de vos documents une dernière fois.",
                    "Check your document classification one last time.",
                    "راجع تصنيف وثائقك مرة أخيرة.",
                  )}
                </p>
              </div>
            </div>
            <div className="upload-summary">
              <div>
                <span className="muted">
                  {tr("Documents", "Documents", "الوثائق")}
                </span>
                <strong>
                  {files.length} {tr("fichier(s)", "file(s)", "ملف")}
                </strong>
              </div>
              <div>
                <span className="muted">
                  {tr("Taille totale", "Total size", "الحجم الإجمالي")}
                </span>
                <strong>{sizeLabel(totalBytes)}</strong>
              </div>
              <div>
                <span className="muted">
                  {tr("Classement", "Classification", "التصنيف")}
                </span>
                <strong>
                  {faculty?.name} · {filiere?.name}
                </strong>
              </div>
            </div>
            <div className="upload-review-list">
              {classifiedFiles.map((item) => (
                <div key={item.key}>
                  <FileText size={18} />
                  <div>
                    <strong dir="auto">{item.meta.title}</strong>
                    <span className="upload-review-filename" dir="auto">
                      {item.file.name}
                    </span>
                    {classificationCopy(item.meta)}
                    {item.meta.author && (
                      <span className="muted" dir="auto">
                        {tr(
                          "Professeur / auteur",
                          "Professor / author",
                          "الأستاذ / المؤلف",
                        )}{" "}
                        · {item.meta.author}
                      </span>
                    )}
                    {item.path.includes("/") && (
                      <span className="upload-file-path" dir="auto">
                        {item.path}
                      </span>
                    )}
                  </div>
                  <span className="muted">
                    {fileTypeLabel(item.file)} · {sizeLabel(item.file.size)}
                  </span>
                </div>
              ))}
            </div>
            <p className="upload-local-notice">
              {isChat
                ? tr(
                    "Ces fichiers seront joints au brouillon, puis envoyés avec votre message. Leur classement restera accessible dans cette discussion.",
                    "These files will be attached to your draft, then uploaded with your message. Their classification will stay available in this conversation.",
                    "ستُرفق الملفات بالمسودة ثم تُرفع مع الرسالة. يبقى تصنيفها متاحاً في هذه المناقشة.",
                  )
                : tr(
                    "Les fichiers seront envoyés et conservés dans la bibliothèque de votre filière.",
                    "Files will be uploaded and saved in your program’s library.",
                    "ستُرفع الملفات وتُحفظ في مكتبة مسلكك.",
                  )}
            </p>
          </>
        )}

        {step === 3 && (
          <div className="upload-progress-screen" data-uploading="true">
            <div className="upload-progress-heading">
              <span className="upload-progress-icon" aria-hidden="true">
                <UploadCloud size={25} strokeWidth={1.6} />
              </span>
              <div>
                <h3>{tr("Envoi des documents…", "Uploading documents…", "جارٍ رفع الوثائق…")}</h3>
                <p className="muted">
                  {tr(
                    "Ils rejoignent votre bibliothèque, un par un.",
                    "Your files are saved to the library, one at a time.",
                    "تُحفظ الملفات في مكتبتك واحداً تلو الآخر.",
                  )}
                </p>
              </div>
            </div>
            <div className="upload-progress-meter">
              <div className="upload-progress-label">
                <span>{tr("Documents enregistrés", "Documents saved", "الوثائق المحفوظة")}</span>
                <strong
                  className="upload-progress-count"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  aria-label={tr(
                    `${uploadedCount} document(s) enregistré(s) sur ${files.length}`,
                    `${uploadedCount} of ${files.length} documents saved`,
                    `تم حفظ ${uploadedCount} من ${files.length} وثيقة`,
                  )}
                >
                  {uploadedCount} / {files.length}
                </strong>
              </div>
              <div
                className="upload-progress-track"
                role="progressbar"
                aria-label={tr("Documents envoyés", "Uploaded documents", "الوثائق المرفوعة")}
                aria-valuemin={0}
                aria-valuemax={files.length}
                aria-valuenow={uploadedCount}
                aria-valuetext={tr(
                  `${uploadedCount} document(s) enregistré(s) sur ${files.length}`,
                  `${uploadedCount} of ${files.length} documents saved`,
                  `تم حفظ ${uploadedCount} من ${files.length} وثيقة`,
                )}
              >
                <span
                  style={{
                    transform: `scaleX(${files.length ? uploadedCount / files.length : 0})`,
                  }}
                />
              </div>
            </div>
            {currentUpload && (
              <div className="upload-current-file">
                <span className="upload-current-file-icon" aria-hidden="true">
                  <FileText size={23} strokeWidth={1.5} />
                </span>
                <div className="upload-current-file-copy">
                  <span className="upload-current-file-status">
                    {tr("En cours d’envoi", "Uploading now", "جارٍ الرفع")}
                  </span>
                  <strong className="upload-current-file-name" dir="auto">
                    {currentUpload.file.name}
                  </strong>
                  <span className="upload-current-file-details">
                    <bdi>{moduleDisplayName(currentUpload.meta.module)}</bdi>
                    <span>·</span>
                    <span>S{currentUpload.meta.semester}</span>
                    <span>·</span>
                    <span>{sizeLabel(currentUpload.file.size)}</span>
                  </span>
                </div>
                <LoaderCircle size={19} className="upload-spinner" aria-hidden="true" />
              </div>
            )}
          </div>
        )}
        {step === 4 && (
          <div className="upload-progress-screen" role="status" aria-live="polite">
            <div className="upload-success-icon">
              <Check size={32} />
            </div>
            <h3>
              {tr("Documents ajoutés", "Documents added", "تمت إضافة الوثائق")}
            </h3>
            <p className="muted">
              {tr(
                `${files.length} document(s) sont disponibles dans votre bibliothèque.`,
                `${files.length} document(s) are now available in your library.`,
                `${files.length} وثيقة متاحة الآن في مكتبتك.`,
              )}
            </p>
            <p className="upload-local-notice">
              {tr(
                "Vos documents et leur classement sont enregistrés. Vous pourrez les retrouver après votre prochaine connexion.",
                "Your documents and classification have been saved. They will remain available when you sign in again.",
                "تم حفظ وثائقك وتصنيفها. ستجدها عند تسجيل الدخول مرة أخرى.",
              )}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
