import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { openDatabase, createPostgresPool } from '../server/db.js';
import { seedDatabase, makePdf } from '../server/seed.js';
import { resolveModule } from '../server/modules.js';
import { createTestEnvironment, createTestApp } from './backend-helpers.mjs';

const connectionString=process.env.CAMPUS_TEST_DATABASE_URL||process.env.DATABASE_URL;
const directory=new URL('../server/migrations/',import.meta.url);
async function oldDatabase(t) {
  const schema=`campuslink_test_${randomUUID().replaceAll('-','')}`;
  const db=await openDatabase({connectionString,schema,migrate:false});
  t.after(async()=>{
    await db.close();
    const pool=createPostgresPool({connectionString,max:1});
    try{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await pool.end();}
  });
  const names=(await readdir(directory)).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)&&Number(name.split('_')[0])<=10).sort();
  await db.transaction(async()=>{for(const name of names)await db.exec(await readFile(new URL(name,directory),'utf8'));});
  await seedDatabase(db);
  return db;
}

test('module folder migration backfills old files and repairs scope without losing file or version metadata',async t=>{
  const db=await oldDatabase(t);
  const original=await resolveModule(db,{facultyId:'flaa',filiereId:'french_studies',semester:1,name:'XML'});
  const fixtures=[
    ['xml','french_studies',1,null,0,1],
    [' Xml ','french_studies',1,null,0,1],
    ['ＸＭＬ','french_studies',1,null,1,1],
    ['XML','french_studies',2,original.id,0,1],
    ['xml','arabic_studies',1,original.id,0,1],
    ['','french_studies',1,original.id,0,0],
    [' Database  systems ','french_studies',1,null,0,1],
    ['database systems','french_studies',1,null,0,1],
  ];
  const resources=[];
  for(const [index,[module,filiere,semester,moduleId,removed,visible]]of fixtures.entries()) {
    resources.push(await db.prepare(`INSERT INTO resources
      (faculty_id,filiere_id,title,filename,object_key,stored_name,sha256,category,semester,module_id,module,created_at,size,mime,removed,library_visible)
      VALUES ('flaa',?,?,?,?,?,?,'courses',?,?,?,'2026-10-01',5,'application/pdf',?,?) RETURNING *`).get(filiere,`Old document ${index}`,'old.pdf',`unchanged/original-${index}.pdf`,`legacy-${index}`,`sha-${index}`,semester,moduleId,module,removed,visible));
  }
  await db.prepare(`INSERT INTO resource_versions
    (resource_id,version,filename,object_key,stored_name,sha256,size,mime,updated_at)
    VALUES (?,1,'earlier.pdf','unchanged/version.pdf','legacy-version','version-sha',5,'application/pdf','2026-09-01')`).run(resources[0].id);
  const versions=await db.prepare('SELECT * FROM resource_versions ORDER BY id').all();
  await db.transaction(async()=>db.exec(await readFile(new URL('011_resource_module_folders.sql',directory),'utf8')));
  const after=await db.prepare('SELECT * FROM resources ORDER BY id').all();
  assert.equal(after.length,resources.length);
  for(const row of after.slice(0,3)) {assert.equal(row.module_id,original.id);assert.equal(row.module,'XML');}
  assert.notEqual(after[3].module_id,original.id,'Another semester owns a separate module.');
  assert.notEqual(after[4].module_id,original.id,'Another programme owns a separate module.');
  assert.equal(after[5].module_id,original.id);assert.equal(after[5].module,'XML','A missing label is restored from the old module link.');
  assert.equal(after[6].module_id,after[7].module_id);assert.equal(after[6].module,'Database systems');
  for(const [index,row]of after.entries()) {
    const {module,module_id,...beforeMetadata}=resources[index];
    const {module:afterModule,module_id:afterModuleId,...afterMetadata}=row;
    assert.deepEqual(afterMetadata,beforeMetadata,'Every field apart from module identity is preserved.');
    assert.ok(afterModule&&afterModuleId);
  }
  assert.deepEqual(await db.prepare('SELECT * FROM resource_versions ORDER BY id').all(),versions);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM modules').get()).n,4);
});

test('simultaneous case variants resolve to one module in every nullable study scope',async t=>{
  const env=await createTestEnvironment({demo:false});t.after(()=>env.close());
  const variants=['XML','xml','Xml','xMl','  XML  ','ＸＭＬ','xml','XML'];
  const rows=await Promise.all(variants.map(name=>resolveModule(env.db,{facultyId:'flaa',filiereId:'french_studies',semester:1,name})));
  assert.equal(new Set(rows.map(row=>row.id)).size,1);
  assert.equal(new Set(rows.map(row=>row.name)).size,1);
  const nullable=await Promise.all(variants.map(name=>resolveModule(env.db,{facultyId:'flaa',name})));
  assert.equal(new Set(nullable.map(row=>row.id)).size,1);
  const otherSemester=await resolveModule(env.db,{facultyId:'flaa',filiereId:'french_studies',semester:2,name:'XML'});
  assert.notEqual(otherSemester.id,rows[0].id);assert.notEqual(nullable[0].id,rows[0].id);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM modules').get()).n,3);
});

test('concurrent PDF imports share a module and every chapter remains available in the library and download API',async t=>{
  const env=await createTestApp({demo:false});
  const user=await env.db.prepare("INSERT INTO users (username,name,faculty_id,filiere_id) VALUES ('folder.student','Folder student','flaa','french_studies') RETURNING id").get();
  await env.auth.bindUser(user.id);
  const server=env.app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{env.app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await env.close();});
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'folder.student',password:'Campus2026!'})});
  assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session=')).split(';')[0];
  const variants=['XML','xml','Xml','xMl'];
  const uploads=await Promise.all(variants.map(async(module,index)=>{
    const form=new FormData();
    for(const [key,value]of Object.entries({title:'XML',category:'courses',filiere_id:'french_studies',semester:'1',module,resource_type:'courses',part_number:String(index+1),channel:'general',publish_message:'false'}))form.set(key,value);
    form.set('file',new Blob([makePdf(`XML chapter ${index+1}`,[randomUUID()])],{type:'application/pdf'}),`chapter-${index+1}.pdf`);
    const response=await fetch(origin+'/api/uploads',{method:'POST',headers:{cookie},body:form});
    const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));return data.resource;
  }));
  assert.equal(new Set(uploads.map(resource=>resource.module_id)).size,1);
  const modules=await (await fetch(origin+'/api/modules?semester=1',{headers:{cookie}})).json();
  assert.equal(modules.modules.length,1);
  const bootstrap=await (await fetch(origin+'/api/bootstrap',{headers:{cookie}})).json();
  assert.equal(bootstrap.resources.length,4);
  assert.deepEqual(bootstrap.resources.map(resource=>resource.part_number).sort(),['1','2','3','4']);
  for(const resource of uploads) {
    assert.equal(resource.title,'XML');assert.equal(resource.module_id,modules.modules[0].id);
    const response=await fetch(origin+`/api/files/${resource.id}`,{headers:{cookie}});
    assert.equal(response.status,200);assert.equal((await response.text()).slice(0,5),'%PDF-');
  }
  assert.equal(env.storage.objects.size,4);
});
