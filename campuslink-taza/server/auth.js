import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';

const PROVIDER_COOKIE = '__Secure-neon-auth.session_token';
// The value remains the opaque Neon-issued session token. Renaming the cookie
// allows the same server proxy to work on localhost HTTP and deployed HTTPS.
export const AUTH_COOKIE = 'campus_neon_session';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class AuthError extends Error {
  constructor(status,message,code='AUTH_ERROR') {super(message);this.status=status;this.code=code;}
}
const invalidCredentials=()=>new AuthError(401,'Nom d’utilisateur ou mot de passe incorrect.','INVALID_CREDENTIALS');
const unavailable=()=>new AuthError(503,'Le service de connexion est indisponible. Réessayez.','AUTH_UNAVAILABLE');
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

export function createAuthService({db,baseUrl=process.env.NEON_AUTH_BASE_URL,jwksUrl=process.env.NEON_AUTH_JWKS_URL,appOrigin=process.env.APP_ORIGIN||'http://localhost:5173',fetchImpl=globalThis.fetch,timeoutMs=10000}={}) {
  let base,jwks;
  try {base=new URL(baseUrl.replace(/\/?$/,'/'));jwks=new URL(jwksUrl);if(base.protocol!=='https:'||jwks.protocol!=='https:')throw Error();}
  catch {throw new AuthError(503,'La configuration Neon Auth est incomplète.','AUTH_CONFIGURATION');}
  const issuer=base.origin;
  const keys=createRemoteJWKSet(jwks,{[customFetch]:fetchImpl,timeoutDuration:timeoutMs,cooldownDuration:1000});
  // Browser origins are checked by Express. The provider receives the configured
  // trusted origin even when the browser opens this proxy through a LAN address.
  function origin(req) {return appOrigin||header(req,'origin')||`${req?.protocol||'http'}://${header(req,'host')||'localhost:5173'}`;}
  function cookieHeader(req) {const token=parseCookie(header(req,'cookie'),AUTH_COOKIE);return token?`${PROVIDER_COOKIE}=${token}`:'';}
  function applyCookies(req,res,cookies) {
    if(!res)return;
    for(const cookie of cookies)if(cookie.name===PROVIDER_COOKIE)res.append('Set-Cookie',serializeSetCookie({
      name:AUTH_COOKIE,value:cookie.value,path:'/',httpOnly:true,sameSite:'lax',
      secure:!!req?.secure||process.env.COOKIE_SECURE==='true',maxAge:cookie.maxAge,expires:cookie.expires,
    }));
  }
  function clearCookie(req,res) {if(res)res.append('Set-Cookie',serializeSetCookie({name:AUTH_COOKIE,value:'',path:'/',httpOnly:true,sameSite:'lax',secure:!!req?.secure||process.env.COOKIE_SECURE==='true',maxAge:0}));}
  async function call(path,{req,res,body,cookies}={}) {
    const requestHeaders={'origin':origin(req),'x-neon-auth-proxy':'express','accept':'application/json'};
    const cookie=cookies??cookieHeader(req);if(cookie)requestHeaders.cookie=cookie;
    if(body!==undefined)requestHeaders['content-type']='application/json';
    let response;
    try {response=await fetchImpl(new URL(path,base),{method:body===undefined?'GET':'POST',headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}
    catch {throw unavailable();}
    const data=await response.json().catch(()=>null);
    const responseCookies=(response.headers.getSetCookie?.()||[]).flatMap(parseSetCookies);
    applyCookies(req,res,responseCookies);
    const delay=Number(response.headers.get('retry-after'));
    return {status:response.status,ok:response.ok,data,cookies:responseCookies,jwt:response.headers.get('set-auth-jwt'),retryAfter:Number.isSafeInteger(delay)&&delay>0&&delay<=900?delay:60};
  }
  const jar=result=>result.cookies.filter(c=>c.name===PROVIDER_COOKIE).map(c=>`${c.name}=${encodeURIComponent(c.value)}`).join('; ');
  function errorFor(result,credentials=false) {
    if(result.status>=500)throw unavailable();
    if(credentials&&(result.status===400||result.status===401||result.status===403))throw invalidCredentials();
    if(result.status===429){const error=new AuthError(429,'Trop de demandes. Réessayez dans un instant.');error.retryAfter=result.retryAfter;throw error;}
    if(result.status===403||result.status===401)throw new AuthError(result.status,'Vous n’avez pas l’autorisation d’effectuer cette action.');
    throw new AuthError(result.status===404?503:400,'L’opération Neon Auth n’a pas pu être effectuée.','AUTH_OPERATION_FAILED');
  }
  async function identity(req,res,cookies) {
    const result=await call('get-session?disableCookieCache=true',{req,res,cookies});
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
    return {authUser:{id:user.id,email:emailValue(user.email),name:user.name||'',emailVerified:!!user.emailVerified,role:user.role||'user'},sessionId:session.id,createdAt:session.createdAt,expiresAt:session.expiresAt};
  }
  async function profileFor(authIdentity) {
    if(!authIdentity||!db)return null;
    const user=await db.prepare('SELECT * FROM users WHERE auth_user_id=?').get(authIdentity.authUser.id);
    if(!user||user.disabled||user.email?.toLowerCase()!==authIdentity.authUser.email)return null;
    if(user.auth_revoked_at&&Date.parse(authIdentity.createdAt)<=Date.parse(user.auth_revoked_at))return null;
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
    const authenticated=await profileFor(authIdentity);
    if(!authenticated) {await call('sign-out',{req,cookies:providerCookies,body:{}}).catch(()=>{});clearCookie(req,res);throw invalidCredentials();}
    applyCookies(req,res,result.cookies);return authenticated;
  }
  async function signOut(req,res) {
    try {if(cookieHeader(req)){const result=await call('sign-out',{req,res,body:{}});if(!result.ok&&result.status!==401)errorFor(result);}}
    finally {clearCookie(req,res);}
    return {ok:true};
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
    applyCookies(req,res,result.cookies);
    // A provider may rotate the session cookie on password change.
    const cookies=jar(result)||cookieHeader(req);
    const next=await profileFor(await identity(req,null,cookies));
    if(!next)throw new AuthError(401,'Connectez-vous pour accéder à votre communauté.');
    return next;
  }
  async function revokeUserSessions(req,authUserId) {
    if(!UUID.test(authUserId))return {supported:false};
    if(db)await db.prepare('UPDATE users SET auth_revoked_at=?,session_version=session_version+1 WHERE auth_user_id=?').run(new Date().toISOString(),authUserId);
    const result=await call('admin/revoke-user-sessions',{req,body:{userId:authUserId}});
    if([401,403,404].includes(result.status))return {supported:false};
    if(!result.ok)errorFor(result);return {supported:true};
  }
  async function removeUser(req,authUserId) {
    if(!UUID.test(authUserId))throw new AuthError(400,'Identifiant invalide.');
    const result=await call('admin/remove-user',{req,body:{userId:authUserId}});
    if(!result.ok)errorFor(result);return {ok:true};
  }
  return {authenticate,signIn,signOut,createUser,changePassword,revokeUserSessions,removeUser,proveIdentity,clearCookie,
    session:authenticate,login:signIn,logout:signOut};
}
