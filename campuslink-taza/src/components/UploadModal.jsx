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
import { getFilieres, getFiliere } from "../data/studies";
import {
  SUPPORTED_FILE_ACCEPT,
  isSupportedFile,
  fileTypeLabel,
  sizeLabel,
  filesFromDrop,
  fileKey,
} from "../lib/files";
import {
  moduleSuggestions,
  moduleDisplayName,
  normalizePart,
  partLabel,
  findResourceConflicts,
} from "../lib/resources";
import { Button, Field, Modal } from "./ui";
import { Select, Autocomplete } from "./Select";
import "../pages/library.css";

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
}) {
  const {
    t,
    tr,
    language,
    user,
    selection: accountSelection,
    faculty,
    isAdmin,
    resources,
    allResources,
    uploadResource,
    closeDialog,
  } = useApp();
  const [program, setProgram] = useState(accountSelection?.filiereId || "");
  const selection = { ...accountSelection, filiereId: isAdmin ? program : accountSelection?.filiereId };
  const filiere = getFiliere(selection.filiereId);
  const isChat = mode === "chat";
  const initialSemester = semesterNumber(selection?.semester || 1);
  const modulesFor = (semester, query = "") =>
    moduleSuggestions(resources, { ...selection, semester }, query);
  const initialFiles = () =>
    initialEntries
      .filter((item) => isSupportedFile(item.file))
      .map(({ file, path }) => ({
        file,
        path: path || file.name,
        key: fileKey(file, path),
        meta: {
          semester: initialSemester,
          module: "",
          category: "courses",
          author: "",
          part: "",
          title: file.name.replace(/\.[^.]+$/, ""),
        },
      }));
  const [step, setStep] = useState(isChat && initialEntries.length ? 1 : 0);
  const [files, setFiles] = useState(initialFiles);
  const [batch, setBatch] = useState({
    semester: initialSemester,
    module: "",
    category: "courses",
    author: "",
    part: "",
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
  const uploaded = useRef(new Set());
  const [error, setError] = useState("");
  const [batchApplied, setBatchApplied] = useState(false);
  const fileInput = useRef(null);
  const directoryInput = useRef(null);
  const closed = useRef(false);
  const dragDepth = useRef(0);
  const directorySupported =
    typeof document !== "undefined" &&
    "webkitdirectory" in document.createElement("input");
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
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
            title: files.length > 1 ? moduleDisplayName(batch.module) : item.meta.title,
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
    const valid = selected.filter((item) => isSupportedFile(item.file));
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
            part: "",
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
            `${skipped} fichier(s) ignoré(s) : format non pris en charge.`,
            `${skipped} file(s) skipped: unsupported format.`,
            `تم تجاهل ${skipped} ملف: صيغة غير مدعومة.`,
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
  const conflicts = findResourceConflicts(
    candidates,
    isChat ? existingAttachments : allResources,
  ).filter((item) => !uploaded.current.has(files[item.index]?.key));
  const conflictByIndex = new Map(conflicts.map((item) => [item.index, item]));
  const validate = () => {
    const invalid = classifiedFiles.find(
      (item) =>
        !uploaded.current.has(item.key) && (
        !item.meta.title.trim() ||
        !item.meta.module.trim() ||
        ![1, 2, 3, 4, 5, 6].includes(Number(item.meta.semester)) ||
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
          "Renseignez le classement commun, puis un Part/Chapitre positif ou Complet pour chaque fichier.",
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
          `Conflit : ${first.resource.originalName} utilise le même ${partLabel(first.resource.part)} que ${first.conflict.originalName || first.conflict.title} dans ce module, semestre et catégorie.`,
          `Conflict: ${first.resource.originalName} shares ${partLabel(first.resource.part, "en")} with ${first.conflict.originalName || first.conflict.title} in this module, semester and category.`,
          `تعارض: ${first.resource.originalName} و${first.conflict.originalName || first.conflict.title} يستخدمان نفس ${partLabel(first.resource.part, "ar")} داخل نفس الوحدة والفصل والفئة.`,
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
        if (uploaded.current.has(item.key)) continue;
        await uploadResource({
          file: item.file,
          path: item.path,
          meta: {
            title: item.meta.title.trim(),
            semester: Number(item.meta.semester),
            module: item.meta.module.trim().replace(/\s+/g, " "),
            category: item.meta.category,
            part: normalizePart(item.meta.part),
            author: item.meta.author.trim(),
            facultyId: selection.facultyId,
            filiereId: selection.filiereId,
          },
        });
        uploaded.current.add(item.key);
        setFiles((current) => current.map((file) =>
          file.key === item.key ? { ...file, meta: { ...item.meta } } : file,
        ));
        setUploadedCount(uploaded.current.size);
      }
      setStep(4);
    } catch (error) {
      setError(error.message || tr("L’envoi a échoué. Réessayez.", "Upload failed. Try again.", "تعذر الرفع. حاول مجدداً."));
      setStep(2);
    } finally {
      setUploading(false);
    }
  };

  const metadataFields = (meta, change, individual = false, disabled = false) => (
    individual ? (
      <SuggestedField
        label={tr("Part/Chapitre *", "Part/Chapitre *", "جزء/فصل *")}
        value={meta.part}
        onChange={(value) => change("part", value)}
        options={["1", "2", "3", "4", "5", "Complet"]}
        showOnEmpty
        required
        disabled={disabled}
        hint={tr(
          "Un nombre entier positif sans limite, ou Complet. Un seul fichier par emplacement.",
          "Any positive integer, or Complete. One file per slot.",
          "أي عدد صحيح موجب أو Complet (كامل). ملف واحد لكل جزء.",
        )}
      />
    ) : (
      <div className="upload-metadata-grid">
        <Field label={`${t("semester")} *`}>
          <Select
            className="input"
            value={meta.semester}
            onChange={(event) => change("semester", Number(event.target.value))}
          >
            {[1, 2, 3, 4, 5, 6].map((value) => (
              <option value={value} key={value}>
                S{value}
              </option>
            ))}
          </Select>
        </Field>
        <SuggestedField
          label={`${t("module")} *`}
          value={meta.module}
          onChange={(value) => change("module", value)}
          options={modulesFor(meta.semester, meta.module)}
          required
          hint={tr(
            "Tapez un nom librement ou choisissez une suggestion issue des fichiers existants.",
            "Type any name or choose a suggestion from existing files.",
            "اكتب أي اسم أو اختر اقتراحاً من الملفات الموجودة.",
          )}
        />
        <Field label={tr("Catégorie *", "Category *", "الفئة *")}>
          <Select
            className="input"
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
    <div className="upload-footer">
      <span className="muted">
        {tr(
          "Partage sécurisé dans votre faculté",
          "Secure sharing within your faculty",
          "مشاركة آمنة داخل كليتك",
        )}
      </span>
      <div>
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
        {step === 3 && (
          <div className="upload-progress-screen" role="status" aria-live="polite">
            <LoaderCircle size={32} className="upload-spinner" />
            <h3>{tr("Envoi des documents…", "Uploading documents…", "جارٍ رفع الوثائق…")}</h3>
            <p className="muted">{uploadedCount} / {files.length}</p>
            <progress value={uploadedCount} max={files.length} aria-label={tr("Documents envoyés", "Uploaded documents", "الوثائق المرفوعة")} />
          </div>
        )}
        {step === 4 && (
          <Button variant="primary" onClick={close}>
            {tr("Terminer", "Done", "إنهاء")}
          </Button>
        )}
      </div>
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
          : tr("Partager des documents", "Share documents", "مشاركة الوثائق")
      }
      onClose={close}
      wide
      footer={footer}
    >
      <div className="upload-workflow">
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
                  "PDF · Images · Word · PowerPoint · Excel · TXT · Sous-dossiers inclus",
                  "PDF · Images · Word · PowerPoint · Excel · TXT · Nested folders included",
                  "PDF · صور · Word · PowerPoint · Excel · TXT · يشمل المجلدات المتداخلة",
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
                  isAdmin ? "Filière de destination" : "Filière attribuée",
                  isAdmin ? "Destination program" : "Assigned program",
                  isAdmin ? "المسلك المستهدف" : "المسلك المخصص",
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
                {isAdmin ? <Select className="input" value={program} disabled={uploading || uploaded.current.size > 0} onChange={(event) => { setProgram(event.target.value); setError(""); }} aria-label={tr("Filière de destination", "Destination program", "المسلك المستهدف")}><option value="">{tr("Choisir une filière", "Choose a program", "اختر مسلكاً")}</option>{getFilieres(accountSelection?.facultyId || user?.facultyId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select> : <input className="input" value={filiere?.name || ""} disabled />}
              </Field>
            </div>
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
                      "Ces informations sont communes à tous les fichiers. Renseignez ensuite le Part/Chapitre de chacun.",
                      "These details apply to every file. Then enter each file’s Part/Chapitre.",
                      "تُطبّق هذه المعلومات على جميع الملفات. أدخل بعدها الجزء/الفصل لكل ملف.",
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
              {files.length > 1 && (
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
                    "Classement appliqué. Choisissez le Part/Chapitre de chaque fichier.",
                    "Classification applied. Choose each file’s Part/Chapitre.",
                    "تم تطبيق التصنيف. اختر الجزء/الفصل لكل ملف.",
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
                    "Ouvrez chaque ligne pour renseigner uniquement son Part/Chapitre obligatoire.",
                    "Expand each row to enter its required Part/Chapitre.",
                    "افتح كل صف لإدخال الجزء/الفصل الإلزامي فقط.",
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
          <div className="upload-progress-screen" role="status" aria-live="polite">
            <LoaderCircle size={32} className="upload-spinner" />
            <h3>{tr("Envoi des documents…", "Uploading documents…", "جارٍ رفع الوثائق…")}</h3>
            <p className="muted">{uploadedCount} / {files.length}</p>
            <progress value={uploadedCount} max={files.length} aria-label={tr("Documents envoyés", "Uploaded documents", "الوثائق المرفوعة")} />
          </div>
        )}
        {step === 4 && (
          <div className="upload-progress-screen">
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
