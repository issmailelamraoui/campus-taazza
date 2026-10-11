import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_RESOURCES } from '../src/data/mock.js';
import { groupResourcesByModule, moduleDisplayName, normalizePart, normalizeModule, moduleSuggestions, findResourceConflicts, resourceSlotKey, compareParts } from '../src/lib/resources.js';
import { SUPPORTED_FILE_ACCEPT, isSupportedFile, fileTypeLabel, collectDirectoryEntry, filesFromDrop } from '../src/lib/files.js';

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
  for (const extension of ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt']) {
    assert.ok(SUPPORTED_FILE_ACCEPT.includes(`.${extension}`));
    assert.ok(isSupportedFile({ name: `Original File.${extension.toUpperCase()}` }));
    assert.equal(fileTypeLabel({ name: `file.${extension}` }), extension.toUpperCase());
  }
  assert.equal(isSupportedFile({ name: 'ignored.zip', type: 'application/zip' }), false);
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
