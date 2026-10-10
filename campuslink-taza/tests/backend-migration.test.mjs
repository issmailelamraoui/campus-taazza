import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';
import { createPostgresPool } from '../server/db.js';
import { cloneMetadata } from '../server/clone-metadata.js';
import { resourceObjectKey, storageObjectKey, createStorage } from '../server/storage.js';

let env, server, origin, student, admin, foreign, otherMajor, facultyAdmin;
async function request(path, { cookie, method='GET', body, form, headers={} }={}) {
  const response=await fetch(origin+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:form||(body?JSON.stringify(body):undefined)});
  const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
  return { status:response.status, data, headers:response.headers, cookie:response.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session='))?.split(';')[0] };
}
async function login(username, password='Campus2026!') {
  const result=await request('/login',{method:'POST',body:{username,password}});
  assert.equal(result.status,200,JSON.stringify(result.data));
  return result.cookie;
}
function uploadForm(label, fields={}) {
  const form=new FormData();
  for(const [key,value]of Object.entries({ title:label,category:'courses',filiere_id:'french_studies',semester:'1',module:'Integration module',resource_type:'courses',part_number:'complete',teacher_name:'',channel:'general',library_visible:'true',publish_message:'false',...fields }))form.set(key,String(value));
  form.set('file',new Blob([`CampusLink test ${label}\n${randomUUID()}`],{type:'text/plain'}),label.replaceAll(' ','-')+'.txt');
  return form;
}
before(async()=>{
  env=await createTestApp();
  server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;
  student=await login('yassine');admin=await login('admin','Admin2026!');foreign=await login('hamza');otherMajor=await login('nour');facultyAdmin=await login('professeure');
});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await env?.close();});

test('persistent server session and cross-faculty restrictions replace browser mock authorization',async()=>{
  const result=await request('/login',{method:'POST',body:{username:'yassine',password:'Campus2026!'}});
  assert.match(result.headers.get('set-cookie'),/HttpOnly/);assert.match(result.headers.get('set-cookie'),/SameSite=Lax/);
  assert.equal((await request('/bootstrap')).status,401);
  assert.equal((await request('/messages',{cookie:student,method:'POST',body:{content:'Cross-site attempt'},headers:{origin:'https://untrusted.example'}})).status,403);
  const boot=await request('/bootstrap',{cookie:student});assert.equal(boot.status,200);assert.equal(boot.data.user.role,'student');assert.ok(boot.data.resources.every(item=>item.faculty_id==='flaa'&&item.filiere_id==='french_studies'));
  assert.equal((await request('/admin',{cookie:student})).status,403);
  assert.equal((await request('/bootstrap?faculty=feg',{cookie:student})).status,403);
  assert.equal('auth_user_id' in boot.data.user,false);assert.ok(!JSON.stringify(boot.data).includes('object_key'));
});

test('library-only upload persists all classification and arbitrary precision parts without creating chat messages',async()=>{
  const before=(await request('/bootstrap',{cookie:student})).data;
  const part='1234567890123456789012345678901234567890';
  const result=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Unlimited numbered lesson',{category:'td',resource_type:'td',part_number:'000'+part,relative_path:'Cours/S1/Unlimited-numbered-lesson.txt'})});
  assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.message,null);assert.equal(result.data.resource.part_number,part);assert.equal(result.data.resource.teacher_name,'');assert.equal(result.data.resource.library_visible,true);assert.equal(result.data.resource.relative_path,'Cours/S1/Unlimited-numbered-lesson.txt');
  const after=(await request('/bootstrap',{cookie:student})).data;assert.equal(after.messages.length,before.messages.length);assert.ok(after.resources.some(item=>item.id===result.data.resource.id));
  const file=await request('/files/'+result.data.resource.id,{cookie:student});assert.equal(file.status,200);assert.match(file.data.toString(),/Unlimited numbered lesson/);
  assert.equal((await request('/files/'+result.data.resource.id,{cookie:otherMajor})).status,403);
  assert.equal((await request('/files/'+result.data.resource.id,{cookie:foreign})).status,403);
  assert.match((await env.db.prepare('SELECT object_key FROM resources WHERE id=?').get(result.data.resource.id)).object_key,/campuslink-prj\/resources\//);
});

test('library part conflicts are enforced server-side while differing resource types and chat-only files remain independent',async()=>{
  const first=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Occupied complete lesson',{module:'Occupied module'})});assert.equal(first.status,201);
  const conflict=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Different bytes same slot',{module:'Occupied module'})});assert.equal(conflict.status,409);assert.equal(conflict.data.code,'RESOURCE_SLOT_CONFLICT');assert.equal(conflict.data.resource.id,first.data.resource.id);
  assert.equal((await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Independent exercises',{module:'Occupied module',category:'exercises',resource_type:'exercises'})})).status,201);
  assert.equal((await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Independent staged lesson',{module:'Occupied module',library_visible:false})})).status,201);
  const zero=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Zero invalid',{part_number:'0'})});assert.equal(zero.status,400);
  const legacy=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Legacy TP classification',{module:'Legacy TP module',category:'exercises',resource_type:'tp'})});assert.equal(legacy.status,201);
  assert.equal((await request('/uploads',{cookie:student,method:'POST',form:uploadForm('New TP same slot',{module:'Legacy TP module',category:'tp',resource_type:'tp'})})).status,409);
  const edited=await request('/admin/resources/'+legacy.data.resource.id,{cookie:admin,method:'PATCH',body:{category:'courses'}});assert.equal(edited.status,200);assert.equal(edited.data.resource.resource_type,'courses');
});

test('classified staged files become one multiattachment chat message and stay out of the library',async()=>{
  const before=(await request('/bootstrap',{cookie:student})).data;
  const a=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Chat attachment A',{library_visible:false})});
  const b=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Chat attachment B',{library_visible:false,category:'corrections',resource_type:'corrections',part_number:'2048'})});
  assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(a.data.message,null);
  assert.equal((await request('/files/'+a.data.resource.id,{cookie:otherMajor})).status,403,'Unpublished files are private to uploader/admin');
  const payload={content:'Documents classés ensemble',channel:'general',client_id:randomUUID(),attachment_ids:[a.data.resource.id,b.data.resource.id]};
  const posted=await request('/messages',{cookie:student,method:'POST',body:payload});assert.equal(posted.status,201,JSON.stringify(posted.data));assert.equal(posted.data.message.attachments.length,2);assert.equal(posted.data.message.attachments[1].part_number,'2048');
  const retry=await request('/messages',{cookie:student,method:'POST',body:payload});assert.equal(retry.status,200);assert.equal(retry.data.message.id,posted.data.message.id);
  const changed=await request('/messages',{cookie:student,method:'POST',body:{...payload,attachment_ids:[b.data.resource.id,a.data.resource.id]}});assert.equal(changed.status,409);
  const after=(await request('/bootstrap',{cookie:student})).data;assert.equal(after.resources.length,before.resources.length);assert.equal(after.messages.length,before.messages.length+1);
  assert.equal((await request('/files/'+a.data.resource.id,{cookie:otherMajor})).status,200,'Faculty general chat attachment follows message access');
  assert.equal((await request('/files/'+a.data.resource.id,{cookie:foreign})).status,403);
  assert.equal((await request('/search?q=Chat%20attachment&type=resource',{cookie:student})).data.results.length,0);
  assert.equal((await request('/messages',{cookie:otherMajor,method:'POST',body:{content:'Reuse someone else’s file',attachment_ids:[a.data.resource.id]}})).status,403);
});

test('private study-year attachments follow parent message scope and support file-only sends',async()=>{
  const staged=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Private study attachment',{library_visible:false,channel:'filiere',chat_semester:2})});assert.equal(staged.status,201);
  const posted=await request('/messages',{cookie:student,method:'POST',body:{content:'',channel:'filiere',semester:2,attachment_ids:[staged.data.resource.id]}});assert.equal(posted.status,201);assert.equal(posted.data.message.semester,1);
  assert.equal((await request('/files/'+staged.data.resource.id,{cookie:otherMajor})).status,403);
  assert.equal((await request('/messages/'+posted.data.message.id,{cookie:otherMajor})).status,403);
});

test('profile name, bio, independent mentions and 2 MB avatar persist without role escalation',async()=>{
  const changed=await request('/profile',{cookie:student,method:'PATCH',body:{name:'Yassine Modifié',bio:'Étudiant · ressources et révisions',preferences:{mentions:false}}});assert.equal(changed.status,200);assert.equal(changed.data.user.name,'Yassine Modifié');assert.equal(changed.data.user.bio,'Étudiant · ressources et révisions');assert.equal(changed.data.user.preferences.mentions,false);
  assert.equal((await request('/profile',{cookie:student,method:'PATCH',body:{role:'global_admin'}})).status,403);
  const png=Buffer.alloc(1024*1024+64);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  const avatar=await request('/profile',{cookie:student,method:'PATCH',body:{avatar:'data:image/png;base64,'+png.toString('base64')}});assert.equal(avatar.status,200);assert.equal((await request('/avatars/'+changed.data.user.id,{cookie:student})).data.length,png.length);
  await request('/profile',{cookie:student,method:'PATCH',body:{avatar:''}});
  const session=await request('/session',{cookie:await login('yassine')});assert.equal(session.data.user.bio,'Étudiant · ressources et révisions');
});

test('history, saves, replies and mentions respect permissions and preferences',async()=>{
  const resources=(await request('/bootstrap',{cookie:student})).data.resources;
  const history=await request('/history',{cookie:student,method:'POST',body:{resource_id:resources[0].id}});assert.equal(history.status,200);
  assert.equal((await request('/bootstrap',{cookie:student})).data.history[0].resource_id,resources[0].id);
  const saved=await request('/saved',{cookie:student,method:'POST',body:{type:'resource',id:resources[0].id}});assert.equal(saved.data.saved,true);
  const original=await request('/messages',{cookie:student,method:'POST',body:{content:'Question sans notification générale',channel:'general'}});
  const count=(await request('/bootstrap',{cookie:student})).data.notifications.length;
  await request('/messages',{cookie:otherMajor,method:'POST',body:{content:'Réponse avec mentions désactivées',channel:'general',reply_to:original.data.message.id}});
  assert.equal((await request('/bootstrap',{cookie:student})).data.notifications.length,count);
  await request('/profile',{cookie:student,method:'PATCH',body:{preferences:{mentions:true}}});
  await request('/messages',{cookie:otherMajor,method:'POST',body:{content:'Réponse avec mentions actives',channel:'general',reply_to:original.data.message.id}});
  assert.equal((await request('/bootstrap',{cookie:student})).data.notifications.filter(item=>item.type==='mentions').length,1);
});

test('administrator announcements persist title, scope and edits; explicit pin promotion is idempotent',async()=>{
  const created=await request('/admin/announcements',{cookie:admin,method:'POST',body:{title:'Annonce ciblée',content:'Information de filière',filiere_id:'french_studies',pinned:true,kind:'administration'}});assert.equal(created.status,201);const id=created.data.announcement.id;
  assert.ok((await request('/bootstrap',{cookie:student})).data.announcements.some(item=>item.id===id));assert.ok(!(await request('/bootstrap',{cookie:otherMajor})).data.announcements.some(item=>item.id===id));
  assert.equal((await request('/admin/announcements/'+id,{cookie:student,method:'PATCH',body:{content:'Forbidden'}})).status,403);
  const edited=await request('/admin/announcements/'+id,{cookie:admin,method:'PATCH',body:{title:'Titre corrigé',content:'Texte corrigé',pinned:false}});assert.equal(edited.data.announcement.title,'Titre corrigé');assert.equal(edited.data.announcement.pinned,false);
  const message=await request('/messages',{cookie:student,method:'POST',body:{content:'Message à promouvoir',channel:'general'}});
  const first=await request(`/messages/${message.data.message.id}/pin`,{cookie:admin,method:'POST',body:{pinned:true,title:'Titre de promotion'}});
  const second=await request(`/messages/${message.data.message.id}/pin`,{cookie:admin,method:'POST',body:{pinned:true,title:'Titre de promotion'}});
  assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(first.data.announcement.id,second.data.announcement.id);
  const unpinned=await request('/admin/announcements/'+first.data.announcement.id,{cookie:admin,method:'PATCH',body:{pinned:false}});assert.equal(unpinned.data.announcement.pinned,false);
  const repinned=await request(`/messages/${message.data.message.id}/pin`,{cookie:admin,method:'POST',body:{pinned:true}});assert.equal(repinned.status,200);assert.equal(repinned.data.announcement.pinned,true);assert.equal(repinned.data.announcement.id,first.data.announcement.id);
  const records=(await request('/admin',{cookie:admin})).data;assert.ok(records.announcements.some(item=>item.id===id));assert.ok(Array.isArray(records.events));
  assert.equal((await request('/admin/announcements/'+id,{cookie:admin,method:'DELETE'})).status,200);assert.ok(!(await request('/bootstrap',{cookie:student})).data.announcements.some(item=>item.id===id));
});

test('administrator account, admission, channel, report and contact functions persist while calendar is removed',async()=>{
  const signup=await request('/register',{method:'POST',body:{username:'pending.integration',name:'Pending integration student',email:'pending.integration@campuslink.test',password:'PrivateIntegration2026!',faculty_id:'flaa',filiere_id:'french_studies',current_semester:1}});assert.equal(signup.status,201);assert.equal(signup.data.user.account_status,'pending');
  assert.equal((await request('/bootstrap',{cookie:signup.cookie})).status,403);
  const pending=await request('/admin/registrations',{cookie:admin});assert.ok(pending.data.requests.some(item=>item.id===signup.data.user.id));
  assert.equal((await request(`/admin/users/${signup.data.user.id}/admission`,{cookie:admin,method:'PATCH',body:{status:'approved'}})).status,200);
  assert.equal((await request('/bootstrap',{cookie:signup.cookie})).status,200);
  const event=await request('/admin/events',{cookie:admin,method:'POST',body:{title:'Rendez-vous de test',date:'2026-10-12',time:'10:00',type:'event',faculty_id:'all'}});assert.equal(event.status,410);assert.deepEqual((await request('/bootstrap',{cookie:student})).data.events,[]);
  const channel=await request('/admin/channels/general',{cookie:facultyAdmin,method:'PATCH',body:{read_only:true}});assert.equal(channel.status,200);
  assert.equal((await request('/messages',{cookie:student,method:'POST',body:{content:'Lecture seule'}})).status,403);
  assert.equal((await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Library while readonly',{module:'Readonly library module'})})).status,201);
  await request('/admin/channels/general',{cookie:facultyAdmin,method:'PATCH',body:{read_only:false}});
  const message=await request('/messages',{cookie:student,method:'POST',body:{content:'Message signalé'}});
  const report=await request('/reports',{cookie:otherMajor,method:'POST',body:{target_type:'message',target_id:message.data.message.id,reason:'Test moderation'}});assert.equal(report.status,201);
  assert.equal((await request('/admin/reports/'+report.data.id,{cookie:admin,method:'PATCH',body:{status:'resolved',note:'Décision persistée'}})).status,200);
  const contact=await request('/contact',{cookie:student,method:'POST',body:{subject:'Aide test',message:'Demande persistée'}});assert.equal(contact.status,201);
  assert.equal((await request('/admin/contacts/'+contact.data.id,{cookie:admin,method:'PATCH',body:{status:'resolved',reply:'Réponse administrateur'}})).status,200);
  const records=(await request('/admin',{cookie:admin})).data;assert.ok(!records.reports.some(item=>item.id===report.data.id));const archive=(await request('/admin?status=all',{cookie:admin})).data;assert.equal(archive.reports.find(item=>item.id===report.data.id).note,'Décision persistée');
  assert.equal((await request(`/admin/users/${signup.data.user.id}`,{cookie:admin,method:'DELETE'})).status,200);assert.equal((await request('/session',{cookie:signup.cookie})).data.user,null);
});

test('pending and rejected applicants can contact administration while campus access remains gated',async()=>{
  const token=randomUUID().slice(0,8);
  const signup=await request('/register',{method:'POST',body:{username:`contact.${token}`,name:'Applicant requesting support',email:`contact.${token}@campuslink.test`,password:'PrivateIntegration2026!',faculty_id:'flaa',filiere_id:'french_studies',current_semester:1}});
  assert.equal(signup.status,201);assert.equal(signup.data.user.account_status,'pending');assert.ok(signup.cookie);
  async function assertSupportOnly(code){
    const support=await request('/contact',{cookie:signup.cookie,method:'POST',body:{subject:'Inscription',message:'Je souhaite comprendre le statut de ma demande.'}});
    assert.equal(support.status,201,JSON.stringify(support.data));
    const stored=await env.db.prepare('SELECT user_id,faculty_id,name FROM contacts WHERE id=?').get(support.data.id);
    assert.equal(stored.user_id,signup.data.user.id);assert.equal(stored.faculty_id,'flaa');assert.equal(stored.name,'Applicant requesting support');
    for(const [path,method,body]of [['/bootstrap','GET'],['/profile','PATCH',{name:'Forbidden change'}],['/messages','POST',{content:'Forbidden publication'}],['/admin','GET']]){
      const blocked=await request(path,{cookie:signup.cookie,method,body});assert.equal(blocked.status,403);assert.equal(blocked.data.code,code);
    }
  }
  await assertSupportOnly('ACCOUNT_PENDING');
  const rejected=await request(`/admin/users/${signup.data.user.id}/admission`,{cookie:admin,method:'PATCH',body:{status:'rejected'}});assert.equal(rejected.status,200);
  await assertSupportOnly('ACCOUNT_REJECTED');
});

test('moderation withdraws attachments and replacement versions preserve private file routes',async()=>{
  const uploaded=await request('/uploads',{cookie:student,method:'POST',form:uploadForm('Replace and withdraw',{module:'Replacement module'})});assert.equal(uploaded.status,201);const id=uploaded.data.resource.id;
  const form=new FormData();form.set('file',new Blob(['New private version '+randomUUID()],{type:'text/plain'}),'replacement.txt');
  const replaced=await request('/admin/resources/'+id+'/replace',{cookie:admin,method:'POST',form});assert.equal(replaced.status,200);assert.equal(replaced.data.resource.version,2);assert.equal(replaced.data.resource.versions.length,2);
  assert.equal((await request('/files/'+id,{cookie:student})).status,200);
  assert.equal((await request('/admin/resources/'+id,{cookie:admin,method:'DELETE'})).status,200);assert.equal((await request('/files/'+id,{cookie:student})).status,404);
});

test('clone utility preserves unknown tables, all metadata and independent sequences without overwriting source',async()=>{
  const target='campuslink_test_'+randomUUID().replaceAll('-','');
  const pool=createPostgresPool({connectionString:process.env.CAMPUS_TEST_DATABASE_URL||process.env.DATABASE_URL,max:1});
  try {
    await env.db.query(`CREATE TABLE "${env.schema}".legacy_folder_fixture (id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,title TEXT)`);
    await env.db.query(`INSERT INTO "${env.schema}".legacy_folder_fixture (title) VALUES ('Retained folder metadata')`);
    const result=await cloneMetadata({connectionString:process.env.CAMPUS_TEST_DATABASE_URL||process.env.DATABASE_URL,sourceSchema:env.schema,targetSchema:target});assert.equal(result.counts.legacy_folder_fixture,1);assert.ok(result.counts.resources>0);
    const fk=await pool.query('SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype=\'f\'',[target]);assert.ok(Number(fk.rows[0].n)>20);
    const inserted=await pool.query(`INSERT INTO "${target}".legacy_folder_fixture (title) VALUES ('Target-only folder') RETURNING id`);assert.equal(inserted.rows[0].id,2);
    const source=await env.db.query(`INSERT INTO "${env.schema}".legacy_folder_fixture (title) VALUES ('Source-only folder') RETURNING id`);assert.equal(source.rows[0].id,2);
    await assert.rejects(cloneMetadata({connectionString:process.env.CAMPUS_TEST_DATABASE_URL||process.env.DATABASE_URL,sourceSchema:env.schema,targetSchema:target}),/not empty/);
    await assert.rejects(cloneMetadata({sourceSchema:env.schema,targetSchema:env.schema}),/distinct/);
  } finally {await pool.query(`DROP SCHEMA IF EXISTS "${target}" CASCADE`);await pool.end();}
});

test('target storage names are isolated and imported source objects cannot be deleted',async()=>{
  const key=resourceObjectKey({filiereId:'french_studies',semester:1,moduleId:1,filename:'safe.pdf'});assert.match(key,/^campuslink-prj\/resources\/french_studies\/1\/1\//);
  assert.equal(storageObjectKey('avatars/1/test.png',{CAMPUS_STORAGE_PREFIX:'campuslink-prj/'}),'campuslink-prj/avatars/1/test.png');
  assert.throws(()=>storageObjectKey('anything',{CAMPUS_STORAGE_PREFIX:'../'}),/Invalid/);
  const storage=createStorage({R2_ENDPOINT:'https://private-storage.invalid',R2_ACCESS_KEY_ID:'test-only',R2_SECRET_ACCESS_KEY:'test-only',R2_BUCKET_NAME:'uploads',R2_REGION:'auto',CAMPUS_STORAGE_PREFIX:'campuslink-prj/'});
  try {await storage.delete('resources/imported-source-object.pdf');await assert.rejects(storage.put('resources/source-overwrite.pdf',Buffer.from('private'), 'application/pdf'),/application prefix/);} finally {storage.close();}
});
