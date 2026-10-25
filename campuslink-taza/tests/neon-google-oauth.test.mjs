import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { AUTH_COOKIE, createAuthService } from '../server/auth.js';

const origin='https://campus.example.test',issuer='https://neon.example.test',baseUrl=`${issuer}/neondb/auth`;
const providerCookie='__Secure-neon-auth.session_token';
const challenge='campus_neon_oauth_challenge=challenge-value';
const req=cookie=>({secure:true,protocol:'https',headers:{origin,host:'campus.example.test',...(cookie?{cookie}:{})}});
const res=()=>({cookies:[],append(name,value){assert.equal(name,'Set-Cookie');this.cookies.push(value);}});
const campusCookies=response=>response.cookies.filter(value=>value.startsWith(`${AUTH_COOKIE}=`));

async function fixture({policy=false}={}) {
  const subject=randomUUID(),sessionId=randomUUID(),oldSessionId=randomUUID(),accountId=randomUUID();
  const {privateKey,publicKey}=await generateKeyPair('EdDSA'),jwk=await exportJWK(publicKey);jwk.kid='oauth-test';jwk.alg='EdDSA';
  const user={id:subject,email:'student@college.example',emailVerified:true,name:'Student',role:'admin'};
  const sessions=new Map(),requests=[],admissions=new Map();
  const profile={id:42,auth_user_id:subject,email:user.email,role:'student',disabled:0};
  const googleAccount={id:accountId,userId:subject,providerId:'google',accountId:'123456789012345678901'};
  const info={account:{id:accountId,providerId:'google',accountId:googleAccount.accountId},user:{name:'Google Student',email:user.email,emailVerified:true},data:{sub:googleAccount.accountId,email:user.email,email_verified:true,hd:'college.example'}};
  const options={accounts:[googleAccount],info,challengeName:'__Secure-neon-auth.session_challenge',returnChallenge:true,exchangeCookie:true,exchangeSubject:subject,exchangeSessionId:sessionId,rotatePassword:false,rotatedPasswordSubject:subject,verificationSendStatus:200,verificationSendData:{success:true},verificationConfirmStatus:200,verificationConfirmData:{status:true,token:null,user:{...user,emailVerified:true}},verificationCookie:null,verificationCleanupStatus:200,verificationCleanupData:{success:true}};
  const session=id=>({id,userId:subject,createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});
  sessions.set('old-token',session(oldSessionId));
  const token=async id=>new SignJWT({}).setProtectedHeader({alg:'EdDSA',kid:jwk.kid}).setIssuer(issuer).setAudience(issuer).setSubject(id).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const json=(data,headers={},status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
  const authorizationURL=()=>{
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for(const [key,value]of Object.entries({redirect_uri:`${baseUrl}/callback/google`,response_type:'code',state:'managed-state',client_id:'managed-client.apps.googleusercontent.com',code_challenge_method:'S256',code_challenge:'A'.repeat(43)}))url.searchParams.set(key,value);
    return options.authorizationURL||url.href;
  };
  const fetchImpl=async(input,init={})=>{
    const url=new URL(input);
    if(url.pathname==='/jwks')return json({keys:[jwk]});
    const path=url.pathname.slice('/neondb/auth/'.length),cookies=init.headers.cookie||'',body=init.body?JSON.parse(init.body):undefined;
    requests.push({path,url,init,body,cookies});
    assert.equal(init.headers['x-neon-auth-middleware'],'true');
    assert.equal(init.headers.origin,origin);
    const opaque=cookies.match(/__Secure-neon-auth\.session_token=([^;]+)/)?.[1];
    if(path==='sign-in/social'||path==='link-social')return json({url:authorizationURL(),redirect:false},options.returnChallenge?{'set-cookie':`${options.challengeName}=challenge-value; Path=/; SameSite=None; Secure; Partitioned; Max-Age=3600`}:{});
    if(path==='sign-in/email') {
      if(body.password!=='existing-password')return json({code:'INVALID_PASSWORD'},{},401);
      sessions.set('password-token',session(randomUUID()));
      return json({user}, {'set-cookie':`${providerCookie}=password-token; Path=/; HttpOnly; Secure; Max-Age=3600`});
    }
    if(path==='get-session') {
      if(url.searchParams.has('neon_auth_session_verifier')) {
        if(url.searchParams.get('neon_auth_session_verifier')!=='valid-verifier'||!cookies.includes('session_chall'))return json({code:'INVALID_VERIFIER'},{},401);
        const exchanged={...session(options.exchangeSessionId),userId:options.exchangeSubject,...options.exchangeSession};
        sessions.set('google-token',exchanged);
        return json({session:exchanged,user},{'set-auth-jwt':await token(subject),...(options.exchangeCookie?{'set-cookie':`${providerCookie}=google-token; HttpOnly; Secure; Max-Age=3600`}:{})});
      }
      const current=sessions.get(opaque);
      return current?json({session:current,user:{...user,id:current.userId}},{'set-auth-jwt':options.jwtOverride??await token(current.userId)}):json(null);
    }
    if(path==='list-accounts')return json(options.accounts);
    if(path==='account-info') {assert.equal(url.searchParams.get('accountId'),accountId);return json(options.infoForCookie?.(opaque)??options.info);}
    if(path==='email-otp/send-verification-otp')return json(options.verificationSendData,{},options.verificationSendStatus);
    if(path==='email-otp/verify-email') {
      if(options.verificationCookie&&!sessions.has(options.verificationCookie))sessions.set(options.verificationCookie,session(randomUUID()));
      return json(options.verificationConfirmData,options.verificationCookie?{'set-cookie':`${providerCookie}=${options.verificationCookie}; HttpOnly; Secure; Max-Age=3600`}:{},options.verificationConfirmStatus);
    }
    if(path==='sign-out') {
      if(options.verificationCleanupStatus===200&&options.verificationCleanupData.success===true)sessions.delete(opaque);
      return json(options.verificationCleanupData,{'set-cookie':`${providerCookie}=; Max-Age=0`},options.verificationCleanupStatus);
    }
    if(path==='change-password') {
      let next=opaque;
      if(options.rotatePassword){next='rotated-token';sessions.set(next,{...session(randomUUID()),userId:options.rotatedPasswordSubject});sessions.delete(opaque);}
      return json({user,token:next},next!==opaque?{'set-cookie':`${providerCookie}=${next}; Max-Age=3600`}:{});
    }
    throw new Error(`Unexpected mocked provider path ${path}`);
  };
  const sessionPolicy={
    async authorize(identity,proof){admissions.set(identity.sessionId,{...proof});},
    async allows(identity){return options.legacySession===identity.sessionId||admissions.get(identity.sessionId)?.method==='password'||admissions.get(identity.sessionId)?.method==='google';},
    async get(identity){return admissions.get(identity.sessionId)||null;},
    async forget(identity){admissions.delete(identity.sessionId);},
  };
  const db={prepare(){return {async get(id){return id===subject?profile:null;}};}};
  const auth=createAuthService({baseUrl,jwksUrl:`${issuer}/jwks`,appOrigin:origin,fetchImpl,db,...(policy?{sessionPolicy}:{})});
  return {auth,subject,sessionId,oldSessionId,user,profile,options,requests,sessions,admissions,sessionPolicy,accountId};
}

test('Google email verification sends only email-verification OTP with normalized email and no browser session',async()=>{
  const f=await fixture({policy:true});
  const result=await f.auth.sendGoogleEmailVerification(req(`${AUTH_COOKIE}=old-token`),{email:'  Student@College.Example  '});
  assert.deepEqual(result,{success:true});assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].path,'email-otp/send-verification-otp');
  assert.deepEqual(f.requests[0].body,{email:f.user.email,type:'email-verification'});assert.equal(f.requests[0].cookies,'');
  assert.equal(f.sessions.has('old-token'),true);assert.equal(f.admissions.size,0);
});

test('Google verification send responses do not reveal absent or ineligible accounts',async t=>{
  for(const [name,status,code]of [['invalid',400,'INVALID_EMAIL'],['unknown',400,'USER_NOT_FOUND'],['unauthorized',401,'USER_NOT_FOUND'],['ineligible',403,'EMAIL_NOT_VERIFIED'],['missing-user',404,'USER_NOT_FOUND']])await t.test(name,async()=>{
    const f=await fixture();f.options.verificationSendStatus=status;f.options.verificationSendData={code,message:'private provider details'};
    assert.deepEqual(await f.auth.sendGoogleEmailVerification(req(`${AUTH_COOKIE}=old-token`),{email:f.user.email}),{success:true});
    assert.equal(f.requests[0].cookies,'');assert.equal(f.sessions.has('old-token'),true);
  });
});

test('Google email confirmation verifies without admitting a session or changing existing password access',async()=>{
  const f=await fixture({policy:true}),request=req(`${AUTH_COOKIE}=old-token`),original=await f.auth.readIdentity(request);
  await f.sessionPolicy.authorize(original,{method:'password',userId:42});f.requests.length=0;
  assert.deepEqual(await f.auth.confirmGoogleEmailVerification(request,{email:f.user.email,code:'123456'}),{verified:true});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'email-otp/verify-email');assert.equal(f.requests[0].cookies,'');
  assert.deepEqual(f.requests[0].body,{email:f.user.email,otp:'123456'});
  assert.equal(f.sessions.has('old-token'),true);assert.equal(f.admissions.size,1);assert.equal(f.admissions.get(original.sessionId).method,'password');
  const logged=await f.auth.signIn(req(),res(),{email:f.user.email,password:'existing-password'});
  assert.equal(logged.user.id,42);assert.equal((await f.auth.authenticate(request)).user.id,42);
  assert.equal(f.requests.some(request=>request.path==='change-password'||request.path==='sign-in/email-otp'),false);
});

test('Google email verification discards managed automatic sign-in and revokes only its new opaque provider session',async()=>{
  const f=await fixture({policy:true}),request=req(`${AUTH_COOKIE}=old-token`),original=await f.auth.readIdentity(request);
  await f.sessionPolicy.authorize(original,{method:'password',userId:42});f.requests.length=0;
  f.options.verificationCookie='temporary-verification-token';f.options.verificationConfirmData.token='private-body-token';
  const result=await f.auth.confirmGoogleEmailVerification(request,{email:f.user.email,code:'123456'});
  assert.deepEqual(result,{verified:true});assert.equal(f.requests.length,2);
  assert.equal(f.requests[0].path,'email-otp/verify-email');assert.equal(f.requests[0].cookies,'');
  assert.equal(f.requests[1].path,'sign-out');assert.equal(f.requests[1].cookies,`${providerCookie}=temporary-verification-token`);
  assert.equal(f.sessions.has('temporary-verification-token'),false);assert.equal(f.sessions.has('old-token'),true);
  assert.equal(f.admissions.size,1);assert.deepEqual(f.admissions.get(original.sessionId),{method:'password',userId:42});
  assert.equal((await f.auth.authenticate(request)).user.id,42);
  const logged=await f.auth.signIn(req(),res(),{email:f.user.email,password:'existing-password'});assert.equal(logged.user.id,42);
});

test('Google email confirmation never revokes an existing browser session echoed by a provider response',async()=>{
  const f=await fixture(),request=req(`${AUTH_COOKIE}=old-token`);
  f.options.verificationCookie='old-token';f.options.verificationConfirmData.token='private-body-token';
  assert.deepEqual(await f.auth.confirmGoogleEmailVerification(request,{email:f.user.email,code:'123456'}),{verified:true});
  assert.equal(f.requests.length,1);assert.equal(f.sessions.has('old-token'),true);
});

test('Google verification recognizes equivalent percent encodings of the original opaque browser cookie',async()=>{
  const f=await fixture(),request=req(`${AUTH_COOKIE}=original%3dtoken`);
  f.sessions.set('original=token',f.sessions.get('old-token'));f.options.verificationCookie='original%3Dtoken';f.options.verificationConfirmData.token='private-body-token';
  assert.deepEqual(await f.auth.confirmGoogleEmailVerification(request,{email:f.user.email,code:'123456'}),{verified:true});
  assert.equal(f.requests.length,1);assert.equal(f.sessions.has('original=token'),true);
});

test('Google email confirmation requires strict matching verified provider output and cleans temporary sessions even on refusal',async t=>{
  const cases={
    'false status':data=>{data.status=false;},
    'string status':data=>{data.status='true';},
    'missing status':data=>{delete data.status;},
    'false verification':data=>{data.user.emailVerified=false;},
    'string true verification':data=>{data.user.emailVerified='true';},
    'string false verification':data=>{data.user.emailVerified='false';},
    'missing verification':data=>{delete data.user.emailVerified;},
    'different email':data=>{data.user.email='other@college.example';},
    'invalid subject':data=>{data.user.id='not-a-managed-uuid';},
    'missing user':data=>{delete data.user;},
  };
  for(const [name,mutate]of Object.entries(cases))await t.test(name,async()=>{
    const f=await fixture({policy:true});f.options.verificationCookie='temporary-verification-token';f.options.verificationConfirmData.token='private-body-token';mutate(f.options.verificationConfirmData);
    await assert.rejects(f.auth.confirmGoogleEmailVerification(req(`${AUTH_COOKIE}=old-token`),{email:f.user.email,code:'123456'}),{status:400,code:'GOOGLE_VERIFICATION_INVALID'});
    assert.equal(f.sessions.has('temporary-verification-token'),false);assert.equal(f.sessions.has('old-token'),true);assert.equal(f.admissions.size,0);
    assert.equal(f.requests[0].cookies,'');assert.equal(f.requests[1].cookies,`${providerCookie}=temporary-verification-token`);
  });
});

test('unknown verification accounts and wrong OTPs produce the same bounded public error',async()=>{
  const results=[];
  for(const [status,code]of [[400,'INVALID_OTP'],[404,'USER_NOT_FOUND']]) {
    const f=await fixture();f.options.verificationConfirmStatus=status;f.options.verificationConfirmData={code,message:'private provider details'};
    try{await f.auth.confirmGoogleEmailVerification(req(),{email:f.user.email,code:'123456'});assert.fail('An invalid OTP must be rejected.');}
    catch(error){results.push({status:error.status,code:error.code,message:error.message});}
  }
  assert.deepEqual(results[0],results[1]);assert.equal(results[0].status,400);assert.equal(results[0].code,'GOOGLE_VERIFICATION_INVALID');assert.doesNotMatch(results[0].message,/private provider/);
});

test('Google verification rejects malformed input before any provider call and never uses sign-in or reset OTP routes',async t=>{
  for(const code of [123456,'12345','1234567','a12345','12345\n','0'.repeat(4097)])await t.test(typeof code==='string'?JSON.stringify(code.slice(0,10)):String(code),async()=>{
    const f=await fixture();
    await assert.rejects(f.auth.confirmGoogleEmailVerification(req(),{email:f.user.email,code}),{status:400,code:'GOOGLE_VERIFICATION_INVALID'});
    assert.equal(f.requests.length,0);
  });
  for(const method of ['sendGoogleEmailVerification','confirmGoogleEmailVerification'])await t.test(method+' invalid email',async()=>{
    const f=await fixture();
    await assert.rejects(f.auth[method](req(),{email:'not-an-email',code:'123456'}),{status:400,code:'GOOGLE_VERIFICATION_INVALID'});assert.equal(f.requests.length,0);
  });
});

test('Google verification fails closed for unavailable endpoints, malformed responses and failed temporary-session cleanup',async t=>{
  for(const method of ['sendGoogleEmailVerification','confirmGoogleEmailVerification'])for(const status of [404,500,429])await t.test(method+' '+status,async()=>{
    const f=await fixture();f.options.verificationSendStatus=status;f.options.verificationConfirmStatus=status;
    f.options.verificationSendData={code:'PROVIDER_UNAVAILABLE',message:'private provider details'};f.options.verificationConfirmData=f.options.verificationSendData;
    await assert.rejects(f.auth[method](req(`${AUTH_COOKIE}=old-token`),{email:f.user.email,code:'123456'}),error=>{
      assert.equal(error.status,status===429?429:503);assert.equal(error.code,status===429?'GOOGLE_VERIFICATION_RATE_LIMITED':'GOOGLE_VERIFICATION_UNAVAILABLE');
      assert.doesNotMatch(error.message,/private provider/);if(status===429)assert.equal(error.retryAfter,60);return true;
    });
    assert.equal(f.sessions.has('old-token'),true);
  });
  for(const token of [undefined,{},'private-body-token'])await t.test('unsafe token without revocable opaque cookie '+typeof token,async()=>{
    const f=await fixture();f.options.verificationConfirmData.token=token;
    await assert.rejects(f.auth.confirmGoogleEmailVerification(req(),{email:f.user.email,code:'123456'}),{status:503,code:'GOOGLE_VERIFICATION_UNAVAILABLE'});
    assert.equal(f.requests.length,1);assert.equal(f.sessions.has('old-token'),true);
  });
  for(const [status,success]of [[500,false],[200,false]])await t.test('failed cleanup '+status,async()=>{
    const f=await fixture();f.options.verificationCookie='temporary-verification-token';f.options.verificationConfirmData.token='private-body-token';f.options.verificationCleanupStatus=status;f.options.verificationCleanupData={success};
    await assert.rejects(f.auth.confirmGoogleEmailVerification(req(`${AUTH_COOKIE}=old-token`),{email:f.user.email,code:'123456'}),{status:503,code:'GOOGLE_VERIFICATION_UNAVAILABLE'});
    assert.equal(f.requests[1].cookies,`${providerCookie}=temporary-verification-token`);assert.equal(f.sessions.has('old-token'),true);assert.equal(f.admissions.size,0);
  });
});

test('Google start uses official managed proxy protocol and private bounded first-party challenge cookies',async()=>{
  const f=await fixture(),response=res();
  const result=await f.auth.beginGoogle(req(),response,{callbackURL:`${origin}/api/auth/google/callback`,errorCallbackURL:`${origin}/api/auth/google/callback`});
  assert.equal(new URL(result.url).origin,'https://accounts.google.com');
  const request=f.requests[0];assert.equal(request.path,'sign-in/social');assert.equal(request.cookies,'');
  assert.deepEqual(request.body,{provider:'google',callbackURL:`${origin}/api/auth/google/callback`,errorCallbackURL:`${origin}/api/auth/google/callback`,disableRedirect:true,additionalParams:{prompt:'select_account'}});
  const cookie=response.cookies.find(value=>value.startsWith('campus_neon_oauth_challenge=challenge-value'));
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);assert.match(cookie,/Max-Age=600/);assert.doesNotMatch(cookie,/Partitioned|Domain=/);
  assert.deepEqual(campusCookies(response),[]);
});

test('managed Neon Google init URL is returned to the browser without a premature server navigation',async t=>{
  for(const link of [false,true])await t.test(link?'explicit linking':'sign-in',async()=>{
    const f=await fixture(),response=res(),token=randomUUID();
    f.options.authorizationURL=`${baseUrl}/sign-in/social/init?token=${token}`;
    assert.equal(f.auth.googleAuthorizationEndpoint,`${baseUrl}/sign-in/social/init`);
    const result=await f.auth.beginGoogle(req(link?`${AUTH_COOKIE}=old-token`:undefined),response,{callbackURL:`${origin}/callback`,errorCallbackURL:`${origin}/error`,link});
    assert.deepEqual(result,{url:f.options.authorizationURL,redirect:true});
    assert.equal(f.requests.length,1);
    assert.equal(f.requests[0].path,link?'link-social':'sign-in/social');
    assert.deepEqual(f.requests[0].body.additionalParams,{prompt:'select_account'});
    assert.ok(response.cookies.some(value=>value.startsWith('campus_neon_oauth_challenge=challenge-value;')));
    assert.deepEqual(campusCookies(response),[]);
  });
});

test('managed Google init hop rejects foreign branches, alternate paths and ambiguous or unsafe tokens',async t=>{
  const endpoint=`${baseUrl}/sign-in/social/init`;
  const scenarios={
    'HTTP protocol':endpoint.replace('https:','http:')+'?token=nonce',
    'foreign origin':'https://other-neon.example.test/neondb/auth/sign-in/social/init?token=nonce',
    'origin suffix':endpoint.replace('neon.example.test','neon.example.test.evil.example')+'?token=nonce',
    'foreign database':endpoint.replace('/neondb/','/otherdb/')+'?token=nonce',
    'foreign auth base':endpoint.replace('/auth/','/other-auth/')+'?token=nonce',
    'alternate path':endpoint.replace('/init','/initialize')+'?token=nonce',
    'encoded path':endpoint.replace('/init','/%69nit')+'?token=nonce',
    'trailing slash':endpoint+'/?token=nonce',
    'credentials':endpoint.replace('https://','https://user:pass@')+'?token=nonce',
    'fragment':endpoint+'?token=nonce#fragment',
    'missing token':endpoint,
    'empty token':endpoint+'?token=',
    'duplicate token':endpoint+'?token=nonce&token=second',
    'redirect parameter':endpoint+'?token=nonce&redirect_uri=https%3A%2F%2Fevil.example',
    'wrong parameter':endpoint+'?state=nonce',
    'whitespace token':endpoint+'?token=nonce%20other',
    'control token':endpoint+'?token=nonce%0Aother',
    'URL-shaped token':endpoint+'?token=https%3A%2F%2Fevil.example',
    'oversize token':endpoint+'?token='+'x'.repeat(4097),
  };
  for(const [name,url]of Object.entries(scenarios))await t.test(name,async()=>{
    const f=await fixture(),response=res();f.options.authorizationURL=url;
    await assert.rejects(f.auth.beginGoogle(req(),response,{callbackURL:`${origin}/callback`,errorCallbackURL:`${origin}/error`}),{code:'AUTH_CONFIGURATION'});
    assert.equal(f.requests.length,1);assert.deepEqual(campusCookies(response),[]);
    assert.equal(response.cookies.some(value=>value.startsWith('campus_neon_oauth_challenge=challenge-value;')),false);
  });
});

test('Google transport rejects untrusted callback/authorization URLs and missing proxy challenge',async t=>{
  for(const scenario of ['callback','authorization','redirect-uri','pkce','challenge'])await t.test(scenario,async()=>{
    const f=await fixture(),response=res();
    if(scenario==='authorization')f.options.authorizationURL='https://evil.example/';
    if(scenario==='redirect-uri')f.options.authorizationURL='https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://evil.example';
    if(scenario==='pkce')f.options.authorizationURL=`https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(`${baseUrl}/callback/google`)}&response_type=code&state=state&client_id=client`;
    if(scenario==='challenge')f.options.returnChallenge=false;
    await assert.rejects(f.auth.beginGoogle(req(),response,{callbackURL:scenario==='callback'?'https://evil.example/callback':`${origin}/callback`,errorCallbackURL:`${origin}/error`}),{code:'AUTH_CONFIGURATION'});
    assert.deepEqual(campusCookies(response),[]);
  });
});

test('verified Google completion remains provisional until explicit commit, then publishes only opaque HTTP-only cookie',async()=>{
  const f=await fixture(),response=res(),request=req(challenge);
  const result=await f.auth.completeGoogle(request,response,{verifier:'valid-verifier'});
  assert.deepEqual(result.google,{subject:f.options.info.data.sub,email:f.user.email,emailVerified:true,name:'Google Student',hostedDomain:'college.example'});
  assert.equal(result.identity.authUser.id,f.subject);assert.equal(result.newSession,true);
  assert.deepEqual(campusCookies(response),[]);assert.doesNotMatch(JSON.stringify(result),/google-token|privateKey|accessToken/);
  assert.match(f.requests[0].cookies,/__Secure-neon-auth.session_challenge=challenge-value/);
  f.auth.commitGoogleSession(request,response,result);
  assert.equal(campusCookies(response).length,1);assert.match(campusCookies(response)[0],/^campus_neon_session=google-token;.*HttpOnly.*SameSite=Lax.*Secure/);
  assert.ok(response.cookies.some(value=>value.startsWith('campus_neon_oauth_challenge=;')&&value.includes('Max-Age=0')));
  assert.throws(()=>f.auth.commitGoogleSession(request,response,result));
  await f.auth.discardGoogleSession(request,response,result);assert.equal(f.sessions.has('google-token'),true);
});

test('legacy misspelled Neon challenge is supported with the same official verifier exchange',async()=>{
  const f=await fixture(),response=res();
  f.options.challengeName='__Secure-neon-auth.session_challange';
  await f.auth.beginGoogle(req(),response,{callbackURL:`${origin}/callback`,errorCallbackURL:`${origin}/error`});
  assert.ok(response.cookies.some(value=>value.startsWith('campus_neon_oauth_challange=challenge-value')));
  const result=await f.auth.completeGoogle(req('campus_neon_oauth_challange=challenge-value'),res(),{verifier:'valid-verifier'});
  assert.equal(result.identity.authUser.id,f.subject);
  assert.ok(f.requests.some(request=>request.cookies.includes('__Secure-neon-auth.session_challange=challenge-value')));
});

test('invalid OAuth verifier/challenge is rejected without publishing or revoking existing credential session',async t=>{
  for(const scenario of ['missing-verifier','missing-challenge','oversize-verifier','invalid-verifier','wrong-verifier','missing-session-cookie'])await t.test(scenario,async()=>{
    const f=await fixture(),response=res();
    if(scenario==='missing-session-cookie')f.options.exchangeCookie=false;
    const verifier=scenario==='missing-verifier'?undefined:scenario==='oversize-verifier'?'x'.repeat(2049):scenario==='invalid-verifier'?'bad\r\nheader':scenario==='wrong-verifier'?'wrong-verifier':'valid-verifier';
    const cookie=`${AUTH_COOKIE}=old-token${scenario==='missing-challenge'?'':`; ${challenge}`}`;
    await assert.rejects(f.auth.completeGoogle(req(cookie),response,{verifier}));
    assert.deepEqual(campusCookies(response),[]);assert.equal(f.sessions.has('old-token'),true);
  });
});

test('Google proof rejects unverified booleans, mismatched identities/providers and ambiguous accounts; provisional session is revoked',async t=>{
  const scenarios={
    'Google false verification':f=>{f.options.info.data.email_verified=false;},
    'Google missing verification':f=>{delete f.options.info.data.email_verified;},
    'Google string true verification':f=>{f.options.info.data.email_verified='true';},
    'Google string false verification':f=>{f.options.info.data.email_verified='false';},
    'mapped false verification':f=>{f.options.info.user.emailVerified=false;},
    'mapped missing verification':f=>{delete f.options.info.user.emailVerified;},
    'mapped string true verification':f=>{f.options.info.user.emailVerified='true';},
    'mapped string false verification':f=>{f.options.info.user.emailVerified='false';},
    'wrong Google subject':f=>{f.options.info.data.sub='another-google-subject';},
    'wrong provider':f=>{f.options.info.account.providerId='credential';},
    'wrong local provider row':f=>{f.options.info.account.id=randomUUID();},
    'wrong Google account ID':f=>{f.options.info.account.accountId='another-google-subject';},
    'wrong managed account owner':f=>{f.options.accounts[0].userId=randomUUID();},
    'different raw email':f=>{f.options.info.data.email='someone@college.example';},
    'different mapped email':f=>{f.options.info.user.email='someone@college.example';},
    'ambiguous Google rows':f=>{f.options.accounts.push({...f.options.accounts[0],id:randomUUID()});},
    'no Google provider':f=>{f.options.accounts=[];},
    'invalid hosted domain':f=>{f.options.info.data.hd='evil.example/path';},
  };
  for(const [name,mutate]of Object.entries(scenarios))for(const localVerified of name.includes('verification')?[false,true]:[true])await t.test(name+(localVerified?'':' (legacy local unverified)'),async()=>{
    const f=await fixture(),response=res();f.user.emailVerified=localVerified;mutate(f);
    await assert.rejects(f.auth.completeGoogle(req(challenge),response,{verifier:'valid-verifier'}));
    assert.deepEqual(campusCookies(response),[]);assert.equal(f.sessions.has('google-token'),false);
    assert.equal(f.sessions.has('old-token'),true);assert.equal(f.requests.filter(request=>request.path==='sign-out').length,1);
  });
});

test('strict verified Google proof supports legacy local unverified credential users without changing their local verification flag',async t=>{
  for(const link of [false,true])await t.test(link?'password-proven linking transport':'fresh Google session',async()=>{
    const f=await fixture(),response=res();f.user.emailVerified=false;
    const request=req(link?`${AUTH_COOKIE}=old-token`:challenge);
    const result=await f.auth.completeGoogle(request,response,link?{linkExpected:{authUserId:f.subject,sessionId:f.oldSessionId}}:{verifier:'valid-verifier'});
    assert.equal(result.identity.authUser.emailVerified,false);
    assert.equal(f.user.emailVerified,false);
    assert.equal(result.google.emailVerified,true);
    assert.equal(result.google.subject,f.options.info.data.sub);
    assert.equal(result.google.email,f.user.email);
    assert.ok(f.requests.some(request=>request.path==='account-info'));
    f.auth.commitGoogleSession(request,response,result);
    assert.equal(f.sessions.has('old-token'),true);
  });
});

test('application refusal discards only a provisional session and cannot later commit it',async()=>{
  const f=await fixture(),response=res(),request=req(challenge),result=await f.auth.completeGoogle(request,response,{verifier:'valid-verifier'});
  await f.auth.discardGoogleSession(request,response,result);await f.auth.discardGoogleSession(request,response,result);
  assert.equal(f.sessions.has('google-token'),false);assert.equal(f.sessions.has('old-token'),true);assert.deepEqual(campusCookies(response),[]);
  assert.equal(f.requests.filter(request=>request.path==='sign-out').length,1);
  assert.throws(()=>f.auth.commitGoogleSession(request,response,result));
});

test('explicit linking requires bound subject and session, can complete without verifier, and preserves original login on refusal',async()=>{
  const f=await fixture(),request=req(`${AUTH_COOKIE}=old-token`),response=res();
  await f.auth.beginGoogle(request,response,{callbackURL:`${origin}/callback`,errorCallbackURL:`${origin}/error`,link:true});
  assert.equal(f.requests[0].path,'link-social');assert.equal(f.requests[0].cookies,`${providerCookie}=old-token`);
  const result=await f.auth.completeGoogle(request,response,{linkExpected:{authUserId:f.subject,sessionId:f.oldSessionId}});
  assert.equal(result.newSession,false);assert.equal(result.identity.sessionId,f.oldSessionId);
  await f.auth.discardGoogleSession(request,response,result);assert.equal(f.sessions.has('old-token'),true);assert.deepEqual(campusCookies(response),[]);
  await assert.rejects(f.auth.completeGoogle(request,res(),{linkExpected:{authUserId:randomUUID(),sessionId:f.oldSessionId}}),{code:'GOOGLE_LINK_SESSION_REQUIRED'});
  await assert.rejects(f.auth.completeGoogle(request,res(),{linkExpected:{authUserId:f.subject,sessionId:randomUUID()}}),{code:'GOOGLE_LINK_SESSION_REQUIRED'});
});

test('link completion forwards an accepted replacement cookie when the provider retains the bound session ID',async()=>{
  const f=await fixture({policy:true}),request=req(`${AUTH_COOKIE}=old-token; ${challenge}`),response=res();
  const original=await f.auth.readIdentity(request);
  await f.sessionPolicy.authorize(original,{method:'password',userId:42});
  f.options.exchangeSessionId=f.oldSessionId;
  const result=await f.auth.completeGoogle(request,response,{verifier:'valid-verifier',linkExpected:{authUserId:f.subject,sessionId:f.oldSessionId}});
  assert.equal(result.newSession,false);assert.equal(result.identity.sessionId,f.oldSessionId);
  assert.deepEqual(campusCookies(response),[]);
  f.auth.commitGoogleSession(request,response,result);
  assert.match(campusCookies(response)[0],/^campus_neon_session=google-token;/);
  assert.equal((await f.auth.authenticate(req(campusCookies(response)[0].split(';')[0]))).user.id,42);
  assert.equal(f.admissions.get(f.oldSessionId).method,'password');
});

test('linking with a distinct temporary provider session preserves the initiating credential session and admission',async()=>{
  const f=await fixture({policy:true}),request=req(`${AUTH_COOKIE}=old-token; ${challenge}`),response=res();
  const original=await f.auth.readIdentity(request);
  await f.sessionPolicy.authorize(original,{method:'password',userId:42});
  const result=await f.auth.completeGoogle(request,response,{verifier:'valid-verifier',linkExpected:{authUserId:f.subject,sessionId:f.oldSessionId}});
  assert.equal(result.newSession,false);assert.equal(result.identity.sessionId,f.oldSessionId);
  assert.equal(f.sessions.has('google-token'),false);assert.equal(f.sessions.has('old-token'),true);
  f.auth.commitGoogleSession(request,response,result);assert.deepEqual(campusCookies(response),[]);
  assert.equal((await f.auth.authenticate(req(`${AUTH_COOKIE}=old-token`))).user.id,42);
  assert.equal(f.admissions.get(f.oldSessionId).method,'password');
});

test('link exchange cannot switch the bound subject or change its verified Google account during session preservation',async t=>{
  for(const scenario of ['different-subject','different-Google-account'])await t.test(scenario,async()=>{
    const f=await fixture(),request=req(`${AUTH_COOKIE}=old-token; ${challenge}`),response=res();
    if(scenario==='different-subject')f.options.exchangeSubject=randomUUID();
    else f.options.infoForCookie=opaque=>opaque==='old-token'?{...f.options.info,data:{...f.options.info.data,sub:'different-subject'}}:f.options.info;
    await assert.rejects(f.auth.completeGoogle(request,response,{verifier:'valid-verifier',linkExpected:{authUserId:f.subject,sessionId:f.oldSessionId}}));
    assert.deepEqual(campusCookies(response),[]);assert.equal(f.sessions.has('google-token'),false);assert.equal(f.sessions.has('old-token'),true);
  });
});

test('Google completion rejects expired provider sessions and invalid JWT proofs before publishing cookies',async t=>{
  for(const scenario of ['expired-session','invalid-JWT'])await t.test(scenario,async()=>{
    const f=await fixture(),response=res();
    if(scenario==='expired-session')f.options.exchangeSession={expiresAt:new Date(Date.now()-1000).toISOString()};
    else f.options.jwtOverride='unsigned.payload.signature';
    await assert.rejects(f.auth.completeGoogle(req(challenge),response,{verifier:'valid-verifier'}));
    assert.deepEqual(campusCookies(response),[]);assert.equal(f.sessions.has('google-token'),false);
    assert.equal(f.requests.some(request=>request.path==='account-info'),false);
  });
});

test('durable admission rejects direct Neon sessions; password login admits without academic restrictions and sign-out forgets proof',async()=>{
  const f=await fixture({policy:true}),response=res();f.user.email='legacy@gmail.com';f.profile.email=f.user.email;
  assert.equal(await f.auth.authenticate(req(`${AUTH_COOKIE}=old-token`)),null);
  const logged=await f.auth.signIn(req(),response,{email:f.user.email,password:'existing-password'});
  assert.equal(logged.user.role,'student');assert.equal(f.admissions.get(logged.sessionId).method,'password');
  const cookie=campusCookies(response)[0].split(';')[0];assert.equal((await f.auth.authenticate(req(cookie))).user.id,42);
  await f.auth.signOut(req(cookie),res());assert.equal(f.admissions.has(logged.sessionId),false);
});

test('password-change rotation retains the Google admission and never converts it into unrestricted password admission',async()=>{
  const f=await fixture({policy:true}),request=req(`${AUTH_COOKIE}=old-token`),response=res();
  const original=await f.auth.readIdentity(request),proof={method:'google',googleSub:f.options.info.data.sub,googleEmailVerified:true,email:f.user.email,hostedDomain:'college.example',userId:42};
  await f.sessionPolicy.authorize(original,proof);f.options.rotatePassword=true;
  const next=await f.auth.changePassword(request,response,{currentPassword:'existing-password',newPassword:'new-password'});
  assert.notEqual(next.sessionId,original.sessionId);assert.deepEqual(f.admissions.get(next.sessionId),proof);
  assert.equal((await f.auth.authenticate(req(campusCookies(response)[0].split(';')[0]))).user.id,42);
});

test('a grandfathered credential session can change its password and explicitly admit its rotated session',async()=>{
  const f=await fixture({policy:true}),request=req(`${AUTH_COOKIE}=old-token`),response=res();
  f.user.email='legacy@gmail.com';f.profile.email=f.user.email;
  f.options.legacySession=f.oldSessionId;f.options.rotatePassword=true;
  assert.equal(await f.sessionPolicy.get(await f.auth.readIdentity(request)),null);
  const next=await f.auth.changePassword(request,response,{currentPassword:'existing-password',newPassword:'new-password'});
  assert.notEqual(next.sessionId,f.oldSessionId);
  assert.deepEqual(f.admissions.get(next.sessionId),{method:'password',userId:42});
  assert.equal((await f.auth.authenticate(req(campusCookies(response)[0].split(';')[0]))).user.id,42);
});

test('password rotation cannot authorize or publish a session for another managed subject',async()=>{
  const f=await fixture({policy:true}),request=req(`${AUTH_COOKIE}=old-token`),response=res();
  const original=await f.auth.readIdentity(request);
  await f.sessionPolicy.authorize(original,{method:'password',userId:42});
  f.options.rotatePassword=true;f.options.rotatedPasswordSubject=randomUUID();
  await assert.rejects(f.auth.changePassword(request,response,{currentPassword:'existing-password',newPassword:'new-password'}),{status:401});
  assert.deepEqual(campusCookies(response),[]);assert.equal(f.admissions.size,1);
  assert.equal([...f.admissions.keys()][0],f.oldSessionId);
});
