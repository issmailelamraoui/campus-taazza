export function academicYear(value) {
  if (value === undefined || value === null || value === '' || value === 'unknown') return null;
  const match = typeof value === 'string' && value.match(/^(19\d{2}|20\d{2}|21\d{2})\/(19\d{2}|20\d{2}|21\d{2})$/);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) throw Object.assign(new Error('Année universitaire invalide.'), {status:400});
  return value;
}
export function academicYears(value, single) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw Object.assign(new Error('Années universitaires invalides.'), {status:400}); } }
  if (value !== undefined && (!Array.isArray(value) || value.length > 30)) throw Object.assign(new Error('Années universitaires invalides.'), {status:400});
  return [...new Set([...(value || []), single].map(academicYear).filter(Boolean))].sort().reverse();
}
export const yearsOf = resource => academicYears(resource.academic_years || [], resource.academic_year);
export function compareAcademicYears(a, b, current = null) {
  const ay=yearsOf(a),by=yearsOf(b),ac=current&&ay.includes(current),bc=current&&by.includes(current);
  if (ac !== bc) return ac ? -1 : 1;
  const year=(by[0] || '').localeCompare(ay[0] || '');
  return year || String(b.created_at || b.date || '').localeCompare(String(a.created_at || a.date || '')) || Number(b.id)-Number(a.id);
}
export const yearsOverlap = (a,b) => (!a.length&&!b.length)||a.some(year=>b.includes(year));
