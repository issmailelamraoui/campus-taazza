import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, normalizeBootstrap } from '../src/lib/backend.js';

const share = { resource_id: 42, module_id: 12, faculty_id: 'fsa', filiere_id: 'mathematics', semester: 4, module: 'Probabilités et Statistiques', accessible: true };
test('module references preserve their exact library scope while year-chat message semesters normalize separately', () => {
  const result = normalizeMessage({ id: 9, channel: 'filiere', semester: 6, content: 'Mon message personnel.', shared_module: share });
  assert.equal(result.channel, 'year-5'); assert.equal(result.content, 'Mon message personnel.');
  assert.deepEqual(result.sharedModule, { resourceId: '42', moduleId: '12', facultyId: 'fsa', filiereId: 'mathematics', semester: 4, module: share.module, accessible: true });
  assert.deepEqual(result.attachments, [], 'A module reference never becomes a republished library file.');
});
test('historical shares without a canonical ID retain their label without inventing an association',()=>{
  const result=normalizeMessage({id:9,shared_module:{...share,module_id:null}});
  assert.equal(result.sharedModule.moduleId,null);assert.equal(result.sharedModule.module,share.module);
});
test('unavailable module snapshots remain recognizable without turning absent access into permission', () => {
  for (const accessible of [false, undefined, 'true']) {
    const result = normalizeMessage({ id: 9, shared_module: { ...share, resource_id: null, accessible } });
    assert.equal(result.sharedModule.resourceId, null); assert.equal(result.sharedModule.accessible, false);
    assert.equal(result.sharedModule.module, share.module);
  }
  assert.equal(normalizeMessage({ id: 10 }).sharedModule, null);
});
test('bootstrap normalization retains persistent module references even when no library documents are returned', () => {
  const result = normalizeBootstrap({ resources: [], messages: [{ id: 9, channel: 'general', shared_module: { ...share, accessible: false } }] });
  assert.equal(result.messages[0].sharedModule.module, share.module);
  assert.equal(result.messages[0].sharedModule.accessible, false); assert.deepEqual(result.resources, []);
});
