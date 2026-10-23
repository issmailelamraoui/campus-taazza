// Native viewing always uses the authenticated application endpoint, never a
// provider URL or a download link supplied by document metadata.
export function isPDFDocument(item) {
  return !!item && (String(item.fileType || '').toUpperCase() === 'PDF' ||
    item.mime === 'application/pdf' || /\.pdf$/i.test(item.originalName || item.filename || ''));
}

export function documentFileUrl(item) {
  if (!item || !/^[1-9]\d*$/.test(String(item.id))) return null;
  const version = Number(item.initialVersion || item.requestedVersion);
  const path = Number.isSafeInteger(version) && version > 0
    ? `/api/reading/${item.id}/file?version=${version}` : `/api/files/${item.id}`;
  const page = Number(item.initialPage);
  return path + (isPDFDocument(item) && Number.isSafeInteger(page) && page > 0 ? `#page=${page}` : '');
}

export function nativePDFUrl(item) {
  return isPDFDocument(item) ? documentFileUrl(item) : null;
}

// Filters and fragment navigation do not constitute another request to open
// the linked document. Keep the command separate from the rest of the URL.
export function documentOpenRequest(location) {
  const params = new URLSearchParams(location.search), id = params.get('document');
  if (!id || !/^[1-9]\d*$/.test(id)) return '';
  return JSON.stringify([location.pathname, id,
    params.has('page') ? Math.max(1, Number(params.get('page')) || 1) : null,
    Number(params.get('version')) || null, params.get('mode') === 'study']);
}

export function isPhoneDocumentViewport() {
  return typeof window !== 'undefined' && window.matchMedia(
    '(max-width: 760px), (pointer: coarse) and (max-width: 950px) and (max-height: 500px)',
  ).matches;
}
