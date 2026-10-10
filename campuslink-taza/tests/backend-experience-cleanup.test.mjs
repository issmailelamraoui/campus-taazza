import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { openDatabase, createPostgresPool } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createTestApp } from './backend-helpers.mjs';

const connectionString=process.env.CAMPUS_TEST_DATABASE_URL||process.env.DATABASE_URL;
const migrationUrl=new URL('../server/migrations/010_user_experience_cleanup.sql',import.meta.url);
const cleanupSql=()=>readFile(migrationUrl,'utf8');
async function legacyDatabase(t) {
  const schema=`campuslink_test_${randomUUID().replaceAll('-','')}`;
  const db=await openDatabase({connectionString,schema,migrate:false});
  t.after(async()=>{
    await db.close();
    const pool=createPostgresPool({connectionString,max:1});
    try{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await pool.end();}
  });
  const directory=new URL('../server/migrations/',import.meta.url);
  const names=(await readdir(directory)).filter(name=>/^00[1-9]_[a-z0-9_]+\.sql$/.test(name)).sort();
  await db.transaction(async()=>{for(const name of names)await db.exec(await readFile(new URL(name,directory),'utf8'));});
  await seedDatabase(db);
  return db;
}
async function fixture(db,prefix) {
  return db.transaction(async()=>{
    const user=(await db.prepare("INSERT INTO users (username,name,faculty_id,filiere_id,preferences) VALUES (?,?,'flaa','french_studies',?) RETURNING id").get(`${prefix}.student`,`${prefix} student`,'{"calendar":true,"mentions":false}')).id;
    const modules=[];
    for(const [name,filiere,semester,faculty='flaa']of [['Analyse numérique','french_studies',1],[' analyse   numérique ','french_studies',1],['ＡＮＡＬＹＳＥ numérique','french_studies',1],['analyse numérique','french_studies',2],['analyse numérique','arabic_studies',1],['analyse numérique','data_science',1,'fsa']])modules.push(await db.prepare('INSERT INTO modules (faculty_id,filiere_id,semester,name) VALUES (?,?,?,?) RETURNING *').get(faculty,filiere,semester,name));
    const resources=[];
    for(const module of modules){
      resources.push(await db.prepare("INSERT INTO resources (faculty_id,filiere_id,title,filename,object_key,stored_name,sha256,category,semester,module_id,module,author_id,created_at,size,mime) VALUES (?,?,?,?,?,?,?,'courses',?,?,?,?,?,5,'application/pdf') RETURNING *").get(module.faculty_id,module.filiere_id,`${prefix} ${module.id}`,'lesson.pdf',`${prefix}/original/module-${module.id}/lesson.pdf`,`${prefix}-stored-${module.id}`,`${prefix}-sha-${module.id}`,module.semester,module.id,module.name,user,'2026-10-01T10:00:00.000Z'));
    }
    const removedResource=await db.prepare("UPDATE resources SET removed=1 WHERE id=? RETURNING *").get(resources.at(-1).id);
    await db.prepare('INSERT INTO resource_versions (resource_id,version,filename,object_key,stored_name,sha256,size,mime,updated_at,editor_id) VALUES (?,1,?,?,?,?,5,?,?,?)').run(resources[1].id,'old.pdf',`${prefix}/original/version.pdf`,`${prefix}-old-stored`,'old-sha','application/pdf','2026-09-01',user);
    const messages=[];
    for(const [channel,removed]of [['general',0],['general',1],['help',0],['life',0]])messages.push(await db.prepare("INSERT INTO messages (faculty_id,channel,content,author_id,created_at,removed) VALUES ('flaa',?,?,?,?,?) RETURNING *").get(channel,`${prefix} ${channel} preserved`,user,'2026-10-01',removed));
    const hiddenAnnouncement=await db.prepare("INSERT INTO announcements (faculty_id,content,message_id,channel,author_id,created_at) VALUES ('flaa','Legacy life announcement',?,'life',?,'2026-10-01') RETURNING *").get(messages[3].id,user);
    for(const [type,target,status]of [['message',messages[0].id,'open'],['message',messages[1].id,'reviewed'],['resource',removedResource.id,'open'],['announcement',999999,'open'],['message',messages[2].id,'open']])await db.prepare("INSERT INTO reports (faculty_id,reporter_id,target_type,target_id,reason,status,created_at) VALUES ('flaa',?,?,?,'Fixture',?,'2026-10-01')").run(user,type,target,status);
    for(const [type,path]of [['calendar','/app/calendar#event-1'],['admin','/app/calendar?date=2026-10-12'],['resources',`/app/resources#resource-${resources[0].id}`]])await db.prepare("INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,'flaa',?,'Fixture','Fixture',?,'2026-10-01')").run(user,type,path);
    for(const faculty of ['flaa','feg','fsjp','fsa'])await db.prepare("INSERT INTO events (faculty_id,title,date,time,type) VALUES (?,'Legacy event','2026-10-12','10:00','event')").run(faculty);
    return {user,modules,resources,messages,hiddenAnnouncement};
  });
}
async function snapshot(db) {
  const tables=['users','modules','resources','resource_versions','messages','announcements','reports','notifications','events'];
  return Object.fromEntries(await Promise.all(tables.map(async table=>[table,await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
}

test('cleanup merges existing module spellings without moving files, removes calendar data and stays in its selected schema',async t=>{
  const [target,source]=await Promise.all([legacyDatabase(t),legacyDatabase(t)]);
  const [data]=await Promise.all([fixture(target,'target'),fixture(source,'source')]);
  const [targetBefore,sourceBefore]=await Promise.all([snapshot(target),snapshot(source)]);
  await target.transaction(()=>cleanupSql().then(sql=>target.exec(sql)));
  const targetAfter=await snapshot(target);
  assert.deepEqual(await snapshot(source),sourceBefore,'The other schema is unchanged, including its events, module duplicates and private file metadata.');
  assert.equal(targetAfter.events.length,0);
  assert.deepEqual(targetAfter.notifications.map(n=>n.type),['resources']);
  assert.deepEqual(JSON.parse(targetAfter.users[0].preferences),{mentions:false});
  assert.equal(targetAfter.modules.length,4,'Case/spacing/NFKC variants collapse only inside the same study scope.');
  for(const resource of targetAfter.resources.slice(0,3)){
    assert.equal(resource.module_id,data.modules[0].id);
    assert.equal(resource.module,'Analyse numérique');
  }
  assert.equal(targetAfter.resources[3].module_id,data.modules[3].id,'Another semester keeps its module ID.');
  assert.equal(targetAfter.resources[4].module_id,data.modules[4].id,'Another filiere keeps its module ID.');
  assert.equal(targetAfter.resources[5].module_id,data.modules[5].id,'Another faculty keeps its module ID.');
  for(const field of ['object_key','stored_name','sha256','filename','version','removed','size','mime'])assert.deepEqual(targetAfter.resources.map(r=>r[field]),targetBefore.resources.map(r=>r[field]),`Resource ${field} is preserved.`);
  assert.deepEqual(targetAfter.resource_versions,targetBefore.resource_versions);
  assert.deepEqual(targetAfter.messages,targetBefore.messages,'Hidden help/life messages remain stored.');
  assert.deepEqual(targetAfter.announcements,targetBefore.announcements);
  assert.deepEqual(targetAfter.reports.map(r=>r.status),['open','resolved','resolved','resolved','open']);
  await assert.rejects(target.prepare("INSERT INTO modules (faculty_id,filiere_id,semester,name) VALUES ('flaa','french_studies',1,'  ANALYSE   numérique  ')").run(),error=>error.code==='23505');
  await target.prepare("INSERT INTO modules (faculty_id,filiere_id,semester,name) VALUES ('flaa','french_studies',3,'analyse numérique')").run();
});

test('uploads and administrator edits reuse the canonical module label and ID across case variants',async t=>{
  const env=await createTestApp();
  const server=env.app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{env.app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await env.close();});
  async function request(path,{cookie,method='GET',body,form}={}){
    const response=await fetch(origin+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:form||(body?JSON.stringify(body):undefined)});
    return {status:response.status,data:await response.json(),cookie:response.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session='))?.split(';')[0]};
  }
  const student=(await request('/login',{method:'POST',body:{username:'yassine',password:'Campus2026!'}})).cookie;
  const admin=(await request('/login',{method:'POST',body:{username:'admin',password:'Admin2026!'}})).cookie;
  async function upload(module,part){
    const form=new FormData();
    for(const [key,value]of Object.entries({title:'Canonical module fixture',category:'courses',filiere_id:'french_studies',semester:'1',module,resource_type:'courses',part_number:part,channel:'general',library_visible:'true',publish_message:'false'}))form.set(key,value);
    form.set('file',new Blob([randomUUID()],{type:'text/plain'}),'fixture.txt');
    return request('/uploads',{cookie:student,method:'POST',form});
  }
  const original=await upload('Canonical Analysis','1');assert.equal(original.status,201,JSON.stringify(original.data));
  const variant=await upload('  canonical   analysis  ','2');assert.equal(variant.status,201,JSON.stringify(variant.data));
  assert.equal(variant.data.resource.module_id,original.data.resource.module_id);assert.equal(variant.data.resource.module,'Canonical Analysis');
  const conflict=await upload('CANONICAL ANALYSIS','1');assert.equal(conflict.status,409);assert.equal(conflict.data.code,'RESOURCE_SLOT_CONFLICT');
  const edited=await request('/admin/resources/'+variant.data.resource.id,{cookie:admin,method:'PATCH',body:{module:'CANONICAL ANALYSIS'}});
  assert.equal(edited.status,200,JSON.stringify(edited.data));assert.equal(edited.data.resource.module_id,original.data.resource.module_id);assert.equal(edited.data.resource.module,'Canonical Analysis');
  const modules=(await request('/modules?semester=1',{cookie:student})).data.modules.filter(m=>m.name.toLowerCase()==='canonical analysis');assert.equal(modules.length,1);
  const legacy=await env.db.prepare("INSERT INTO modules (faculty_id,filiere_id,semester,name) VALUES ('flaa','french_studies',1,' Ｃａｎｏｎｉｃａｌ   Ｌｅｇａｃｙ ') RETURNING *").get();
  const legacyUpload=await upload('canonical legacy','1');assert.equal(legacyUpload.status,201,JSON.stringify(legacyUpload.data));assert.equal(legacyUpload.data.resource.module_id,legacy.id);assert.equal(legacyUpload.data.resource.module,legacy.name);
  const legacyConflict=await upload('CANONICAL LEGACY','1');assert.equal(legacyConflict.status,409);assert.equal(legacyConflict.data.code,'RESOURCE_SLOT_CONFLICT');
});
