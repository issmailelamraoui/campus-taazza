import { groupResourcesByModule, moduleDisplayName, normalizeModule } from './resources.js';

// Search normalization is deliberately separate from canonical module IDs.
// It helps students find accented and vocalized labels without changing them.
export function normalizeLibrarySearch(value) {
  let text;
  try { text = String(value ?? ''); }
  catch { return ''; }
  return text.normalize('NFKD').replace(/[\p{M}\u0640]/gu, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

const searchableFields = ['title', 'originalName', 'module', 'author', 'uploader', 'uploaderUsername', 'fileType', 'path'];

export function matchesLibrarySearch(resource, query) {
  const search = normalizeLibrarySearch(query);
  if (!search) return true;
  const text = searchableFields.map(field => normalizeLibrarySearch(resource?.[field])).join(' ');
  return search.split(' ').every(term => text.includes(term));
}

// The library's document page is independent of a PDF reader's page parameter.
export function parseLibraryDocumentPage(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page - 1 : 0;
}

export function normalizeLibraryDate(value) {
  return ['7', '30', '90'].includes(value) ? value : 'all';
}
const semesterNumber = value => typeof value === 'number' || typeof value === 'string'
  ? Number(String(value).replace(/^s/i, '')) : NaN;
const validModuleName = value => typeof value === 'string' && !value.includes('\0');

// A catalog entry can exist before its first Library document. Retain both it
// and upload-only legacy modules, but never borrow labels from another scope.
export function mergeLibraryModuleFolders(resources, catalog, scope) {
  const semester = semesterNumber(scope?.semester);
  if (typeof scope?.facultyId !== 'string' || !scope.facultyId
    || typeof scope?.filiereId !== 'string' || !scope.filiereId
    || ![1, 2, 3, 4, 5, 6].includes(semester)) return [];

  const folders = new Map();
  for (const item of Array.isArray(catalog) ? catalog : []) {
    if (!item || !validModuleName(item.name) || !normalizeModule(item.name)
      || item.filiere_id !== scope.filiereId || semesterNumber(item.semester) !== semester
      || (item.faculty_id != null && item.faculty_id !== scope.facultyId)) continue;
    const key = normalizeModule(item.name);
    if (!folders.has(key)) folders.set(key, { key, name: moduleDisplayName(item.name), documents: [] });
  }

  const scopedResources = (Array.isArray(resources) ? resources : []).filter(item => item
    && item.facultyId === scope.facultyId && item.filiereId === scope.filiereId
    && semesterNumber(item.semester) === semester && item.libraryVisible !== false
    && item.status !== 'removed' && (item.module == null || validModuleName(item.module)));
  for (const group of groupResourcesByModule(scopedResources)) {
    if (folders.has(group.key)) folders.get(group.key).documents = group.documents;
    else folders.set(group.key, group);
  }
  return [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
}
