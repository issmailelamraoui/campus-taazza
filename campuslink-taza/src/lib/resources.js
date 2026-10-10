export const normalizeModule = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const displayModule = value => String(value || '').trim().replace(/\s+/g, ' ');
export const moduleDisplayName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
const semesterNumber = value => Number(String(value ?? '').replace(/^s/i, ''));

// Callers provide one academic scope. Stored titles, IDs and filenames remain
// intact; the folder is a view over every document with the same module name.
export function groupResourcesByModule(resources) {
  const groups = new Map();
  for (const resource of resources) {
    if (resource.status === 'removed') continue;
    const key = normalizeModule(resource.module);
    if (!groups.has(key)) groups.set(key, { key, name: moduleDisplayName(resource.module), documents: [] });
    groups.get(key).documents.push(resource);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Suggestions come exclusively from classified resources in the selected
// program and semester, including files added in the current frontend session.
export function moduleSuggestions(resources, scope, query = '') {
  const names = new Map();
  const search = normalizeModule(query);
  for (const item of resources) {
    if (item.status === 'removed' || item.facultyId !== scope?.facultyId
      || item.filiereId !== scope?.filiereId
      || semesterNumber(item.semester) !== semesterNumber(scope?.semester)) continue;
    const key = normalizeModule(item.module);
    if (key && key.includes(search) && !names.has(key)) names.set(key, displayModule(item.module));
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

// Keep numbers as decimal strings so very large user-entered chapter numbers
// are neither capped nor rounded by JavaScript's numeric precision.
export function normalizePart(value) {
  const text = String(value ?? '').trim();
  if (/^(complete|complet)$/i.test(text)) return 'complete';
  if (!/^\d+$/.test(text)) return '';
  return text.replace(/^0+/, '') || '';
}
export function partLabel(part, language = 'fr') {
  const normalized = normalizePart(part);
  if (normalized === 'complete') return language === 'ar' ? 'كامل' : language === 'en' ? 'Complete' : 'Complet';
  if (!normalized) return '—';
  return `${language === 'ar' ? 'جزء/فصل' : 'Part/Chapitre'} ${normalized}`;
}
export function compareParts(left, right) {
  const a = normalizePart(left), b = normalizePart(right);
  const rank = value => !value ? 2 : value === 'complete' ? 1 : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a === b || rank(a) > 0) return 0;
  return a.length - b.length || (a < b ? -1 : 1);
}
export function resourceSlotKey(item) {
  const part = normalizePart(item.part);
  const module = normalizeModule(item.module);
  const semester = semesterNumber(item.semester);
  if (!item.facultyId || !item.filiereId || !module || !item.category
    || ![1, 2, 3, 4, 5, 6].includes(semester) || !part) return '';
  return JSON.stringify([item.facultyId, item.filiereId, semester, module, item.category, part]);
}
export function findResourceConflicts(candidates, existing = []) {
  const occupied = new Map();
  for (const item of existing) {
    const key = resourceSlotKey(item);
    if (key && item.status !== 'removed' && !occupied.has(key)) occupied.set(key, item);
  }
  const batch = new Map();
  candidates.forEach((item, index) => {
    const key = resourceSlotKey(item);
    if (key) batch.set(key, [...(batch.get(key) || []), index]);
  });
  return candidates.flatMap((resource, index) => {
    const key = resourceSlotKey(resource);
    if (!key) return [];
    if (occupied.has(key)) return [{ index, resource, conflict: occupied.get(key), source: 'existing', key }];
    const other = batch.get(key).find(i => i !== index);
    return other === undefined ? [] : [{ index, resource, conflict: candidates[other], source: 'batch', key }];
  });
}
