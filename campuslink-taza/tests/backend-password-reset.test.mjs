import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';

// Password changes remain inside an explicitly configured disposable test schema
// and the injected identity double. These tests never reset provider accounts.
const integration=process.env.CAMPUS_TEST_DATABASE_URL?test:test.skip;
const temporary='Temporary-private-2026!';
const replacement='Student-private-password-2026!';
const reason='Identité du compte confirmée directement avec cet étudiant.';
const payload=(overrides={})=>({operation_id:randomUUID(),temporary_password:temporary,reason,identity_verified:true,...overrides});
async function reached(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Password reset did not reach the provider race boundary.')),5000);})]);}finally{clearTimeout(timer);}}

async function fixture(t){
 const env=await createTestApp();
 // Real Neon identities are UUIDs. Keep the shared compatibility double intact
 // while using the production identity shape in this reset-specific fixture.
 for(const user of await env.db.prepare('SELECT id,auth_user_id FROM users').all()){
  const identity=env.auth.identities.get(user.auth_user_id),id=randomUUID();
  env.auth.identities.delete(user.auth_user_id);identity.id=id;env.auth.identities.set(id,identity);
  await env.db.prepare('UPDATE users SET auth_user_id=? WHERE id=?').run(id,user.id);
 }
 const provider={calls:0,mode:'success',before:null};
 env.auth.resetUserPassword=async(_req,{authUserId,newPassword})=>{
  provider.calls++;
  if(provider.before)await provider.before();
  if(provider.mode==='failed')throw Object.assign(new Error('Identity provider rejected the reset.'),{status:503,code:'AUTH_ADMIN_CONFIGURATION'});
  const identity=env.auth.identities.get(authUserId);
  assert.ok(identity,'Only an existing linked test identity can be reset.');
  identity.password=newPassword;
  for(const [key,session]of env.auth.sessions)if(session.authUserId===authUserId)env.auth.sessions.delete(key);
  if(provider.mode==='unknown')throw Object.assign(new Error('Identity provider response was lost.'),{status:503,code:'AUTH_PASSWORD_RESET_UNKNOWN'});
  if(provider.mode==='unconfirmed')return {confirmed:false,providerSessionsRevoked:false};
  return {confirmed:true,providerSessionsRevoked:true};
 };
 const server=env.app.listen(0,'127.0.0.1');await once(server,'listening');
 const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{env.app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await env.close();});
 async function request(path,{cookie,method='GET',body}={}){
  const response=await fetch(origin+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  return {status:response.status,data,cookie:response.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session='))?.split(';')[0]};
 }
 const login=(username,password=username==='admin'?'Admin2026!':'Campus2026!')=>request('/login',{method:'POST',body:{username,password}});
 const cookies={};
 for(const username of ['admin','yassine','sara','professeure']){const logged=await login(username);assert.equal(logged.status,200,JSON.stringify(logged.data));cookies[username]=logged.cookie;}
 const issue=(id=4,body=payload(),cookie=cookies.admin)=>request('/admin/users/'+id+'/password-reset',{method:'POST',cookie,body});
 const complete=(cookie,currentPassword=temporary,newPassword=replacement)=>request('/password-reset/complete',{method:'POST',cookie,body:{currentPassword,newPassword}});
 return {...env,provider,request,login,cookies,issue,complete};
}

integration('password issuance is exclusive to the owner and cannot target protected accounts',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/admin/users/4/password-reset',{method:'POST',body:payload()})).status,401);
 for(const name of ['yassine','professeure'])assert.equal((await f.issue(4,payload(),f.cookies[name])).status,403);
 await f.db.prepare("UPDATE users SET role='faculty_leader' WHERE id=3").run();
 for(const target of [2,3,7])assert.equal((await f.issue(target)).status,403,'Owner, leader and appointed staff cannot be reset as ordinary students.');
 await f.db.prepare("INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,filiere_id,capabilities,created_at) VALUES(4,2,'flaa','french_studies','[\"student.support\"]',?)").run(new Date().toISOString());
 assert.equal((await f.issue(4)).status,403,'An ordinary role with an active appointment is protected.');
 await f.db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE user_id=4').run(new Date().toISOString());
 await f.db.prepare("UPDATE users SET account_status='pending' WHERE id=4").run();
 assert.equal((await f.issue(4)).status,403);
 assert.equal(f.provider.calls,0);
});

integration('invalid passwords, reasons and operation IDs fail before any provider change',async t=>{
 const f=await fixture(t);
 for(const invalid of [{temporary_password:'too-short'},{temporary_password:'a'.repeat(129)},{reason:'short'},{reason:'a'.repeat(501)},{operation_id:'not-a-uuid'},{identity_verified:false},{reason:'Verified student, temporary password is '+temporary}])assert.equal((await f.issue(4,payload(invalid))).status,400,JSON.stringify(invalid));
 assert.equal(f.provider.calls,0);
 assert.equal(Number((await f.db.prepare('SELECT COUNT(*) AS n FROM password_reset_operations').get()).n),0);
 assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,false);
});

integration('linked feedback must belong to the selected account and an anonymous email never selects its target',async t=>{
 const f=await fixture(t);
 const own=await f.request('/feedback',{method:'POST',cookie:f.cookies.yassine,body:{category:'concern',title:'Forgotten password',description:'I need help accessing my account.'}});
 assert.equal(own.status,201);
 assert.equal((await f.issue(4,payload({contact_id:own.data.ticket.id}))).status,403);
 const anonymous=await f.db.prepare("INSERT INTO contacts(faculty_id,user_id,name,email,subject,message,created_at,filiere_id) VALUES('flaa',NULL,'Unverified sender','sara@campuslink.test','Forgotten password','Unverified request',?,'french_studies') RETURNING id").get(new Date().toISOString());
 const issued=await f.issue(5,payload({contact_id:anonymous.id}));
 assert.equal(issued.status,200,JSON.stringify(issued.data));
 assert.equal(f.provider.calls,1);
 assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,false,'Matching text in an anonymous email must not mutate Sara.');
 assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=5').get()).password_change_required,true);
});

integration('issued resets record an audit and salted verifier without returning or persisting the password',async t=>{
 const f=await fixture(t),body=payload(),issued=await f.issue(4,body);
 assert.equal(issued.status,200,JSON.stringify(issued.data));
 assert.equal(issued.data.ok,true);assert.equal(issued.data.must_change_password,true);assert.equal(issued.data.operation_id,body.operation_id);
 assert.ok(Date.parse(issued.data.expires_at)>Date.now()+23*60*60*1000);
 const operation=await f.db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=?').get(body.operation_id);
 assert.equal(operation.status,'issued');
 const audit=await f.db.prepare("SELECT * FROM administrative_audit WHERE actor_id=2 AND target_id='4' ORDER BY id DESC").all();
 assert.ok(audit.length>0);
 assert.ok(audit.some(item=>JSON.stringify(item.details).includes(reason)));
 for(const value of [issued.data,operation,audit])assert.ok(!JSON.stringify(value).includes(temporary),'No API response, operation row or audit may contain the temporary password.');
 const identityId=(await f.db.prepare('SELECT auth_user_id FROM users WHERE id=4').get()).auth_user_id;
 assert.ok(!JSON.stringify(issued.data).includes(identityId));
});

integration('temporary credentials revoke old sessions and require a personal password before normal API access',async t=>{
 const f=await fixture(t),issued=await f.issue();assert.equal(issued.status,200);
 assert.equal((await f.request('/bootstrap',{cookie:f.cookies.sara})).status,401);
 assert.equal((await f.login('sara','Campus2026!')).status,401);
 const temporaryLogin=await f.login('sara',temporary);assert.equal(temporaryLogin.status,200,JSON.stringify(temporaryLogin.data));
 assert.equal(temporaryLogin.data.user.must_change_password,true);assert.equal('auth_user_id' in temporaryLogin.data.user,false);
 const session=await f.request('/session',{cookie:temporaryLogin.cookie});assert.equal(session.status,200);assert.equal(session.data.user.must_change_password,true);
 for(const [path,method,body]of [['/bootstrap','GET'],['/profile','PATCH',{name:'Must stay blocked'}],['/profile','PATCH',{current_password:temporary,password:replacement}]]){
  const denied=await f.request(path,{cookie:temporaryLogin.cookie,method,body});assert.equal(denied.status,403,JSON.stringify(denied.data));assert.equal(denied.data.code,'PASSWORD_CHANGE_REQUIRED');
 }
 assert.equal((await f.complete(temporaryLogin.cookie,'incorrect-password')).status,403);
 assert.equal((await f.complete(temporaryLogin.cookie,temporary,temporary)).status,400,'The student must choose a different password.');
 const finished=await f.complete(temporaryLogin.cookie);assert.equal(finished.status,200,JSON.stringify(finished.data));
 const personal=await f.login('sara',replacement);assert.equal(personal.status,200,JSON.stringify(personal.data));assert.equal(personal.data.user.must_change_password,false);
 assert.equal((await f.request('/bootstrap',{cookie:personal.cookie})).status,200);
 assert.equal((await f.login('sara',temporary)).status,401);
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(issued.data.operation_id)).status,'completed');
});

integration('expired temporary credentials cannot complete or regain normal account access',async t=>{
 const f=await fixture(t),body=payload(),issued=await f.issue(4,body);assert.equal(issued.status,200);
 const logged=await f.login('sara',temporary);assert.equal(logged.status,200);
 await f.db.prepare('UPDATE users SET password_reset_expires_at=? WHERE id=4').run(new Date(Date.now()-1000).toISOString());
 const finished=await f.complete(logged.cookie);assert.equal(finished.status,403,JSON.stringify(finished.data));
 const replay=await f.issue(4,body);assert.equal(replay.status,403,JSON.stringify(replay.data));assert.equal(replay.data.code,'PASSWORD_RESET_EXPIRED');assert.equal(f.provider.calls,1);
 assert.equal((await f.request('/bootstrap',{cookie:logged.cookie})).status,403);
 assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,true);
});

integration('retrying the same issued operation is idempotent and changed payload is rejected',async t=>{
 const f=await fixture(t),body=payload(),first=await f.issue(4,body);assert.equal(first.status,200);
 const second=await f.issue(4,{...body});assert.equal(second.status,200,JSON.stringify(second.data));assert.equal(second.data.operation_id,first.data.operation_id);assert.equal(f.provider.calls,1);
 const changed=await f.issue(4,{...body,temporary_password:'Another-temporary-private-2026!'});assert.equal(changed.status,409);assert.equal(f.provider.calls,1);
});

integration('a definite provider rejection restores the original account and leaves a failed audit trail',async t=>{
 const f=await fixture(t),body=payload();f.provider.mode='failed';
 const failed=await f.issue(4,body);assert.equal(failed.status,503,JSON.stringify(failed.data));
 const state=await f.db.prepare('SELECT password_change_required,password_reset_operation_id FROM users WHERE id=4').get();assert.equal(state.password_change_required,false);assert.equal(state.password_reset_operation_id,null);
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'failed');
 const old=await f.login('sara','Campus2026!');assert.equal(old.status,200);assert.equal((await f.request('/bootstrap',{cookie:old.cookie})).status,200);
});

integration('a failed replacement preserves the previously issued temporary credential and operation',async t=>{
 const f=await fixture(t),first=await f.issue();assert.equal(first.status,200);
 f.provider.mode='failed';const body=payload({temporary_password:'Rejected-temporary-private-2026!'});
 assert.equal((await f.issue(4,body)).status,503);
 const state=await f.db.prepare('SELECT password_change_required,password_reset_operation_id FROM users WHERE id=4').get();assert.equal(state.password_change_required,true);assert.equal(state.password_reset_operation_id,first.data.operation_id);
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(first.data.operation_id)).status,'issued');
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'failed');
 const previous=await f.login('sara',temporary);assert.equal(previous.status,200);assert.equal((await f.complete(previous.cookie)).status,200);
});

integration('an ambiguous provider outcome blocks the account until an explicit fresh rotation succeeds',async t=>{
 const f=await fixture(t),body=payload();f.provider.mode='unknown';
 const ambiguous=await f.issue(4,body);assert.equal(ambiguous.status,503,JSON.stringify(ambiguous.data));
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'unknown');
 assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,true);
 const repeated=await f.issue(4,body);assert.equal(repeated.status,503);assert.equal(repeated.data.code,'PASSWORD_RESET_UNKNOWN');assert.equal(f.provider.calls,1);
 const logged=await f.login('sara',temporary);assert.equal(logged.status,200,JSON.stringify(logged.data));assert.equal(logged.data.user.must_change_password,true);
 assert.equal((await f.request('/bootstrap',{cookie:logged.cookie})).status,403);
 const blocked=await f.complete(logged.cookie);assert.ok([409,503].includes(blocked.status));
 f.provider.mode='success';const confirmed='Confirmed-temporary-private-2026!';
 assert.equal((await f.issue(4,payload({temporary_password:confirmed}))).status,200);
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'superseded');
 const corrected=await f.login('sara',confirmed);assert.equal(corrected.status,200);
 assert.equal((await f.complete(corrected.cookie,confirmed)).status,200);
});

integration('an unconfirmed provider response cannot acknowledge usable temporary credentials',async t=>{
 const f=await fixture(t),body=payload();f.provider.mode='unconfirmed';
 const result=await f.issue(4,body);assert.equal(result.status,503);assert.equal(result.data.code,'PASSWORD_RESET_UNKNOWN');assert.equal(result.data.ok,undefined);
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'unknown');
 assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,true);
 const logged=await f.login('sara',temporary);assert.equal(logged.status,200);assert.equal((await f.request('/bootstrap',{cookie:logged.cookie})).status,403);
 assert.equal((await f.issue(4,body)).status,503);assert.equal(f.provider.calls,1);
});

integration('simultaneous retries call the identity provider once and never issue a second in-flight rotation',async t=>{
 const f=await fixture(t),body=payload();let enter,release;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 f.provider.before=async()=>{enter();await held;};
 try{
  const first=f.issue(4,body);await reached(entered);
  assert.equal((await f.issue(4,body)).status,409);
  assert.equal((await f.issue(4,payload())).status,409);
  assert.equal(f.provider.calls,1);release();assert.equal((await first).status,200);
  assert.equal((await f.issue(4,body)).status,200);assert.equal(f.provider.calls,1);
 }finally{release();}
});

integration('explicit replacement supersedes the prior temporary password and enforces the hourly limit',async t=>{
 const f=await fixture(t),first=await f.issue();assert.equal(first.status,200);
 const next='Second-temporary-private-2026!',last='Third-temporary-private-2026!';
 assert.equal((await f.issue(4,payload({temporary_password:next}))).status,200);
 assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(first.data.operation_id)).status,'superseded');
 assert.equal((await f.login('sara',temporary)).status,401);
 assert.equal((await f.issue(4,payload({temporary_password:last}))).status,200);
 assert.equal((await f.issue(4,payload({temporary_password:'Fourth-temporary-private-2026!'}))).status,429);
 assert.equal(f.provider.calls,3);assert.equal((await f.login('sara',last)).status,200);
});

integration('reset finalization rechecks an owner disabled while the provider is processing the password',async t=>{
 const f=await fixture(t),body=payload();let enter,release;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 f.provider.before=async()=>{enter();await held;};
 try{
  const pending=f.issue(4,body);await reached(entered);
  await f.db.prepare('UPDATE users SET disabled=1 WHERE id=2').run();release();
  const result=await pending;assert.ok(result.status>=400,JSON.stringify(result.data));
  const operation=await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id);assert.equal(operation.status,'unknown');
  assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,true);
  const logged=await f.login('sara',temporary);assert.equal(logged.status,200);assert.equal((await f.request('/bootstrap',{cookie:logged.cookie})).status,403);
 }finally{release();}
});

integration('reset finalization keeps a newly protected target restricted when an appointment changes in flight',async t=>{
 const f=await fixture(t),body=payload();let enter,release;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 f.provider.before=async()=>{enter();await held;};
 try{
  const pending=f.issue(4,body);await reached(entered);
  await f.db.prepare("INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,filiere_id,capabilities,created_at) VALUES(4,2,'flaa','french_studies','[\"student.support\"]',?)").run(new Date().toISOString());release();
  const result=await pending;assert.ok(result.status>=400,JSON.stringify(result.data));
  assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'unknown');
  assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,true);
 }finally{release();}
});

integration('personal password completion claims the operation before RPC and blocks concurrent completion or issuance',async t=>{
 const f=await fixture(t),issued=await f.issue();assert.equal(issued.status,200);
 const logged=await f.login('sara',temporary);assert.equal(logged.status,200);
 let enter,release,calls=0;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 const changePassword=f.auth.changePassword.bind(f.auth);
 f.auth.changePassword=async(...args)=>{calls++;enter();await held;return changePassword(...args);};
 try{
  const pending=f.complete(logged.cookie);await reached(entered);
  assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(issued.data.operation_id)).status,'changing');
  const competing=await f.issue(4,payload({temporary_password:'Competing-temporary-private-2026!'}));assert.equal(competing.status,409);assert.equal(competing.data.code,'PASSWORD_RESET_PENDING');
  const duplicate=await f.complete(logged.cookie);assert.equal(duplicate.status,409);assert.equal(calls,1);assert.equal(f.provider.calls,1);
  release();const completed=await pending;assert.equal(completed.status,200,JSON.stringify(completed.data));
  assert.equal(completed.data.user.must_change_password,false);
  const personal=await f.login('sara',replacement);assert.equal(personal.status,200);assert.equal((await f.request('/bootstrap',{cookie:personal.cookie})).status,200);
 }finally{release();}
});

integration('an interrupted pending operation becomes unknown only after an explicit owner retry',async t=>{
 const f=await fixture(t),body=payload();let enter,release;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 f.provider.before=async()=>{enter();await held;};
 try{
  const pending=f.issue(4,body);await reached(entered);
  await f.db.prepare('UPDATE password_reset_operations SET updated_at=? WHERE operation_id=?').run(new Date(Date.now()-121000).toISOString(),body.operation_id);
  await f.request('/session',{cookie:f.cookies.admin});
  assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'pending','Ordinary session reads cannot retry an external password mutation.');
  const explicit=await f.issue(4,body);assert.equal(explicit.status,503);assert.equal(explicit.data.code,'PASSWORD_RESET_UNKNOWN');assert.equal(f.provider.calls,1);
  assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'unknown');
  release();assert.equal((await pending).status,503);assert.equal(f.provider.calls,1);
  assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,true);
 }finally{release();}
});

integration('completion CAS keeps a newer account restriction when the active operation changes during RPC',async t=>{
 const f=await fixture(t),issued=await f.issue();assert.equal(issued.status,200);
 const logged=await f.login('sara',temporary);assert.equal(logged.status,200);
 let enter,release;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 const changePassword=f.auth.changePassword.bind(f.auth);
 f.auth.changePassword=async(...args)=>{enter();await held;return changePassword(...args);};
 const newer=randomUUID();
 try{
  const pending=f.complete(logged.cookie);await reached(entered);
  const user=await f.db.prepare('SELECT auth_user_id FROM users WHERE id=4').get();
  await f.db.prepare("INSERT INTO password_reset_operations(operation_id,actor_id,target_user_id,auth_user_id,reason,request_salt,request_hash,status) VALUES(?,2,4,?,?,?,?,'pending')").run(newer,user.auth_user_id,'A newer account restriction was applied.',randomUUID(),'00'.repeat(32));
  await f.db.prepare('UPDATE users SET password_reset_operation_id=?,password_reset_expires_at=NULL WHERE id=4').run(newer);
  release();const result=await pending;assert.equal(result.status,503);assert.equal(result.data.code,'PASSWORD_RESET_UNKNOWN');
  const state=await f.db.prepare('SELECT password_change_required,password_reset_operation_id FROM users WHERE id=4').get();assert.equal(state.password_change_required,true);assert.equal(state.password_reset_operation_id,newer);
  assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(newer)).status,'pending');
  assert.equal((await f.request('/bootstrap',{cookie:result.cookie||logged.cookie})).status,401,'A failed finalization must dispose of its provider session.');
 }finally{release();}
});

integration('an interrupted personal password change is surfaced to the owner without another provider RPC',async t=>{
 const f=await fixture(t),body=payload(),issued=await f.issue(4,body);assert.equal(issued.status,200);
 const logged=await f.login('sara',temporary);assert.equal(logged.status,200);
 let enter,release,calls=0;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 const changePassword=f.auth.changePassword.bind(f.auth);
 f.auth.changePassword=async(...args)=>{calls++;enter();await held;return changePassword(...args);};
 try{
  const pending=f.complete(logged.cookie);await reached(entered);
  await f.db.prepare('UPDATE password_reset_operations SET updated_at=? WHERE operation_id=?').run(new Date(Date.now()-121000).toISOString(),body.operation_id);
  const session=await f.request('/session',{cookie:logged.cookie});assert.equal(session.status,200);assert.equal(session.data.user.must_change_password,true);
  assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'changing');
  const explicit=await f.issue(4,body);assert.equal(explicit.status,503);assert.equal(explicit.data.code,'PASSWORD_RESET_UNKNOWN');assert.equal(f.provider.calls,1);assert.equal(calls,1);
  release();const result=await pending;assert.equal(result.status,503);
  assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(body.operation_id)).status,'unknown');
  assert.equal((await f.db.prepare('SELECT password_change_required FROM users WHERE id=4').get()).password_change_required,true);
 }finally{release();}
});
