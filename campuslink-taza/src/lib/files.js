// Device files are kept only in this page session. Messages may retain their
// metadata in the local demo, but never an expired or permanently stored URL.
export const SUPPORTED_FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt';
const extensions = new Set(SUPPORTED_FILE_ACCEPT.split(',').map(value => value.slice(1)));
const mimeExtensions = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};
const sessionFiles = new Map();
export const fileExtension = file => {
  const extension = String(file?.name || '').split('.').pop().toLowerCase();
  return extensions.has(extension) ? extension : mimeExtensions[file?.type] || '';
};
export const isSupportedFile = file => Boolean(fileExtension(file));
export const fileTypeLabel = file => fileExtension(file).toUpperCase();
export const sizeLabel = bytes => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} Ko`
  : `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
export const fileKey = (file, path = '') => `${path || file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;

// WebKit directory readers deliver multiple batches, including at every nested
// level. Read to exhaustion rather than stopping after the first batch.
export async function collectDirectoryEntry(entry, parentPath = '') {
  if (!entry) return [];
  const path = `${parentPath}${entry.name}`;
  if (entry.isFile) {
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
  return (await Promise.all(entries.map(child => collectDirectoryEntry(child, `${path}/`)))).flat();
}

export async function filesFromDrop(dataTransfer) {
  // Capture entries before awaiting: browser drag-event access is temporary.
  const entries = Array.from(dataTransfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  const fallback = Array.from(dataTransfer.files || [])
    .map(file => ({ file, path: file.webkitRelativePath || file.name }));
  return entries.length
    ? (await Promise.all(entries.map(entry => collectDirectoryEntry(entry)))).flat()
    : fallback;
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
