import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareUploadFiles, runUploadBatch, MAX_UPLOAD_BYTES } from '../src/upload-batch.js';

test('recursive selection preserves paths and validates each file independently', () => {
  const rows = prepareUploadFiles([
    { name: 'analyse.pdf', size: 12, webkitRelativePath: 'Cours/S1/analyse.pdf' },
    { name: 'analyse.pdf', size: 18, webkitRelativePath: 'Cours/دروس/analyse.pdf' },
    { name: 'notes.txt', size: 0 }, { name: 'big.pdf', size: MAX_UPLOAD_BYTES + 1 }, { name: 'archive.zip', size: 22 },
    { name: 'notes.DOC', size: 10 },
  ], true);
  assert.equal(rows[0].relativePath, 'Cours/S1/analyse.pdf');
  assert.equal(rows[1].relativePath, 'Cours/دروس/analyse.pdf');
  assert.deepEqual(rows.map(row => row.status), ['queued', 'queued', 'skipped', 'skipped', 'skipped', 'queued']);
  assert.equal(rows[0].title, 'analyse');
  assert.equal(prepareUploadFiles([{ name: 'one.pdf', size: 12 }])[0].relativePath, '');
});

test('batch bounds concurrent requests and retries only failures', async () => {
  let active = 0, peak = 0;
  const calls = [];
  let rows = prepareUploadFiles(Array.from({ length: 5 }, (_, id) => ({ name: `${id}.pdf`, size: 10 })));
  const update = (id, patch) => { rows = rows.map(row => row.id === id ? { ...row, ...patch } : row); };
  await runUploadBatch(rows, async row => {
    calls.push(row.id); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 8)); active--;
    if (row.id === 1) throw Object.assign(new Error('duplicate'), { status: 409, data: { resource: { id: 101 } } });
    if (row.id === 3) throw new Error('offline');
    return { resource: { id: row.id } };
  }, update);
  assert.equal(peak, 2);
  assert.deepEqual(rows.map(row => row.status), ['uploaded', 'duplicate', 'uploaded', 'error', 'uploaded']);
  await runUploadBatch(rows, async row => { calls.push(row.id); return { resource: { id: row.id } }; }, update);
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 3]);
  assert.ok(rows.every(row => ['uploaded', 'duplicate'].includes(row.status)));
});
