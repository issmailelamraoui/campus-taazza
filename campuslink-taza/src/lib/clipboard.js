export async function copyText(text) {
  const value = String(text ?? '');
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch {}
  }
  // Phones opening the development server over LAN HTTP may not expose the
  // secure Clipboard API. Keep the user's focus and selection intact.
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement('textarea');
  field.value = value; field.setAttribute('readonly', '');
  Object.assign(field.style, { position: 'fixed', opacity: '0', inset: '0', width: '1px', height: '1px', fontSize: '16px' });
  document.body.appendChild(field);
  try {
    field.select(); field.setSelectionRange(0, value.length);
    if (!document.execCommand('copy')) throw new Error('La copie a échoué. Réessayez.');
  } finally {
    field.remove(); focused?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
  }
}
