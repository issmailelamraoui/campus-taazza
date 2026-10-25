import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import test from 'node:test';
import {createApp} from '../server/app.js';
import {googleOAuthConfiguration,assertGoogleAcademicIdentity,createAuthSessionPolicy} from '../server/auth-sessions.js';
import {createTestEnvironment} from './backend-helpers.mjs';

const integration=process.env.CAMPUS_TEST_DATABASE_URL?test:test.skip;
const publicOrigin='https://taza-link.vercel.app';
const error=(status,code)=>Object.assign(new Error(code),{status,code});
const sha=value=>createHash('sha256').update(value).digest('hex');
const profileFields={username:'google_student',name:'Étudiant Google',faculty_id:'fsa',filiere_id:'information_systems',current_semester:3};
const cookieToken=req=>(req.get('cookie')||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('test_session='))?.slice('test_session='.length);
const responseCookies=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).filter(value=>!value.endsWith('='));

// Only the external Neon transport is doubled here. HTTP middleware, durable
// admission, PostgreSQL constraints, transactions and student workflows are real.
async function fixture(t,{enabled=true,workspaceDomains=[],origin=publicOrigin}={}) {
  // Never use the compatibility helper's DATABASE_URL fallback for this suite.
  assert.ok(process.env.CAMPUS_TEST_DATABASE_URL,'An isolated PostgreSQL URL is required.');
  const env=await createTestEnvironment({demo:false});
  let policy;
  const sessions=new Map(),state={begin:[],completed:0,committed:0,discarded:0,passwordChecks:0,disposed:0,verificationSends:[],verificationConfirms:[],verificationCodes:new Map(),providerVerifiedEmails:new Set()};
  const auth={
    googleAuthorizationEndpoint:'https://managed-auth.example.test/neondb/auth/sign-in/social/init',
    setSessionPolicy(value){policy=value;},
    async readIdentity(req){const identity=sessions.get(cookieToken(req));return identity&&Date.parse(identity.expiresAt)>Date.now()?identity:null;},
    async authenticate(req){
      const identity=await this.readIdentity(req);
      if(!identity)return null;
      const user=await env.db.prepare('SELECT * FROM users WHERE auth_user_id=?').get(identity.authUser.id);
      if(!user||user.disabled||user.email?.toLowerCase()!==identity.authUser.email||user.auth_revoked_at&&Date.parse(identity.createdAt)<=Date.parse(user.auth_revoked_at)||!await policy.allows(identity,user))return null;
      return {...identity,user};
    },
    async beginGoogle(_req,_res,args){state.begin.push(args);if(state.beginError)throw state.beginError;return {url:'https://accounts.google.com/o/oauth2/v2/auth?state=managed-state'};},
    async completeGoogle(req,_res,args){
      state.completed++;state.completeArgs=args;
      if(state.completeError)throw state.completeError;
      if(args.linkExpected){
        const original=await this.readIdentity(req);
        if(!original||original.sessionId!==args.linkExpected.sessionId||original.authUser.id!==args.linkExpected.authUserId)throw error(401,'GOOGLE_SESSION_INVALID');
      }
      return {identity:state.nextIdentity,google:state.google,newSession:state.newSession??true};
    },
    async commitGoogleSession(_req,res,result){state.committed++;sessions.set(result.identity.sessionId,result.identity);res.cookie('test_session',result.identity.sessionId,{httpOnly:true,sameSite:'lax',path:'/'});},
    async discardGoogleSession(_req,_res,result){state.discarded++;if(result?.newSession)sessions.delete(result.identity.sessionId);},
    async sendGoogleEmailVerification(_req,{email}){
      state.verificationSends.push(email);
      if(state.sendVerificationError)throw state.sendVerificationError;
      if(!state.unknownVerificationEmails?.has(email))state.verificationCodes.set(email,'123456');
      return {success:true};
    },
    async confirmGoogleEmailVerification(_req,{email,code}){
      state.verificationConfirms.push({email,code});
      if(state.confirmVerificationError)throw state.confirmVerificationError;
      if(state.verificationCodes.get(email)!==code)throw error(400,'GOOGLE_VERIFICATION_INVALID');
      state.verificationCodes.delete(email);state.providerVerifiedEmails.add(email);
      return {verified:true};
    },
    async proveIdentity({email,password}){
      state.passwordChecks++;
      if(password!=='Existing-password-2026')throw error(401,'INVALID_CREDENTIALS');
      const identity=state.passwordIdentity;
      if(!identity||identity.authUser.email!==email)throw error(401,'INVALID_CREDENTIALS');
      return {...identity,dispose:async()=>{state.disposed++;}};
    },
    async signIn(_req,res,{email,password,expectedAuthUserId}){
      if(password!=='Existing-password-2026')throw error(401,'INVALID_CREDENTIALS');
      const user=await env.db.prepare('SELECT * FROM users WHERE auth_user_id=? AND lower(email)=?').get(expectedAuthUserId,email);
      if(!user||user.disabled)throw error(401,'INVALID_CREDENTIALS');
      const identity=makeIdentity({subject:expectedAuthUserId,email});
      await policy.authorize(identity,{method:'password',userId:user.id});
      sessions.set(identity.sessionId,identity);res.cookie('test_session',identity.sessionId,{httpOnly:true,sameSite:'lax',path:'/'});
      state.passwordIdentity=identity;
      return {...identity,user};
    },
    async signOut(req,res){const identity=await this.readIdentity(req);if(identity)await policy.forget(identity);sessions.delete(cookieToken(req));res.clearCookie('test_session',{path:'/'});},
  };
  const app=await createApp({db:env.db,auth,storage:env.storage,appOrigin:origin,googleOAuth:{enabled,domains:['usmba.ac.ma'],workspaceDomains}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.close();await env.close();});
  const address=`http://127.0.0.1:${server.address().port}`;
  async function request(path,{method='GET',body,cookie='',headers={}}={}){
    const response=await fetch(address+'/api'+path,{method,headers:{origin:publicOrigin,...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    const data=await response.json().catch(()=>null);
    return {status:response.status,data,headers:response.headers,cookies:responseCookies(response)};
  }
  function chooseGoogle(options={}){
    state.nextIdentity=makeIdentity(options);
    state.google={subject:options.googleSub||'google-'+state.nextIdentity.authUser.id,email:options.googleEmail||state.nextIdentity.authUser.email,emailVerified:Object.hasOwn(options,'googleVerified')?options.googleVerified:true,hostedDomain:options.hostedDomain??null};
    state.newSession=options.newSession;
    return state.nextIdentity;
  }
  async function start(options={}){const result=await request('/auth/google/start',{method:'POST',body:{intent:'login'},...options});assert.equal(result.status,200,JSON.stringify(result.data));return result.cookies.find(value=>value.startsWith('campus_google_attempt='));}
  async function callback(cookie,query='neon_auth_session_verifier=managed-verifier'){return request('/auth/google/callback'+(query?'?'+query:''),{cookie});}
  async function createUser({email='existing@usmba.ac.ma',subject=randomUUID(),status='approved',role='student',username='existing_'+randomUUID().slice(0,8)}={}){
    return env.db.prepare('INSERT INTO users(username,name,email,auth_user_id,role,faculty_id,filiere_id,account_status) VALUES (?,?,?,?,?,?,?,?) RETURNING *').get(username,'Existing student',email,subject,role,'fsa','information_systems',status);
  }
  async function login(user){const result=await request('/login',{method:'POST',body:{username:user.username,password:'Existing-password-2026'}});assert.equal(result.status,200,JSON.stringify(result.data));return result.cookies.find(value=>value.startsWith('test_session='));}
  return {...env,app,auth,state,sessions,request,start,callback,chooseGoogle,createUser,login,policy:app.locals.sessionPolicy};
}

function makeIdentity({email='student@usmba.ac.ma',subject=randomUUID(),verified=true,createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString()}={}){
  return {authUser:{id:subject,email,name:'Verified student',emailVerified:verified,role:'admin'},sessionId:randomUUID(),createdAt,expiresAt};
}

test('Google configuration fails closed and matches exact explicit domains only',()=>{
  assert.equal(googleOAuthConfiguration({enabled:true,domains:[]}).enabled,false);
  assert.equal(googleOAuthConfiguration({enabled:true,domains:['@usmba.ac.ma']}).enabled,false);
  assert.equal(googleOAuthConfiguration({enabled:false,domains:['usmba.ac.ma']}).enabled,false);
  const config=googleOAuthConfiguration({enabled:true,domains:['USMBA.AC.MA','usmba.ac.ma']});
  assert.deepEqual(config.domains,['usmba.ac.ma']);
  for(const email of ['student@gmail.com','student@yahoo.com','student@sub.usmba.ac.ma','student@usmba.ac.ma.evil.test'])assert.throws(()=>assertGoogleAcademicIdentity(makeIdentity({email}),{subject:'google-id',email,emailVerified:true},config),{code:'GOOGLE_DOMAIN_REJECTED'});
  assert.equal(assertGoogleAcademicIdentity(makeIdentity(),{subject:'google-id',email:'student@usmba.ac.ma',emailVerified:true},config).email,'student@usmba.ac.ma');
  assert.equal(assertGoogleAcademicIdentity(makeIdentity({verified:false}),{subject:'google-id',email:'student@usmba.ac.ma',emailVerified:true},config).googleEmailVerified,true);
  for(const emailVerified of [false,undefined,'true','false'])assert.throws(()=>assertGoogleAcademicIdentity(makeIdentity(),{subject:'google-id',email:'student@usmba.ac.ma',emailVerified},config),{code:'GOOGLE_EMAIL_UNVERIFIED'});
});

integration('Google remains unavailable when disabled or without a fixed allowed public origin',async t=>{
  for(const options of [{enabled:false},{origin:'https://taza-link.vercel.app/attacker-path'}])await t.test(JSON.stringify(options),async t=>{
    const f=await fixture(t,options);
    assert.deepEqual((await f.request('/auth/google/config')).data,{enabled:false,domains:[]});
    assert.equal((await f.request('/auth/google/start',{method:'POST',body:{},headers:{origin:'http://localhost:5173'}})).status,503);
    assert.equal((await f.request('/auth/google/profile')).status,503);
    assert.equal(f.state.begin.length,0);
  });
});

integration('optional academic email verification is nonenumerating and never publishes an application session or changes a profile',async t=>{
  const f=await fixture(t),user=await f.createUser({role:'faculty_admin',status:'pending'});
  const before=await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  f.state.unknownVerificationEmails=new Set(['unknown@usmba.ac.ma']);
  const send=email=>f.request('/auth/google/email-verification/start',{method:'POST',body:{email}});
  const confirm=(email,code)=>f.request('/auth/google/email-verification/confirm',{method:'POST',body:{email,code}});
  const sent=await send('  EXISTING@USMBA.AC.MA  '),unknown=await send('unknown@usmba.ac.ma');
  for(const response of [sent,unknown]) {
    assert.equal(response.status,200);assert.deepEqual(response.data,{success:true});assert.deepEqual(response.cookies,[]);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert.deepEqual(f.state.verificationSends,[user.email,'unknown@usmba.ac.ma']);
  for(const [email,code]of [['unknown@usmba.ac.ma','123456'],[user.email,'111111'],[user.email,'12345'],[user.email,123456]]) {
    const response=await confirm(email,code);assert.equal(response.status,400);assert.equal(response.data.code,'GOOGLE_VERIFICATION_INVALID');assert.deepEqual(response.cookies,[]);
  }
  const confirmed=await confirm('EXISTING@USMBA.AC.MA','123456');
  assert.equal(confirmed.status,200);assert.deepEqual(confirmed.data,{verified:true});assert.deepEqual(confirmed.cookies,[]);
  assert.equal((await confirm(user.email,'123456')).status,400,'Provider verification codes remain one use.');
  assert.equal(f.state.providerVerifiedEmails.has(user.email),true);
  assert.deepEqual(await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id),before);
  for(const table of ['google_auth_links','auth_session_admissions','google_oauth_attempts'])assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n,0);
  assert.equal(f.sessions.size,0);assert.equal(f.state.begin.length,0);assert.equal(f.state.completed,0);assert.equal(f.state.committed,0);assert.equal(f.state.passwordChecks,0);
  assert.equal((await f.request('/bootstrap')).status,401);
  const passwordCookie=await f.login(user);assert.equal((await f.request('/session',{cookie:passwordCookie})).data.user.id,user.id,'The existing password still works.');
});

integration('email verification rejects unconfigured domains, unavailable adapters and cross-site requests before contacting the provider',async t=>{
  const f=await fixture(t);
  for(const route of ['start','confirm']) {
    for(const email of ['student@gmail.com','student@sub.usmba.ac.ma','student@usmba.ac.ma.evil.test','bad@@usmba.ac.ma','student @usmba.ac.ma',null,'a'.repeat(255)+'@usmba.ac.ma']) {
      const response=await f.request('/auth/google/email-verification/'+route,{method:'POST',body:{email,code:'123456'}});
      assert.equal(response.status,400);assert.equal(response.data.code,'GOOGLE_VERIFICATION_INVALID');
    }
    const response=await f.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:'student@usmba.ac.ma',code:'123456'},headers:{origin:'https://evil.test'}});
    assert.equal(response.status,403);
  }
  assert.deepEqual(f.state.verificationSends,[]);assert.deepEqual(f.state.verificationConfirms,[]);
  delete f.auth.sendGoogleEmailVerification;
  for(const route of ['start','confirm']) {
    const response=await f.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:'student@usmba.ac.ma',code:'123456'}});
    assert.equal(response.status,503);assert.equal(response.data.code,'GOOGLE_VERIFICATION_UNAVAILABLE');
  }
  const disabled=await fixture(t,{enabled:false});
  assert.equal((await disabled.request('/auth/google/email-verification/start',{method:'POST',body:{email:'student@usmba.ac.ma'}})).status,503);
  assert.deepEqual(disabled.state.verificationSends,[]);
});

integration('email verification sanitizes provider failures consistently without exposing account existence or details',async t=>{
  const f=await fixture(t);
  for(const status of [400,401,403]) {
    f.state.sendVerificationError=error(status,'PRIVATE_ACCOUNT_DOES_NOT_EXIST');
    const sent=await f.request('/auth/google/email-verification/start',{method:'POST',body:{email:`send${status}@usmba.ac.ma`}});
    assert.equal(sent.status,200);assert.deepEqual(sent.data,{success:true});assert.deepEqual(sent.cookies,[]);
    f.state.confirmVerificationError=error(status,'PRIVATE_CODE_OR_ACCOUNT_DETAILS');
    const confirmed=await f.request('/auth/google/email-verification/confirm',{method:'POST',body:{email:`confirm${status}@usmba.ac.ma`,code:'123456'}});
    assert.equal(confirmed.status,400);assert.equal(confirmed.data.code,'GOOGLE_VERIFICATION_INVALID');assert.doesNotMatch(JSON.stringify(confirmed.data),/PRIVATE/);
  }
  for(const route of ['start','confirm']) {
    f.state.sendVerificationError=error(500,'PRIVATE_PROVIDER_FAILURE');f.state.confirmVerificationError=f.state.sendVerificationError;
    const unavailable=await f.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:'service@usmba.ac.ma',code:'123456'}});
    assert.equal(unavailable.status,503);assert.equal(unavailable.data.code,'GOOGLE_VERIFICATION_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(unavailable.data),/PRIVATE/);
    f.state.sendVerificationError=Object.assign(error(429,'PRIVATE_PROVIDER_RATE_LIMIT'),{retryAfter:60});f.state.confirmVerificationError=f.state.sendVerificationError;
    const limited=await f.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:'limited@usmba.ac.ma',code:'123456'}});
    assert.equal(limited.status,429);assert.equal(limited.data.code,'GOOGLE_VERIFICATION_RATE_LIMITED');assert.equal(limited.headers.get('retry-after'),'60');assert.equal(limited.data.retryAfter,60);
  }
});

integration('email verification limits both IP and normalized email before making provider requests',async t=>{
  for(const [route,emailLimit,ipLimit,stateKey]of [['start',3,12,'verificationSends'],['confirm',8,30,'verificationConfirms']])await t.test(route,async t=>{
    const f=await fixture(t);
    for(let i=0;i<emailLimit;i++)await f.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:i%2?'STUDENT@USMBA.AC.MA':'student@usmba.ac.ma',code:'000000'}});
    const emailLimited=await f.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:'student@usmba.ac.ma',code:'000000'}});
    assert.equal(emailLimited.status,429);assert.equal(emailLimited.data.code,'GOOGLE_VERIFICATION_RATE_LIMITED');assert.ok(Number(emailLimited.headers.get('retry-after'))>0);assert.equal(emailLimited.data.retryAfter,Number(emailLimited.headers.get('retry-after')));assert.ok(emailLimited.data.retryAfter<=900);
    assert.equal(f.state[stateKey].length,emailLimit);
    const byIP=await fixture(t);
    for(let i=0;i<ipLimit;i++)await byIP.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:`student${i}@usmba.ac.ma`,code:'000000'}});
    const ipLimited=await byIP.request('/auth/google/email-verification/'+route,{method:'POST',body:{email:'another@usmba.ac.ma',code:'000000'}});
    assert.equal(ipLimited.status,429);assert.equal(ipLimited.data.code,'GOOGLE_VERIFICATION_RATE_LIMITED');assert.equal(byIP.state[stateKey].length,ipLimit);assert.equal(ipLimited.data.retryAfter,Number(ipLimited.headers.get('retry-after')));
  });
});

integration('manual email confirmation requires a fresh authoritative Google login and preserves approved or pending existing accounts',async t=>{
  for(const status of ['approved','pending'])await t.test(status,async t=>{
    const f=await fixture(t),user=await f.createUser({status});
    f.chooseGoogle({subject:user.auth_user_id,email:user.email,verified:false,hostedDomain:'usmba.ac.ma'});
    // Managed Neon may refuse implicit linking before releasing Google proof.
    // Model that upstream refusal separately from CampusLink's callback policy.
    assert.match((await f.callback(await f.start(),'error=account_not_linked')).headers.get('location'),/GOOGLE_LINK_REQUIRED/);
    assert.equal((await f.request('/auth/google/email-verification/start',{method:'POST',body:{email:user.email}})).status,200);
    const confirmed=await f.request('/auth/google/email-verification/confirm',{method:'POST',body:{email:user.email,code:'123456'}});
    assert.equal(confirmed.status,200);assert.deepEqual(confirmed.cookies,[]);assert.equal(f.state.committed,0);assert.equal(f.sessions.size,0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM auth_session_admissions').get()).n,0);
    assert.equal((await f.request('/bootstrap')).status,401);
    const identity=f.chooseGoogle({subject:user.auth_user_id,email:user.email,verified:f.state.providerVerifiedEmails.has(user.email),hostedDomain:'usmba.ac.ma'});
    const callback=await f.callback(await f.start()),cookie=callback.cookies.find(value=>value.startsWith('test_session='));
    assert.equal(callback.headers.get('location'),publicOrigin+(status==='approved'?'/app':'/account-review'));
    assert.equal((await f.policy.get(identity)).method,'google');assert.equal((await f.request('/bootstrap',{cookie})).status,status==='approved'?200:403);
    assert.equal(f.state.passwordChecks,0);
    const after=await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    for(const key of ['auth_user_id','email','username','role','account_status','faculty_id','filiere_id'])assert.equal(after[key],user[key]);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);
  });
});

integration('new academic Google signup requires a completed profile and existing administrative approval',async t=>{
  const f=await fixture(t),identity=f.chooseGoogle({verified:false});
  assert.deepEqual((await f.request('/auth/google/config')).data,{enabled:true,domains:['usmba.ac.ma'],authorizationEndpoint:f.auth.googleAuthorizationEndpoint});
  const before=await f.request('/bootstrap',{cookie:'test_session='+identity.sessionId});assert.equal(before.status,401);
  const attempt=await f.start(),callback=await f.callback(attempt);
  assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),publicOrigin+'/auth/google/complete');
  assert.equal(callback.headers.get('referrer-policy'),'no-referrer');assert.equal(callback.headers.get('cache-control'),'no-store');
  assert.equal(f.state.begin[0].callbackURL,publicOrigin+'/api/auth/google/callback');
  const cookie=callback.cookies.find(value=>value.startsWith('test_session='));
  assert.equal((await f.request('/session',{cookie})).data.user,null);
  assert.equal((await f.request('/bootstrap',{cookie})).status,401);
  const profile=await f.request('/auth/google/profile',{cookie});assert.equal(profile.status,200,JSON.stringify(profile.data));assert.equal(profile.data.profile.email,'student@usmba.ac.ma');
  const invalid=await f.request('/auth/google/profile',{method:'POST',cookie,body:{...profileFields,faculty_id:'feg'}});assert.equal(invalid.status,400);
  const complete=await f.request('/auth/google/profile',{method:'POST',cookie,body:{...profileFields,email:'attacker@gmail.com',auth_user_id:randomUUID(),role:'global_admin',account_status:'approved'}});
  assert.equal(complete.status,201,JSON.stringify(complete.data));assert.equal(complete.data.user.role,'student');assert.equal(complete.data.user.account_status,'pending');assert.equal(complete.data.user.email,identity.authUser.email);
  assert.equal((await f.request('/bootstrap',{cookie})).status,403);
  assert.equal((await f.request('/session',{cookie})).data.user.account_status,'pending');
  const retried=await f.request('/auth/google/profile',{method:'POST',cookie,body:{role:'global_admin',faculty_id:'feg'}});assert.equal(retried.status,200);assert.equal(retried.data.user.id,complete.data.user.id);assert.equal(retried.data.user.faculty_id,'fsa');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);
  await f.db.prepare("UPDATE users SET account_status='approved' WHERE id=?").run(complete.data.user.id);
  assert.equal((await f.request('/bootstrap',{cookie})).status,200);
  const stored=await f.db.prepare('SELECT * FROM users WHERE id=?').get(complete.data.user.id);
  const disabledPolicy=createAuthSessionPolicy({db:f.db,googleConfig:googleOAuthConfiguration({enabled:false,domains:['usmba.ac.ma']})});
  assert.equal(await disabledPolicy.allows(identity,stored),false,'Turning off Google closes admitted Google sessions while preserving account data.');
  const link=await f.db.prepare('SELECT * FROM google_auth_links').get();assert.equal(link.user_id,complete.data.user.id);assert.equal(link.google_sub,f.state.google.subject);
  const logout=await f.request('/logout',{method:'POST',cookie,body:{}});assert.equal(logout.status,200);assert.equal(await f.policy.get(identity),null);assert.equal((await f.request('/bootstrap',{cookie})).status,401);
  const fresh=f.chooseGoogle({subject:identity.authUser.id});
  const reconnect=await f.callback(await f.start());assert.equal(reconnect.headers.get('location'),publicOrigin+'/app');
  assert.equal((await f.request('/bootstrap',{cookie:'test_session='+fresh.sessionId})).status,200);
  await f.db.prepare('UPDATE users SET auth_revoked_at=? WHERE id=?').run(new Date(Date.now()+1000).toISOString(),complete.data.user.id);
  assert.equal((await f.request('/auth/google/profile',{cookie:'test_session='+fresh.sessionId})).status,401,'Revoked Google sessions cannot read completed profiles through the public completion endpoint.');
});

integration('personal, unverified, inconsistent and Workspace-mismatched identities never create application profiles or admissions',async t=>{
  for(const [name,options]of Object.entries({personal:{email:'student@gmail.com'},unverified:{googleVerified:false},missingVerification:{googleVerified:undefined},stringTrueVerification:{googleVerified:'true'},stringFalseVerification:{googleVerified:'false'},subdomain:{email:'student@students.usmba.ac.ma'},mismatch:{googleEmail:'other@usmba.ac.ma'},workspace:{hostedDomain:'other.ac.ma'}}))await t.test(name,async t=>{
    const f=await fixture(t);const identity=f.chooseGoogle(options),result=await f.callback(await f.start());
    assert.equal(result.status,303);assert.match(result.headers.get('location'),/\/login\?google_error=GOOGLE_(EMAIL_UNVERIFIED|DOMAIN_REJECTED)/);
    assert.equal(result.cookies.some(value=>value.startsWith('test_session=')),false);assert.equal(f.state.committed,0);assert.equal(f.state.discarded,1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,0);assert.equal(await f.policy.get(identity),null);
  });
  await t.test('required Workspace claim cannot be omitted',async t=>{const f=await fixture(t,{workspaceDomains:['usmba.ac.ma']});f.chooseGoogle();const result=await f.callback(await f.start());assert.match(result.headers.get('location'),/GOOGLE_DOMAIN_REJECTED/);});
});

integration('browser attempts are one use, expire durably and cannot be replaced by query or body data',async t=>{
  const f=await fixture(t);f.chooseGoogle();
  const absent=await f.callback('');assert.match(absent.headers.get('location'),/GOOGLE_ATTEMPT_INVALID/);assert.equal(f.state.completed,0);
  const attempt=await f.start();
  const attacker=await f.request('/auth/google/callback?campus_google_attempt='+attempt.split('=')[1]+'&neon_auth_session_verifier=managed-verifier');assert.match(attacker.headers.get('location'),/GOOGLE_ATTEMPT_INVALID/);
  const valid=await f.callback(attempt);assert.equal(valid.headers.get('location'),publicOrigin+'/auth/google/complete');
  const replay=await f.callback(attempt);assert.match(replay.headers.get('location'),/GOOGLE_ATTEMPT_INVALID/);assert.equal(f.state.completed,1);
  const expired=await f.start();await f.db.prepare('UPDATE google_oauth_attempts SET expires_at=? WHERE token_hash=?').run(new Date(Date.now()-1000).toISOString(),sha(expired.split('=')[1]));
  assert.match((await f.callback(expired)).headers.get('location'),/GOOGLE_ATTEMPT_INVALID/);assert.equal(f.state.completed,1);
  const canceled=await f.callback(await f.start(),'error=access_denied&error_description=private-provider-details');assert.match(canceled.headers.get('location'),/GOOGLE_OAUTH_FAILED/);assert.doesNotMatch(canceled.headers.get('location'),/private-provider/);
  const linkAttempt=await f.start();
  const linkRequired=await f.callback(linkAttempt,'error=account_not_linked&error_description=private-provider-details');
  assert.equal(linkRequired.headers.get('location'),publicOrigin+'/login?google_error=GOOGLE_LINK_REQUIRED');
  assert.equal(f.state.completed,1);assert.equal(f.state.committed,1);
  assert.match((await f.callback(linkAttempt,'error=account_not_linked')).headers.get('location'),/GOOGLE_ATTEMPT_INVALID/);
  const unknownProviderError=await f.callback(await f.start(),'error=account_not_linked_extra');assert.match(unknownProviderError.headers.get('location'),/GOOGLE_OAUTH_FAILED/);
  assert.equal((await f.request('/auth/google/start',{method:'POST',body:{callbackURL:'https://evil.test'},headers:{origin:'https://evil.test'}})).status,403);
});

integration('existing profiles without authoritative first-association proof can use password-proven explicit linking and preserve roles, academic scope and approval',async t=>{
  const f=await fixture(t),user=await f.createUser({role:'faculty_admin',status:'pending'});
  f.chooseGoogle({subject:user.auth_user_id,email:user.email});
  const initial=await f.callback(await f.start());assert.match(initial.headers.get('location'),/GOOGLE_LINK_REQUIRED/);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);
  assert.equal((await f.request('/auth/google/start',{method:'POST',body:{intent:'link',password:'Existing-password-2026'}})).status,401);
  const cookie=await f.login(user);
  assert.equal((await f.request('/auth/google/start',{method:'POST',cookie,body:{intent:'link',password:'wrong'}})).status,403);
  const start=await f.request('/auth/google/start',{method:'POST',cookie,body:{intent:'link',password:'Existing-password-2026'}});assert.equal(start.status,200);assert.equal(f.state.disposed,1);
  f.state.nextIdentity=await f.auth.readIdentity({get:()=>cookie});f.state.newSession=false;
  const result=await f.callback(cookie+'; '+start.cookies.find(value=>value.startsWith('campus_google_attempt=')),'' );assert.equal(result.headers.get('location'),publicOrigin+'/account-review');
  assert.equal((await f.policy.get(f.state.nextIdentity)).method,'password');assert.equal((await f.request('/auth/google/link',{cookie})).data.linked,true);
  const after=await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);assert.equal(after.role,'faculty_admin');assert.equal(after.account_status,'pending');assert.equal(after.faculty_id,user.faculty_id);assert.equal(after.filiere_id,user.filiere_id);
  assert.equal((await f.request('/bootstrap',{cookie})).status,403);
  await f.request('/logout',{method:'POST',cookie,body:{}});
  f.chooseGoogle({subject:user.auth_user_id,email:user.email});const login=await f.callback(await f.start());assert.equal(login.headers.get('location'),publicOrigin+'/account-review');
});

integration('existing canonical Neon users continue directly with authoritative Google Workspace proof while retaining roles and approval',async t=>{
  for(const [name,options]of Object.entries({approved:{role:'student',status:'approved'},pending:{role:'student',status:'pending'},facultyAdmin:{role:'faculty_admin',status:'approved'},globalAdmin:{role:'global_admin',status:'approved'},legacyUnverified:{role:'student',status:'approved',verified:false},legacyStringFlag:{role:'student',status:'approved',verified:'true'}}))await t.test(name,async t=>{
    const f=await fixture(t),user=await f.createUser(options);
    const identity=f.chooseGoogle({subject:user.auth_user_id,email:user.email,hostedDomain:'usmba.ac.ma',...(Object.hasOwn(options,'verified')?{verified:options.verified}:{})});
    const callback=await f.callback(await f.start());
    assert.equal(callback.headers.get('location'),publicOrigin+(options.status==='approved'?'/app':'/account-review'));
    assert.equal(f.state.passwordChecks,0,'Google continuation does not ask for the existing username or password.');
    assert.deepEqual(f.state.verificationSends,[],'Strict Google proof never requests an extra email code.');
    assert.deepEqual(f.state.verificationConfirms,[]);
    assert.equal(identity.authUser.emailVerified,options.verified??true,'The legacy Neon flag is not rewritten.');
    assert.equal(f.state.begin[0].link,false);
    const cookie=callback.cookies.find(value=>value.startsWith('test_session='));
    assert.ok(cookie);assert.equal((await f.request('/bootstrap',{cookie})).status,options.status==='approved'?200:403);
    const admitted=await f.policy.get(identity);assert.equal(admitted.method,'google');assert.equal(admitted.googleEmailVerified,true);assert.equal(admitted.userId,user.id);
    const link=await f.db.prepare('SELECT * FROM google_auth_links WHERE user_id=?').get(user.id);
    assert.equal(link.auth_user_id,user.auth_user_id);assert.equal(link.google_sub,f.state.google.subject);assert.equal(link.email,user.email);assert.equal(link.hosted_domain,'usmba.ac.ma');
    const after=await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    for(const key of ['username','email','auth_user_id','role','faculty_id','filiere_id','current_semester','account_status','must_change_password','password_change_required'])assert.equal(after[key],user[key],key+' is preserved.');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);
  });
});

integration('automatic Google association rejects unverified Google evidence, non-authoritative proof, conflicting bindings and different canonical subjects',async t=>{
  const scenarios={
    googleUnverified:{identity:{googleVerified:false},code:'GOOGLE_EMAIL_UNVERIFIED'},
    googleStringVerification:{identity:{verified:false,googleVerified:'true'},code:'GOOGLE_EMAIL_UNVERIFIED'},
    unverifiedWithoutWorkspace:{identity:{verified:false,hostedDomain:null},code:'GOOGLE_LINK_REQUIRED'},
    missingWorkspace:{identity:{hostedDomain:null},code:'GOOGLE_LINK_REQUIRED'},
    wrongWorkspace:{identity:{hostedDomain:'other.ac.ma'},code:'GOOGLE_DOMAIN_REJECTED'},
    differentCanonicalSubject:{identity:{subject:randomUUID()},code:'GOOGLE_LINK_REQUIRED'},
    differentEmail:{identity:{email:'other@usmba.ac.ma'},code:'GOOGLE_LINK_CONFLICT'},
    conflictingGoogleSubject:{binding:'subject',code:'GOOGLE_LINK_CONFLICT'},
    conflictingAuthSubject:{binding:'auth',code:'GOOGLE_LINK_CONFLICT'},
    conflictingOtherUser:{binding:'user',code:'GOOGLE_LINK_CONFLICT'},
    disabled:{account:{disabled:1},code:'GOOGLE_ACCOUNT_DISABLED'},
    deleted:{account:{account_status:'deleted'},code:'GOOGLE_ACCOUNT_DISABLED'},
    revoked:{account:{auth_revoked_at:new Date(Date.now()+3600000).toISOString()},code:'GOOGLE_SESSION_INVALID'},
  };
  for(const [name,scenario]of Object.entries(scenarios))await t.test(name,async t=>{
    const f=await fixture(t),user=await f.createUser();
    if(scenario.account)for(const [key,value]of Object.entries(scenario.account))await f.db.prepare(`UPDATE users SET ${key}=? WHERE id=?`).run(value,user.id);
    const identity=f.chooseGoogle({subject:user.auth_user_id,email:user.email,hostedDomain:'usmba.ac.ma',...scenario.identity});
    if(scenario.binding==='subject'||scenario.binding==='auth')await f.db.prepare('INSERT INTO google_auth_links(user_id,auth_user_id,google_sub,email) VALUES(?,?,?,?)').run(user.id,scenario.binding==='auth'?randomUUID():user.auth_user_id,scenario.binding==='subject'?'another-google-subject':f.state.google.subject,user.email);
    if(scenario.binding==='user') {
      const other=await f.createUser({email:'other@usmba.ac.ma'});
      await f.db.prepare('INSERT INTO google_auth_links(user_id,auth_user_id,google_sub,email) VALUES(?,?,?,?)').run(other.id,other.auth_user_id,f.state.google.subject,other.email);
    }
    const beforeLinks=(await f.db.prepare('SELECT COUNT(*) AS n FROM google_auth_links').get()).n;
    const callback=await f.callback(await f.start());
    assert.equal(callback.headers.get('location'),publicOrigin+'/login?google_error='+scenario.code);
    assert.equal(f.state.committed,0);assert.equal(f.state.passwordChecks,0);assert.equal(await f.policy.get(identity),null);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM google_auth_links').get()).n,beforeLinks,'Refusal never inserts a binding, including transaction rollback after revocation.');
    const after=await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    assert.equal(after.auth_user_id,user.auth_user_id);assert.equal(after.email,user.email);assert.equal(after.role,user.role);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,scenario.binding==='user'?2:1);
  });
});

integration('legacy local unverified accounts explicitly link strict verified Google proof, preserve password access and admit subsequent Google sessions',async t=>{
  const f=await fixture(t),user=await f.createUser({role:'faculty_admin'});
  f.chooseGoogle({subject:user.auth_user_id,email:user.email,verified:false});
  const withoutLink=await f.callback(await f.start());
  assert.match(withoutLink.headers.get('location'),/GOOGLE_LINK_REQUIRED/);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM google_auth_links').get()).n,0);
  const passwordCookie=await f.login(user),passwordIdentity=f.state.passwordIdentity;
  passwordIdentity.authUser.emailVerified=false;
  const start=await f.request('/auth/google/start',{method:'POST',cookie:passwordCookie,body:{intent:'link',password:'Existing-password-2026'}});
  assert.equal(start.status,200,JSON.stringify(start.data));assert.equal(f.state.passwordChecks,1);
  f.state.nextIdentity=passwordIdentity;f.state.newSession=false;
  const linked=await f.callback(passwordCookie+'; '+start.cookies.find(value=>value.startsWith('campus_google_attempt=')),'');
  assert.equal(linked.headers.get('location'),publicOrigin+'/app/profile');
  assert.equal(passwordIdentity.authUser.emailVerified,false,'Linking does not rewrite the local Neon flag.');
  assert.equal((await f.policy.get(passwordIdentity)).method,'password');
  assert.equal((await f.request('/bootstrap',{cookie:passwordCookie})).status,200,'The initiating password session is preserved.');
  assert.deepEqual((await f.request('/auth/google/link',{cookie:passwordCookie})).data,{linked:true,email:user.email});
  await f.request('/logout',{method:'POST',cookie:passwordCookie,body:{}});
  const googleIdentity=f.chooseGoogle({subject:user.auth_user_id,email:user.email,verified:false});
  const signedIn=await f.callback(await f.start());
  assert.equal(signedIn.headers.get('location'),publicOrigin+'/app');
  const googleCookie=signedIn.cookies.find(value=>value.startsWith('test_session='));
  assert.equal((await f.request('/bootstrap',{cookie:googleCookie})).status,200);
  const durablePolicy=createAuthSessionPolicy({db:f.db,googleConfig:googleOAuthConfiguration({enabled:true,domains:['usmba.ac.ma']})});
  const durableProof=await durablePolicy.get(googleIdentity);
  assert.equal(durableProof.method,'google');assert.equal(durableProof.googleEmailVerified,true);
  assert.equal(await durablePolicy.allows(googleIdentity,user),true);
  const after=await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  assert.equal(after.role,user.role);assert.equal(after.account_status,user.account_status);assert.equal(after.faculty_id,user.faculty_id);assert.equal(after.filiere_id,user.filiere_id);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);
});

integration('Google verification must come from server proof, never a browser flag or an existing link row',async t=>{
  const f=await fixture(t),user=await f.createUser(),identity=makeIdentity({subject:user.auth_user_id,email:user.email});
  const evidence={googleSub:'verified-google-subject',email:user.email,hostedDomain:null,userId:user.id};
  await f.db.prepare('INSERT INTO google_auth_links(user_id,auth_user_id,google_sub,email) VALUES(?,?,?,?)').run(user.id,user.auth_user_id,evidence.googleSub,user.email);
  for(const method of ['google','google_pending'])for(const googleEmailVerified of [undefined,false,'true','false']) {
    await assert.rejects(f.policy.authorize(identity,{method,...evidence,googleEmailVerified}),{code:'GOOGLE_EMAIL_UNVERIFIED'});
    assert.equal(await f.policy.get(identity),null);
  }
  f.chooseGoogle({subject:user.auth_user_id,email:user.email,googleSub:evidence.googleSub,googleVerified:false});
  const attempt=await f.start({body:{intent:'login',emailVerified:true,googleEmailVerified:true}});
  const callback=await f.callback(attempt,'neon_auth_session_verifier=managed-verifier&emailVerified=true&googleEmailVerified=true');
  assert.match(callback.headers.get('location'),/GOOGLE_EMAIL_UNVERIFIED/);
  assert.equal(f.state.committed,0);assert.equal(await f.policy.get(f.state.nextIdentity),null);
});

integration('linking rejects changed account state, conflicting Google subjects and swapped session cookies',async t=>{
  for(const scenario of ['revoked','session','conflict'])await t.test(scenario,async t=>{
    const f=await fixture(t),user=await f.createUser(),cookie=await f.login(user);
    f.chooseGoogle({subject:user.auth_user_id,email:user.email});f.state.nextIdentity=await f.auth.readIdentity({get:()=>cookie});f.state.newSession=false;
    const start=await f.request('/auth/google/start',{method:'POST',cookie,body:{intent:'link',password:'Existing-password-2026'}});assert.equal(start.status,200);
    let callbackCookie=cookie;
    if(scenario==='revoked')await f.db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(user.id);
    if(scenario==='session'){const other=await f.createUser({email:'other@usmba.ac.ma'});callbackCookie=await f.login(other);}
    if(scenario==='conflict'){const other=await f.createUser({email:'other@usmba.ac.ma'});await f.db.prepare('INSERT INTO google_auth_links(user_id,auth_user_id,google_sub,email) VALUES(?,?,?,?)').run(other.id,other.auth_user_id,f.state.google.subject,other.email);}
    const result=await f.callback(callbackCookie+'; '+start.cookies.find(value=>value.startsWith('campus_google_attempt=')),'' );
    assert.match(result.headers.get('location'),/google_error=GOOGLE_(SESSION_INVALID|LINK_CONFLICT)/);assert.equal(f.state.committed,0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM google_auth_links WHERE user_id=?').get(user.id)).n,0);
  });
});

integration('old email-password accounts retain personal emails and durable sessions while direct public provider sessions cannot bypass admission',async t=>{
  const f=await fixture(t),user=await f.createUser({email:'existing@gmail.com'});
  const direct=makeIdentity({subject:user.auth_user_id,email:user.email});f.sessions.set(direct.sessionId,direct);
  assert.equal((await f.request('/bootstrap',{cookie:'test_session='+direct.sessionId})).status,401);
  const cookie=await f.login(user);assert.equal((await f.request('/bootstrap',{cookie})).status,200);
  const expired=await f.auth.readIdentity({get:()=>cookie});expired.expiresAt=new Date(Date.now()-1000).toISOString();assert.equal((await f.request('/bootstrap',{cookie})).status,401);
  const replacement=await f.login(user);await f.db.prepare('UPDATE users SET auth_revoked_at=? WHERE id=?').run(new Date(Date.now()+1000).toISOString(),user.id);assert.equal((await f.request('/bootstrap',{cookie:replacement})).status,401);
});

integration('only previously snapshotted subjects receive the pre-migration session exception',async t=>{
  const f=await fixture(t),user=await f.createUser();
  await f.db.prepare('INSERT INTO auth_legacy_subjects(auth_user_id,user_id) VALUES(?,?)').run(user.auth_user_id,user.id);
  const cutoff=(await f.db.prepare('SELECT created_at FROM auth_session_cutover WHERE singleton=TRUE').get()).created_at;
  const before=makeIdentity({subject:user.auth_user_id,email:user.email,createdAt:new Date(cutoff.getTime()-1000).toISOString()});
  const after=makeIdentity({subject:user.auth_user_id,email:user.email,createdAt:new Date(cutoff.getTime()+1000).toISOString()});
  assert.equal(await f.policy.allows(before,user),true);assert.equal(await f.policy.allows(after,user),false);
  const newcomer=await f.createUser({email:'newcomer@usmba.ac.ma'});assert.equal(await f.policy.allows(makeIdentity({subject:newcomer.auth_user_id,email:newcomer.email,createdAt:before.createdAt}),newcomer),false);
  const disabledPolicy=createAuthSessionPolicy({db:f.db,googleConfig:googleOAuthConfiguration({enabled:false,domains:['usmba.ac.ma']})});assert.equal(await disabledPolicy.allows(before,user),true);
});

integration('concurrent profile completions and callback replays create exactly one student with no privilege increase',async t=>{
  const f=await fixture(t);f.chooseGoogle();const attempt=await f.start();
  const callbacks=await Promise.all([f.callback(attempt),f.callback(attempt)]);assert.equal(callbacks.filter(result=>result.headers.get('location')===publicOrigin+'/auth/google/complete').length,1);assert.equal(f.state.completed,1);
  const cookie=callbacks.find(result=>result.cookies.some(value=>value.startsWith('test_session='))).cookies.find(value=>value.startsWith('test_session='));
  const submissions=await Promise.all(Array.from({length:3},()=>f.request('/auth/google/profile',{method:'POST',cookie,body:{...profileFields,role:'global_admin'}})));
  assert.deepEqual(submissions.map(value=>value.status).sort(),[200,200,201]);assert.equal(new Set(submissions.map(value=>value.data.user.id)).size,1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM google_auth_links').get()).n,1);assert.ok(submissions.every(value=>value.data.user.role==='student'&&value.data.user.account_status==='pending'));
});

integration('trusted live rolling sessions retain their original proof without reviving expired or replaced identities',async t=>{
  const f=await fixture(t),user=await f.createUser(),identity=makeIdentity({subject:user.auth_user_id,email:user.email,verified:false});
  const evidence={email:user.email,googleSub:'rolling-google-subject',googleEmailVerified:true,hostedDomain:null,userId:user.id};
  await f.db.prepare('INSERT INTO google_auth_links(user_id,auth_user_id,google_sub,email) VALUES(?,?,?,?)').run(user.id,user.auth_user_id,evidence.googleSub,user.email);
  for(const method of ['password','google_pending','google']) {
    await f.policy.authorize(identity,{method,...evidence});
    const past=new Date(Date.now()-5000).toISOString();
    await f.db.prepare('UPDATE auth_session_admissions SET expires_at=? WHERE session_id=?').run(past,identity.sessionId);
    const reloaded=await createAuthSessionPolicy({db:f.db,googleConfig:googleOAuthConfiguration({enabled:true,domains:['usmba.ac.ma']})}).get(identity);
    assert.equal(reloaded.method,method);
    assert.equal(reloaded.googleEmailVerified,method!=='password');
    assert.equal((await f.db.prepare('SELECT expires_at FROM auth_session_admissions WHERE session_id=?').get(identity.sessionId)).expires_at.getTime(),Date.parse(identity.expiresAt));
    assert.equal(await f.policy.allows(identity,user),method!=='google_pending');
    await f.db.prepare('UPDATE auth_session_admissions SET expires_at=? WHERE session_id=?').run(past,identity.sessionId);
    assert.equal(await f.policy.get({...identity,expiresAt:past}),null,'An actually expired provider identity is never refreshed.');
    assert.equal(await f.policy.get({...identity,createdAt:new Date(Date.parse(identity.createdAt)-1000).toISOString()}),null,'A changed creation time cannot reuse an admission.');
    assert.equal((await f.db.prepare('SELECT expires_at FROM auth_session_admissions WHERE session_id=?').get(identity.sessionId)).expires_at.getTime(),Date.parse(past));
  }
  await f.db.prepare('UPDATE users SET auth_revoked_at=? WHERE id=?').run(new Date(Date.now()+1000).toISOString(),user.id);
  await assert.rejects(f.policy.authorize(identity,{method:'google',...evidence}),{code:'GOOGLE_SESSION_INVALID'});
  assert.equal(await f.policy.allows(identity,await f.db.prepare('SELECT * FROM users WHERE id=?').get(user.id)),false);
});
