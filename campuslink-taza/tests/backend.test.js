import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { makePdf } from '../server/seed.js';

const directory=mkdtempSync(join(tmpdir(),'campuslink-tests-'));
let app,server,base;
let student,admin,other,moderator,facultyAdmin;
async function request(path,{cookie,method='GET',body,form,origin}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},body:form|| (body?JSON.stringify(body):undefined)});
  const contentType=response.headers.get('content-type')||'';
  const data=contentType.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,data,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function login(username,password='Campus2026!'){const r=await request('/login',{method:'POST',body:{username,password}});assert.equal(r.status,200);return r.cookie;}

before(async()=>{
  app=createApp({dataDir:directory});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  student=await login('ismail');admin=await login('admin','Admin2026!');other=await login('hamza');moderator=await login('amina');facultyAdmin=await login('professeure');
});
after(async()=>{await new Promise(r=>server.close(r));app.locals.close();rmSync(directory,{recursive:true,force:true});});

test('secure persistent session cookies and anonymous protections',async()=>{
  const r=await request('/login',{method:'POST',body:{username:'ismail',password:'Campus2026!'}});
  assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Lax/);assert.match(r.headers.get('set-cookie'),/Max-Age=2592000/);
  const session=await request('/session',{cookie:r.cookie});assert.equal(session.data.user.username,'ismail');assert.equal('password_hash' in session.data.user,false);
  assert.equal((await request('/bootstrap')).status,401);
  assert.equal((await request('/messages',{method:'POST',body:{content:'secret'}})).status,401);
  assert.equal((await request('/login',{method:'POST',origin:'https://evil.example',body:{username:'ismail',password:'Campus2026!'}})).status,403);
  const stored=app.locals.db.prepare('SELECT password_hash FROM users WHERE username=?').get('ismail').password_hash;assert.notEqual(stored,'Campus2026!');assert.match(stored,/^[a-f0-9]{32}:[a-f0-9]{128}$/);
});

test('onboarding requires confirmation and faculty choice becomes permanently locked',async()=>{
  assert.equal((await request('/bootstrap',{cookie:student})).status,403);
  const faculties=await request('/faculties',{cookie:student});assert.equal(faculties.data.faculties.length,4);
  assert.equal((await request('/faculty',{cookie:student,method:'POST',body:{faculty_id:'flaa'}})).status,400);
  const assigned=await request('/faculty',{cookie:student,method:'POST',body:{faculty_id:'flaa',confirmed:true}});assert.equal(assigned.status,200);assert.equal(assigned.data.user.faculty_id,'flaa');
  assert.equal((await request('/studies',{cookie:student,method:'POST',body:{filiere_id:'french_studies',current_semester:1}})).status,200);
  assert.equal((await request('/faculty',{cookie:student,method:'POST',body:{faculty_id:'feg',confirmed:true}})).status,403);
  assert.equal((await request('/faculties',{cookie:student})).status,403);
  assert.equal((await request('/profile',{cookie:student,method:'PATCH',body:{faculty_id:'feg'}})).status,403);
  assert.equal((await request('/profile',{cookie:student,method:'PATCH',body:{role:'global_admin'}})).status,403);
});

test('bootstrap, direct file access, save and search enforce faculty boundaries',async()=>{
  const a=await request('/bootstrap',{cookie:student});const b=await request('/bootstrap',{cookie:other});
  assert.equal(a.status,200);assert.ok(a.data.resources.length>=14);assert.equal(a.data.faculty.id,'flaa');assert.equal(a.data.faculty.members,a.data.members.length);assert.ok(a.data.messages.every(m=>m.faculty_id==='flaa'));assert.ok(a.data.resources.every(r=>r.faculty_id==='flaa'));
  const foreign=b.data.resources[0];assert.equal((await request(`/files/${foreign.id}`,{cookie:student})).status,403);
  assert.equal((await request('/saved',{cookie:student,method:'POST',body:{type:'resource',id:foreign.id}})).status,403);
  assert.equal((await request('/search?q=comptabilité',{cookie:student})).data.results.length,0);
  assert.equal((await request('/search?faculty_id=feg',{cookie:student})).status,403);
  assert.equal((await request('/bootstrap?faculty=feg',{cookie:student})).status,403);
  const filtered=await request('/search?type=courses&semester=1&module=Linguistique&author=7',{cookie:student});assert.equal(filtered.data.results.length,1);assert.match(filtered.data.results[0].path,/#resource-/);
  assert.ok(!JSON.stringify(a.data.resources).includes('stored_name'));assert.ok(!JSON.stringify(a.data).includes('password_hash'));
  const file=await request(`/files/${a.data.resources[0].id}`,{cookie:student});assert.equal(file.status,200);assert.equal(file.data.subarray(0,5).toString(),'%PDF-');
  const history=(await request('/bootstrap',{cookie:student})).data.history;assert.equal(history[0].resource_id,a.data.resources[0].id);
});

test('general chat creates no notifications; important messages and pins notify exact destinations',async()=>{
  const before=(await request('/bootstrap',{cookie:student})).data.notifications.length;
  const general=await request('/messages',{cookie:admin,method:'POST',body:{content:'Une discussion générale sans notification.',channel:'general',semester:1}});assert.equal(general.status,201);
  assert.equal((await request('/bootstrap',{cookie:student})).data.notifications.length,before);
  assert.equal((await request(`/messages/${general.data.message.id}/pin`,{cookie:student,method:'POST',body:{}})).status,403);
  const pinned=await request(`/messages/${general.data.message.id}/pin`,{cookie:moderator,method:'POST',body:{}});assert.equal(pinned.data.pinned,true);
  let bootstrap=(await request('/bootstrap',{cookie:student})).data;
  const linked=bootstrap.announcements.find(a=>a.message_id===general.data.message.id);assert.ok(linked);assert.equal(linked.author.id,2);assert.equal(linked.created_at,general.data.message.created_at);assert.equal(linked.channel,'general');
  assert.equal(bootstrap.notifications.length,before+1);assert.match(bootstrap.notifications[0].path,/#announcement-/);
  const important=await request('/messages',{cookie:admin,method:'POST',body:{content:'Une information importante pour demain.',channel:'important'}});assert.equal(important.status,201);
  bootstrap=(await request('/bootstrap',{cookie:student})).data;assert.equal(bootstrap.notifications.length,before+2);assert.equal(bootstrap.notifications[0].type,'important');assert.match(bootstrap.notifications[0].path,/#message-/);
  const unpinned=await request(`/messages/${general.data.message.id}/pin`,{cookie:moderator,method:'POST',body:{}});assert.equal(unpinned.data.pinned,false);assert.ok(!(await request('/bootstrap',{cookie:student})).data.announcements.some(a=>a.message_id===general.data.message.id));
});

test('upload creates one file and one resource shared by chat/library; rejects duplicates and invalid files',async()=>{
  const beforeFiles=readdirSync(join(directory,'files')).length;
  const pdf=makePdf('Test Linguistique',['Exercice de transcription phonetique.']);
  const form=new FormData();form.set('file',new Blob([pdf],{type:'application/pdf'}),'linguistique.pdf');form.set('title','Exercice de test');form.set('category','exercises');form.set('semester','1');form.set('module','Linguistique');form.set('channel','general');
  form.set('filiere_id','french_studies');form.set('resource_type','exercises');form.set('chat_semester','1');
  const upload=await request('/uploads',{cookie:student,method:'POST',form});assert.equal(upload.status,201);assert.equal(upload.data.message.resource_id,upload.data.resource.id);assert.equal(upload.data.resource.message_id,upload.data.message.id);assert.equal(readdirSync(join(directory,'files')).length,beforeFiles+1);
  const duplicate=await request('/uploads',{cookie:student,method:'POST',form});assert.equal(duplicate.status,409);assert.equal(duplicate.data.resource.id,upload.data.resource.id);assert.equal(readdirSync(join(directory,'files')).length,beforeFiles+1);
  const search=await request('/search?q=Exercice%20de%20test&type=exercises&semester=1',{cookie:student});assert.equal(search.data.results.length,1);assert.match(search.data.results[0].path,/exercises\/s1\/linguistique#resource-/);
  const missing=new FormData();missing.set('file',new Blob([pdf],{type:'application/pdf'}),'test.pdf');missing.set('category','courses');assert.equal((await request('/uploads',{cookie:student,method:'POST',form:missing})).status,400);
  const invalid=new FormData();invalid.set('file',new Blob(['<script>bad()</script>'],{type:'image/svg+xml'}),'image.svg');invalid.set('category','general');assert.equal((await request('/uploads',{cookie:student,method:'POST',form:invalid})).status,400);
});

test('bookmarks, notification ownership and preferences are persisted',async()=>{
  const bootstrap=(await request('/bootstrap',{cookie:student})).data;const r=bootstrap.resources[0];
  assert.equal((await request('/saved',{cookie:student,method:'POST',body:{type:'resource',id:r.id}})).data.saved,true);
  assert.ok((await request('/bootstrap',{cookie:student})).data.saved.some(s=>s.id===r.id&&s.type==='resource'));
  assert.equal((await request('/saved',{cookie:student,method:'POST',body:{type:'resource',id:r.id}})).data.saved,false);
  assert.equal((await request('/notifications/read',{cookie:student,method:'POST',body:{}})).status,200);assert.ok((await request('/bootstrap',{cookie:student})).data.notifications.every(n=>n.read));
  const prefs=await request('/profile',{cookie:student,method:'PATCH',body:{language:'ar',preferences:{important:false}}});assert.equal(prefs.data.user.language,'ar');assert.equal(prefs.data.user.preferences.important,false);
  const before=(await request('/bootstrap',{cookie:student})).data.notifications.length;await request('/messages',{cookie:admin,method:'POST',body:{channel:'important',content:'Préférence respectée.'}});assert.equal((await request('/bootstrap',{cookie:student})).data.notifications.length,before);
});

test('scoped role gates protect reports, users, resources and contacts',async()=>{
  const r=(await request('/bootstrap',{cookie:student})).data.resources[0];
  const report=await request('/reports',{cookie:student,method:'POST',body:{target_type:'resource',target_id:r.id,reason:'wrong_semester',details:'À vérifier.'}});assert.equal(report.status,201);
  assert.equal((await request('/admin',{cookie:student})).status,403);
  const modData=await request('/admin',{cookie:moderator});assert.equal(modData.status,200);assert.equal(modData.data.users.length,0);assert.ok(modData.data.reports.some(x=>x.id===report.data.id));
  assert.equal((await request(`/admin/reports/${report.data.id}`,{cookie:moderator,method:'PATCH',body:{status:'reviewed'}})).status,200);
  assert.equal((await request('/admin/users/9',{cookie:facultyAdmin,method:'PATCH',body:{disabled:true}})).status,403);
  assert.equal((await request('/admin/users/3',{cookie:facultyAdmin,method:'PATCH',body:{faculty_id:'feg'}})).status,403);
  assert.equal((await request('/admin/users/3',{cookie:facultyAdmin,method:'PATCH',body:{role:'global_admin'}})).status,403);
  assert.equal((await request(`/admin/resources/${r.id}`,{cookie:moderator,method:'PATCH',body:{semester:2}})).status,403);
  assert.equal((await request(`/admin/resources/${r.id}`,{cookie:facultyAdmin,method:'PATCH',body:{status:'corrected'}})).status,200);
  const recovery=await request('/contact',{method:'POST',body:{name:'Étudiant',email:'etudiant@example.com',subject:'Identifiants oubliés',message:'Merci de vérifier mon accès.'}});assert.equal(recovery.status,201);
  assert.ok((await request('/admin',{cookie:admin})).data.contacts.some(x=>x.id===recovery.data.id));assert.ok(!(await request('/admin',{cookie:facultyAdmin})).data.contacts.some(x=>x.id===recovery.data.id));
});

test('resource replacement maintains shared ID, physical version history and restricted access',async()=>{
  const r=(await request('/bootstrap',{cookie:student})).data.resources[0];const form=new FormData();form.set('file',new Blob([makePdf('Nouvelle version',['Document corrige pour les revisions.'])],{type:'application/pdf'}),'correction.pdf');
  assert.equal((await request(`/admin/resources/${r.id}/replace`,{cookie:student,method:'POST',form})).status,403);
  const result=await request(`/admin/resources/${r.id}/replace`,{cookie:facultyAdmin,method:'POST',form});assert.equal(result.status,200);assert.equal(result.data.resource.id,r.id);assert.equal(result.data.resource.version,2);assert.equal(result.data.resource.versions.length,2);assert.equal(result.data.resource.status,'updated');
  const bootstrap=(await request('/bootstrap',{cookie:student})).data;assert.equal(bootstrap.messages.find(m=>m.id===r.message_id).resource_id,r.id);
});

test('withdrawal and chat moderation remove files, pins and search results without exposing foreign content',async()=>{
  const foreign=(await request('/bootstrap',{cookie:other})).data.resources[0];
  const filesBefore=readdirSync(join(directory,'files')).length;
  assert.equal((await request(`/admin/resources/${foreign.id}`,{cookie:facultyAdmin,method:'DELETE'})).status,403);
  const replace=new FormData();replace.set('file',new Blob([makePdf('Foreign replacement',['Restricted faculty data.'])],{type:'application/pdf'}),'foreign.pdf');
  assert.equal((await request(`/admin/resources/${foreign.id}/replace`,{cookie:facultyAdmin,method:'POST',form:replace})).status,403);assert.equal(readdirSync(join(directory,'files')).length,filesBefore);
  const form=new FormData();form.set('file',new Blob([makePdf('Document retire',['Retrait et moderation.'])],{type:'application/pdf'}),'retrait.pdf');form.set('title','Document unique pour retrait');form.set('category','courses');form.set('semester','2');
  form.set('filiere_id','french_studies');form.set('resource_type','courses');form.set('module','Méthodologie');form.set('chat_semester','2');
  const uploaded=await request('/uploads',{cookie:student,method:'POST',form});assert.equal(uploaded.status,201);
  const r=uploaded.data.resource,m=uploaded.data.message;
  await request(`/messages/${m.id}/pin`,{cookie:moderator,method:'POST'});
  assert.equal((await request(`/admin/resources/${r.id}`,{cookie:student,method:'DELETE'})).status,403);
  assert.equal((await request(`/admin/resources/${r.id}`,{cookie:facultyAdmin,method:'DELETE'})).status,200);
  assert.equal((await request(`/files/${r.id}`,{cookie:student})).status,404);assert.equal((await request('/search?q=Document%20unique%20pour%20retrait&type=courses',{cookie:student})).data.results.length,0);
  let data=(await request('/bootstrap',{cookie:student})).data;assert.ok(!data.resources.some(x=>x.id===r.id));assert.equal(data.messages.find(x=>x.id===m.id).resource_id,null);assert.equal(data.announcements.find(x=>x.message_id===m.id).resource_id,null);
  assert.equal((await request(`/admin/messages/${m.id}/remove`,{cookie:student,method:'POST'})).status,403);
  assert.equal((await request(`/admin/messages/${m.id}/remove`,{cookie:moderator,method:'POST'})).status,200);
  data=(await request('/bootstrap',{cookie:student})).data;assert.ok(!data.messages.some(x=>x.id===m.id));assert.ok(!data.announcements.some(x=>x.message_id===m.id));
  const foreignMessage=(await request('/bootstrap',{cookie:other})).data.messages[0];assert.equal((await request(`/admin/messages/${foreignMessage.id}/remove`,{cookie:moderator,method:'POST'})).status,403);
});

test('administrators manage channel access; readonly restriction cannot be bypassed by uploads',async()=>{
  assert.equal((await request('/admin/channels/help',{cookie:student,method:'PATCH',body:{read_only:true}})).status,403);
  assert.equal((await request('/admin/channels/help',{cookie:facultyAdmin,method:'PATCH',body:{read_only:true,faculty_id:'feg'}})).status,403);
  const locked=await request('/admin/channels/help',{cookie:facultyAdmin,method:'PATCH',body:{read_only:true,description:'Révisions temporairement en lecture seule.'}});assert.equal(locked.status,200);assert.equal(locked.data.channel.read_only,true);
  assert.equal((await request('/messages',{cookie:student,method:'POST',body:{channel:'help',content:'Je tente de publier.'}})).status,403);
  const form=new FormData();form.set('file',new Blob([makePdf('Lecture seule',['Message joint.'])],{type:'application/pdf'}),'readonly.pdf');form.set('category','general');form.set('channel','help');
  assert.equal((await request('/uploads',{cookie:student,method:'POST',form})).status,403);
  assert.equal((await request('/messages',{cookie:moderator,method:'POST',body:{channel:'help',content:'Le modérateur peut expliquer la fermeture.'}})).status,201);
  assert.equal((await request('/bootstrap',{cookie:student})).data.channels.find(c=>c.id==='help').read_only,true);
  await request('/admin/channels/help',{cookie:facultyAdmin,method:'PATCH',body:{read_only:false}});
  assert.equal((await request('/messages',{cookie:student,method:'POST',body:{channel:'help',content:'La discussion est à nouveau ouverte.'}})).status,201);
});

test('private account provisioning and faculty-wide publication obey global role permissions',async()=>{
  const payload={username:'nouveau.etudiant',name:'Nouvel étudiant',password:'PrivateAccount2026!',faculty_id:null};
  assert.equal((await request('/admin/users',{cookie:facultyAdmin,method:'POST',body:payload})).status,403);
  const created=await request('/admin/users',{cookie:admin,method:'POST',body:payload});assert.equal(created.status,201);assert.equal(created.data.user.faculty_id,null);assert.equal('password' in created.data.user,false);assert.equal('password_hash' in created.data.user,false);
  const cookie=await login(payload.username,payload.password);assert.equal((await request('/bootstrap',{cookie})).status,403);assert.equal((await request('/faculties',{cookie})).data.faculties.length,4);
  assert.equal((await request('/admin/users',{cookie:admin,method:'POST',body:payload})).status,409);
  assert.equal((await request('/admin/announcements',{cookie:facultyAdmin,method:'POST',body:{faculty_id:'feg',content:'Tentative hors faculté.'}})).status,403);
  const publication=await request('/admin/announcements',{cookie:admin,method:'POST',body:{faculty_id:'all',content:'Annonce système de test pour chaque communauté.'}});assert.equal(publication.status,201);assert.equal(publication.data.announcements.length,4);
  assert.ok((await request('/bootstrap',{cookie:other})).data.announcements.some(a=>a.content==='Annonce système de test pour chaque communauté.'));
  assert.equal((await request('/messages',{cookie:student,method:'POST'})).status,400);
  assert.equal((await request('/admin/users/3',{cookie:admin,method:'PATCH',body:{faculty_id:{id:'feg'}}})).status,400);
  assert.equal((await request('/admin/users/2',{cookie:admin,method:'PATCH',body:{disabled:true}})).status,400);
});

test('password changes require current password and invalidate other sessions; logout revokes access',async()=>{
  const second=await login('ismail');
  assert.equal((await request('/profile',{cookie:student,method:'PATCH',body:{password:'NewSecure2026!',current_password:'bad'}})).status,403);
  assert.equal((await request('/profile',{cookie:student,method:'PATCH',body:{password:'short',current_password:'Campus2026!'}})).status,400);
  const change=await request('/profile',{cookie:student,method:'PATCH',body:{password:'NewSecure2026!',current_password:'Campus2026!'}});assert.equal(change.status,200);assert.ok(change.cookie);assert.equal((await request('/session',{cookie:second})).data.user,null);assert.equal((await request('/bootstrap',{cookie:student})).status,401);
  student=change.cookie;assert.equal((await request('/session',{cookie:student})).data.user.username,'ismail');
  assert.equal((await request('/login',{method:'POST',body:{username:'ismail',password:'Campus2026!'}})).status,401);
  const persisted=await login('ismail','NewSecure2026!');assert.equal((await request('/session',{cookie:persisted})).data.user.faculty_id,'flaa');
  await request('/logout',{cookie:persisted,method:'POST',body:{}});assert.equal((await request('/session',{cookie:persisted})).data.user,null);
});

test('live SSE updates remain inside the faculty and stop after logout',async()=>{
  const liveCookie=await login('ismail','NewSecure2026!');
  const controllerA=new AbortController(),controllerB=new AbortController();
  const a=await fetch(base+'/api/events/stream',{headers:{cookie:liveCookie},signal:controllerA.signal});
  const b=await fetch(base+'/api/events/stream',{headers:{cookie:other},signal:controllerB.signal});
  const readerA=a.body.getReader(),readerB=b.body.getReader();await readerA.read();await readerB.read();
  const resultA=readerA.read();const resultB=readerB.read().catch(()=>null);
  try{
    await request('/messages',{cookie:admin,method:'POST',body:{channel:'general',semester:1,content:'Mise à jour en direct de la faculté.'}});
    const update=await Promise.race([resultA,new Promise((_,reject)=>setTimeout(()=>reject(Error('Missing live update')),2000))]);assert.match(Buffer.from(update.value).toString(),/event: update/);
    assert.equal(await Promise.race([resultB,new Promise(resolve=>setTimeout(()=>resolve(null),150))]),null);
    const end=readerA.read();await request('/logout',{cookie:liveCookie,method:'POST',body:{}});assert.equal((await end).done,true);
  }finally{controllerA.abort();controllerB.abort();await resultB;}
});

test('global admin reassigns faculty, revokes sessions, and prevents old faculty content leakage',async()=>{
  assert.equal((await request('/admin/users/1',{cookie:admin,method:'PATCH',body:{faculty_id:'feg'}})).status,200);
  assert.equal((await request('/session',{cookie:student})).data.user,null);
  const cookie=await login('ismail','NewSecure2026!');const data=(await request('/bootstrap',{cookie})).data;
  assert.equal(data.faculty.id,'feg');assert.ok(data.resources.every(r=>r.faculty_id==='feg'));assert.equal(data.history.length,0);assert.equal(data.notifications.length,0);assert.equal(data.saved.length,0);
  assert.equal((await request('/files/1',{cookie})).status,403);
});

test('sessions and content survive a full application restart',async()=>{
  const persistent=await login('ismail','NewSecure2026!');
  await new Promise(resolve=>server.close(resolve));app.locals.close();
  app=createApp({dataDir:directory});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  const session=await request('/session',{cookie:persistent});assert.equal(session.data.user.username,'ismail');assert.equal(session.data.user.faculty_id,'feg');assert.equal(session.data.user.language,'ar');
  assert.ok((await request('/bootstrap',{cookie:persistent})).data.resources.length>0);
});
