import { moduleDisplayName, normalizeModule, resourceFolderOwner, UNKNOWN_CONTRIBUTOR } from './resources.js';
import { resourceCategory } from '../../shared/resource-categories.js';

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

// The catalog supplies academic labels; visible folders come from accessible
// files. Empty catalog entries remain available to the upload selector, without
// creating ghost folders after the last file is moved, hidden or removed.
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
    const key = item.id == null ? `legacy:${normalizeModule(item.name)}` : `id:${item.id}`;
    if (!folders.has(key)) folders.set(key, { key, id: item.id == null ? null : String(item.id), rawName: item.name, name: moduleDisplayName(item.name), catalogStatus: item.catalog_status || 'legacy', documents: [] });
  }

  const scopedResources = (Array.isArray(resources) ? resources : []).filter(item => item
    && item.facultyId === scope.facultyId && item.filiereId === scope.filiereId
    && semesterNumber(item.semester) === semester && item.libraryVisible !== false
    && item.library_visible !== false && item.library_visible !== 0
    && !item.removed && item.status !== 'removed' && (item.module == null || validModuleName(item.module)));
  for (const resource of scopedResources) {
    const id = resource.moduleId ?? resource.module_id;
    let key = id == null ? `legacy:${normalizeModule(resource.module)}` : `id:${id}`;
    if (!folders.has(key)) folders.set(key, { key, id: id == null ? null : String(id), rawName: resource.module || '', name: moduleDisplayName(resource.module), catalogStatus: 'legacy', documents: [] });
    folders.get(key).documents.push(resource);
  }
  return [...folders.values()].filter(folder => folder.documents.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function libraryModuleMatches(resource, selected, folders = []) {
  if (selected === null) return true;
  let entry = folders.find(item => item.key === selected);
  if (!entry && !selected.startsWith('id:') && !selected.startsWith('legacy:')) {
    const candidates = folders.filter(item => normalizeModule(item.rawName) === normalizeModule(selected));
    if (candidates.length !== 1) return false;
    entry = candidates[0];
  }
  if (entry?.id != null || selected.startsWith('id:')) return String(resource.moduleId ?? resource.module_id ?? '') === String(entry?.id ?? selected.slice(3));
  const name = entry?.rawName ?? selected.replace(/^legacy:/, '');
  return resource.moduleId == null && resource.module_id == null && normalizeModule(resource.module) === normalizeModule(name);
}

export function libraryContributors(resources, category) {
  const contributors = new Map();
  for (const item of resources) {
    if (item.status === 'removed' || item.removed || item.libraryVisible === false || item.library_visible === false || resourceCategory(item) !== category) continue;
    const owner = resourceFolderOwner(item);
    if (!contributors.has(owner)) contributors.set(owner, { id: owner,
      name: owner === UNKNOWN_CONTRIBUTOR ? '' : item.uploader || item.author?.name || item.uploaderUsername || item.author?.username || '', count: 0 });
    contributors.get(owner).count++;
  }
  return [...contributors.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
