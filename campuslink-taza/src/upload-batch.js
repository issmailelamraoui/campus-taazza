export const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.txt';
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const extensions = new Set(UPLOAD_ACCEPT.split(','));

export function prepareUploadFiles(files, folder = false) {
  return Array.from(files, (file, index) => {
    const relativePath = folder ? file.webkitRelativePath || file.name : '';
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const issue = !file.size ? 'uploadEmptyFile' : file.size > MAX_UPLOAD_BYTES ? 'uploadTooLarge' : !extensions.has(extension) ? 'uploadUnsupported' : '';
    return { id: index, file, relativePath, title: file.name.replace(/\.[^.]+$/, '').slice(0, 180), partNumber: index + 1, teacherName: '', status: issue ? 'skipped' : 'queued', issue };
  });
}

// Individual requests preserve existing permissions and duplicate checks. Two
// workers keep large selections from buffering every document on the server.
export async function runUploadBatch(entries, upload, onUpdate, concurrency = 2) {
  const pending = entries.filter(entry => ['queued', 'error'].includes(entry.status));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (next < pending.length) {
      const entry = pending[next++];
      onUpdate(entry.id, { status: 'uploading', error: '', result: null });
      try {
        const result = await upload(entry);
        onUpdate(entry.id, { status: 'uploaded', result });
      } catch (error) {
        const resource = error.status === 409 && (error.data?.resource || error.data?.existing);
        onUpdate(entry.id, resource ? { status: 'duplicate', result: { resource } } : { status: 'error', error: error.message });
      }
    }
  }));
}
