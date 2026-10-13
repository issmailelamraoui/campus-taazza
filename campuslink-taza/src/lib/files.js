// Device files are kept only in this page session. Messages may retain their
// metadata in the local demo, but never an expired or permanently stored URL.
export const SUPPORTED_FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.odp,.rtf,.txt,.md,.tex,.py,.ipynb,.c,.cpp,.h,.hpp,.js,.jsx,.ts,.tsx,.html,.css,.xml,.svg,.json,.csv,.sql,.java,.zip,.rar,.7z,.tar,.gz';
const extensions = new Set(SUPPORTED_FILE_ACCEPT.split(',').map(value => value.slice(1)));
export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_BATCH_FILES = 1000;
const sessionFiles = new Map();
export const fileExtension = file => {
  const name = String(file?.name || '');
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  // A claimed MIME type cannot disguise an executable or an unknown suffix.
  // The server independently validates content and safe download handling.
  return extensions.has(extension) ? extension : '';
};
export const isSupportedFile = file => Boolean(fileExtension(file));
export const fileTypeLabel = file => fileExtension(file).toUpperCase() || 'FILE';
export const sizeLabel = bytes => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} Ko`
  : `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
export const fileKey = (file, path = '') => `${path || file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;

export function normalizeRelativePath(value, filename) {
  const path = String(value || filename || '');
  const segments = path.split('/');
  if (!path || path.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(path) || /^[a-z]:/i.test(path)
    || segments.length > 64 || segments.some(segment => !segment || segment.length > 255 || ['.', '..'].includes(segment))
    || segments.at(-1).length > 180 || (filename && segments.at(-1) !== filename)) return '';
  return path;
}
export function uploadFileIssue(file, path = '') {
  if (!isSupportedFile(file)) return 'format';
  if (!normalizeRelativePath(path || file.webkitRelativePath || file.name, file.name)) return 'path';
  if (Number(file.size) > MAX_UPLOAD_FILE_BYTES) return 'size';
  return '';
}

// WebKit directory readers deliver multiple batches, including at every nested
// level. Read to exhaustion rather than stopping after the first batch.
export async function collectDirectoryEntry(entry, parentPath = '', limits = { count: 0 }) {
  if (!entry) return [];
  const path = `${parentPath}${entry.name}`;
  if (!normalizeRelativePath(path)) throw new Error('Chemin du dossier invalide ou trop profond.');
  if (entry.isFile) {
    if (++limits.count > MAX_UPLOAD_BATCH_FILES) throw new Error('Le dossier contient trop de fichiers. Sélectionnez un sous-dossier.');
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const entries = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    entries.push(...batch);
  }
  const files = [];
  for (const child of entries) files.push(...await collectDirectoryEntry(child, `${path}/`, limits));
  return files;
}

export async function filesFromDrop(dataTransfer) {
  // Capture entries before awaiting: browser drag-event access is temporary.
  const entries = Array.from(dataTransfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  const fallback = Array.from(dataTransfer.files || [])
    .map(file => ({ file, path: file.webkitRelativePath || file.name }));
  if (!entries.length) return fallback;
  const limits = { count: 0 }, selected = [];
  for (const entry of entries) selected.push(...await collectDirectoryEntry(entry, '', limits));
  const keys = new Set(selected.map(item => fileKey(item.file, item.path)));
  return [...selected, ...fallback.filter(item => !keys.has(fileKey(item.file, item.path)))];
}

export function createSessionAttachment(file, path = '') {
  const id = `device-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  sessionFiles.set(id, { file, url: URL.createObjectURL(file) });
  return { id, title: file.name, name: file.name, size: sizeLabel(file.size),
    fileType: fileTypeLabel(file), path: path || file.webkitRelativePath || file.name, sessionOnly: true };
}
export const getSessionFile = id => sessionFiles.get(id);
export function releaseSessionAttachment(id) {
  const item = sessionFiles.get(id);
  if (item) URL.revokeObjectURL(item.url);
  sessionFiles.delete(id);
}
