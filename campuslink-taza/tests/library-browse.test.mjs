import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLibrarySearch,
  matchesLibrarySearch,
  parseLibraryDocumentPage,
  normalizeLibraryDate,
  mergeLibraryModuleFolders,
} from '../src/lib/library-browse.js';

test('library search matches accents and compatibility forms without changing displayed data', () => {
  const resource = Object.freeze({ title: 'Économie : méthodes de révision', module: 'ＳＴＡＴＩＳＴＩＱＵＥＳ' });
  assert.equal(normalizeLibrarySearch('  ÉCONOMIE\t me\u0301thodes  '), 'economie methodes');
  assert.equal(matchesLibrarySearch(resource, 'methodes statistiques economie'), true);
  assert.equal(resource.title, 'Économie : méthodes de révision');
  assert.equal(resource.module, 'ＳＴＡＴＩＳＴＩＱＵＥＳ');
});

test('Arabic vocalization and tatweel do not prevent an unvocalized search', () => {
  const resource = { title: 'دُرُوس الإِحْصَاء', module: 'العُـلُوم' };
  assert.equal(normalizeLibrarySearch('  دُرُوسُ  العُـلُومِ  '), 'دروس العلوم');
  assert.equal(matchesLibrarySearch(resource, 'الاحصاء دروس العلوم'), true);
  assert.equal(matchesLibrarySearch(resource, 'دروس الكيمياء'), false);
});

test('all search words must match, in any order and across different document fields', () => {
  const resource = {
    title: 'Graphes et réseaux', originalName: 'chapitre-final.pdf', module: 'Data Science',
    author: 'Pr. Chloé', uploader: 'Sara Benali', uploaderUsername: 'sara.demo',
    fileType: 'PDF', path: 'Archives/Algorithmes/chapitre-final.pdf',
  };
  for (const query of ['chloe graphes', 'science sara', 'pdf archives', 'sara.demo final algorithmes', 'réseaux data']) {
    assert.equal(matchesLibrarySearch(resource, query), true, query);
  }
  assert.equal(matchesLibrarySearch(resource, 'graphes chimie'), false);
  assert.equal(matchesLibrarySearch(resource, 'mathématiques'), false);
  assert.equal(matchesLibrarySearch({ title: 'Analyse' }, 'analyse'), true);
  assert.equal(matchesLibrarySearch({}, 'analyse'), false);
});

test('empty search admits every resource and code-language punctuation stays meaningful', () => {
  for (const query of ['', ' \t\n ', null, undefined]) {
    assert.equal(matchesLibrarySearch(null, query), true);
    assert.equal(matchesLibrarySearch({ title: 'Algèbre' }, query), true);
  }
  assert.equal(matchesLibrarySearch({ title: 'Introduction C++' }, 'c++'), true);
  assert.equal(matchesLibrarySearch({ title: 'Introduction Python' }, 'c++'), false);
});

test('document-page URLs are one based while the library slice is zero based', () => {
  assert.equal(parseLibraryDocumentPage('1'), 0);
  assert.equal(parseLibraryDocumentPage('2'), 1);
  assert.equal(parseLibraryDocumentPage('25'), 24);
  assert.equal(parseLibraryDocumentPage('002'), 1);
  assert.equal(parseLibraryDocumentPage(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER - 1);
});

test('malformed and unsafe page parameters fall back to the first document page', () => {
  for (const value of [undefined, null, '', '0', '000', '-1', '+2', '1.5', '1e2', '2files', ' 2 ', 'NaN', 'Infinity',
    '9007199254740992', '999999999999999999999999999999999', 2, {}, [], Symbol('page')]) {
    assert.equal(parseLibraryDocumentPage(value), 0, String(value));
  }
});

test('date URLs accept only the supported lookback windows', () => {
  for (const value of ['7', '30', '90']) assert.equal(normalizeLibraryDate(value), value);
  for (const value of [undefined, null, '', 'all', 'banana', '-1', '0', '365', '7days', ' 7 ', 7, {}, [], Symbol('date')]) {
    assert.equal(normalizeLibraryDate(value), 'all', String(value));
  }
});

test('missing and malformed search data does not crash browsing', () => {
  const uncoercible = Object.create(null);
  assert.equal(normalizeLibrarySearch(uncoercible), '');
  for (const value of [null, undefined, false, 123, [], {}, Symbol('test'), uncoercible]) {
    assert.doesNotThrow(() => normalizeLibrarySearch(value));
    assert.doesNotThrow(() => matchesLibrarySearch(value, 'cours'));
    assert.doesNotThrow(() => matchesLibrarySearch({ title: value }, 'cours'));
    assert.doesNotThrow(() => matchesLibrarySearch({ title: 'Cours' }, value));
  }
});

const moduleScope = Object.freeze({ facultyId: 'fsa', filiereId: 'data_science', semester: 5 });
const catalogModule = (name, extra = {}) => ({ id: 1, name, filiere_id: 'data_science', semester: 5, ...extra });
const libraryDocument = (id, module, extra = {}) => ({ id, module, ...moduleScope, title: `Document ${id}`, ...extra });

test('empty catalog modules do not create library folders or mutate the upload catalog', () => {
  const catalog = Object.freeze([Object.freeze(catalogModule('Traitement d’image', { catalog_status: 'official' }))]);
  assert.deepEqual(mergeLibraryModuleFolders([], catalog, moduleScope), []);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].catalog_status, 'official');
});

test('catalog and uploads merge canonical module variants but keep distinct accented identities', () => {
  const first = libraryDocument(101, '  xml  ',{moduleId:'1'}), second = libraryDocument(102, 'ＸＭＬ',{moduleId:'1'});
  const resources = Object.freeze([Object.freeze(first), Object.freeze(second), Object.freeze(libraryDocument(103, 'Économie')), Object.freeze(libraryDocument(104, 'Economie', { moduleId: '2' }))]);
  const catalog = [catalogModule('XML'), catalogModule('  ＸＭＬ  '), catalogModule('Economie',{id:2})];
  const folders = mergeLibraryModuleFolders(resources, catalog, moduleScope);
  assert.equal(folders.length, 3);
  assert.deepEqual(folders.find(folder => folder.key === 'id:1').documents, [first, second]);
  assert.equal(folders.find(folder => folder.key === 'id:2').documents.length, 1);
  assert.equal(folders.find(folder => folder.key === 'legacy:économie').documents.length, 1);
  assert.equal(first.module, '  xml  ');
  assert.equal(second.module, 'ＸＭＬ');
  assert.deepEqual(catalog.map(item => item.name), ['XML', '  ＸＭＬ  ', 'Economie']);
});

test('module catalog entries must belong to the requested program and exact semester', () => {
  const catalog = [catalogModule('Valid'),
    catalogModule('Other faculty', { faculty_id: 'feg' }),
    catalogModule('Other program', { filiere_id: 'mathematics' }),
    catalogModule('Other semester', { semester: 4 }),
    catalogModule('Unassigned program', { filiere_id: null }),
    catalogModule('No semester', { semester: null }),
    catalogModule('Missing program', { filiere_id: undefined }),
  ];
  assert.deepEqual(mergeLibraryModuleFolders([libraryDocument(1, 'Fallback', { moduleId: '1' })], catalog, moduleScope).map(folder => folder.name), ['VALID']);
});

test('legacy upload-only and unclassified modules survive an empty or incomplete catalog', () => {
  const legacy = libraryDocument(1, 'Ancien module'), unclassified = libraryDocument(2, '');
  const folders = mergeLibraryModuleFolders([legacy, unclassified], [catalogModule('Nouveau module')], moduleScope);
  assert.deepEqual(folders.find(folder => folder.key === 'legacy:ancien module').documents, [legacy]);
  assert.deepEqual(folders.find(folder => folder.key === 'legacy:').documents, [unclassified]);
  assert.equal(folders.find(folder => folder.key === 'id:1'), undefined, 'An empty catalog entry is not a student library folder.');
  assert.equal(mergeLibraryModuleFolders([legacy], null, moduleScope)[0].documents[0], legacy);
});

test('catalog merging cannot expose another study scope or non-Library documents', () => {
  const visible = libraryDocument(1, 'Visible');
  const resources = [visible,
    libraryDocument(2, 'Wrong faculty', { facultyId: 'feg' }),
    libraryDocument(3, 'Wrong program', { filiereId: 'mathematics' }),
    libraryDocument(4, 'Wrong semester', { semester: 4 }),
    libraryDocument(5, 'Chat attachment', { libraryVisible: false }),
    libraryDocument(6, 'Removed', { status: 'removed' }),
  ];
  assert.deepEqual(mergeLibraryModuleFolders(resources, [], moduleScope), [{ key: 'legacy:visible', id:null, rawName:'Visible', name: 'VISIBLE', catalogStatus:'legacy', documents: [visible] }]);
});

test('malformed catalog names and missing scope do not create broken module choices', () => {
  const catalog = [null, {}, catalogModule(''), catalogModule(' \t '), catalogModule(null),
    catalogModule({}), catalogModule('Bad\0name'), catalogModule('Good')];
  assert.deepEqual(mergeLibraryModuleFolders([libraryDocument(1, 'Good', { moduleId: '1' })], catalog, moduleScope).map(folder => folder.name), ['GOOD']);
  for (const scope of [null, undefined, {}, { ...moduleScope, filiereId: null }, { ...moduleScope, semester: 9 }]) {
    assert.deepEqual(mergeLibraryModuleFolders([libraryDocument(1, 'Secret')], [catalogModule('Secret')], scope), []);
  }
  assert.deepEqual(mergeLibraryModuleFolders(null, {}, moduleScope), []);
});
