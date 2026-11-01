import test from 'node:test';
import assert from 'node:assert/strict';
import { browseResourceDirectory, resourceDirectory } from '../src/lib/resources.js';

test('folder navigation retains nested paths and separates equal names from different uploaders', () => {
  const files = [
    { id: 1, path: 'direct.pdf', uploaderUsername: 'alice' },
    { id: 2, path: 'Cours/chapitre.pdf', uploaderUsername: 'alice' },
    { id: 3, path: 'Cours/TD/exercice.pdf', uploaderUsername: 'alice' },
    { id: 4, path: 'Cours/autre.pdf', uploaderUsername: 'bob' },
    { id: 5, path: 'Cours/TD/retire.pdf', uploaderUsername: 'alice', status: 'removed' },
  ];
  const before = structuredClone(files);
  const root = browseResourceDirectory(files);
  assert.deepEqual(root.documents.map(item => item.id), [1]);
  assert.deepEqual(root.folders.map(folder => [folder.path, folder.owner, folder.count]), [['Cours', 'alice', 2], ['Cours', 'bob', 1]]);
  const alice = browseResourceDirectory(files, 'Cours', 'alice');
  assert.deepEqual(alice.documents.map(item => item.id), [2]);
  assert.deepEqual(alice.folders.map(folder => [folder.path, folder.owner, folder.count]), [['Cours/TD', 'alice', 1]]);
  assert.deepEqual(browseResourceDirectory(files, 'Cours/TD', 'alice').documents.map(item => item.id), [3]);
  assert.deepEqual(browseResourceDirectory(files, 'Cours', 'bob').documents.map(item => item.id), [4]);
  assert.deepEqual(browseResourceDirectory(files, 'Inexistant', 'alice'), { documents: [], folders: [] });
  assert.deepEqual(files, before);
});

test('folder paths preserve Unicode and segment boundaries', () => {
  const files = [{ id: 1, path: 'دروس/جزء 1/نص.pdf' }, { id: 2, path: 'Cours bis/test.pdf' }, { id: 3, path: 'Cours/test.pdf' }];
  assert.equal(resourceDirectory(files[0]), 'دروس/جزء 1');
  assert.deepEqual(browseResourceDirectory(files, 'Cours').documents.map(item => item.id), [3]);
  assert.equal(browseResourceDirectory(files, 'Cours').folders.length, 0);
  assert.equal(browseResourceDirectory(files, 'دروس').folders[0].name, 'جزء 1');
});


test('same uploader and path keep distinct document categories separate',()=>{
 const files=[{id:1,path:'Maths/a.pdf',author_id:3,category:'courses'},{id:2,path:'Maths/b.pdf',author_id:3,category:'td'}];
 const result=browseResourceDirectory(files);
 assert.equal(result.folders.length,2);
 assert.deepEqual(result.folders.map(f=>f.category).sort(),['courses','td']);
 assert.ok(result.folders.every(f=>f.count===1));
});

test('TD and TP folder navigation preserves type across matching nested paths and uploaders', () => {
  const files = [
    { id: 'td-direct', path: 'Maths/exercices.pdf', author_id: 3, category: 'td' },
    { id: 'tp-direct', path: 'Maths/manipulation.pdf', author_id: 3, category: 'tp' },
    { id: 'td-nested', path: 'Maths/Semaine 1/serie.pdf', author_id: 3, category: 'td' },
    { id: 'tp-nested', path: 'Maths/Semaine 1/labo.pdf', author_id: 3, category: 'tp' },
    { id: 'other-owner', path: 'Maths/Semaine 1/serie.pdf', author_id: 4, category: 'td' },
    { id: 'removed', path: 'Maths/Semaine 1/retire.pdf', author_id: 3, category: 'td', status: 'removed' },
  ];
  const before = structuredClone(files);
  const root = browseResourceDirectory(files);
  assert.deepEqual(root.folders.map(folder => [folder.owner, folder.category, folder.count]), [
    ['3', 'td', 2], ['3', 'tp', 2], ['4', 'td', 1],
  ]);
  assert.equal(new Set(root.folders.map(folder => folder.key)).size, 3);
  const all = browseResourceDirectory(files, 'Maths', '3');
  assert.deepEqual(all.documents.map(file => file.id), ['td-direct', 'tp-direct']);
  assert.deepEqual(all.folders.map(folder => [folder.path, folder.category, folder.count]), [
    ['Maths/Semaine 1', 'td', 1], ['Maths/Semaine 1', 'tp', 1],
  ]);
  for (const category of ['td', 'tp']) {
    const selected = browseResourceDirectory(files, 'Maths', '3', category);
    assert.deepEqual(selected.documents.map(file => file.id), [`${category}-direct`]);
    assert.deepEqual(selected.folders.map(folder => [folder.path, folder.owner, folder.category, folder.count]), [
      ['Maths/Semaine 1', '3', category, 1],
    ]);
    assert.deepEqual(browseResourceDirectory(files, 'Maths/Semaine 1', '3', category).documents.map(file => file.id), [`${category}-nested`]);
  }
  assert.deepEqual(browseResourceDirectory(files, 'Maths', '3', 'exams'), { documents: [], folders: [] });
  assert.deepEqual(files, before);
});
