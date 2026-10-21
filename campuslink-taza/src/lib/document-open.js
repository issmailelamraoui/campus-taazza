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

export function isPhoneDocumentViewport() {
  return typeof window !== 'undefined' && window.matchMedia(
    '(max-width: 760px), (pointer: coarse) and (max-width: 950px) and (max-height: 500px)',
  ).matches;
}
