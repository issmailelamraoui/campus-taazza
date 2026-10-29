import { resourceCategory } from '../../shared/resource-categories.js';

export const normalizeModule = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const displayModule = value => String(value || '').trim().replace(/\s+/g, ' ');
export const moduleDisplayName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
const semesterNumber = value => Number(String(value ?? '').replace(/^s/i, ''));

export function normalizeAcademicYear(value) {
  const match = /^(\d{4})\/(\d{4})$/.exec(String(value ?? '').trim());
  return match && Number(match[1]) >= 1900 && Number(match[1]) < 2200
    && Number(match[2]) === Number(match[1]) + 1 ? `${match[1]}/${match[2]}` : '';
}
export function resourceAcademicYears(resource) {
  let years = resource?.academicYears ?? resource?.academic_years;
  if (typeof years === 'string') {
    try { years = JSON.parse(years); } catch { years = []; }
  }
  return [...new Set([
    ...(Array.isArray(years) ? years : []),
    resource?.academicYear ?? resource?.academic_year,
  ].map(normalizeAcademicYear).filter(Boolean))].sort((a, b) => b.localeCompare(a));
}
export function compareAcademicYears(left, right, currentYear = '') {
  const a = normalizeAcademicYear(left), b = normalizeAcademicYear(right);
  const current = normalizeAcademicYear(currentYear);
  const rank = value => !value ? 2 : value === current ? 0 : 1;
  return rank(a) - rank(b) || b.localeCompare(a);
}
export function resourceDisplayYear(resource, currentYear = '', filterYear = '') {
  const years = resourceAcademicYears(resource);
  const filter = normalizeAcademicYear(filterYear);
  if (filter && years.includes(filter)) return filter;
  return [...years].sort((a, b) => compareAcademicYears(a, b, currentYear))[0] || '';
}
// Existing material never receives a guessed year. Calendar years below are
// merely selector choices; only a configured server year becomes the default.
export function academicYearOptions(currentYear = '', existing = [], date = new Date()) {
  const localYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Africa/Casablanca', year: 'numeric' }).format(date));
  const configured = normalizeAcademicYear(currentYear);
  const newest = Math.max(localYear, Number(configured.slice(0, 4)) || 0);
  const values = new Set([...existing].map(normalizeAcademicYear).filter(Boolean));
  if (configured) values.add(configured);
  for (let start = newest; start >= Math.max(1900, newest - 30); start--) values.add(`${start}/${start + 1}`);
  return [...values].sort((a, b) => compareAcademicYears(a, b, configured));
}
export function orderResourcesByAcademicYear(items, sort = 'recent', currentYear = '', filterYear = '') {
  const titleOrder = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
  const partOrder = (a, b) => compareParts(a.part, b.part) || titleOrder(a, b);
  const dateValue = item => new Date(item.date || item.created_at).getTime() || 0;
  return [...items].sort((a, b) => {
    const yearOrder = compareAcademicYears(resourceDisplayYear(a, currentYear, filterYear), resourceDisplayYear(b, currentYear, filterYear), currentYear);
    if (yearOrder) return yearOrder;
    if (sort === 'title') return titleOrder(a, b) || compareParts(a.part, b.part);
    if (sort === 'part') return normalizeModule(a.module).localeCompare(normalizeModule(b.module))
      || String(a.category || '').localeCompare(String(b.category || '')) || partOrder(a, b);
    return (sort === 'oldest' ? dateValue(a) - dateValue(b) : dateValue(b) - dateValue(a)) || partOrder(a, b);
  });
}
export function groupResourcesByAcademicYear(items, currentYear = '', filterYear = '') {
  const groups = new Map();
  for (const resource of items) {
    const year = resourceDisplayYear(resource, currentYear, filterYear);
    if (!groups.has(year)) groups.set(year, { year, documents: [] });
    groups.get(year).documents.push(resource);
  }
  return [...groups.values()].sort((a, b) => compareAcademicYears(a.year, b.year, currentYear));
}

// Broad rights come only from the authenticated server's scope calculation.
// The fallback keeps legacy ordinary sessions usable within their study pair.
export function uploadScopesForUser(user) {
  const capability = user?.uploadCapabilities ?? user?.upload_capabilities;
  if (capability && Array.isArray(capability.scopes)) {
    return capability.scopes.map(scope => ({
      facultyId: scope.facultyId, filiereId: scope.filiereId,
      semesters: [...new Set((scope.semesters || []).map(semesterNumber).filter(value => [1, 2, 3, 4, 5, 6].includes(value)))],
    })).filter(scope => scope.facultyId && scope.filiereId && scope.semesters.length);
  }
  if (user?.role !== 'student' || !user.facultyId || !user.filiereId) return [];
  const semester = semesterNumber(user.semester);
  if (![1, 2, 3, 4, 5, 6].includes(semester)) return [];
  const first = Math.floor((semester - 1) / 2) * 2 + 1;
  return [{ facultyId: user.facultyId, filiereId: user.filiereId, semesters: [first, first + 1] }];
}

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

// Relative paths describe the uploaded hierarchy. Keep each uploader's tree
// and document type separate when their folder names match.
export function resourceDirectory(resource) {
  return String(resource?.path || resource?.relative_path || resource?.originalName || '')
    .split('/').filter(Boolean).slice(0, -1).join('/');
}
export const UNKNOWN_CONTRIBUTOR = 'unknown';
export function resourceFolderOwner(resource) {
  const owner = resource?.uploaderId ?? resource?.uploader_id ?? resource?.author_id ?? resource?.author?.id;
  return owner == null || owner === '' ? UNKNOWN_CONTRIBUTOR : String(owner);
}
export function browseResourceDirectory(resources, path = '', owner = '', category = '') {
  const folders = new Map(), documents = [];
  const prefix = path ? `${path}/` : '';
  for (const resource of resources) {
    if (resource.status === 'removed' || resource.removed || resource.libraryVisible === false || resource.library_visible === false
      || (owner && resourceFolderOwner(resource) !== owner) || (category && resourceCategory(resource) !== category)) continue;
    const directory = resourceDirectory(resource);
    if (directory === path) { documents.push(resource); continue; }
    if (path && !directory.startsWith(prefix)) continue;
    const name = directory.slice(prefix.length).split('/')[0];
    if (!name) continue;
    const folderOwner = resourceFolderOwner(resource), folderPath = prefix + name;
    const key = JSON.stringify([folderPath, folderOwner, resource.category||'']);
    if (!folders.has(key)) folders.set(key, { key, name, category:resource.category||'', path: folderPath, owner: folderOwner, uploader: resource.uploaderUsername ? `@${resource.uploaderUsername.replace(/^@/, '')}` : resource.uploader || '', count: 0 });
    folders.get(key).count++;
  }
  return { folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)
    || a.owner.localeCompare(b.owner) || a.category.localeCompare(b.category)), documents };
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
  const module = item.moduleId != null || item.module_id != null ? `id:${item.moduleId ?? item.module_id}` : normalizeModule(item.module);
  const semester = semesterNumber(item.semester);
  if (!item.facultyId || !item.filiereId || !module || !item.category
    || ![1, 2, 3, 4, 5, 6].includes(semester) || !part) return '';
  return JSON.stringify([item.facultyId, item.filiereId, semester, module, item.category, part,
    resourceFolderOwner(item), String(item.path || item.relative_path || item.originalName || ''), resourceAcademicYears(item)[0] || 'unknown']);
}
function resourceSlotKeys(item) {
  const key = resourceSlotKey(item);
  if (!key) return [];
  const base = JSON.parse(key).slice(0, -1);
  const years = resourceAcademicYears(item);
  return (years.length ? years : ['unknown']).map(year => JSON.stringify([...base, year]));
}
export function findResourceConflicts(candidates, existing = []) {
  const occupied = new Map();
  for (const item of existing) {
    if (item.status === 'removed') continue;
    for (const key of resourceSlotKeys(item)) if (!occupied.has(key)) occupied.set(key, item);
  }
  const batch = new Map();
  candidates.forEach((item, index) => {
    for (const key of resourceSlotKeys(item)) batch.set(key, [...(batch.get(key) || []), index]);
  });
  return candidates.flatMap((resource, index) => {
    for (const key of resourceSlotKeys(resource)) {
      if (occupied.has(key)) return [{ index, resource, conflict: occupied.get(key), source: 'existing', key }];
      const other = batch.get(key).find(i => i !== index);
      if (other !== undefined) return [{ index, resource, conflict: candidates[other], source: 'batch', key }];
    }
    return [];
  });
}
