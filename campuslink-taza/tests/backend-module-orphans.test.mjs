import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';
import { resolveModule, pruneRemovedResourceModule, moduleCatalogKey } from '../server/modules.js';

const connection=process.env.CAMPUS_TEST_DATABASE_URL;
assert.ok(connection&&['127.0.0.1','localhost'].includes(new URL(connection).hostname),'Use an explicit disposable local PostgreSQL database.');
let env,server,origin,cookie;
const scope={facultyId:'flaa',filiereId:'french_studies',semester:1};
async function legacy(extra={}){
  return env.db.transaction(()=>resolveModule(env.db,{...scope,...extra,name:`Orphan fixture ${randomUUID()}`}));
}
const reference=module=>({module_id:module.id,faculty_id:'flaa',filiere_id:'french_studies',semester:1});
const moduleRow=id=>env.db.prepare('SELECT * FROM modules WHERE id=?').get(id);
async function resource(module,{removed=0}={}){
  const token=randomUUID();
  return env.db.prepare(`INSERT INTO resources(faculty_id,filiere_id,semester,module_id,module,title,filename,object_key,sha256,category,part_number,author_id,created_at,size,mime,library_visible,removed)
    VALUES('flaa','french_studies',1,?,?,?,?,?,?,'courses','complete',3,'2026-10-28T12:00:00Z',7,'text/plain',1,?) RETURNING *`)
    .get(module.id,module.name,'Fixture','fixture.txt',`local-orphan/${token}`,token,removed);
}
before(async()=>{
  env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'Admin2026!'})});
  assert.equal(login.status,200);cookie=login.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session=')).split(';')[0];
});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await env?.close();});

test('a legacy module without any resource or relationship is permanently removed',async()=>{
  const module=await legacy(),before=(await env.db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n;
  assert.equal(await pruneRemovedResourceModule(env.db,reference(module)),true);
  assert.equal(await moduleRow(module.id),undefined);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM resources').get()).n,before);
  assert.equal(env.storage.deleteCount,0);
});

test('moving the last resource prunes only its obsolete legacy module and preserves bytes, ownership and ID',async()=>{
  const old=await legacy(),file=await resource(old),destination=await legacy({semester:2});
  await env.db.prepare("UPDATE modules SET catalog_status='official',catalog_key=?,curriculum_source='Synthetic local curriculum',verified_by=1,verified_at='2026-10-28' WHERE id=?").run(moduleCatalogKey(destination.name),destination.id);
  await env.storage.put(file.object_key,Buffer.from('fixture'),'text/plain');
  const stored=[...env.storage.objects.keys()];
  const result=await fetch(origin+`/api/admin/resources/${file.id}`,{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({semester:2,module_id:destination.id})});
  assert.equal(result.status,200,await result.clone().text());
  assert.equal(await moduleRow(old.id),undefined);
  const after=await env.db.prepare('SELECT * FROM resources WHERE id=?').get(file.id);
  assert.equal(after.id,file.id);assert.equal(after.module_id,destination.id);assert.equal(after.semester,2);
  assert.equal(after.author_id,file.author_id);assert.equal(after.object_key,file.object_key);assert.equal(after.sha256,file.sha256);
  assert.deepEqual([...env.storage.objects.keys()],stored);assert.equal(env.storage.deleteCount,0);
});

test('an empty official curriculum entry remains a catalog identity',async()=>{
  const module=await legacy();
  await env.db.prepare("UPDATE modules SET catalog_status='official',catalog_key=?,curriculum_source='Synthetic local curriculum',verified_by=1,verified_at='2026-10-28' WHERE id=?").run(moduleCatalogKey(module.name),module.id);
  assert.equal(await pruneRemovedResourceModule(env.db,reference(module)),false);
  assert.ok(await moduleRow(module.id));
});

test('soft-deleted resources and unlinked historical label matches prevent destructive pruning',async()=>{
  const linked=await legacy(),linkedFile=await resource(linked,{removed:1});
  assert.equal(await pruneRemovedResourceModule(env.db,reference(linked)),false);
  assert.deepEqual(await env.db.prepare('SELECT * FROM resources WHERE id=?').get(linkedFile.id),linkedFile);
  const unlinked=await legacy(),file=await resource(unlinked,{removed:1});
  await env.db.prepare('UPDATE resources SET module_id=NULL WHERE id=?').run(file.id);
  assert.equal(await pruneRemovedResourceModule(env.db,reference(unlinked)),false);
  assert.ok(await moduleRow(unlinked.id));
});

test('an unknown cascading foreign key protects its module and dependent data',async()=>{
  const module=await legacy();
  await env.db.query(`CREATE TABLE "${env.db.schema}".module_orphan_dependency (module_id INTEGER REFERENCES "${env.db.schema}".modules(id) ON DELETE CASCADE, evidence TEXT)`);
  await env.db.query(`INSERT INTO "${env.db.schema}".module_orphan_dependency(module_id,evidence) VALUES($1,$2)`,[module.id,'Preserve this relationship']);
  assert.equal(await pruneRemovedResourceModule(env.db,reference(module)),false);
  assert.equal((await env.db.query(`SELECT evidence FROM "${env.db.schema}".module_orphan_dependency WHERE module_id=$1`,[module.id])).rows[0].evidence,'Preserve this relationship');
});

test('plain module labels, JSON context and direct audit targets preserve application dependencies',async()=>{
  const text=await legacy();
  await env.db.prepare("INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,module,created_at) VALUES('flaa','french_studies',3,'Question','Preserved question',?,'2026-10-28')").run(text.name);
  assert.equal(await pruneRemovedResourceModule(env.db,reference(text)),false);
  const json=await legacy();
  await env.db.prepare("INSERT INTO administrative_audit(actor_id,action,target_type,target_id,details,created_at) VALUES(1,'fixture','fixture','unrelated',?,'2026-10-28')").run(JSON.stringify({context:{module_id:json.id}}));
  assert.equal(await pruneRemovedResourceModule(env.db,reference(json)),false);
  const target=await legacy();
  await env.db.prepare("INSERT INTO administrative_audit(actor_id,action,target_type,target_id,details,created_at) VALUES(1,'fixture','module',?,'{}','2026-10-28')").run(String(target.id));
  assert.equal(await pruneRemovedResourceModule(env.db,reference(target)),false);
});

test('serialized TEXT JSON and notification library paths protect historical module context',async()=>{
  const module=await legacy();
  await env.db.query(`CREATE TABLE "${env.db.schema}".module_orphan_text_context (details TEXT)`);
  await env.db.query(`INSERT INTO "${env.db.schema}".module_orphan_text_context(details) VALUES($1)`,[JSON.stringify({module_id:module.id})]);
  assert.equal(await pruneRemovedResourceModule(env.db,reference(module)),false);
  const path=await legacy();
  await env.db.prepare("INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at) VALUES(3,'flaa','resources','Fixture','Preserve path',?,'2026-10-28')").run(`/app/library?semester=1&module=id%3A${path.id}`);
  assert.equal(await pruneRemovedResourceModule(env.db,reference(path)),false);
});

test('orphan deletion rolls back with its enclosing transaction and refuses a mismatched scope',async()=>{
  const module=await legacy();
  assert.equal(await pruneRemovedResourceModule(env.db,{...reference(module),faculty_id:'fsa'}),false);
  await assert.rejects(env.db.transaction(async()=>{assert.equal(await pruneRemovedResourceModule(env.db,reference(module)),true);throw new Error('Rollback fixture');}),/Rollback fixture/);
  assert.ok(await moduleRow(module.id));
});
