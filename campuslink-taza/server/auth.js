import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';

const PROVIDER_COOKIE = '__Secure-neon-auth.session_token';
// The value remains the opaque Neon-issued session token. Renaming the cookie
// allows the same server proxy to work on localhost HTTP and deployed HTTPS.
export const AUTH_COOKIE = 'campus_neon_session';
const GOOGLE_CHALLENGES = [
  ['__Secure-neon-auth.session_challenge','campus_neon_oauth_challenge'],
  ['__Secure-neon-auth.session_challange','campus_neon_oauth_challange'],
];
const boundedString=(value,max=4096)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\r\n\u0000]/.test(value);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class AuthError extends Error {
  constructor(status,message,code='AUTH_ERROR') {super(message);this.status=status;this.code=code;}
}
const invalidCredentials=()=>new AuthError(401,'Nom d’utilisateur ou mot de passe incorrect.','INVALID_CREDENTIALS');
const unavailable=()=>new AuthError(503,'Le service de connexion est indisponible. Réessayez.','AUTH_UNAVAILABLE');
const passwordResetUnknown=()=>new AuthError(503,'Le résultat de la réinitialisation n’a pas pu être confirmé. Vérifiez la demande avant de créer un autre mot de passe.','AUTH_PASSWORD_RESET_UNKNOWN');
const header=(req,name)=>req?.get?.(name)||req?.headers?.[name.toLowerCase()]||'';
const parseCookie=(value,name)=>String(value||'').split(';').map(c=>c.trim()).find(c=>c.startsWith(`${name}=`))?.slice(name.length+1)||'';
function parseSetCookies(value) {
  const parts=value.split(';').map(p=>p.trim()),first=parts.shift(),split=first.indexOf('=');
  if(split<1)return [];
  let token;try {token=decodeURIComponent(first.slice(split+1));}catch{return [];}
  const cookie={name:first.slice(0,split),value:token};
  for(const part of parts) {
    const [key,...rest]=part.split('='),option=rest.join('=');
    if(key.toLowerCase()==='max-age'&&/^-?\d+$/.test(option))cookie.maxAge=Number(option);
    if(key.toLowerCase()==='expires'&&Number.isFinite(Date.parse(option)))cookie.expires=new Date(option);
  }
  return [cookie];
}
function serializeSetCookie(cookie) {
  return `${cookie.name}=${encodeURIComponent(cookie.value)}; Path=/; HttpOnly; SameSite=Lax${cookie.secure?'; Secure':''}${cookie.maxAge!==undefined?`; Max-Age=${cookie.maxAge}`:''}${cookie.expires?`; Expires=${cookie.expires.toUTCString()}`:''}`;
}
const emailValue=value=>{
  if(typeof value!=='string'||value.length>256||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))throw new AuthError(400,'Adresse e-mail invalide.');
  return value.trim().toLowerCase();
};
const passwordValue=value=>{if(typeof value!=='string'||!value.length||value.length>256)throw new AuthError(400,'Mot de passe invalide.');return value;};

export function createAuthService({db,sessionPolicy,baseUrl=process.env.NEON_AUTH_BASE_URL,jwksUrl=process.env.NEON_AUTH_JWKS_URL,appOrigin=process.env.APP_ORIGIN||'http://localhost:5173',fetchImpl=globalThis.fetch,timeoutMs=10000}={}) {
  let base,jwks;
  try {base=new URL(baseUrl.replace(/\/?$/,'/'));jwks=new URL(jwksUrl);if(base.protocol!=='https:'||jwks.protocol!=='https:')throw Error();}
  catch {throw new AuthError(503,'La configuration Neon Auth est incomplète.','AUTH_CONFIGURATION');}
  const issuer=base.origin;
  const googleAuthorizationEndpoint=new URL('sign-in/social/init',base);
  const keys=createRemoteJWKSet(jwks,{[customFetch]:fetchImpl,timeoutDuration:timeoutMs,cooldownDuration:1000});
  // Browser origins are checked by Express. The provider receives the configured
  // trusted origin even when the browser opens this proxy through a LAN address.
  function origin(req) {return appOrigin||header(req,'origin')||`${req?.protocol||'http'}://${header(req,'host')||'localhost:5173'}`;}
  function cookieHeader(req) {const token=parseCookie(header(req,'cookie'),AUTH_COOKIE);return boundedString(token)&&!/[;\s]/.test(token)?`${PROVIDER_COOKIE}=${token}`:'';}
  function applyCookies(req,res,cookies) {
    if(!res)return;
    for(const cookie of cookies)if(cookie.name===PROVIDER_COOKIE)res.append('Set-Cookie',serializeSetCookie({
      name:AUTH_COOKIE,value:cookie.value,path:'/',httpOnly:true,sameSite:'lax',
      secure:!!req?.secure||process.env.COOKIE_SECURE==='true',maxAge:cookie.maxAge,expires:cookie.expires,
    }));
  }
  function clearCookie(req,res) {if(res)res.append('Set-Cookie',serializeSetCookie({name:AUTH_COOKIE,value:'',path:'/',httpOnly:true,sameSite:'lax',secure:!!req?.secure||process.env.COOKIE_SECURE==='true',maxAge:0}));}
  async function call(path,{req,res,body,cookies,uncertainPasswordReset=false}={}) {
    const requestHeaders={'origin':origin(req),'x-neon-auth-proxy':'express','x-neon-auth-middleware':'true','accept':'application/json'};
    const cookie=cookies??cookieHeader(req);if(cookie)requestHeaders.cookie=cookie;
    if(body!==undefined)requestHeaders['content-type']='application/json';
    let response;
    try {response=await fetchImpl(new URL(path,base),{method:body===undefined?'GET':'POST',headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}
    catch {throw uncertainPasswordReset?passwordResetUnknown():unavailable();}
    const data=await response.json().catch(()=>null);
    const responseCookies=(response.headers.getSetCookie?.()||[]).flatMap(parseSetCookies);
    applyCookies(req,res,responseCookies);
    const delay=Number(response.headers.get('retry-after'));
    return {status:response.status,ok:response.ok,data,cookies:responseCookies,jwt:response.headers.get('set-auth-jwt'),retryAfter:Number.isSafeInteger(delay)&&delay>0&&delay<=900?delay:60};
  }
  const jar=result=>result.cookies.filter(c=>c.name===PROVIDER_COOKIE).map(c=>`${c.name}=${encodeURIComponent(c.value)}`).join('; ');
  function errorFor(result,credentials=false) {
    if(['INVALID_ORIGIN','MISSING_OR_NULL_ORIGIN','INVALID_CALLBACK_URL'].includes(result.data?.code))throw new AuthError(503,'La configuration du service de connexion doit être vérifiée par l’administration.','AUTH_CONFIGURATION');
    if(result.status>=500)throw unavailable();
    if(credentials&&(result.status===400||result.status===401||result.status===403))throw invalidCredentials();
    if(result.status===429){const error=new AuthError(429,'Trop de demandes. Réessayez dans un instant.');error.retryAfter=result.retryAfter;throw error;}
    if(result.status===403||result.status===401)throw new AuthError(result.status,'Vous n’avez pas l’autorisation d’effectuer cette action.');
    throw new AuthError(result.status===404?503:400,'L’opération Neon Auth n’a pas pu être effectuée.','AUTH_OPERATION_FAILED');
  }
  async function identity(req,res,cookies) {
    const result=await call('get-session?disableCookieCache=true',{req,res,cookies});
    if(result.data?.code==='INVALID_ORIGIN')errorFor(result);
    if(result.status===401||result.status===403)return null;
    if(!result.ok)errorFor(result);
    const user=result.data?.user,session=result.data?.session;
    if(!user||!session)return null;
    const expiresAt=Date.parse(session.expiresAt),createdAt=Date.parse(session.createdAt);
    if(!UUID.test(user.id)||session.userId!==user.id||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||!Number.isFinite(createdAt)||user.banned)return null;
    let token=result.jwt;
    if(!token) {const tokenResponse=await call('token',{req,cookies});if(!tokenResponse.ok)errorFor(tokenResponse);token=tokenResponse.data?.token;}
    try {
      const {payload}=await jwtVerify(token,keys,{issuer,audience:issuer,algorithms:['EdDSA','ES256','RS256'],requiredClaims:['sub','exp','iat']});
      if(payload.sub!==user.id||payload.banned===true)return null;
    } catch {return null;}
    if(!boundedString(session.id,256))return null;
    return {authUser:{id:user.id,email:emailValue(user.email),name:user.name||'',emailVerified:user.emailVerified===true,role:user.role||'user'},sessionId:session.id,createdAt:session.createdAt,expiresAt:session.expiresAt};
  }
  async function profileFor(authIdentity,{checkPolicy=true}={}) {
    if(!authIdentity||!db)return null;
    const user=await db.prepare('SELECT * FROM users WHERE auth_user_id=?').get(authIdentity.authUser.id);
    if(!user||user.disabled||user.email?.toLowerCase()!==authIdentity.authUser.email)return null;
    if(user.auth_revoked_at&&Date.parse(authIdentity.createdAt)<=Date.parse(user.auth_revoked_at))return null;
    if(checkPolicy&&sessionPolicy&&!await sessionPolicy.allows(authIdentity,user))return null;
    return {...authIdentity,user,authUserId:authIdentity.authUser.id};
  }
  async function authenticate(req,res) {if(!cookieHeader(req))return null;return profileFor(await identity(req,res));}
  async function signIn(req,res,{email,password,expectedAuthUserId}={}) {
    const result=await call('sign-in/email',{req,body:{email:emailValue(email),password:passwordValue(password),rememberMe:true}});
    if(!result.ok)errorFor(result,true);
    const providerCookies=jar(result);
    const authIdentity=await identity(req,null,providerCookies);
    if(!authIdentity||expectedAuthUserId&&authIdentity.authUser.id!==expectedAuthUserId) {
      if(providerCookies)await call('sign-out',{req,cookies:providerCookies,body:{}}).catch(()=>{});
      clearCookie(req,res);throw invalidCredentials();
    }
    const authenticated=await profileFor(authIdentity,{checkPolicy:false});
    if(!authenticated) {await call('sign-out',{req,cookies:providerCookies,body:{}}).catch(()=>{});clearCookie(req,res);throw invalidCredentials();}
    try {if(sessionPolicy)await sessionPolicy.authorize(authIdentity,{method:'password',userId:authenticated.user.id});}
    catch(error) {await call('sign-out',{req,cookies:providerCookies,body:{}}).catch(()=>{});clearCookie(req,res);throw error;}
    applyCookies(req,res,result.cookies);return authenticated;
  }
  async function signOut(req,res) {
    try {if(cookieHeader(req)){const existing=sessionPolicy?await identity(req).catch(()=>null):null;const result=await call('sign-out',{req,res,body:{}});if(existing)await sessionPolicy.forget(existing);if(!result.ok&&result.status!==401)errorFor(result);}}
    finally {clearCookie(req,res);}
    return {ok:true};
  }
  const googleResults=new WeakMap();
  const oauthFailure=(code='GOOGLE_IDENTITY_INVALID')=>new AuthError(401,'La connexion Google n’a pas pu être vérifiée. Réessayez.',''+code);
  function clearGoogleChallenge(req,res) {
    if(res)for(const [,name]of GOOGLE_CHALLENGES)res.append('Set-Cookie',serializeSetCookie({name,value:'',maxAge:0,secure:!!req?.secure||process.env.COOKIE_SECURE==='true'}));
  }
  function googleChallengeHeader(req) {
    return GOOGLE_CHALLENGES.flatMap(([provider,name])=>{
      const value=parseCookie(header(req,'cookie'),name);
      return boundedString(value)&&!/[;\s]/.test(value)?[`${provider}=${value}`]:[];
    }).join('; ');
  }
  function checkedCallback(value) {
    try {const url=new URL(value),expected=new URL(appOrigin);if(url.origin!==expected.origin||url.username||url.password||url.hash||value.length>2048)throw Error();return url.href;}
    catch {throw new AuthError(503,'La configuration du retour Google doit être vérifiée.','AUTH_CONFIGURATION');}
  }
  function checkedGoogleURL(value) {
    try {
      if(!boundedString(value,20000))throw Error();
      const url=new URL(value);
      if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error();
      // Managed shared credentials begin with a browser navigation to this
      // branch's Neon init endpoint. Its opaque token carries the provider
      // handshake; following it on the server would consume the browser hop.
      if(url.origin===googleAuthorizationEndpoint.origin&&url.pathname===googleAuthorizationEndpoint.pathname) {
        const params=[...url.searchParams];
        if(params.length!==1||params[0][0]!=='token'||!boundedString(params[0][1])||!/^[A-Za-z0-9._~-]+$/.test(params[0][1]))throw Error();
        return url.href;
      }
      if(url.origin!=='https://accounts.google.com'||!['/o/oauth2/v2/auth','/o/oauth2/auth'].includes(url.pathname))throw Error();
      if(url.searchParams.get('redirect_uri')!==new URL('callback/google',base).href||url.searchParams.get('response_type')!=='code'||!boundedString(url.searchParams.get('state'),2048)||!boundedString(url.searchParams.get('client_id'),512)||url.searchParams.get('code_challenge_method')!=='S256'||!/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get('code_challenge')||''))throw Error();
      return url.href;
    } catch {throw new AuthError(503,'La configuration Google OAuth doit être vérifiée.','AUTH_CONFIGURATION');}
  }
  async function beginGoogle(req,res,{callbackURL,errorCallbackURL,link=false}={}) {
    const callbacks={callbackURL:checkedCallback(callbackURL),errorCallbackURL:checkedCallback(errorCallbackURL)};
    if(link&&!cookieHeader(req))throw oauthFailure('GOOGLE_LINK_SESSION_REQUIRED');
    clearGoogleChallenge(req,res);
    const result=await call(link?'link-social':'sign-in/social',{req,cookies:link?cookieHeader(req):'',body:{provider:'google',...callbacks,disableRedirect:true,additionalParams:{prompt:'select_account'}}});
    if(!result.ok)errorFor(result);
    const url=checkedGoogleURL(result.data?.url);
    const challenges=result.cookies.filter(cookie=>GOOGLE_CHALLENGES.some(([provider])=>provider===cookie.name)&&boundedString(cookie.value)&&cookie.maxAge!==0);
    if(!challenges.length)throw new AuthError(503,'Le service Google ne prend pas en charge la connexion sécurisée par proxy.','AUTH_CONFIGURATION');
    for(const cookie of challenges)if(res)res.append('Set-Cookie',serializeSetCookie({name:GOOGLE_CHALLENGES.find(([provider])=>provider===cookie.name)[1],value:cookie.value,maxAge:Math.min(600,Number.isFinite(cookie.maxAge)&&cookie.maxAge>0?cookie.maxAge:600),secure:!!req?.secure||process.env.COOKIE_SECURE==='true'}));
    return {url,redirect:true};
  }
  function googleVerificationFailure(status=503) {
    return new AuthError(status,status===400?'Le code de vérification est invalide ou a expiré.':status===429?'Trop de demandes. Réessayez plus tard.':'La vérification de l’adresse est temporairement indisponible.',status===400?'GOOGLE_VERIFICATION_INVALID':status===429?'GOOGLE_VERIFICATION_RATE_LIMITED':'GOOGLE_VERIFICATION_UNAVAILABLE');
  }
  function googleVerificationEmail(value) {
    try{return emailValue(value);}catch{throw googleVerificationFailure(400);}
  }
  async function googleVerificationRequest(req,path,body) {
    // Verification is not sign-in. Do not send an existing session or publish
    // any response cookie, JWT, provider user, or token to the browser.
    try{return await call(path,{req,cookies:'',body});}catch{throw googleVerificationFailure();}
  }
  function googleVerificationResponseError(result) {
    const error=googleVerificationFailure(result.status===429?429:result.status>=500||result.status===404&&result.data?.code!=='USER_NOT_FOUND'?503:400);
    if(error.status===429)error.retryAfter=result.retryAfter;
    return error;
  }
  async function discardGoogleVerificationSession(req,result) {
    let existing=parseCookie(header(req,'cookie'),AUTH_COOKIE);
    try{existing=decodeURIComponent(existing);}catch{/* Keep malformed input opaque. */}
    const temporary=[...new Set(result.cookies.filter(cookie=>cookie.name===PROVIDER_COOKIE&&boundedString(cookie.value)&&cookie.maxAge!==0&&cookie.value!==existing).map(cookie=>cookie.value))];
    // Managed Neon may auto-sign-in after verifying email. Revoke only the
    // newly returned opaque session; never revoke the initiating browser login.
    for(const token of temporary) {
      let discarded;
      try{discarded=await call('sign-out',{req,cookies:`${PROVIDER_COOKIE}=${encodeURIComponent(token)}`,body:{}});}catch{throw googleVerificationFailure();}
      if(!discarded.ok||discarded.data?.success!==true)throw googleVerificationFailure();
    }
  }
  async function sendGoogleEmailVerification(req,{email}={}) {
    const normalized=googleVerificationEmail(email);
    const result=await googleVerificationRequest(req,'email-otp/send-verification-otp',{email:normalized,type:'email-verification'});
    try {
      if(!result.ok) {
        // Match the provider's non-enumerating send contract. A nonexistent or
        // ineligible account must not have a distinct public response.
        if([400,401,403].includes(result.status)||result.status===404&&result.data?.code==='USER_NOT_FOUND')return {success:true};
        throw googleVerificationResponseError(result);
      }
      if(result.data?.success!==true)throw googleVerificationFailure();
      return {success:true};
    } finally {await discardGoogleVerificationSession(req,result);}
  }
  async function confirmGoogleEmailVerification(req,{email,code}={}) {
    const normalized=googleVerificationEmail(email);
    if(typeof code!=='string'||!/^\d{6}$/.test(code))throw googleVerificationFailure(400);
    const result=await googleVerificationRequest(req,'email-otp/verify-email',{email:normalized,otp:code});
    try {
      if(!result.ok)throw googleVerificationResponseError(result);
      const user=result.data?.user;
      let verifiedEmail;
      try{verifiedEmail=emailValue(user?.email);}catch{throw googleVerificationFailure(400);}
      if(result.data?.status!==true||user?.emailVerified!==true||!UUID.test(user?.id)||verifiedEmail!==normalized)throw googleVerificationFailure(400);
      // A non-null token means the service created a temporary sign-in. It
      // remains private; require its opaque cookie so it can be revoked below.
      if(result.data.token!==null&&(!boundedString(result.data.token)||!result.cookies.some(cookie=>cookie.name===PROVIDER_COOKIE&&boundedString(cookie.value)&&cookie.maxAge!==0)))throw googleVerificationFailure();
      return {verified:true};
    } finally {await discardGoogleVerificationSession(req,result);}
  }
  async function verifyGoogleIdentity(req,authIdentity,cookies) {
    if(!authIdentity?.authUser)throw oauthFailure('GOOGLE_EMAIL_UNVERIFIED');
    const result=await call('list-accounts',{req,cookies});
    if(!result.ok)errorFor(result);
    if(!Array.isArray(result.data))throw oauthFailure();
    const accounts=result.data.filter(account=>account?.providerId==='google');
    if(accounts.length!==1)throw oauthFailure();
    const account=accounts[0];
    if(account.userId!==authIdentity.authUser.id||!boundedString(account.id,256)||!boundedString(account.accountId,256))throw oauthFailure();
    const info=await call(`account-info?accountId=${encodeURIComponent(account.id)}`,{req,cookies});
    if(!info.ok)errorFor(info);
    const profile=info.data?.data,mapped=info.data?.user,provider=info.data?.account;
    if(provider?.providerId!=='google'||provider.id!==account.id||provider.accountId!==account.accountId||profile?.sub!==account.accountId)throw oauthFailure();
    if(profile.email_verified!==true||mapped?.emailVerified!==true)throw oauthFailure('GOOGLE_EMAIL_UNVERIFIED');
    let email,mappedEmail;
    try {email=emailValue(profile.email);mappedEmail=emailValue(mapped.email);}catch {throw oauthFailure();}
    if(email!==authIdentity.authUser.email||mappedEmail!==email)throw oauthFailure();
    if(profile.hd!==undefined&&(!boundedString(profile.hd,253)||!/^[a-z0-9.-]+$/i.test(profile.hd)))throw oauthFailure();
    // Explicit linking can preserve an older credential user's local
    // emailVerified=false. The verified Google profile, checked above, is the
    // authority for Google sign-in; never rewrite or trust the local flag here.
    return {subject:profile.sub,email,emailVerified:true,name:String(mapped.name||authIdentity.authUser.name||'').trim().slice(0,100),hostedDomain:profile.hd?.toLowerCase()||null};
  }
  async function discardGoogleSession(req,res,result) {
    const provisional=result&&googleResults.get(result);
    if(provisional&&!provisional.committed&&!provisional.discarded) {
      provisional.discarded=true;
      if(provisional.newSession&&provisional.providerCookies)await call('sign-out',{req,cookies:provisional.providerCookies,body:{}}).catch(()=>{});
    }
    clearGoogleChallenge(req,res);
  }
  async function completeGoogle(req,res,{verifier,linkExpected}={}) {
    let providerCookies='',responseCookies=[],authIdentity,googleIdentity,newSession=false,result;
    try {
      let original;
      if(linkExpected) {
        const expectedSubject=linkExpected.authUserId||linkExpected.expectedAuthUserId;
        if(!boundedString(linkExpected.sessionId,256)||!UUID.test(expectedSubject))throw oauthFailure('GOOGLE_LINK_SESSION_REQUIRED');
        original=await identity(req);
        if(!original||original.sessionId!==linkExpected.sessionId||original.authUser.id!==expectedSubject)throw oauthFailure('GOOGLE_LINK_SESSION_REQUIRED');
      }
      if(verifier!==undefined&&verifier!==null&&verifier!=='') {
        if(!boundedString(verifier,2048)||!/^[A-Za-z0-9._~-]+$/.test(verifier))throw oauthFailure('GOOGLE_STATE_INVALID');
        const challenge=googleChallengeHeader(req);
        if(!challenge)throw oauthFailure('GOOGLE_STATE_INVALID');
        const exchange=await call(`get-session?neon_auth_session_verifier=${encodeURIComponent(verifier)}&disableCookieCache=true`,{req,cookies:challenge});
        responseCookies=exchange.cookies;providerCookies=jar(exchange);
        newSession=!original&&!!providerCookies&&providerCookies!==cookieHeader(req);
        if(!exchange.ok)errorFor(exchange);
        if(!providerCookies)throw oauthFailure('GOOGLE_STATE_INVALID');
        authIdentity=await identity(req,null,providerCookies);
        if(original&&authIdentity)newSession=authIdentity.sessionId!==original.sessionId;
        if(!authIdentity||original&&authIdentity.authUser.id!==original.authUser.id)throw oauthFailure();
        if(original&&newSession) {
          const exchangedGoogle=await verifyGoogleIdentity(req,authIdentity,providerCookies);
          // Linking must preserve the credential session bound to the browser
          // attempt. A managed provider may also mint a temporary session;
          // revoke that session, then prove the initiating session still lives.
          await call('sign-out',{req,cookies:providerCookies,body:{}});
          newSession=false;providerCookies='';responseCookies=[];
          const retained=await identity(req);
          if(!retained||retained.sessionId!==original.sessionId||retained.authUser.id!==original.authUser.id)throw oauthFailure('GOOGLE_LINK_SESSION_REQUIRED');
          authIdentity=retained;providerCookies=cookieHeader(req);
          googleIdentity=await verifyGoogleIdentity(req,authIdentity,providerCookies);
          if(googleIdentity.subject!==exchangedGoogle.subject||googleIdentity.email!==exchangedGoogle.email)throw oauthFailure();
        }
      } else {
        if(!original)throw oauthFailure('GOOGLE_STATE_INVALID');
        // Explicit linking preserves the bound credential session on providers
        // that do not mint another session or verifier after linking.
        authIdentity=original;providerCookies=cookieHeader(req);
      }
      result={identity:authIdentity,google:null,newSession};
      googleResults.set(result,{providerCookies,cookies:responseCookies,newSession,committed:false,discarded:false});
      result.google=googleIdentity||await verifyGoogleIdentity(req,authIdentity,providerCookies);
      return result;
    } catch(error) {
      if(!result&&providerCookies){result={};googleResults.set(result,{providerCookies,cookies:responseCookies,newSession,committed:false,discarded:false});}
      await discardGoogleSession(req,res,result);
      throw error;
    }
  }
  function commitGoogleSession(req,res,result) {
    const provisional=result&&googleResults.get(result);
    if(!provisional||provisional.discarded||provisional.committed||!result.google)throw oauthFailure();
    provisional.committed=true;
    // A provider can replace its opaque token while retaining the session ID.
    // Forward validated cookies even when no distinct session was created.
    applyCookies(req,res,provisional.cookies);
    clearGoogleChallenge(req,res);
  }
  // This proof has no application role mapping. It is used only by the trusted
  // operator linking CLI; an auth subject alone never creates or elevates a role.
  async function proveIdentity({email,password,requestOrigin='http://localhost:5173'}={}) {
    const req={headers:{origin:requestOrigin}};
    const result=await call('sign-in/email',{req,body:{email:emailValue(email),password:passwordValue(password)}});
    if(!result.ok)errorFor(result,true);
    const cookies=jar(result),proof=await identity(req,null,cookies);
    if(!proof){await call('sign-out',{req,cookies,body:{}}).catch(()=>{});throw invalidCredentials();}
    return {...proof,dispose:()=>call('sign-out',{req,cookies,body:{}}).then(()=>undefined)};
  }
  async function cleanupCreatedUser(req,created,cookies,password) {
    if(Date.now()-created.createdAtMs>600000)throw new AuthError(503,'Le nettoyage du compte temporaire a échoué.','AUTH_CLEANUP_FAILED');
    const linked=db?await db.prepare('SELECT id FROM users WHERE auth_user_id=?').get(created.id):null;
    if(linked)throw new AuthError(409,'Ce compte est déjà lié à un profil.','AUTH_PROFILE_LINKED');
    const removed=await call('delete-user',{req,cookies,body:{password}});
    if(removed.ok)return;
    // Neon may disable self-deletion. Only compensate a fresh provider signup
    // that THIS operation created, with no existing application profile.
    if(!db||![403,404].includes(removed.status))errorFor(removed);
    const result=await db.prepare('DELETE FROM neon_auth."user" WHERE id=? AND lower(email)=? AND "createdAt">?').run(created.id,created.email,new Date(Date.now()-600000).toISOString());
    if(result.changes!==1)throw new AuthError(503,'Le nettoyage du compte temporaire a échoué.','AUTH_CLEANUP_FAILED');
  }
  async function createUser(req,{email,password,name}={}) {
    email=emailValue(email);password=passwordValue(password);
    const result=await call('sign-up/email',{req,cookies:'',body:{email,password,name:String(name||'').trim().slice(0,100)}});
    if(!result.ok) {if(result.data?.code==='USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')throw new AuthError(409,'Cette adresse e-mail est déjà utilisée.');errorFor(result);}
    const user=result.data?.user;
    if(!user||!UUID.test(user.id)||emailValue(user.email)!==email)throw unavailable();
    const created={id:user.id,email,name:user.name||'',emailVerified:!!user.emailVerified,createdAtMs:Date.now()};
    const cookies=jar(result);
    const {createdAtMs,...safe}=created;
    return {...safe,cleanup:()=>cleanupCreatedUser(req,created,cookies,password)};
  }
  async function changePassword(req,res,{currentPassword,newPassword}={}) {
    const authenticated=await authenticate(req);
    if(!authenticated)throw new AuthError(401,'Connectez-vous pour accéder à votre communauté.');
    const result=await call('change-password',{req,body:{currentPassword:passwordValue(currentPassword),newPassword:passwordValue(newPassword),revokeOtherSessions:true}});
    if(!result.ok) {if(result.status===400||result.status===401)throw new AuthError(403,'Le mot de passe actuel est incorrect.');errorFor(result);}
    // Better Auth confirms this mutation with the changed user's identity.
    // An unchanged valid session alone does not prove the password changed.
    if(result.data?.user?.id!==authenticated.authUserId||!Object.hasOwn(result.data,'token')||result.data.token!==null&&typeof result.data.token!=='string'||result.data.status===false||result.data.success===false)throw passwordResetUnknown();
    // A provider may rotate the session cookie on password change.
    const cookies=jar(result)||cookieHeader(req);
    const nextIdentity=await identity(req,null,cookies);
    if(!nextIdentity||nextIdentity.authUser.id!==authenticated.authUserId)throw new AuthError(401,'Connectez-vous pour accéder à votre communauté.');
    if(sessionPolicy&&nextIdentity&&nextIdentity.sessionId!==authenticated.sessionId) {
      // A password mutation does not change how this session was admitted.
      // In particular, a Google login must retain its academic restrictions.
      // An authenticated session without an admission can only be an exact
      // legacy subject/session preserved by the rollout cutoff. Its successful
      // current-password proof admits a rotated credential session explicitly.
      const admission=await sessionPolicy.get(authenticated)||{method:'password',userId:authenticated.user.id};
      await sessionPolicy.authorize(nextIdentity,admission);
    }
    const next=await profileFor(nextIdentity);
    if(!next)throw new AuthError(401,'Connectez-vous pour accéder à votre communauté.');
    applyCookies(req,res,result.cookies);
    return next;
  }
  async function revokeUserSessions(req,authUserId) {
    if(!UUID.test(authUserId))return {supported:false};
    if(db)await db.prepare('UPDATE users SET auth_revoked_at=?,session_version=session_version+1 WHERE auth_user_id=?').run(new Date().toISOString(),authUserId);
    const result=await call('admin/revoke-user-sessions',{req,body:{userId:authUserId}});
    if([401,403,404].includes(result.status))return {supported:false};
    if(!result.ok)errorFor(result);return {supported:true};
  }
  // Neon Auth's managed Better Auth Admin API verifies the operator's own
  // provider-admin session. Application owner authorization is enforced by the
  // caller; provider roles never grant application privileges. Do not forward
  // Set-Cookie here or sign in as the student: the operator keeps their session.
  async function resetUserPassword(req,{authUserId,newPassword}={}) {
    if(!UUID.test(authUserId))throw new AuthError(400,'Identifiant invalide.');
    newPassword=passwordValue(newPassword);
    if(newPassword.length<8||newPassword.length>128)throw new AuthError(400,'Le nouveau mot de passe doit contenir entre 8 et 128 caractères.');
    if(!cookieHeader(req))throw new AuthError(401,'Reconnectez-vous pour réinitialiser un mot de passe.','AUTH_ADMIN_SESSION_EXPIRED');
    const result=await call('admin/set-user-password',{req,body:{userId:authUserId,newPassword},uncertainPasswordReset:true});
    // A failed transport or server error can follow a committed provider write.
    // Never retry this mutation automatically or report a usable password until
    // the provider explicitly confirms it.
    if(result.status>=500||result.ok&&result.data?.status!==true)throw passwordResetUnknown();
    if(result.status===401)throw new AuthError(401,'Votre session a expiré. Reconnectez-vous pour réinitialiser un mot de passe.','AUTH_ADMIN_SESSION_EXPIRED');
    if(result.status===403||result.status===404)throw new AuthError(503,'La réinitialisation nécessite un compte administrateur Neon Auth autorisé.','AUTH_ADMIN_CONFIGURATION');
    if(!result.ok)errorFor(result);
    let providerSessionsRevoked=false;
    try {
      const revoked=await call('admin/revoke-user-sessions',{req,body:{userId:authUserId}});
      providerSessionsRevoked=revoked.ok&&revoked.data?.success===true;
    } catch { /* A confirmed password change must retain its confirmed outcome. */ }
    // The caller must also invalidate all application sessions with its durable
    // local cutoff, independently of optional provider session cleanup.
    return {confirmed:true,providerSessionsRevoked};
  }
  async function removeUser(req,authUserId) {
    if(!UUID.test(authUserId))throw new AuthError(400,'Identifiant invalide.');
    const result=await call('admin/remove-user',{req,body:{userId:authUserId}});
    if(!result.ok)errorFor(result);return {ok:true};
  }
  return {authenticate,signIn,signOut,createUser,changePassword,resetUserPassword,revokeUserSessions,removeUser,proveIdentity,clearCookie,
    googleAuthorizationEndpoint:googleAuthorizationEndpoint.href,
    readIdentity:identity,beginGoogle,completeGoogle,verifyGoogleIdentity,commitGoogleSession,discardGoogleSession,clearGoogleChallenge,sendGoogleEmailVerification,confirmGoogleEmailVerification,
    session:authenticate,login:signIn,logout:signOut};
}
