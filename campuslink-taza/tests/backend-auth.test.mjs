import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAuthService, AUTH_COOKIE } from '../server/auth.js';

const issuer='https://auth.example.invalid';
const origin='http://localhost:5173';
const lanOrigin='http://192.168.1.102:5173';
const subject=randomUUID();
function response() {const headers=[];return {headers,append(name,value){headers.push({name,value});}};}
const request=cookie=>({headers:{origin,host:'localhost:5173',...(cookie?{cookie}:{})},protocol:'http'});
const lanRequest=cookie=>({headers:{origin:lanOrigin,host:new URL(lanOrigin).host,...(cookie?{cookie}:{})},protocol:'http'});
function browserCookie(res) {return res.headers.filter(h=>h.name==='Set-Cookie').at(-1)?.value.split(';')[0];}

async function fixture({appOrigin=origin,trustedOrigin,includeAppOrigin=true}={}) {
  const {privateKey,publicKey}=await generateKeyPair('EdDSA');
  const jwk=await exportJWK(publicKey);jwk.kid='test-key';jwk.alg='EdDSA';
  const sessions=new Map(),managedUsers=new Map(),profiles=new Map(),providerRequests=[];
  let jwtOverride,signInSubject=subject,deleteStatus=404,changePasswordReply;
  let passwordResetReply={status:200,data:{status:true}},adminRevokeReply={status:403,data:{}};
  managedUsers.set(subject,{id:subject,email:'student@example.com',name:'Student',password:'Temporary2026!',createdAt:new Date().toISOString()});
  profiles.set(subject,{id:7,username:'student',name:'Student',auth_user_id:subject,email:'student@example.com',role:'student',disabled:0,auth_revoked_at:null,session_version:0,faculty_id:'fsa',filiere_id:'data_science',current_semester:5});
  const token=async (user,options={})=>new SignJWT({role:'global_admin'}).setProtectedHeader({alg:'EdDSA',kid:'test-key'}).setIssuer(options.issuer||issuer).setAudience(options.audience||issuer).setSubject(user.id).setIssuedAt().setExpirationTime(options.expires||'5m').sign(privateKey);
  const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
  const fetchImpl=async(input,options={})=>{
    const url=new URL(input),path=url.pathname.replace('/auth/',''),body=options.body?JSON.parse(options.body):{},cookies=options.headers?.cookie||'';
    const opaque=cookies.match(/__Secure-neon-auth\.session_token=([^;]+)/)?.[1];
    const session=sessions.get(opaque),user=session?managedUsers.get(session.userId):null;
    if(url.pathname==='/jwks')return json({keys:[jwk]});
    providerRequests.push({path,origin:options.headers?.origin,method:options.method,cookie:cookies,body});
    if(trustedOrigin&&options.headers?.origin!==trustedOrigin)return json({code:'INVALID_ORIGIN'},403);
    if(path==='sign-in/email') {
      const found=[...managedUsers.values()].find(u=>u.email===body.email&&u.password===body.password);
      if(!found)return json({code:'INVALID_EMAIL_OR_PASSWORD'},401);
      const id=signInSubject===subject?found.id:signInSubject,opaque=randomUUID();
      sessions.set(opaque,{id:randomUUID(),userId:id,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});
      return json({user:{id},token:opaque},200,{'set-cookie':`__Secure-neon-auth.session_token=${opaque}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`});
    }
    if(path==='get-session') {
      if(!user)return json(null);
      const jwt=jwtOverride??await token(user);
      return json({user:{...user,password:undefined,emailVerified:false,role:'global_admin'},session:{...session,token:opaque}},200,{'set-auth-jwt':jwt});
    }
    if(path==='sign-out'){if(opaque)sessions.delete(opaque);return json({success:true},200,{'set-cookie':'__Secure-neon-auth.session_token=; Max-Age=0; Path=/; Secure; HttpOnly'});}
    if(path==='sign-up/email') {
      const id=randomUUID(),opaque=randomUUID();
      const created={id,email:body.email,name:body.name,password:body.password,createdAt:new Date().toISOString()};
      managedUsers.set(id,created);sessions.set(opaque,{id:randomUUID(),userId:id,createdAt:created.createdAt,expiresAt:new Date(Date.now()+3600000).toISOString()});
      return json({user:{...created,password:undefined}},200,{'set-cookie':`__Secure-neon-auth.session_token=${opaque}; Max-Age=3600; Path=/; HttpOnly; Secure`});
    }
    if(path==='delete-user') {if(deleteStatus===200&&user){managedUsers.delete(user.id);for(const [key,s]of sessions)if(s.userId===user.id)sessions.delete(key);}return json({},deleteStatus);}
    if(path==='admin/set-user-password') {
      if(!user)return json({code:'UNAUTHORIZED'},401);
      const target=managedUsers.get(body.userId);
      if(!target)return json({code:'USER_NOT_FOUND'},400);
      if(passwordResetReply.mutate===true||passwordResetReply.mutate!==false&&passwordResetReply.status>=200&&passwordResetReply.status<300)target.password=body.newPassword;
      if(passwordResetReply.error)throw passwordResetReply.error;
      if(Object.hasOwn(passwordResetReply,'raw'))return new Response(passwordResetReply.raw,{status:passwordResetReply.status,headers:passwordResetReply.headers});
      return json(passwordResetReply.data,passwordResetReply.status,passwordResetReply.headers);
    }
    if(path==='admin/revoke-user-sessions') {
      if(adminRevokeReply.error)throw adminRevokeReply.error;
      if(adminRevokeReply.status===200&&adminRevokeReply.data?.success===true)for(const [key,s]of sessions)if(s.userId===body.userId)sessions.delete(key);
      return json(adminRevokeReply.data,adminRevokeReply.status,adminRevokeReply.headers);
    }
    if(path==='change-password') {
      if(changePasswordReply)return json(changePasswordReply);
      if(!user||body.currentPassword!==user.password)return json({},400);
      user.password=body.newPassword;
      for(const [key,s]of sessions)if(s.userId===user.id&&key!==opaque)sessions.delete(key);
      return json({token:opaque,user:{id:user.id}});
    }
    throw Error('Unexpected authentication endpoint');
  };
  const db={prepare(sql){return {
    async get(id){if(sql.startsWith('SELECT * FROM users'))return profiles.get(id);if(sql.startsWith('SELECT id FROM users'))return profiles.has(id)?{id:profiles.get(id).id}:undefined;throw Error('Unexpected profile query');},
    async run(...values) {
      if(sql.startsWith('UPDATE users SET auth_revoked_at=')){const profile=profiles.get(values[1]);if(profile){profile.auth_revoked_at=values[0];profile.session_version++;}return {changes:profile?1:0};}
      if(sql.startsWith('DELETE FROM neon_auth.')){const user=managedUsers.get(values[0]);if(user&&user.email===values[1]&&user.createdAt>values[2]){managedUsers.delete(user.id);for(const [key,s]of sessions)if(s.userId===user.id)sessions.delete(key);return {changes:1};}return {changes:0};}
      throw Error('Unexpected identity mutation');
    },
  };}};
  const auth=createAuthService({db,baseUrl:`${issuer}/auth`,jwksUrl:`${issuer}/jwks`,fetchImpl,...(includeAppOrigin?{appOrigin}:{})});
  return {auth,profiles,managedUsers,sessions,providerRequests,token,setJWT:value=>jwtOverride=value,setSubject:value=>signInSubject=value,setDeleteStatus:value=>deleteStatus=value,setChangePasswordReply:value=>changePasswordReply=value,setPasswordResetReply:value=>passwordResetReply=value,setAdminRevokeReply:value=>adminRevokeReply=value};
}

test('Neon login verifies provider session/JWKS identity and retains trusted application roles',async()=>{
  const {auth}=await fixture(),res=response();
  const logged=await auth.signIn(request(),res,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
  assert.equal(logged.user.id,7);assert.equal(logged.user.role,'student'); // Provider claims cannot grant roles.
  assert.equal(logged.user.current_semester,5);assert.equal(logged.authUserId,subject);
  const setCookie=res.headers[0].value;
  assert.match(setCookie,new RegExp(`^${AUTH_COOKIE}=`));assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Lax/);assert.ok(!setCookie.includes('Domain='));assert.ok(!setCookie.includes('SameSite=None'));
  const cookie=browserCookie(res);
  assert.equal((await auth.authenticate(request(cookie))).user.id,7);
  const loggedOut=response();await auth.signOut(request(cookie),loggedOut);
  assert.equal(await auth.authenticate(request(cookie)),null);assert.ok(loggedOut.headers.some(h=>h.value.includes('Max-Age=0')));
});

test('LAN signup and sessions use the configured provider origin while cookies follow browser transport',async()=>{
  const {auth,profiles,managedUsers,providerRequests}=await fixture({appOrigin:origin,trustedOrigin:origin});
  const created=await auth.createUser(lanRequest(),{email:'phone@example.com',password:'Temporary2026!',name:'Phone student'});
  assert.equal(managedUsers.has(created.id),true);
  profiles.set(created.id,{id:8,username:'phone',name:'Phone student',auth_user_id:created.id,email:created.email,role:'student',disabled:0,auth_revoked_at:null});
  const credentials={email:created.email,password:'Temporary2026!',expectedAuthUserId:created.id};
  const res=response(),logged=await auth.signIn(lanRequest(),res,credentials);
  assert.equal(logged.user.id,8);assert.equal(logged.user.role,'student');
  const setCookie=res.headers.find(h=>h.name==='Set-Cookie').value;
  assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Lax/);assert.ok(!setCookie.includes('Domain='));
  assert.equal(setCookie.includes('; Secure'),process.env.COOKIE_SECURE==='true');
  const cookie=browserCookie(res);
  assert.equal((await auth.authenticate(lanRequest(cookie))).authUserId,created.id);
  const loggedOut=response();await auth.signOut(lanRequest(cookie),loggedOut);
  assert.equal(await auth.authenticate(lanRequest(cookie)),null);
  assert.ok(loggedOut.headers.some(h=>h.value.includes('Max-Age=0')));

  const httpsOrigin='https://campus.example.test';
  const httpsRequest={headers:{origin:httpsOrigin,host:new URL(httpsOrigin).host},protocol:'https',secure:true};
  const httpsRes=response();await auth.signIn(httpsRequest,httpsRes,credentials);
  assert.ok(httpsRes.headers.some(h=>h.name==='Set-Cookie'&&h.value.includes('; Secure')));
  await auth.signOut({...httpsRequest,headers:{...httpsRequest.headers,cookie:browserCookie(httpsRes)}},response());

  profiles.delete(created.id);await created.cleanup();assert.equal(managedUsers.has(created.id),false);
  assert.ok(providerRequests.some(call=>call.path==='sign-up/email'));
  assert.ok(providerRequests.some(call=>call.path==='sign-in/email'));
  assert.ok(providerRequests.some(call=>call.path==='get-session'));
  assert.ok(providerRequests.some(call=>call.path==='sign-out'));
  assert.ok(providerRequests.every(call=>call.origin===origin));
});

test('factory default provider origin permits phone signup without an explicit appOrigin option',async()=>{
  const expectedOrigin=process.env.APP_ORIGIN||origin;
  const {auth,managedUsers,providerRequests}=await fixture({includeAppOrigin:false,trustedOrigin:expectedOrigin});
  const created=await auth.createUser(lanRequest(),{email:'default-phone@example.com',password:'Temporary2026!',name:'Phone student'});
  assert.equal(managedUsers.has(created.id),true);
  await created.cleanup();assert.equal(managedUsers.has(created.id),false);
  assert.ok(providerRequests.some(call=>call.path==='sign-up/email'));
  assert.ok(providerRequests.every(call=>call.origin===expectedOrigin));
});

test('operator identity proof and disposal retain the configured provider origin',async()=>{
  const configuredOrigin='https://campus.example.test';
  const {auth,sessions,providerRequests}=await fixture({appOrigin:configuredOrigin,trustedOrigin:configuredOrigin});
  const proof=await auth.proveIdentity({email:'student@example.com',password:'Temporary2026!',requestOrigin:lanOrigin});
  assert.equal(proof.authUser.id,subject);assert.equal(sessions.size,1);
  await proof.dispose();assert.equal(sessions.size,0);
  assert.deepEqual(providerRequests.map(call=>call.path),['sign-in/email','get-session','sign-out']);
  assert.ok(providerRequests.every(call=>call.origin===configuredOrigin));
});

test('unlinked, disabled, mismatched and revoked application profiles cannot authenticate',async()=>{
  const {auth,profiles}=await fixture(),res=response();
  await auth.signIn(request(),res,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
  const req=request(browserCookie(res)),profile=profiles.get(subject);
  profile.disabled=1;assert.equal(await auth.authenticate(req),null);profile.disabled=0;
  profile.email='different@example.com';assert.equal(await auth.authenticate(req),null);profile.email='student@example.com';
  profile.auth_revoked_at=new Date(Date.now()+1000).toISOString();assert.equal(await auth.authenticate(req),null);profile.auth_revoked_at=null;
  profiles.delete(subject);assert.equal(await auth.authenticate(req),null);
  await assert.rejects(auth.signIn(request(),response(),{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject}),{status:401});
});

test('JWT signature, subject and expiry are verified instead of accepting provider/client claims blindly',async()=>{
  const {auth,setJWT,token}=await fixture(),res=response();
  await auth.signIn(request(),res,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
  const req=request(browserCookie(res));
  setJWT('unsigned.payload.signature');assert.equal(await auth.authenticate(req),null);
  setJWT(await token({id:randomUUID()}));assert.equal(await auth.authenticate(req),null);
  setJWT(await token({id:subject},{expires:'-1s'}));assert.equal(await auth.authenticate(req),null);
  setJWT(await token({id:subject},{issuer:'https://other.example.invalid'}));assert.equal(await auth.authenticate(req),null);
  setJWT(await token({id:subject},{audience:'https://other.example.invalid'}));assert.equal(await auth.authenticate(req),null);
  await assert.rejects(auth.signIn(request(),response(),{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:randomUUID()}),{status:401});
});

test('password changes use provider verification and revoke other managed sessions',async()=>{
  const {auth}=await fixture(),first=response(),second=response();
  await auth.signIn(request(),first,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
  await auth.signIn(request(),second,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
  await assert.rejects(auth.changePassword(request(browserCookie(first)),response(),{currentPassword:'incorrect',newPassword:'Changed2026!'}),{status:403});
  assert.equal((await auth.changePassword(request(browserCookie(first)),response(),{currentPassword:'Temporary2026!',newPassword:'Changed2026!'})).user.id,7);
  assert.equal(await auth.authenticate(request(browserCookie(second))),null);
  await assert.rejects(auth.signIn(request(),response(),{email:'student@example.com',password:'Temporary2026!'}),{status:401});
});

test('profile authorization cutoff revokes application access even when provider admin API is unavailable',async()=>{
  const {auth}=await fixture(),res=response();
  await auth.signIn(request(),res,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
  assert.equal((await auth.revokeUserSessions(request(browserCookie(res)),subject)).supported,false);
  assert.equal(await auth.authenticate(request(browserCookie(res))),null);
});

async function passwordResetFixture() {
  const setup=await fixture(),targetId=randomUUID(),operatorResponse=response(),targetResponse=response();
  setup.managedUsers.set(targetId,{id:targetId,email:'forgotten@example.com',name:'Forgotten password',password:'OldStudent2026!',createdAt:new Date().toISOString()});
  setup.profiles.set(targetId,{id:8,username:'forgotten',name:'Forgotten password',auth_user_id:targetId,email:'forgotten@example.com',role:'student',disabled:0,auth_revoked_at:null,session_version:0});
  await setup.auth.signIn(request(),operatorResponse,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
  await setup.auth.signIn(request(),targetResponse,{email:'forgotten@example.com',password:'OldStudent2026!',expectedAuthUserId:targetId});
  setup.providerRequests.length=0;
  return {...setup,targetId,operatorResponse,operatorCookie:browserCookie(operatorResponse),targetCookie:browserCookie(targetResponse),newPassword:'NewTemporary2026!'};
}

test('personal password change requires explicit matching provider confirmation',async t=>{
  for(const reply of [{},{status:false},{user:{id:randomUUID()}},{user:{id:subject}},{token:null,user:{id:subject},status:false}])await t.test(JSON.stringify(reply),async()=>{
    const {auth,managedUsers,setChangePasswordReply}=await fixture(),res=response();
    await auth.signIn(request(),res,{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject});
    setChangePasswordReply(reply);
    await assert.rejects(auth.changePassword(request(browserCookie(res)),response(),{currentPassword:'Temporary2026!',newPassword:'Changed2026!'}),{status:503,code:'AUTH_PASSWORD_RESET_UNKNOWN'});
    assert.equal(managedUsers.get(subject).password,'Temporary2026!');
  });
});

test('provider-confirmed administrator password reset targets the linked identity and preserves the operator session',async()=>{
  const {auth,managedUsers,sessions,providerRequests,targetId,operatorResponse,operatorCookie,targetCookie,newPassword,setPasswordResetReply,setAdminRevokeReply}=await passwordResetFixture();
  // Even if the provider sends a replacement cookie, this operation must not
  // turn the support operator into the student or replace their browser cookie.
  const unsolicitedCookie='__Secure-neon-auth.session_token=student-cookie; Path=/; HttpOnly; Secure';
  setPasswordResetReply({status:200,data:{status:true},headers:{'set-cookie':unsolicitedCookie}});
  setAdminRevokeReply({status:200,data:{success:true},headers:{'set-cookie':unsolicitedCookie}});
  const originalHeaders=structuredClone(operatorResponse.headers),req=request(operatorCookie);
  assert.deepEqual(await auth.resetUserPassword(req,{authUserId:targetId,newPassword}),{confirmed:true,providerSessionsRevoked:true});
  assert.deepEqual(providerRequests.map(({path,body,method,cookie})=>({path,body,method,cookie})),[
    {path:'admin/set-user-password',body:{userId:targetId,newPassword},method:'POST',cookie:operatorCookie.replace(`${AUTH_COOKIE}=`,`__Secure-neon-auth.session_token=`)},
    {path:'admin/revoke-user-sessions',body:{userId:targetId},method:'POST',cookie:operatorCookie.replace(`${AUTH_COOKIE}=`,`__Secure-neon-auth.session_token=`)},
  ]);
  assert.ok(providerRequests.every(call=>call.origin===origin));
  assert.deepEqual(operatorResponse.headers,originalHeaders);
  assert.equal(req.headers.cookie,operatorCookie);
  assert.equal(managedUsers.get(subject).password,'Temporary2026!');
  assert.equal(managedUsers.get(targetId).password,newPassword);
  assert.equal((await auth.authenticate(request(operatorCookie))).authUserId,subject);
  assert.equal(await auth.authenticate(request(targetCookie)),null);
  assert.equal(sessions.size,1);
  await assert.rejects(auth.signIn(request(),response(),{email:'forgotten@example.com',password:'OldStudent2026!',expectedAuthUserId:targetId}),{status:401});
  assert.equal((await auth.signIn(request(),response(),{email:'forgotten@example.com',password:newPassword,expectedAuthUserId:targetId})).authUserId,targetId);
});

test('administrator password reset rejects malformed identity/password inputs and missing application cookies before any provider write',async()=>{
  const {auth,providerRequests}=await fixture(),targetId=randomUUID(),req=request(`${AUTH_COOKIE}=operator-session`);
  const invalidInputs=[
    {authUserId:null,newPassword:'Temporary2026!'},
    {authUserId:'not-a-uuid',newPassword:'Temporary2026!'},
    {authUserId:7,newPassword:'Temporary2026!'},
    {authUserId:{},newPassword:'Temporary2026!'},
    {authUserId:targetId,newPassword:null},
    {authUserId:targetId,newPassword:42},
    {authUserId:targetId,newPassword:''},
    {authUserId:targetId,newPassword:'seven77'},
    {authUserId:targetId,newPassword:'x'.repeat(129)},
  ];
  for(const input of invalidInputs)await assert.rejects(auth.resetUserPassword(req,input),{status:400});
  for(const cookie of [undefined,'unrelated=token',`${AUTH_COOKIE}=`,`__Secure-neon-auth.session_token=provider-token`]) {
    await assert.rejects(auth.resetUserPassword(request(cookie),{authUserId:targetId,newPassword:'Temporary2026!'}),{status:401,code:'AUTH_ADMIN_SESSION_EXPIRED'});
  }
  assert.equal(providerRequests.length,0);
});

test('administrator reset categorizes explicit provider refusals without retrying or revoking target sessions',async t=>{
  const cases=[
    {providerStatus:401,expectedStatus:401,code:'AUTH_ADMIN_SESSION_EXPIRED'},
    {providerStatus:403,expectedStatus:503,code:'AUTH_ADMIN_CONFIGURATION'},
    {providerStatus:404,expectedStatus:503,code:'AUTH_ADMIN_CONFIGURATION'},
    {providerStatus:400,expectedStatus:400,code:'AUTH_OPERATION_FAILED'},
    {providerStatus:429,expectedStatus:429,code:'AUTH_ERROR',headers:{'retry-after':'120'},retryAfter:120},
  ];
  for(const entry of cases)await t.test(`provider ${entry.providerStatus}`,async()=>{
    const {auth,providerRequests,targetId,operatorCookie,targetCookie,newPassword,setPasswordResetReply,managedUsers}=await passwordResetFixture();
    setPasswordResetReply({status:entry.providerStatus,data:{code:'PROVIDER_REFUSAL'},headers:entry.headers});
    await assert.rejects(auth.resetUserPassword(request(operatorCookie),{authUserId:targetId,newPassword}),error=>{
      assert.equal(error.status,entry.expectedStatus);assert.equal(error.code,entry.code);
      if(entry.retryAfter)assert.equal(error.retryAfter,entry.retryAfter);
      return true;
    });
    assert.equal(managedUsers.get(targetId).password,'OldStudent2026!');
    assert.deepEqual(providerRequests.map(call=>call.path),['admin/set-user-password']);
    assert.equal((await auth.authenticate(request(targetCookie))).authUserId,targetId);
    assert.equal((await auth.authenticate(request(operatorCookie))).authUserId,subject);
  });
});

test('administrator reset treats transport, server and malformed-success responses as ambiguous and performs exactly one password write',async t=>{
  const cases=[
    {name:'network failure after a committed write',reply:{status:200,error:new Error('Connection closed after commit'),mutate:true}},
    {name:'provider 500 after a committed write',reply:{status:500,data:{error:'Internal error'},mutate:true}},
    {name:'provider 503 after a committed write',reply:{status:503,data:{error:'Unavailable'},mutate:true}},
    {name:'invalid JSON success',reply:{status:200,raw:'not JSON',mutate:true}},
    {name:'empty success',reply:{status:204,raw:null,mutate:true}},
    {name:'missing explicit confirmation',reply:{status:200,data:{success:true},mutate:true}},
    {name:'false explicit confirmation',reply:{status:200,data:{status:false},mutate:true}},
    {name:'wrong confirmation type',reply:{status:200,data:{status:'true'},mutate:true}},
  ];
  for(const entry of cases)await t.test(entry.name,async()=>{
    const {auth,providerRequests,targetId,operatorCookie,newPassword,setPasswordResetReply,managedUsers}=await passwordResetFixture();
    setPasswordResetReply(entry.reply);
    await assert.rejects(auth.resetUserPassword(request(operatorCookie),{authUserId:targetId,newPassword}),{status:503,code:'AUTH_PASSWORD_RESET_UNKNOWN'});
    assert.equal(managedUsers.get(targetId).password,newPassword); // A failed response can follow a successful remote write.
    assert.deepEqual(providerRequests.map(call=>call.path),['admin/set-user-password']);
    assert.equal((await auth.authenticate(request(operatorCookie))).authUserId,subject);
  });
});

test('a confirmed administrator reset remains confirmed when optional provider session cleanup is unavailable or inconclusive',async t=>{
  const cases=[
    {name:'session cleanup permission denied',reply:{status:403,data:{}}},
    {name:'session cleanup endpoint missing',reply:{status:404,data:{}}},
    {name:'session cleanup provider error',reply:{status:503,data:{}}},
    {name:'session cleanup transport failure',reply:{error:new Error('Connection closed')}},
    {name:'session cleanup success without explicit confirmation',reply:{status:200,data:{}}},
  ];
  for(const entry of cases)await t.test(entry.name,async()=>{
    const {auth,providerRequests,targetId,operatorCookie,newPassword,setAdminRevokeReply,managedUsers,profiles}=await passwordResetFixture();
    setAdminRevokeReply(entry.reply);
    assert.deepEqual(await auth.resetUserPassword(request(operatorCookie),{authUserId:targetId,newPassword}),{confirmed:true,providerSessionsRevoked:false});
    assert.equal(managedUsers.get(targetId).password,newPassword);
    assert.deepEqual(providerRequests.map(call=>call.path),['admin/set-user-password','admin/revoke-user-sessions']);
    // The API caller owns the durable application cutoff; optional provider
    // cleanup must not pretend that this separate database mutation happened.
    assert.equal(profiles.get(targetId).auth_revoked_at,null);
    assert.equal(profiles.get(targetId).session_version,0);
    assert.equal((await auth.authenticate(request(operatorCookie))).authUserId,subject);
  });
});

test('failed account provisioning cleans only its fresh unlinked provider user',async()=>{
  const {auth,managedUsers,profiles}=await fixture();
  const created=await auth.createUser(request(),{email:'temporary@example.com',password:'Temporary2026!',name:'Temporary'});
  assert.equal(managedUsers.has(created.id),true);await created.cleanup();assert.equal(managedUsers.has(created.id),false);assert.equal(managedUsers.has(subject),true);
  const linked=await auth.createUser(request(),{email:'linked@example.com',password:'Temporary2026!',name:'Linked'});
  profiles.set(linked.id,{id:8,auth_user_id:linked.id});
  await assert.rejects(linked.cleanup(),{code:'AUTH_PROFILE_LINKED'});assert.equal(managedUsers.has(linked.id),true);
});



test('provider origin rejection is a configuration failure, never incorrect credentials',async()=>{
 const {auth}=await fixture({appOrigin:'https://wrong.example.invalid',trustedOrigin:origin});
 await assert.rejects(auth.signIn(request(),response(),{email:'student@example.com',password:'Temporary2026!',expectedAuthUserId:subject}),{status:503,code:'AUTH_CONFIGURATION'});
});
