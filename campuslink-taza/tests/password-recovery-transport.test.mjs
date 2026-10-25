import test from 'node:test';
import assert from 'node:assert/strict';
import {AUTH_COOKIE,createAuthService} from '../server/auth.js';

// All provider requests are synthetic. No email, real identity or password is
// submitted to Neon by this suite.
const origin='https://campus.example.test',baseUrl='https://neon.example.test/neondb/auth';
const providerCookie='__Secure-neon-auth.session_token';
const req={secure:true,protocol:'https',headers:{origin,host:'campus.example.test',cookie:`${AUTH_COOKIE}=existing-session`}};
const input={email:'  Student@College.Example  ',code:'123456',newPassword:'12345678'};
function fixture({reply={success:true},status=200,headers={},networkError=false,raw,cleanupReply={success:true},cleanupStatus=200}={}) {
  const requests=[];
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname.slice('/neondb/auth/'.length);
    requests.push({path,headers:options.headers,body:options.body?JSON.parse(options.body):null});
    if(path==='sign-out')return new Response(JSON.stringify(cleanupReply),{status:cleanupStatus,headers:{'content-type':'application/json'}});
    if(networkError)throw new Error('Synthetic connection interrupted');
    return new Response(raw===undefined?JSON.stringify(reply):raw,{status,headers:{'content-type':'application/json',...headers}});
  };
  return {requests,auth:createAuthService({baseUrl,jwksUrl:'https://neon.example.test/jwks',appOrigin:origin,fetchImpl})};
}
const rejected=(code,status)=>error=>{assert.equal(error.code,code);assert.equal(error.status,status);return true;};

test('Password recovery sends a normalized email without browser/provider credentials',async()=>{
  const f=fixture();
  assert.deepEqual(await f.auth.requestPasswordRecovery(req,input),{success:true});
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].path,'email-otp/request-password-reset');
  assert.deepEqual(f.requests[0].body,{email:'student@college.example'});
  assert.equal(f.requests[0].headers.cookie,undefined);
  assert.equal(f.requests[0].headers.origin,origin);
});

test('Password reset uses the OTP-specific endpoint and accepts eight digits as the password',async()=>{
  const f=fixture({reply:{success:true,user:{id:'private-user'},token:null}});
  const result=await f.auth.completePasswordRecovery(req,input);
  assert.deepEqual(result,{success:true});
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].path,'email-otp/reset-password');
  assert.deepEqual(f.requests[0].body,{email:'student@college.example',otp:'123456',password:'12345678'});
  assert.equal(f.requests[0].headers.cookie,undefined);
  assert.equal(JSON.stringify(result).includes(input.code),false);
  assert.equal(JSON.stringify(result).includes(input.newPassword),false);
});

test('Password recovery checks an OTP without consuming it or sending session credentials',async()=>{
  const f=fixture();
  assert.deepEqual(await f.auth.checkPasswordRecoveryCode(req,input),{success:true});
  assert.deepEqual(await f.auth.checkPasswordRecoveryCode(req,input),{success:true});
  assert.equal(f.requests.length,2);
  for(const request of f.requests){assert.equal(request.path,'email-otp/check-verification-otp');assert.deepEqual(request.body,{email:'student@college.example',type:'forget-password',otp:'123456'});assert.equal(request.headers.cookie,undefined);}
  assert.equal(f.requests.some(request=>request.path==='email-otp/reset-password'),false);
});

test('OTP preflight rejects malformed input before contacting the provider',async()=>{
  const f=fixture();
  for(const body of [{email:'invalid',code:input.code},{email:input.email,code:'12345'},{email:input.email,code:123456}])await assert.rejects(f.auth.checkPasswordRecoveryCode(req,body),rejected('PASSWORD_RECOVERY_INVALID',400));
  assert.equal(f.requests.length,0);
});

test('OTP preflight categorizes definitive refusals and unavailable responses without a mutation-unknown error',async t=>{
  for(const [options,status,code]of [[{status:400,reply:{code:'OTP_EXPIRED'}},400,'PASSWORD_RECOVERY_INVALID'],[{status:403,reply:{}},400,'PASSWORD_RECOVERY_INVALID'],[{status:404,reply:{}},503,'PASSWORD_RECOVERY_UNAVAILABLE'],[{status:500,reply:{}},503,'PASSWORD_RECOVERY_UNAVAILABLE'],[{reply:{success:false}},503,'PASSWORD_RECOVERY_UNAVAILABLE'],[{raw:'invalid-json'},503,'PASSWORD_RECOVERY_UNAVAILABLE'],[{networkError:true},503,'PASSWORD_RECOVERY_UNAVAILABLE']])await t.test(JSON.stringify(options),async()=>{
    const f=fixture(options);await assert.rejects(f.auth.checkPasswordRecoveryCode(req,input),rejected(code,status));assert.equal(f.requests.length,1);
  });
});

test('Malformed inputs fail before any provider request',async t=>{
  for(const data of [{email:'invalid'}, {email:''}, {code:'12345'}, {code:'1234567'}, {code:123456}, {code:'12345a'}, {newPassword:'1234567'}, {newPassword:'x'.repeat(129)}, {newPassword:12345678}])await t.test(JSON.stringify(Object.keys(data)),async()=>{
    const f=fixture();
    await assert.rejects(f.auth.completePasswordRecovery(req,{...input,...data}),rejected('PASSWORD_RECOVERY_INVALID',400));
    assert.equal(f.requests.length,0);
  });
  const f=fixture();
  await assert.rejects(f.auth.requestPasswordRecovery(req,{email:'invalid'}),rejected('PASSWORD_RECOVERY_INVALID',400));
  assert.equal(f.requests.length,0);
});

test('The send result does not enumerate absent or ineligible academic addresses',async t=>{
  for(const [status,code]of [[400,'USER_NOT_FOUND'],[401,'UNAUTHORIZED'],[403,'EMAIL_NOT_VERIFIED'],[404,'USER_NOT_FOUND']])await t.test(String(status),async()=>{
    const f=fixture({status,reply:{code,message:'private provider detail'}});
    assert.deepEqual(await f.auth.requestPasswordRecovery(req,input),{success:true});
    assert.equal(f.requests.length,1);
  });
});

test('Send config failures, unsupported endpoints, malformed success and transport failures are unavailable',async t=>{
  for(const options of [{status:400,reply:{code:'INVALID_ORIGIN'}},{status:403,reply:{code:'MISSING_OR_NULL_ORIGIN'}},{status:404,reply:{}},{status:500,reply:{}},{reply:{success:false}},{raw:'not-json'},{networkError:true}])await t.test(JSON.stringify(options),async()=>{
    const f=fixture(options);
    await assert.rejects(f.auth.requestPasswordRecovery(req,input),rejected('PASSWORD_RECOVERY_UNAVAILABLE',503));
    assert.equal(f.requests.length,1);
  });
});

test('Provider rate limits retain a bounded retry delay on send and complete',async t=>{
  for(const method of ['requestPasswordRecovery','checkPasswordRecoveryCode','completePasswordRecovery'])await t.test(method,async()=>{
    const f=fixture({status:429,reply:{message:'private detail'},headers:{'retry-after':'123'}});
    await assert.rejects(f.auth[method](req,input),error=>{rejected('PASSWORD_RECOVERY_RATE_LIMITED',429)(error);assert.equal(error.retryAfter,123);assert.equal(error.message.includes('private'),false);return true;});
    assert.equal(f.requests.length,1);
  });
});

test('A rejected or expired OTP is distinct from an uncertain password mutation',async t=>{
  for(const status of [400,401,403])await t.test(String(status),async()=>{
    const f=fixture({status,reply:{code:'OTP_EXPIRED',message:'private provider detail'}});
    await assert.rejects(f.auth.completePasswordRecovery(req,input),rejected('PASSWORD_RECOVERY_INVALID',400));
    assert.equal(f.requests.length,1);
  });
});

test('An interrupted, malformed or server-failed reset is never retried or reported as successful',async t=>{
  for(const options of [{status:500,reply:{}},{status:503,reply:{success:true}},{reply:{success:false}},{reply:{status:true}},{raw:'malformed'},{networkError:true}])await t.test(JSON.stringify(options),async()=>{
    const f=fixture(options);
    await assert.rejects(f.auth.completePasswordRecovery(req,input),rejected('PASSWORD_RECOVERY_UNKNOWN',503));
    assert.equal(f.requests.length,1);
  });
});

test('Unexpected temporary sessions are revoked without touching the existing browser session',async t=>{
  for(const method of ['requestPasswordRecovery','checkPasswordRecoveryCode','completePasswordRecovery'])await t.test(method,async()=>{
    const f=fixture({headers:{'set-cookie':`${providerCookie}=temporary-private-session; Max-Age=3600; HttpOnly; Secure`}});
    assert.deepEqual(await f.auth[method](req,input),{success:true});
    assert.equal(f.requests.length,2);
    assert.equal(f.requests[0].headers.cookie,undefined);
    assert.equal(f.requests[1].path,'sign-out');
    assert.equal(f.requests[1].headers.cookie,`${providerCookie}=temporary-private-session`);
    assert.deepEqual(f.requests[1].body,{});
  });
});

test('A provider echo of the initiating session does not revoke that existing session',async()=>{
  const f=fixture({headers:{'set-cookie':`${providerCookie}=existing-session; Max-Age=3600; HttpOnly; Secure`}});
  assert.deepEqual(await f.auth.completePasswordRecovery(req,input),{success:true});
  assert.equal(f.requests.length,1);
});

test('Failure to discard an unexpected temporary session remains safely unconfirmed',async t=>{
  for(const [method,code]of [['requestPasswordRecovery','PASSWORD_RECOVERY_UNAVAILABLE'],['completePasswordRecovery','PASSWORD_RECOVERY_UNKNOWN']])await t.test(method,async()=>{
    const f=fixture({headers:{'set-cookie':`${providerCookie}=temporary-private-session; Max-Age=3600`},cleanupStatus:503,cleanupReply:{}});
    await assert.rejects(f.auth[method](req,input),rejected(code,503));
    assert.equal(f.requests.length,2);
  });
});
