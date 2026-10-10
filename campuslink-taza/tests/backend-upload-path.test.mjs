import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadFilePath } from '../server/upload-path.js';

test('optional folder metadata leaves existing single-file names unchanged', () => {
  assert.deepEqual(uploadFilePath('course.pdf'), { filename: 'course.pdf', relativePath: '' });
  assert.deepEqual(uploadFilePath('../notes\u0001.pdf', ''), { filename: 'notes.pdf', relativePath: '' });
  assert.deepEqual(uploadFilePath('a'.repeat(181) + '.pdf'), { filename: 'a'.repeat(180), relativePath: '' });
});

test('folder metadata preserves nested paths, spaces and Unicode names', () => {
  for (const relativePath of ['Cours/TD/correction.pdf', ' Mon dossier / notes .pdf', 'Dossier français/دروس/cours-économie-عربي.pdf', 'a'.repeat(255) + '/course.pdf']) {
    const filename = relativePath.split('/').at(-1);
    assert.deepEqual(uploadFilePath(filename, relativePath), { filename, relativePath });
    const multipartName = Buffer.from(filename, 'utf8').toString('latin1');
    assert.deepEqual(uploadFilePath(multipartName, relativePath), { filename, relativePath });
  }
  assert.deepEqual(uploadFilePath('course.pdf', 'course.pdf'), { filename: 'course.pdf', relativePath: 'course.pdf' });
});

test('folder metadata rejects traversal, malformed paths and mismatched filenames', () => {
  const paths = [null, 5, {}, '/Cours/course.pdf', '../course.pdf', 'Cours/../course.pdf', './course.pdf', 'Cours//course.pdf', 'Cours/course.pdf/', 'C:/Cours/course.pdf', 'Cours\\course.pdf', 'Cours/\u0000course.pdf', 'Cours/\u007fcourse.pdf', 'Cours/other.pdf', 'a'.repeat(256) + '/course.pdf', 'Root/' + 'a'.repeat(181) + '.pdf', Array(64).fill('folder').join('/') + '/course.pdf', 'a'.repeat(2049)];
  for (const path of paths) assert.throws(() => uploadFilePath('course.pdf', path), error => error.status === 400, String(path));
  // Invalid UTF-8 cannot be repaired into a different submitted filename.
  assert.throws(() => uploadFilePath('cours-\u00e9.pdf', 'Dossier/cours-e.pdf'), error => error.status === 400);
});
