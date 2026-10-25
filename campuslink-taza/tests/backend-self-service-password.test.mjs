import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestEnvironment} from './backend-helpers.mjs';
import {createApp} from '../server/app.js';

// Only disposable schemas on an explicit, independent test database are used.
// The injected provider never delivers mail or changes a real password.
const integration=process.env.CAMPUS_TEST_DATABASE_URL?test:test.skip;
const original='Campus2026!',chosen='12345678',code='123456';
const failure=(status,code)=>Object.assign(new Error('Synthetic provider refusal'),{status,code});

async function fixture(t){
  const url=new URL(process.env.CAMPUS_TEST_DATABASE_URL);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol),'Use an explicit PostgreSQL test database.');
  if(process.env.DATABASE_URL){const production=new URL(process.env.DATABASE_URL);assert.ok(url.hostname!==production.hostname||url.pathname!==production.pathname||url.port!==production.port,'The test database must differ from the application database.');}
  const env=await createTestEnvironment();
  const users=new Map();
  for(const row of await env.db.prepare('SELECT * FROM users').all()){
    const email=`${row.username}@usmba.ac.ma`;
    await env.auth.bindUser(row.id,{email,password:row.username==='admin'?'Admin2026!':original});
    users.set(row.username,{...row,email});
  }
  const provider={sent:[],checked:[],completed:[],codes:new Map(),mode:'success',afterMutation:null};
  env.auth.requestPasswordRecovery=async(_req,{email})=>{provider.sent.push(email);provider.codes.set(email,code);return {success:true};};
  env.auth.checkPasswordRecoveryCode=async(_req,{email,code:otp})=>{provider.checked.push({email,code:otp});if(provider.mode==='invalid'||provider.codes.get(email)!==otp)throw failure(400,'PASSWORD_RECOVERY_INVALID');return {success:true};};
  env.auth.completePasswordRecovery=async(_req,body)=>{
    provider.completed.push({...body});
    if(['invalid','reset-invalid'].includes(provider.mode)||provider.codes.get(body.email)!==body.code)throw failure(400,'PASSWORD_RECOVERY_INVALID');
    const identity=[...env.auth.identities.values()].find(value=>value.email===body.email);
    assert.ok(identity,'Only an existing mapped synthetic identity may be changed.');
    identity.password=body.newPassword;provider.codes.delete(body.email);
    provider.afterMutation?.();
    if(provider.mode==='unknown')throw failure(503,'PASSWORD_RECOVERY_UNKNOWN');
    return {success:true};
  };
  env.auth.clearCookie=(_req,res)=>res.clearCookie('campus_neon_test_session',{httpOnly:true,sameSite:'lax',path:'/'});
  const app=await createApp({db:env.db,auth:env.auth,storage:env.storage,googleOAuth:{enabled:false,domains:['usmba.ac.ma']}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.close();await env.close();});
  async function request(path,{cookie,method='GET',body,headers={}}={}){
    const response=await fetch(origin+'/api'+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),headers:response.headers,cookie:response.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session='))?.split(';')[0]};
  }
  const login=(username,password=username==='admin'?'Admin2026!':original)=>request('/login',{method:'POST',body:{username,password}});
  const start=(email,cookie)=>request('/auth/password-recovery/start',{method:'POST',cookie,body:{email}});
  const complete=(email,{cookie,otp=code,newPassword=chosen}={})=>request('/auth/password-recovery/complete',{method:'POST',cookie,body:{email,code:otp,newPassword}});
  const row=username=>env.db.prepare('SELECT * FROM users WHERE id=?').get(users.get(username).id);
  async function operation(username,status='issued'){
    const user=await row(username),id=randomUUID(),expiry=new Date(Date.now()+3600000).toISOString();
    await env.db.prepare('INSERT INTO password_reset_operations(operation_id,actor_id,target_user_id,auth_user_id,reason,request_salt,request_hash,status,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,users.get('admin').id,user.id,user.auth_user_id,'Synthetic administrator reset for recovery regression.','synthetic-salt','synthetic-hash',status,expiry);
    await env.db.prepare('UPDATE users SET password_change_required=TRUE,password_reset_operation_id=?,password_reset_expires_at=? WHERE id=?').run(id,expiry,user.id);
    return {id,expiry};
  }
  return {...env,app,users,provider,request,login,start,complete,row,operation};
}

integration('Academic email self-service password recovery routes',async t=>{
  const f=await fixture(t),sara=f.users.get('sara'),yassine=f.users.get('yassine'),admin=f.users.get('admin');

  await t.test('Personal emails and lookalike academic domains fail before provider requests',async()=>{
    for(const email of ['student@gmail.com','student@sub.usmba.ac.ma','student@usmba.ac.ma.evil.test','invalid']){
      const result=await f.start(email);assert.equal(result.status,400);assert.equal(result.data.code,'PASSWORD_RECOVERY_INVALID');
    }
    assert.equal(f.provider.sent.length,0);assert.equal(f.provider.completed.length,0);
  });

  await t.test('Unknown and disabled academic addresses return the same generic send response without mail',async()=>{
    const disabled=f.users.get('professeure');await f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(disabled.id);
    const unknown=await f.start('unknown@usmba.ac.ma'),blocked=await f.start(disabled.email);
    assert.equal(unknown.status,200);assert.equal(blocked.status,200);assert.deepEqual(unknown.data,{success:true});assert.deepEqual(blocked.data,unknown.data);
    assert.equal(f.provider.sent.length,0);await f.db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(disabled.id);
  });

  await t.test('Authenticated accounts cannot request or complete recovery for another address',async()=>{
    const signed=await f.login('yassine');assert.equal(signed.status,200);
    const sent=await f.start(sara.email,signed.cookie),completed=await f.complete(sara.email,{cookie:signed.cookie});
    assert.equal(sent.status,400);assert.equal(completed.status,400);
    assert.equal(f.provider.sent.length,0);assert.equal(f.provider.completed.length,0);
    assert.equal((await f.request('/session',{cookie:signed.cookie})).data.user.id,yassine.id);
  });

  await t.test('Invalid passwords and codes never reach the provider or revoke sessions',async()=>{
    const signed=await f.login('sara');assert.equal(signed.status,200);const before=await f.row('sara');
    for(const options of [{newPassword:'1234567'},{newPassword:'x'.repeat(129)},{otp:'12345'},{otp:'12345a'}]){const result=await f.complete(sara.email,options);assert.equal(result.status,400);assert.equal(result.data.code,'PASSWORD_RECOVERY_INVALID');}
    assert.equal(f.provider.completed.length,0);const after=await f.row('sara');assert.equal(after.auth_revoked_at,before.auth_revoked_at);assert.equal(after.session_version,before.session_version);
    assert.equal((await f.request('/session',{cookie:signed.cookie})).data.user.id,sara.id);
  });

  await t.test('A rejected provider OTP leaves the account and all existing sessions unchanged',async()=>{
    const signed=await f.login('yassine'),before=await f.row('yassine');
    const result=await f.complete(yassine.email,{otp:'654321'});assert.equal(result.status,400);assert.equal(result.data.code,'PASSWORD_RECOVERY_INVALID');
    const after=await f.row('yassine');assert.equal(after.auth_revoked_at,before.auth_revoked_at);assert.equal(after.session_version,before.session_version);
    assert.equal((await f.request('/session',{cookie:signed.cookie})).data.user.id,yassine.id);
  });

  await t.test('Confirmed eight-digit password reset cuts off old sessions and preserves profile, role, status and content',async()=>{
    const signed=await f.login('sara'),signedAgain=await f.login('sara'),other=await f.login('yassine');
    assert.equal((await f.start('  SARA@USMBA.AC.MA  ')).status,200);assert.equal(f.provider.sent.at(-1),sara.email);
    const before=await f.row('sara'),counts=await f.db.prepare('SELECT (SELECT count(*) FROM resources) AS resources,(SELECT count(*) FROM messages) AS messages').get();
    const result=await f.complete(sara.email,{cookie:signed.cookie});assert.equal(result.status,200,JSON.stringify(result.data));assert.deepEqual(result.data,{success:true});
    assert.match(result.headers.get('set-cookie'),/campus_neon_test_session=;/);
    const after=await f.row('sara');assert.ok(after.auth_revoked_at);assert.equal(after.session_version,before.session_version+1);
    for(const field of ['id','name','username','email','role','account_status','faculty_id','filiere_id','current_semester','preferences','auth_user_id'])assert.deepEqual(after[field],before[field],`Preserve ${field}.`);
    assert.deepEqual(await f.db.prepare('SELECT (SELECT count(*) FROM resources) AS resources,(SELECT count(*) FROM messages) AS messages').get(),counts);
    for(const cookie of [signed.cookie,signedAgain.cookie])assert.equal((await f.request('/session',{cookie})).data.user,null);
    assert.equal((await f.request('/session',{cookie:other.cookie})).data.user.id,yassine.id);
    assert.equal((await f.login('sara',original)).status,401);assert.equal((await f.login('sara',chosen)).status,200);
    const audit=await f.db.prepare("SELECT * FROM administrative_audit WHERE action='password-recovery.self-service-completed' AND target_id=?").all(String(sara.id));
    assert.ok(audit.length);assert.equal(JSON.stringify(audit).includes(chosen),false);assert.equal(JSON.stringify(audit).includes(code),false);
  });

  await t.test('Replaying a consumed OTP is rejected without a second session cutoff',async()=>{
    const before=await f.row('sara'),result=await f.complete(sara.email);assert.equal(result.status,400);assert.equal(result.data.code,'PASSWORD_RECOVERY_INVALID');
    assert.equal((await f.row('sara')).session_version,before.session_version);
  });

  await t.test('A confirmed email code clears an issued administrator temporary-password restriction',async()=>{
    const op=await f.operation('yassine');assert.equal((await f.start(yassine.email)).status,200);
    const signed=await f.login('yassine');assert.equal(signed.status,200);assert.equal(signed.data.user.must_change_password,true);
    const result=await f.complete(yassine.email,{cookie:signed.cookie,newPassword:'87654321'});assert.equal(result.status,200,JSON.stringify(result.data));
    const user=await f.row('yassine');assert.equal(user.password_change_required,false);assert.equal(user.password_reset_operation_id,null);assert.equal(user.password_reset_expires_at,null);
    assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(op.id)).status,'superseded');
    const completed=await f.db.prepare("SELECT * FROM password_reset_operations WHERE target_user_id=? AND previous_operation_id=?").get(yassine.id,op.id);assert.equal(completed.status,'completed');
    const next=await f.login('yassine','87654321');assert.equal(next.status,200);assert.equal(next.data.user.must_change_password,false);
  });

  await t.test('An uncertain provider outcome revokes old sessions and preserves restriction flags and operation',async()=>{
    const op=await f.operation('sara','unknown'),before=await f.row('sara'),signed=await f.login('sara',chosen);
    assert.equal((await f.start(sara.email)).status,200);f.provider.mode='unknown';
    const result=await f.complete(sara.email,{cookie:signed.cookie,newPassword:'11223344'});f.provider.mode='success';
    assert.equal(result.status,503);assert.equal(result.data.code,'PASSWORD_RECOVERY_UNKNOWN');
    const after=await f.row('sara');assert.equal(after.session_version,before.session_version+1);assert.equal(after.password_change_required,true);assert.notEqual(after.password_reset_operation_id,op.id);assert.equal(after.password_reset_expires_at,null);
    const current=await f.db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=?').get(after.password_reset_operation_id);assert.equal(current.status,'unknown');assert.equal(current.previous_operation_id,op.id);assert.equal(current.previous_required,true);
    assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(op.id)).status,'unknown');
    assert.equal((await f.request('/session',{cookie:signed.cookie})).data.user,null);
    assert.match(result.headers.get('set-cookie'),/campus_neon_test_session=;/);
  });

  await t.test('A pending administrator password mutation blocks OTP recovery before reaching the provider',async()=>{
    const op=await f.operation('yassine','pending'),before=await f.row('yassine'),writes=f.provider.completed.length;
    assert.equal((await f.start(yassine.email)).status,200);
    const result=await f.complete(yassine.email);assert.equal(result.status,503);assert.equal(result.data.code,'PASSWORD_RECOVERY_UNAVAILABLE');
    assert.equal(f.provider.completed.length,writes);const after=await f.row('yassine');assert.equal(after.session_version,before.session_version);assert.equal(after.password_reset_operation_id,op.id);assert.equal(after.password_change_required,true);
    assert.equal((await f.db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(op.id)).status,'pending');
  });

  await t.test('A definitive reset refusal after OTP preflight restores prior flags and retains the old-session cutoff',async()=>{
    const amina=f.users.get('amina'),signed=await f.login('amina'),before=await f.row('amina');
    assert.equal((await f.start(amina.email)).status,200);f.provider.mode='reset-invalid';
    const result=await f.complete(amina.email);f.provider.mode='success';assert.equal(result.status,400);assert.equal(result.data.code,'PASSWORD_RECOVERY_INVALID');
    const after=await f.row('amina');assert.equal(after.password_change_required,before.password_change_required);assert.equal(after.password_reset_operation_id,before.password_reset_operation_id);assert.equal(after.password_reset_expires_at,before.password_reset_expires_at);assert.equal(after.session_version,before.session_version+1);
    assert.equal((await f.request('/session',{cookie:signed.cookie})).data.user,null);assert.equal((await f.login('amina')).status,200);
    const operation=await f.db.prepare('SELECT * FROM password_reset_operations WHERE target_user_id=? ORDER BY created_at DESC LIMIT 1').get(amina.id);assert.equal(operation.status,'failed');
  });

  await t.test('A database finalization failure after provider success preserves the durable restriction and blocks an immediate retry',async()=>{
    const omar=f.users.get('omar'),signed=await f.login('omar'),before=await f.row('omar'),originalPrepare=f.db.prepare.bind(f.db);
    assert.equal((await f.start(omar.email)).status,200);
    let armed=false,failed=false;
    f.provider.afterMutation=()=>{armed=true;};
    f.db.prepare=function(sql){
      if(armed&&!failed&&sql.startsWith('UPDATE password_reset_operations SET status=')){failed=true;throw new Error('Synthetic database finalization failure');}
      return originalPrepare(sql);
    };
    let result;
    try{result=await f.complete(omar.email);}finally{f.db.prepare=originalPrepare;f.provider.afterMutation=null;}
    assert.equal(failed,true);assert.equal(result.status,503);assert.equal(result.data.code,'PASSWORD_RECOVERY_UNKNOWN');
    const after=await f.row('omar');assert.equal(after.password_change_required,true);assert.ok(after.password_reset_operation_id);assert.equal(after.session_version,before.session_version+1);assert.ok(after.auth_revoked_at);
    const operation=await f.db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=?').get(after.password_reset_operation_id);assert.equal(operation.status,'changing');
    assert.equal((await f.request('/session',{cookie:signed.cookie})).data.user,null);
    const changed=await f.login('omar',chosen);assert.equal(changed.status,200);assert.equal(changed.data.user.must_change_password,true);
    const writes=f.provider.completed.length;f.provider.codes.set(omar.email,code);
    const retry=await f.complete(omar.email);assert.equal(retry.status,503);assert.equal(retry.data.code,'PASSWORD_RECOVERY_UNAVAILABLE');assert.equal(f.provider.completed.length,writes);
  });

  await t.test('Pending account recovery preserves admission status and administrative role is unchanged',async()=>{
    await f.db.prepare("UPDATE users SET account_status='pending' WHERE id=?").run(admin.id);
    const before=await f.row('admin');assert.equal((await f.start(admin.email)).status,200);
    const result=await f.complete(admin.email);assert.equal(result.status,200);
    const after=await f.row('admin');assert.equal(after.account_status,'pending');assert.equal(after.role,before.role);
  });

  await t.test('Send and completion limits are enforced without sending mail for unknown addresses',async()=>{
    const sends=f.provider.sent.length,writes=f.provider.completed.length;
    for(let i=0;i<3;i++)assert.equal((await f.start('limited@usmba.ac.ma')).status,200);
    const limited=await f.start('limited@usmba.ac.ma');assert.equal(limited.status,429);assert.equal(limited.data.code,'PASSWORD_RECOVERY_RATE_LIMITED');assert.ok(limited.data.retryAfter>0);assert.ok(Number(limited.headers.get('retry-after'))>0);
    for(let i=0;i<8;i++)assert.equal((await f.complete('missing@usmba.ac.ma')).status,400);
    const attempts=await f.complete('missing@usmba.ac.ma');assert.equal(attempts.status,429);assert.equal(attempts.data.code,'PASSWORD_RECOVERY_RATE_LIMITED');assert.ok(attempts.data.retryAfter>0);
    assert.equal(f.provider.sent.length,sends);assert.equal(f.provider.completed.length,writes);
  });
});
