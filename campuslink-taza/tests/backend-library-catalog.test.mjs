import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
import {makePdf} from '../server/seed.js';
import {resolveModule,moduleCatalogKey} from '../server/modules.js';

let env,server,origin,admin,studentX,studentY,tpOnly,module;
async function login(username,password='Campus2026!'){
  const r=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200,await r.clone().text());return r.headers.getSetCookie().find(c=>c.startsWith('campus_neon_test_session=')).split(';')[0];
}
async function request(path,{cookie=admin,method='GET',body}={}){
  const r=await fetch(origin+'/api'+path,{method,headers:{cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};
}
async function upload(cookie,{category='courses',type=category,moduleId=module.id,semester=1,filiere='french_studies',filename=`${randomUUID()}.pdf`,path=filename,part='complete',visible=true,extra={}}={}){
  const form=new FormData();
  const fields={title:filename,category,resource_type:type,semester:String(semester),filiere_id:filiere,module:'Untrusted misspelled client label',part_number:part,channel:'general',publish_message:'false',library_visible:String(visible),relative_path:path,...extra};
  if(moduleId!==null)fields.module_id=String(moduleId);
  for(const [k,v]of Object.entries(fields))form.set(k,v);
  form.set('file',new Blob([makePdf(filename,[randomUUID()])],{type:'application/pdf'}),filename);
  const r=await fetch(origin+'/api/uploads',{method:'POST',headers:{cookie},body:form});return {status:r.status,data:await r.json()};
}
before(async()=>{
  env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;
  admin=await login('admin','Admin2026!');studentX=await login('yassine');studentY=await login('sara');tpOnly=await login('omar');
  // Synthetic curriculum source is exclusively a disposable local fixture.
  const result=await request('/admin/modules',{method:'POST',body:{filiere_id:'french_studies',semester:1,name:'Catalogue fixture Analyse numérique',curriculum_source:'Local synthetic test curriculum; no production catalog assertion',confirmed:true}});
  assert.equal(result.status,201,JSON.stringify(result.data));module=result.data.module;
});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await env?.close();});

test('catalog remains read-only, legacy records remain visible and official selector excludes unverified history',async()=>{
  const legacy=await resolveModule(env.db,{facultyId:'flaa',filiereId:'french_studies',semester:1,name:'Historical unverified test'});
  const ordinary=await request('/modules?semester=1',{cookie:studentX});assert.equal(ordinary.status,200);assert.ok(ordinary.data.modules.some(m=>m.id===legacy.id));
  const official=await request('/modules?semester=1&official=1',{cookie:studentX});assert.ok(official.data.modules.some(m=>m.id===module.id));assert.ok(!official.data.modules.some(m=>m.id===legacy.id));
  assert.equal((await upload(studentX,{moduleId:legacy.id})).status,409);
});
test('explicit official selection rejects missing IDs, wrong faculty/program/semester and student module creation',async()=>{
  const before=(await env.db.prepare('SELECT COUNT(*) AS n FROM modules').get()).n,puts=env.storage.putCount;
  for(const options of [{moduleId:null},{semester:2},{filiere:'arabic_studies'}])assert.ok([400,403].includes((await upload(studentX,options)).status));
  assert.equal(env.storage.putCount,puts);assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM modules').get()).n,before);
  const create=await request('/admin/modules',{cookie:studentX,method:'POST',body:{filiere_id:'french_studies',semester:1,name:'No student creation',curriculum_source:'x',confirmed:true}});assert.equal(create.status,403);
  const verify=await request(`/admin/modules/${module.id}`,{cookie:studentX,method:'PATCH',body:{curriculum_source:'x',confirmed:true}});assert.equal(verify.status,403);
});
test('catalog reads permit an authorized owner or scoped administrator across faculties while ordinary users stay isolated',async()=>{
  assert.equal((await request('/modules?faculty_id=fsa&filiere_id=data_science&semester=5')).status,200);
  assert.equal((await request('/modules?faculty_id=fsa&filiere_id=data_science&semester=5',{cookie:studentX})).status,403);
  const grant=await request('/admin/appointments',{method:'POST',body:{user_id:4,role:'faculty_admin',faculty_id:'fsa',filiere_id:'data_science',capabilities:['resource.manage']}});assert.equal(grant.status,201,JSON.stringify(grant.data));
  try{const scoped=await login('sara');assert.equal((await request('/modules?faculty_id=fsa&filiere_id=data_science&semester=5',{cookie:scoped})).status,200);assert.equal((await request('/modules?faculty_id=fsa&filiere_id=mathematics&semester=5',{cookie:scoped})).status,403);}
  finally{assert.equal((await request(`/admin/appointments/${grant.data.appointment.id}`,{method:'DELETE'})).status,200);studentY=await login('sara');}
});
test('case, accent and whitespace duplicates are blocked without merging digit-distinct official modules',async()=>{
  assert.equal(moduleCatalogKey('  Analyse  NUMÉRIQUE  '),'analyse numerique');
  const same=await request('/admin/modules',{method:'POST',body:{filiere_id:'french_studies',semester:1,name:'  CATALOGUE fixture analyse numerique ',curriculum_source:'local fixture',confirmed:true}});assert.equal(same.status,409);
  for(const name of ['Fixture Analyse 1','Fixture Analyse 4']){const r=await request('/admin/modules',{method:'POST',body:{filiere_id:'french_studies',semester:1,name,curriculum_source:'local fixture',confirmed:true}});assert.equal(r.status,201);}
});
test('3 Cours and 2 TP produce category-specific contributor counts and preserve real nested paths',async()=>{
  const files=[];
  for(let i=1;i<=3;i++){const r=await upload(studentX,{filename:`cours-${i}.pdf`,path:`Original folder/Chapitres/cours-${i}.pdf`});assert.equal(r.status,201,JSON.stringify(r.data));files.push(r.data.resource);}
  for(let i=1;i<=2;i++){const r=await upload(studentX,{category:'exercises',type:'tp',filename:`tp-${i}.pdf`,path:`Original folder/Pratique/tp-${i}.pdf`});assert.equal(r.status,201,JSON.stringify(r.data));files.push(r.data.resource);}
  assert.ok(files.every(r=>r.module_id===module.id&&r.module===module.name&&r.uploader_id===3));
  const courses=await request(`/library/modules/${module.id}?category=cours&uploader_id=3`,{cookie:studentY});assert.equal(courses.status,200);assert.equal(courses.data.resources.length,3);assert.ok(courses.data.resources.every(r=>r.category_key==='courses'));assert.equal(courses.data.contributors.find(c=>c.id===3).count,3);assert.ok(courses.data.contributors[0].paths.includes('Original folder/Chapitres'));
  const tp=await request(`/library/modules/${module.id}?category=tp&uploader_id=3`,{cookie:studentY});assert.equal(tp.data.resources.length,2);assert.ok(tp.data.resources.every(r=>r.category_key==='tp'));assert.equal(tp.data.contributors.find(c=>c.id===3).count,2);
});
test('TP-only student is absent from Cours; distinct users with matching public names get distinct folders',async()=>{
  await env.db.prepare("UPDATE users SET name='Same public display' WHERE id IN(3,4)").run();
  assert.equal((await upload(studentY,{filename:'cours-1.pdf',path:'Original folder/Chapitres/cours-1.pdf'})).status,201,'Another contributor may upload the same part/path with different bytes.');
  assert.equal((await upload(tpOnly,{category:'tp',filename:'tp-only.pdf'})).status,201);
  const courses=await request(`/library/modules/${module.id}?category=courses`,{cookie:studentX});assert.equal(courses.data.contributors.length,2);assert.deepEqual(courses.data.contributors.map(c=>c.id).sort(),[3,4]);assert.equal(new Set(courses.data.contributors.map(c=>c.name)).size,1);
  const tp=await request(`/library/modules/${module.id}?category=tp`,{cookie:studentX});assert.deepEqual(tp.data.contributors.map(c=>c.id).sort(),[3,5]);
});
test('other students can download but cannot modify ownership or edit/delete another contribution',async()=>{
  const browse=await request(`/library/modules/${module.id}?category=tp&uploader_id=3`,{cookie:studentY}),file=browse.data.resources[0];
  const bytes=await fetch(origin+`/api/files/${file.id}`,{headers:{cookie:studentY}});assert.equal(bytes.status,200);assert.equal((await bytes.text()).slice(0,5),'%PDF-');
  const patch=await request(`/admin/resources/${file.id}`,{cookie:studentY,method:'PATCH',body:{title:'stolen'}});assert.equal(patch.status,403);
  const remove=await request(`/admin/resources/${file.id}`,{cookie:studentY,method:'DELETE'});assert.equal(remove.status,403);
  const years=await request(`/resources/${file.id}/academic-years`,{cookie:studentY,method:'PATCH',body:{academic_years:['2025/2026']}});assert.equal(years.status,403);
  const own=await upload(studentY,{category:'tp',extra:{uploader_id:'3',owner_id:'3'}});assert.equal(own.status,201);assert.equal(own.data.resource.uploader_id,4);
});
test('unreadable and hidden resources never generate category folders or counts, and empty modules remain preserved',async()=>{
  const hidden=await upload(studentX,{category:'tp',visible:false});assert.equal(hidden.status,201);
  const before=await request(`/library/modules/${module.id}?category=tp`,{cookie:studentY});assert.ok(!before.data.resources.some(r=>r.id===hidden.data.resource.id));
  const foreign=await resolveModule(env.db,{facultyId:'flaa',filiereId:'arabic_studies',semester:1,name:'Other scope'});
  assert.equal((await request(`/library/modules/${foreign.id}`,{cookie:studentY})).status,403);
  const empty=await request('/admin/modules',{method:'POST',body:{filiere_id:'french_studies',semester:1,name:'Empty official fixture',curriculum_source:'Local synthetic fixture',confirmed:true}});assert.equal(empty.status,201);
  const file=await upload(studentX,{moduleId:empty.data.module.id});assert.equal(file.status,201);const snapshot=await env.db.prepare('SELECT * FROM resources WHERE id=?').get(file.data.resource.id);
  assert.equal((await request(`/admin/resources/${snapshot.id}`,{method:'DELETE'})).status,200);
  assert.ok(await env.db.prepare('SELECT * FROM modules WHERE id=?').get(empty.data.module.id));const after=await env.db.prepare('SELECT * FROM resources WHERE id=?').get(snapshot.id);assert.equal(after.module_id,snapshot.module_id);assert.equal(after.object_key,snapshot.object_key);assert.equal(after.removed,1);
  const catalog=await request('/modules?semester=1&official=1',{cookie:studentX});assert.ok(catalog.data.modules.some(m=>m.id===empty.data.module.id));
});
test('admin verification preserves resource identity, scope, bytes, ownership and history',async()=>{
  const row=await env.db.prepare('SELECT * FROM modules WHERE id=?').get(module.id),resources=await env.db.prepare('SELECT * FROM resources WHERE module_id=? ORDER BY id').all(module.id);
  const unverify=await request(`/admin/modules/${module.id}`,{method:'PATCH',body:{catalog_status:'legacy',confirmed:true}});assert.equal(unverify.status,200);
  const verify=await request(`/admin/modules/${module.id}`,{method:'PATCH',body:{catalog_status:'official',curriculum_source:'Local verified synthetic curriculum',confirmed:true}});assert.equal(verify.status,200);
  assert.equal(verify.data.module.name,row.name);assert.deepEqual(await env.db.prepare('SELECT * FROM resources WHERE module_id=? ORDER BY id').all(module.id),resources);
});
test('resumed complete-folder uploads preserve canonical selection, nested path, category and actual uploader',async()=>{
  const filename='nested-resumed.pdf',path='Cours et TP/TP/Chapitres/'+filename;
  const bytes=makePdf(filename,[randomUUID()]),fields=Object.entries({title:filename,category:'exercises',resource_type:'tp',module_id:String(module.id),module:'Client typo',semester:'1',filiere_id:'french_studies',part_number:'complete',relative_path:path,channel:'general',publish_message:'false',academic_year:'2026/2027'});
  const session=await request('/upload-sessions',{cookie:studentX,method:'POST',body:{path:'/uploads',file:{name:filename,type:'application/pdf',size:bytes.length},fields}});assert.equal(session.status,201,JSON.stringify(session.data));
  const piece=await fetch(origin+`/api/upload-sessions/${session.data.id}/parts/1`,{method:'PUT',headers:{cookie:studentX,'content-type':'application/octet-stream'},body:bytes});assert.equal(piece.status,200);
  const complete=await request(`/upload-sessions/${session.data.id}/complete`,{cookie:studentX,method:'POST',body:{}});assert.equal(complete.status,201,JSON.stringify(complete.data));
  const file=complete.data.resource;assert.equal(file.module_id,module.id);assert.equal(file.category_key,'tp');assert.equal(file.relative_path,path);assert.equal(file.uploader_id,3);assert.deepEqual(file.academic_years,['2026/2027']);
  const replay=await request(`/upload-sessions/${session.data.id}/complete`,{cookie:studentX,method:'POST',body:{}});assert.equal(replay.status,201);assert.equal(replay.data.resource.id,file.id);
});
test('PDF keyword search applies explicit category/contributor resource IDs before its result limit and retains authorization',async()=>{
  const rows=await env.db.prepare('SELECT * FROM resources WHERE module_id=? AND removed=0 AND library_visible=1 ORDER BY id').all(module.id);
  const course=rows.find(r=>r.category==='courses'),tp=rows.find(r=>r.resource_type==='tp');
  for(const row of [course,tp]){
    await env.db.prepare("INSERT INTO document_text_indexes(resource_id,document_version,source_sha256,status,page_count,text_bytes,indexed_by,indexed_at) VALUES(?,?,?,'ready',1,30,3,'2026-10-28')").run(row.id,row.version,row.sha256);
    await env.db.prepare("INSERT INTO document_text_pages(resource_id,document_version,page,text,normalized_text) VALUES(?,?,1,'scopedkeyword scopedlibrary','scopedkeyword scopedlibrary')").run(row.id,row.version);
  }
  const found=await request(`/document-search?q=scopedkeyword&resource_ids=${tp.id}`,{cookie:studentY});assert.equal(found.status,200);assert.deepEqual(found.data.matches.map(r=>r.resourceId),[tp.id]);
  const empty=await request('/document-search?q=scopedkeyword&resource_ids=',{cookie:studentY});assert.deepEqual(empty.data.matches,[]);
  assert.equal((await request('/document-search?q=scopedkeyword&resource_ids=1%2CNaN',{cookie:studentY})).status,400);
  const foreign=await login('nour');const denied=await request(`/document-search?q=scopedkeyword&resource_ids=${tp.id}`,{cookie:foreign});assert.equal(denied.status,200);assert.deepEqual(denied.data.matches,[]);
});
test('missing programme profiles cannot browse ambiguous null-program legacy modules',async()=>{
  const user=await env.db.prepare("INSERT INTO users(username,name,faculty_id) VALUES('no.program.catalog','No programme profile','flaa') RETURNING *").get();await env.auth.bindUser(user.id);const cookie=await login(user.username);
  const legacy=await resolveModule(env.db,{facultyId:'flaa',filiereId:null,semester:1,name:'Null programme legacy fixture'});
  await env.db.prepare("INSERT INTO resources(faculty_id,filiere_id,semester,module_id,module,title,filename,object_key,sha256,category,author_id,created_at,size,mime) VALUES('flaa',NULL,1,?,?,'Unscoped legacy fixture','unscoped.pdf','synthetic/unscoped','legacy','courses',NULL,'2026-10-28',1,'application/pdf')").run(legacy.id,legacy.name);
  assert.equal((await request(`/library/modules/${legacy.id}`,{cookie})).status,403);
  assert.equal((await request(`/library/modules/${legacy.id}`)).status,200,'Explicit owner permission remains valid.');
});
test('canonical endpoint never infers null-ID or wrong-scope resources into a module and retains ownerless IDs',async()=>{
  const insert=async(moduleId,filiere='french_studies')=>env.db.prepare("INSERT INTO resources(faculty_id,filiere_id,semester,module_id,module,title,filename,object_key,sha256,category,author_id,created_at,size,mime) VALUES('flaa',?,1,?,?,'Legacy identifier fixture','legacy.pdf',?,?,'courses',NULL,'2026-10-28',1,'application/pdf') RETURNING *").get(filiere,moduleId,module.name,'synthetic/'+randomUUID(),randomUUID());
  const unlinked=await insert(null),wrongScope=await insert(module.id,'arabic_studies'),ownerless=await insert(module.id);
  const result=await request(`/library/modules/${module.id}?category=courses&uploader_id=unknown`,{cookie:studentX});assert.equal(result.status,200);assert.deepEqual(result.data.resources.map(r=>r.id),[ownerless.id]);
  assert.ok(!result.data.resources.some(r=>r.id===unlinked.id||r.id===wrongScope.id));assert.ok(result.data.contributors.some(c=>c.id===null));
});
