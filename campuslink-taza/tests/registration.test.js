import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createTestApp} from './helpers.mjs';
import {makePdf} from '../server/seed.js';

let environment,server,base,admin,member,moderator,registration,rejected,retainedResource,retainedMessage;
const signup=(username,extra={})=>({name:`Étudiant ${username}`,username,email:`${username}@campuslink.test`,password:'Student2026!',faculty_id:'fsa',filiere_id:'data_science',current_semester:6,...extra});
async function request(path,{cookie,method='GET',body,form,origin}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},body:form||(body?JSON.stringify(body):undefined)});
  const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function login(username,password='Campus2026!'){
  const result=await request('/login',{method:'POST',body:{username,password}});assert.equal(result.status,200);return result.cookie;
}
before(async()=>{
  environment=await createTestApp({legacyCommunity:false});
  server=environment.app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  admin=await login('admin','Admin2026!');member=await login('meryem');moderator=await login('amina');
});
after(async()=>{
  environment?.app.locals.endStreams();server?.closeAllConnections();
  if(server)await new Promise(resolve=>server.close(resolve));await environment?.close();
});

test('registration uses existing faculty and major metadata and validates before provider creation',async()=>{
  const options=await request('/registration-options');assert.equal(options.status,200);assert.equal(options.data.faculties.length,4);
  assert.equal(options.data.faculties.find(f=>f.id==='fsa').filieres.length,8);assert.equal(options.data.faculties.find(f=>f.id==='feg').filieres.length,2);
  const before=environment.auth.identities.size;
  for(const body of [signup('invalid-major',{filiere_id:'management'}),signup('invalid-semester',{current_semester:7}),signup('short-password',{password:'short'})])assert.equal((await request('/register',{method:'POST',body})).status,400);
  assert.equal(environment.auth.identities.size,before);
  assert.equal((await request('/register',{method:'POST',origin:'https://foreign.example',body:signup('cross-site')})).status,403);
});

test('self-service registration always creates a pending student and notifies the global admin across faculties',async()=>{
  registration=await request('/register',{method:'POST',body:signup('new-student',{role:'global_admin',account_status:'approved',disabled:false})});
  assert.equal(registration.status,201);assert.equal(registration.data.authenticated,true);assert.ok(registration.cookie);
  const u=registration.data.user;assert.equal(u.role,'student');assert.equal(u.account_status,'pending');assert.equal(u.current_semester,6);assert.equal(u.filiere_id,'data_science');assert.ok(u.registered_at);assert.equal(u.reviewed_at,null);
  assert.equal('auth_user_id' in u,false);assert.equal('password' in u,false);
  const persisted=await environment.db.prepare('SELECT * FROM users WHERE id=?').get(u.id);assert.equal(persisted.account_status,'pending');assert.equal(persisted.last_seen,null);assert.equal(persisted.legacy_password_hash,null);
  const notices=await environment.db.prepare("SELECT * FROM notifications WHERE user_id=2 AND path='/app/admin?tab=registrations'").all();assert.equal(notices.length,1);assert.equal(notices[0].faculty_id,'fsa');
  rejected=await request('/register',{method:'POST',body:signup('reject-student',{faculty_id:'flaa',filiere_id:'french_studies',current_semester:3})});assert.equal(rejected.status,201);
  const crossFacultyNotice=await environment.db.prepare("SELECT * FROM notifications WHERE user_id=2 AND path='/app/admin?tab=registrations' ORDER BY id DESC LIMIT 1").get();assert.equal(crossFacultyNotice.faculty_id,'fsa');assert.equal(crossFacultyNotice.body,'Étudiant reject-student');
});

test('pending credentials expose their status while all private routes and community membership stay gated',async()=>{
  const u=registration.data.user,cookie=registration.cookie;
  assert.equal((await request('/session',{cookie})).data.user.account_status,'pending');
  const pendingLogin=await request('/login',{method:'POST',body:{username:u.username,password:'Student2026!'}});assert.equal(pendingLogin.status,200);assert.equal(pendingLogin.data.user.account_status,'pending');
  for(const path of ['/bootstrap','/faculties','/studies','/modules?filiere_id=data_science&semester=1','/messages','/files/1','/avatars/2','/events/stream','/search','/admin','/admin/registrations']){
    const result=await request(path,{cookie});assert.equal(result.status,403,path);assert.equal(result.data.code,'ACCOUNT_PENDING',path);
  }
  for(const [path,method,body]of [['/messages','POST',{channel:'general',content:'Should not send'}],['/profile','PATCH',{name:'Bypass',account_status:'approved'}],['/studies','POST',{filiere_id:'physics',current_semester:1}],['/uploads','POST',{}]])assert.equal((await request(path,{cookie,method,body})).status,403,path);
  const bootstrap=(await request('/bootstrap',{cookie:member})).data;assert.ok(!bootstrap.members.some(m=>m.id===u.id));assert.equal(bootstrap.faculty.members,bootstrap.members.length);
  assert.equal((await request('/search?type=member&q=new-student',{cookie:member})).data.results.length,0);
  assert.equal((await request(`/admin/users/${u.id}`,{cookie:admin,method:'PATCH',body:{disabled:false,role:'global_admin'}})).status,409);
  assert.equal((await request('/admin/registrations',{cookie:member})).status,403);assert.equal((await request('/admin/registrations',{cookie:moderator})).status,403);
  const requests=(await request('/admin/registrations',{cookie:admin})).data.requests;assert.ok(requests.some(r=>r.id===u.id));assert.ok(requests.some(r=>r.id===rejected.data.user.id));
  const important=await request('/messages',{cookie:admin,method:'POST',body:{channel:'important',content:'Pending students do not receive member notifications.'}});assert.equal(important.status,201);
  assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=?').get(u.id)).n,0);
});

test('global admin approval immediately admits the existing pending session and idempotent decisions do not repeat notices',async()=>{
  const id=registration.data.user.id;
  assert.equal((await request(`/admin/users/${id}/admission`,{cookie:member,method:'PATCH',body:{status:'approved'}})).status,403);
  const approved=await request(`/admin/users/${id}/admission`,{cookie:admin,method:'PATCH',body:{status:'approved'}});assert.equal(approved.status,200);assert.equal(approved.data.user.account_status,'approved');assert.ok(approved.data.user.reviewed_at);assert.equal(approved.data.user.current_semester,6);
  assert.equal((await request('/session',{cookie:registration.cookie})).data.user.account_status,'approved');
  const bootstrap=await request('/bootstrap',{cookie:registration.cookie});assert.equal(bootstrap.status,200);assert.ok(bootstrap.data.members.some(m=>m.id===id));
  const send=await request('/messages',{cookie:registration.cookie,method:'POST',body:{channel:'filiere',semester:6,content:'Approved into the correct study year.'}});assert.equal(send.status,201);assert.equal(send.data.message.semester,5);
  assert.equal((await request(`/admin/users/${id}/admission`,{cookie:admin,method:'PATCH',body:{status:'approved'}})).status,200);
  assert.equal((await environment.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title='Inscription acceptée'").get(id)).n,1);
  assert.equal((await request(`/admin/users/${id}/admission`,{cookie:admin,method:'PATCH',body:{status:'rejected'}})).status,409);
  assert.ok(!(await request('/admin/registrations',{cookie:admin})).data.requests.some(r=>r.id===id));
});

test('rejection remains visible to the requester without granting private access or allowing legacy admin bypasses',async()=>{
  const id=rejected.data.user.id;
  const result=await request(`/admin/users/${id}/admission`,{cookie:admin,method:'PATCH',body:{status:'rejected'}});assert.equal(result.status,200);assert.equal(result.data.user.account_status,'rejected');
  assert.equal((await request('/session',{cookie:rejected.cookie})).data.user.account_status,'rejected');
  const blocked=await request('/bootstrap',{cookie:rejected.cookie});assert.equal(blocked.status,403);assert.equal(blocked.data.code,'ACCOUNT_REJECTED');
  assert.equal((await request(`/admin/users/${id}`,{cookie:admin,method:'PATCH',body:{disabled:false,role:'student'}})).status,409);
  const requests=(await request('/admin/registrations',{cookie:admin})).data.requests;assert.equal(requests.find(r=>r.id===id).account_status,'rejected');
  assert.equal((await request('/logout',{cookie:rejected.cookie,method:'POST'})).status,200);
  const rejectedLogin=await request('/login',{method:'POST',body:{username:'reject-student',password:'Student2026!'}});assert.equal(rejectedLogin.status,200);assert.equal(rejectedLogin.data.user.account_status,'rejected');
});

test('a provider sign-in failure preserves a successfully submitted pending request',async()=>{
  const signIn=environment.auth.signIn;
  environment.auth.signIn=async()=>{throw Object.assign(new Error('Fixture provider offline'),{status:503});};
  let result;
  try{result=await request('/register',{method:'POST',body:signup('session-unavailable')});}finally{environment.auth.signIn=signIn;}
  assert.equal(result.status,201);assert.equal(result.data.authenticated,false);assert.equal(result.data.user.account_status,'pending');
  const stored=await environment.db.prepare('SELECT * FROM users WHERE id=?').get(result.data.user.id);assert.ok(stored.auth_user_id);
  const logged=await request('/login',{method:'POST',body:{username:'session-unavailable',password:'Student2026!'}});assert.equal(logged.status,200);assert.equal(logged.data.user.account_status,'pending');
});

test('concurrent duplicate applications keep one profile and compensate the unlinked provider identity',async()=>{
  const before=environment.auth.identities.size;
  const results=await Promise.all([request('/register',{method:'POST',body:signup('concurrent-request',{email:'race-one@campuslink.test'})}),request('/register',{method:'POST',body:signup('concurrent-request',{email:'race-two@campuslink.test'})})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal((await environment.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username='concurrent-request'").get()).n,1);
  assert.equal(environment.auth.identities.size,before+1);
});

test('student deletion closes live access, anonymizes attribution, and preserves academic files even when provider revocation is unsupported',async()=>{
  const id=registration.data.user.id;
  for(const [cookie,target]of [[member,id],[moderator,id],[admin,2],[admin,6]])assert.equal((await request(`/admin/users/${target}`,{cookie,method:'DELETE'})).status,403);
  const form=new FormData();for(const [key,value]of Object.entries({title:'File retained after account deletion',category:'courses',semester:'6',module:'Analyse des données',filiere_id:'data_science',resource_type:'courses',channel:'general',content:'Academic contribution remains available.'}))form.set(key,value);
  form.set('file',new Blob([makePdf('Retained student file',['Do not remove the academic document.'])],{type:'application/pdf'}),'retained-student.pdf');
  const uploaded=await request('/uploads',{cookie:registration.cookie,method:'POST',form});assert.equal(uploaded.status,201);retainedResource=uploaded.data.resource.id;retainedMessage=uploaded.data.message.id;
  assert.equal((await request('/saved',{cookie:registration.cookie,method:'POST',body:{type:'resource',id:retainedResource}})).status,200);
  const before=await environment.db.prepare('SELECT * FROM users WHERE id=?').get(id),providerIdentity=environment.auth.identities.get(before.auth_user_id),objectCount=environment.storage.objects.size;
  const controller=new AbortController(),stream=await fetch(base+'/api/events/stream',{headers:{cookie:registration.cookie},signal:controller.signal}),reader=stream.body.getReader();await reader.read();
  const revoke=environment.auth.revokeUserSessions;environment.auth.revokeUserSessions=async()=>({supported:false});
  try{
    const update=reader.read();assert.equal((await request(`/admin/users/${id}`,{cookie:admin,method:'DELETE'})).status,200);assert.match(Buffer.from((await update).value).toString(),/event: update\ndata: \{\}/);assert.equal((await reader.read()).done,true);
  }finally{environment.auth.revokeUserSessions=revoke;controller.abort();}
  const tombstone=await environment.db.prepare('SELECT * FROM users WHERE id=?').get(id);assert.equal(tombstone.account_status,'deleted');assert.equal(tombstone.disabled,1);assert.equal(tombstone.auth_user_id,null);assert.equal(tombstone.email,null);assert.equal(tombstone.avatar,'');assert.equal(tombstone.name,'Étudiant supprimé');assert.notEqual(tombstone.username,before.username);assert.ok(tombstone.auth_revoked_at);assert.ok(tombstone.session_version>before.session_version);
  assert.equal(environment.auth.identities.get(before.auth_user_id),providerIdentity);assert.equal(environment.storage.objects.size,objectCount);
  assert.equal((await request('/session',{cookie:registration.cookie})).data.user,null);
  for(const path of ['/bootstrap','/messages','/files/'+retainedResource,'/events/stream'])assert.equal((await request(path,{cookie:registration.cookie})).status,401,path);
  assert.equal((await request('/login',{method:'POST',body:{username:before.username,password:'Student2026!'}})).status,401);
  assert.equal((await request(`/admin/users/${id}`,{cookie:admin,method:'PATCH',body:{disabled:false,role:'global_admin'}})).status,404);
  assert.equal((await request(`/admin/users/${id}/admission`,{cookie:admin,method:'PATCH',body:{status:'approved'}})).status,404);
  const bootstrap=(await request('/bootstrap',{cookie:member})).data;assert.ok(!bootstrap.members.some(u=>u.id===id));assert.equal(bootstrap.resources.find(r=>r.id===retainedResource).author.name,'Étudiant supprimé');assert.equal(bootstrap.messages.find(m=>m.id===retainedMessage).author.name,'Étudiant supprimé');
  assert.equal((await request(`/files/${retainedResource}`,{cookie:member})).status,200);assert.equal((await request(`/avatars/${id}`,{cookie:member})).status,404);
  assert.ok(!(await request('/admin',{cookie:admin})).data.users.some(u=>u.id===id));
  for(const table of ['notifications','saved','history','reactions','chat_bans'])assert.equal((await environment.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(id)).n,0);
});

test('administrator-created accounts retain immediate approved access',async()=>{
  const result=await request('/admin/users',{cookie:admin,method:'POST',body:signup('operator-created')});assert.equal(result.status,201);assert.equal(result.data.user.account_status,'approved');
  const signed=await request('/login',{method:'POST',body:{username:'operator-created',password:'Student2026!'}});assert.equal(signed.status,200);assert.equal((await request('/bootstrap',{cookie:signed.cookie})).status,200);
});

test('registration stream updates stay explicit when admin notifications are muted, including review and deletion',async()=>{
  const preferences=(await environment.db.prepare('SELECT preferences FROM users WHERE id=2').get()).preferences;
  await environment.db.prepare('UPDATE users SET preferences=? WHERE id=2').run(JSON.stringify({...JSON.parse(preferences),admin:false}));
  const before=(await environment.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=2').get()).n;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  let reader;
  try{
    const stream=await fetch(base+'/api/events/stream',{headers:{cookie:admin},signal:controller.signal});reader=stream.body.getReader();await reader.read();
    const pending=await request('/register',{method:'POST',body:signup('muted-admin-request',{faculty_id:'flaa',filiere_id:'french_studies',current_semester:2})});assert.equal(pending.status,201);
    assert.match(Buffer.from((await reader.read()).value).toString(),/event: update\ndata: \{"registrations":true\}/);
    assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=2').get()).n,before);
    const id=pending.data.user.id;
    assert.equal((await request(`/admin/users/${id}/admission`,{cookie:admin,method:'PATCH',body:{status:'approved'}})).status,200);
    assert.match(Buffer.from((await reader.read()).value).toString(),/"registrations":true/);
    assert.equal((await request(`/admin/users/${id}`,{cookie:admin,method:'DELETE'})).status,200);
    assert.match(Buffer.from((await reader.read()).value).toString(),/"registrations":true/);
    assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=2').get()).n,before);
  }finally{
    clearTimeout(timeout);
    controller.abort();
    await environment.db.prepare('UPDATE users SET preferences=? WHERE id=2').run(preferences);
  }
});
