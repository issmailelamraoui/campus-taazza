import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_RESOURCES } from '../src/data/mock.js';
import { groupResourcesByModule, moduleDisplayName, normalizePart, normalizeModule, moduleSuggestions, findResourceConflicts, resourceSlotKey, compareParts, normalizeAcademicYear, resourceAcademicYears, orderResourcesByAcademicYear, groupResourcesByAcademicYear, academicYearOptions, uploadScopesForUser } from '../src/lib/resources.js';
import { SUPPORTED_FILE_ACCEPT, isSupportedFile, fileTypeLabel, collectDirectoryEntry, filesFromDrop, normalizeRelativePath, uploadFileIssue, MAX_UPLOAD_FILE_BYTES } from '../src/lib/files.js';

const scope = { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 };
const course = { ...scope, module: 'Linguistique', category: 'courses', part: '1', title: 'Cours.pdf' };

test('module folders join legacy casing and Unicode variants without changing file records', () => {
  const files = ['XML', 'xml', 'Xml', 'xMl', ' ＸＭＬ '].map((module, index) => ({ ...course, id: String(index), module, title: `Titre ${index}`, originalName: `original-${index}.pdf`, objectKey: `private/${index}` }));
  const before = structuredClone(files);
  const groups = groupResourcesByModule([...files, { ...course, module: 'Databases' }, { ...course, module: 'xml', status: 'removed' }]);
  assert.deepEqual(groups.map(group => [group.key, group.name, group.documents.length]), [['databases', 'DATABASES', 1], ['xml', 'XML', 5]]);
  assert.deepEqual(groups[1].documents, files);
  assert.deepEqual(files, before);
  assert.equal(moduleDisplayName('  Administration   de bases '), 'ADMINISTRATION DE BASES');
});

test('module grouping retains every document in large and unclassified legacy folders', () => {
  const files = Array.from({ length: 1000 }, (_, id) => ({ ...course, id, module: id % 2 ? 'xml' : 'XML', part: String(id + 1) }));
  const groups = groupResourcesByModule([...files, { ...course, id: 'legacy', module: '' }]);
  assert.equal(groups.find(group => group.key === 'xml').documents.length, 1000);
  assert.equal(new Set(groups.find(group => group.key === 'xml').documents.map(file => file.id)).size, 1000);
  assert.equal(groups.find(group => group.key === '').documents[0].id, 'legacy');
});

test('Part/Chapitre requires a positive integer or Complet without an upper cap', () => {
  for (const value of ['', null, undefined, '0', '0000', '-1', '1.5', '1e3', 'Infinity']) assert.equal(normalizePart(value), '');
  assert.equal(normalizePart(' 00125 '), '125');
  assert.equal(normalizePart('999999999999999999999999999999999999999'), '999999999999999999999999999999999999999');
  assert.equal(normalizePart('Complet'), 'complete');
  assert.equal(normalizePart('COMPLETE'), 'complete');
  const huge = '999999999999999999999999999999999999999';
  assert.deepEqual(['complete', huge, '2', '125', '1', '10'].sort(compareParts), ['1', '2', '10', '125', huge, 'complete']);
});

test('module autocomplete uses uploaded resource scope and deduplicates spacing and case', () => {
  const data = [course,
    { ...course, module: '  LINGUISTIQUE  ', part: '2' },
    { ...course, module: 'Analyse   du discours', part: '3' },
    { ...course, module: 'Autre semestre', semester: 2 },
    { ...course, module: 'Autre filière', filiereId: 'arabic_studies' },
    { ...course, module: 'Retiré', status: 'removed' },
  ];
  assert.deepEqual(moduleSuggestions(data, scope, 'ling'), ['Linguistique']);
  assert.deepEqual(moduleSuggestions(data, scope, 'analyse du'), ['Analyse du discours']);
  assert.deepEqual(moduleSuggestions(data, scope, 'nouveau module libre'), []);
  assert.deepEqual(moduleSuggestions(data, { ...scope, semester: 6 }), []);
  assert.equal(normalizeModule(' Analyse   DU discours '), 'analyse du discours');
});

test('one file per slot detects existing and batch conflicts independently per category', () => {
  const existing = [{ ...course, id: 'existing' }];
  assert.equal(findResourceConflicts([{ ...course, module: ' LINGUISTIQUE ', part: '01' }], existing)[0].source, 'existing');
  const variants = [
    { ...course, category: 'exercises' }, { ...course, category: 'exams' },
    { ...course, category: 'rattrapage' }, { ...course, semester: 2 },
    { ...course, filiereId: 'arabic_studies' }, { ...course, module: 'Autre unité' },
    { ...course, part: 'complete' }, { ...course, part: '125' },
  ];
  assert.deepEqual(findResourceConflicts(variants, existing), []);
  const duplicate = findResourceConflicts([{ ...course, part: 'complete' }, { ...course, part: 'Complet' }]);
  assert.deepEqual(duplicate.map(item => item.index), [0, 1]);
  assert.ok(duplicate.every(item => item.source === 'batch'));
  assert.deepEqual(findResourceConflicts([course], [{ ...course, status: 'removed' }]), []);
});

test('demo resources retain complete required classifications without duplicate slots', () => {
  assert.ok(INITIAL_RESOURCES.every(item => resourceSlotKey(item) && item.originalName && item.fileType && item.size));
  assert.deepEqual(findResourceConflicts(INITIAL_RESOURCES), []);
});

test('device file selection accepts every requested format and rejects unsupported ones', () => {
  for (const extension of ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'tex', 'py', 'ipynb', 'c', 'cpp', 'h', 'hpp', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'xml', 'svg', 'json', 'csv', 'sql', 'java', 'zip', 'rar', '7z', 'tar', 'gz']) {
    assert.ok(SUPPORTED_FILE_ACCEPT.includes(`.${extension}`));
    assert.ok(isSupportedFile({ name: `Original File.${extension.toUpperCase()}` }));
    assert.equal(fileTypeLabel({ name: `file.${extension}` }), extension.toUpperCase());
  }
  assert.equal(isSupportedFile({ name: 'ignored.exe', type: 'application/pdf' }), false);
  assert.equal(isSupportedFile({ name: 'ignored.sh', type: 'text/plain' }), false);
  assert.equal(isSupportedFile({ name: 'no-extension', type: 'application/pdf' }), false);
});

test('academic years retain unknown legacy metadata and reject invented or malformed associations', () => {
  for (const value of [null, undefined, '', 'unknown', '2026', '2026/2028', '2026-2027', '1899/1900', '2200/2201']) assert.equal(normalizeAcademicYear(value), '');
  assert.equal(normalizeAcademicYear(' 2026/2027 '), '2026/2027');
  assert.deepEqual(resourceAcademicYears({ created_at: '2026-10-01T10:00:00Z' }), []);
  assert.deepEqual(resourceAcademicYears({ academic_year: '2024/2025', academic_years: '["2026/2027","2024/2025","2026/2027","bad"]' }), ['2026/2027', '2024/2025']);
  const options = academicYearOptions('2025/2026', ['1994/1995'], new Date('2026-10-01T00:00:00Z'));
  assert.equal(options[0], '2025/2026');
  assert.ok(options.includes('1994/1995'));
});

test('year-first ordering stays consistent before pagination and within upload-date or title sorts', () => {
  const files = [
    { id: 'old', title: 'A', academicYear: '2023/2024', date: '2026-10-10' },
    { id: 'unknown', title: 'A', date: '2026-10-11' },
    { id: 'current-z', title: 'Z', academicYear: '2026/2027', date: '2026-09-10' },
    { id: 'past', title: 'A', academicYear: '2025/2026', date: '2026-10-11' },
    { id: 'current-a', title: 'A', academicYear: '2026/2027', date: '2026-09-11' },
  ];
  const ordered = orderResourcesByAcademicYear(files, 'recent', '2026/2027');
  assert.deepEqual(ordered.map(file => file.id), ['current-a', 'current-z', 'past', 'old', 'unknown']);
  const pages = [ordered.slice(0, 2), ordered.slice(2, 4), ordered.slice(4)];
  assert.deepEqual(pages.map(page => groupResourcesByAcademicYear(page, '2026/2027').map(group => group.year)), [['2026/2027'], ['2025/2026', '2023/2024'], ['']]);
  assert.deepEqual(orderResourcesByAcademicYear(files, 'oldest', '2026/2027').map(file => file.id), ['current-z', 'current-a', 'past', 'old', 'unknown']);
  assert.deepEqual(orderResourcesByAcademicYear(files, 'title', '2026/2027').map(file => file.id), ['current-a', 'current-z', 'past', 'old', 'unknown']);
});

test('reused material keeps one resource and occupies every associated year without forbidding other promotions', () => {
  const reused = { ...course, id: 'reused', academicYears: ['2026/2027', '2024/2025'] };
  const grouped = groupResourcesByAcademicYear([reused], '2026/2027');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].year, '2026/2027');
  assert.equal(grouped[0].documents[0], reused);
  assert.equal(groupResourcesByAcademicYear([reused], '2026/2027', '2024/2025')[0].year, '2024/2025');
  assert.equal(findResourceConflicts([{ ...course, academicYear: '2024/2025' }], [reused])[0].source, 'existing');
  assert.deepEqual(findResourceConflicts([{ ...course, academicYear: '2025/2026' }], [reused]), []);
  assert.equal(findResourceConflicts([{ ...course, academicYear: '2024/2025' }, { ...course, academicYears: ['2024/2025', '2023/2024'] }]).length, 2);
  assert.deepEqual(findResourceConflicts([{ ...course, academicYear: '2024/2025' }], [course]), []);
});

test('upload UI follows server scopes and never infers broad permissions from role labels or client XP', () => {
  const student = { role: 'student', facultyId: 'flaa', filiereId: 'french_studies', semester: 3, xp: 9999999, facultyLeader: true };
  assert.deepEqual(uploadScopesForUser(student), [{ facultyId: 'flaa', filiereId: 'french_studies', semesters: [3, 4] }]);
  assert.deepEqual(uploadScopesForUser({ ...student, role: 'faculty_admin' }), []);
  assert.deepEqual(uploadScopesForUser({ ...student, uploadCapabilities: { scopes: [] } }), []);
  const authorized = { facultyId: 'flaa', filiereId: 'arabic_studies', semesters: [1, 2, 3, 4, 5, 6] };
  assert.deepEqual(uploadScopesForUser({ ...student, role: 'faculty_admin', upload_capabilities: { scopes: [authorized], source: 'appointment' } }), [authorized]);
  assert.deepEqual(uploadScopesForUser({ ...student, uploadCapabilities: { scopes: [{ ...authorized, filiereId: 'french_studies' }], source: 'xp_leader' } })[0].semesters, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(uploadScopesForUser({ ...student, semester: 7 }), []);
});

test('selection rejects path traversal, excessive nesting and oversized files while preserving Unicode folders', () => {
  assert.equal(normalizeRelativePath('محاضرات/Cours/notes.py', 'notes.py'), 'محاضرات/Cours/notes.py');
  for (const path of ['../notes.py', '/notes.py', 'Cours/./notes.py', 'Cours\\notes.py', 'C:/notes.py', 'Cours//notes.py', 'Cours/notes\u0000.py', `${'nested/'.repeat(64)}notes.py`]) assert.equal(normalizeRelativePath(path), '');
  assert.equal(normalizeRelativePath('Cours/other.py', 'notes.py'), '');
  assert.equal(uploadFileIssue({ name: 'notes.py', size: MAX_UPLOAD_FILE_BYTES }, 'Cours/notes.py'), '');
  assert.equal(uploadFileIssue({ name: 'notes.py', size: MAX_UPLOAD_FILE_BYTES + 1 }), 'size');
  assert.equal(uploadFileIssue({ name: 'notes.exe', size: 1, type: 'text/plain' }), 'format');
  assert.equal(uploadFileIssue({ name: 'notes.py', size: 1 }, '../notes.py'), 'path');
});

test('nested folder drop reads all reader batches and preserves every relative path', async () => {
  const file = name => ({ name, isFile: true, file: resolve => resolve({ name }) });
  const folder = (name, batches) => ({ name, isDirectory: true, createReader: () => { let index = 0; return { readEntries: resolve => resolve(batches[index++] || []) }; } });
  const deep = folder('deep', [[file('slides.pptx')], [file('notes.txt')], []]);
  const root = folder('Cours', [[file('cours.pdf'), folder('nested', [[deep], []])], [file('tableau.xlsx')], []]);
  const paths = (await collectDirectoryEntry(root)).map(item => item.path);
  assert.deepEqual(paths, ['Cours/cours.pdf', 'Cours/nested/deep/slides.pptx', 'Cours/nested/deep/notes.txt', 'Cours/tableau.xlsx']);
  const dropped = await filesFromDrop({ items: [{ kind: 'file', webkitGetAsEntry: () => root }], files: [] });
  assert.deepEqual(dropped.map(item => item.path), paths);
  const fallback = await filesFromDrop({ items: [], files: [{ name: 'image.png', webkitRelativePath: 'Album/image.png' }] });
  assert.equal(fallback[0].path, 'Album/image.png');
});
