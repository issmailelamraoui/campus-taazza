import {createHash,randomBytes} from 'node:crypto';
import {assertGoogleAcademicIdentity} from './auth-sessions.js';
import {createRateLimiter} from './rate-limit.js';

const ATTEMPT_COOKIE='campus_google_attempt';
const ATTEMPT_PATH='/api/auth/google/callback';
const ATTEMPT_TTL=10*60*1000;
const failure=(status,message,code)=>Object.assign(new Error(message),{status,code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const cookieValue=req=>String(req.get('cookie')||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(ATTEMPT_COOKIE+'='))?.slice(ATTEMPT_COOKIE.length+1)||'';
const validNonce=value=>/^[A-Za-z0-9_-]{43}$/.test(value);
const cookieOptions=req=>({httpOnly:true,secure:!!req.secure||process.env.COOKIE_SECURE==='true',sameSite:'lax',path:ATTEMPT_PATH});
const callbackErrors=new Set(['GOOGLE_DISABLED','GOOGLE_EMAIL_UNVERIFIED','GOOGLE_DOMAIN_REJECTED','GOOGLE_IDENTITY_REJECTED','GOOGLE_LINK_REQUIRED','GOOGLE_LINK_CONFLICT','GOOGLE_SESSION_INVALID','GOOGLE_ATTEMPT_INVALID','GOOGLE_OAUTH_FAILED','GOOGLE_ACCOUNT_DISABLED']);

export function installGoogleOAuthRoutes(app,{db,auth,sessionPolicy,config,appOrigin,transaction,string,semesterValue,filiereBelongsToFaculty,selfUser,notifyRegistration,broadcastRegistrations,limiter}={}) {
  let publicOrigin;
  try {
    const url=new URL(appOrigin);
    if(url.origin!==appOrigin||url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error();
    publicOrigin=url.origin;
  } catch { /* Fixed public redirects are required before enabling the feature. */ }
  const enabled=()=>config.enabled&&!!publicOrigin&&['beginGoogle','completeGoogle','commitGoogleSession','discardGoogleSession','readIdentity','proveIdentity'].every(name=>typeof auth[name]==='function');
  function requireEnabled(){if(!enabled())throw failure(503,'La connexion Google est actuellement indisponible.','GOOGLE_DISABLED');}
  const verificationMessage='La confirmation de cette adresse est actuellement indisponible. Réessayez plus tard.';
  const verificationLimits={
    sendIP:createRateLimiter({limit:12,windowMs:900000,message:verificationMessage}),
    sendEmail:createRateLimiter({limit:3,windowMs:900000,message:verificationMessage}),
    confirmIP:createRateLimiter({limit:30,windowMs:900000,message:verificationMessage}),
    confirmEmail:createRateLimiter({limit:8,windowMs:900000,message:verificationMessage}),
  };
  function verificationEmail(value) {
    const email=typeof value==='string'&&value.length<=254?value.trim().toLowerCase():'';
    if(!/^[^\s@]+@[^\s@]+$/.test(email)||!config.domains.includes(email.split('@')[1]))throw failure(400,'Utilisez une adresse académique autorisée.','GOOGLE_VERIFICATION_INVALID');
    return email;
  }
  function requireVerification() {
    requireEnabled();
    if(typeof auth.sendGoogleEmailVerification!=='function'||typeof auth.confirmGoogleEmailVerification!=='function')throw failure(503,verificationMessage,'GOOGLE_VERIFICATION_UNAVAILABLE');
  }
  function verificationFailure(error) {
    if(error?.status===429) {
      const limited=failure(429,'Trop de demandes de confirmation. Réessayez plus tard.','GOOGLE_VERIFICATION_RATE_LIMITED');
      limited.retryAfter=Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?Math.min(error.retryAfter,900):900;
      return limited;
    }
    if(error?.code==='GOOGLE_VERIFICATION_INVALID'||[400,401,403].includes(error?.status))return failure(400,'Le code est invalide ou a expiré. Réessayez.','GOOGLE_VERIFICATION_INVALID');
    return failure(503,verificationMessage,'GOOGLE_VERIFICATION_UNAVAILABLE');
  }
  function takeVerificationAttempt(kind,req,email) {
    try {
      verificationLimits[kind+'IP'].take(req.ip);
      verificationLimits[kind+'Email'].take(hash(email));
    } catch(error) {throw verificationFailure(error);}
  }
  const destination=user=>user?.account_status!=='approved'?'/account-review':user.must_change_password||user.password_change_required?'/change-password':!user.faculty_id||!user.filiere_id?'/onboarding':'/app';
  const linkDestination=user=>destination(user)==='/app'?'/app/profile':destination(user);
  function redirect(req,res,path){res.set('Referrer-Policy','no-referrer');res.redirect(303,new URL(path,publicOrigin||'http://localhost:5173').href);}
  function clearAttempt(req,res){res.clearCookie(ATTEMPT_COOKIE,cookieOptions(req));}
  async function completionIdentity(req) {
    requireEnabled();
    const identity=await auth.readIdentity(req);
    const proof=await sessionPolicy.get(identity);
    if(!identity||!['google_pending','google'].includes(proof?.method))throw failure(401,'Reconnectez-vous avec Google pour compléter votre inscription.','GOOGLE_SESSION_INVALID');
    const evidence=assertGoogleAcademicIdentity(identity,{subject:proof.googleSub,email:proof.email,emailVerified:proof.googleEmailVerified,hostedDomain:proof.hostedDomain},config);
    if(proof.method==='google') {
      const user=await db.prepare('SELECT * FROM users WHERE id=? AND auth_user_id=?').get(proof.userId,identity.authUser.id);
      if(!user||user.disabled||user.account_status==='deleted'||!await sessionPolicy.allows(identity,user))throw failure(401,'Votre session a expiré. Reconnectez-vous.','GOOGLE_SESSION_INVALID');
      return {identity,proof:{...proof,...evidence},user};
    }
    return {identity,proof:{...proof,...evidence}};
  }

  app.get('/api/auth/google/config',(_req,res)=>{
    const available=enabled();
    res.json({enabled:available,domains:available?[...config.domains]:[],...(available&&typeof auth.googleAuthorizationEndpoint==='string'?{authorizationEndpoint:auth.googleAuthorizationEndpoint}:{})});
  });
  // This recovery verifies only ownership of the existing email through the
  // provider's verification endpoint. It neither signs in nor associates a
  // Google account; a fresh, fully checked Google callback remains necessary.
  app.post('/api/auth/google/email-verification/start',async(req,res)=>{
    requireVerification();
    const email=verificationEmail(req.body.email);
    takeVerificationAttempt('send',req,email);
    try {await auth.sendGoogleEmailVerification(req,{email});}
    catch(error) {
      // Existing and unknown academic addresses receive the same response.
      // Provider details must never disclose whether a campus account exists.
      if(![400,401,403].includes(error?.status))throw verificationFailure(error);
    }
    res.json({success:true});
  });
  app.post('/api/auth/google/email-verification/confirm',async(req,res)=>{
    requireVerification();
    const email=verificationEmail(req.body.email);
    takeVerificationAttempt('confirm',req,email);
    const code=typeof req.body.code==='string'?req.body.code.trim():'';
    if(!/^\d{6}$/.test(code))throw failure(400,'Le code est invalide ou a expiré. Réessayez.','GOOGLE_VERIFICATION_INVALID');
    try {await auth.confirmGoogleEmailVerification(req,{email,code});}
    catch(error) {throw verificationFailure(error);}
    res.json({verified:true});
  });
  app.post('/api/auth/google/start',async(req,res)=>{
    requireEnabled();limiter.take(req.ip);
    const intent=req.body.intent??'login';
    if(!['login','link'].includes(intent))throw failure(400,'Action Google invalide.','GOOGLE_OAUTH_FAILED');
    let expected=null;
    if(intent==='link') {
      if(!req.user)throw failure(401,'Connectez-vous avec votre mot de passe avant d’associer Google.','GOOGLE_LINK_REQUIRED');
      const identity=await auth.readIdentity(req);
      if(!identity||identity.authUser.id!==req.user.auth_user_id)throw failure(401,'Votre session a expiré. Reconnectez-vous.','GOOGLE_SESSION_INVALID');
      let proof;
      try {
        try{proof=await auth.proveIdentity({email:req.user.email,password:req.body.password,requestOrigin:publicOrigin});}
        catch(error){if(error.status===401||error.status===400)throw failure(403,'Le mot de passe actuel est incorrect.','GOOGLE_PASSWORD_INVALID');throw error;}
        if(proof.authUser.id!==identity.authUser.id||proof.authUser.email!==identity.authUser.email)throw failure(403,'Le compte vérifié ne correspond pas à votre session.','GOOGLE_LINK_REQUIRED');
      } finally {if(proof)await proof.dispose().catch(()=>{});}
      expected={identity,user:req.user};
    } else if(req.user)throw failure(409,'Déconnectez-vous avant de changer de compte.','GOOGLE_SESSION_INVALID');
    const previous=cookieValue(req);
    if(validNonce(previous))await db.prepare('DELETE FROM google_oauth_attempts WHERE token_hash=?').run(hash(previous));
    // Expired attempts contain no usable token and are bounded on each start.
    await db.prepare('DELETE FROM google_oauth_attempts WHERE expires_at<CURRENT_TIMESTAMP').run();
    const token=randomBytes(32).toString('base64url'),tokenHash=hash(token);
    await db.prepare('INSERT INTO google_oauth_attempts (token_hash,intent,expires_at,expected_auth_user_id,expected_user_id,expected_session_id,expected_session_version,expected_auth_revoked_at) VALUES (?,?,?,?,?,?,?,?)').run(tokenHash,intent,new Date(Date.now()+ATTEMPT_TTL).toISOString(),expected?.identity.authUser.id??null,expected?.user.id??null,expected?.identity.sessionId??null,expected?.user.session_version??null,expected?.user.auth_revoked_at??null);
    try {
      const callbackURL=new URL('/api/auth/google/callback',publicOrigin).href;
      const started=await auth.beginGoogle(req,res,{callbackURL,errorCallbackURL:callbackURL,link:intent==='link'});
      res.cookie(ATTEMPT_COOKIE,token,{...cookieOptions(req),maxAge:ATTEMPT_TTL});
      res.json({url:started.url});
    } catch(error) {await db.prepare('DELETE FROM google_oauth_attempts WHERE token_hash=?').run(tokenHash);clearAttempt(req,res);throw error;}
  });

  app.get('/api/auth/google/callback',async(req,res)=>{
    let result,attempt;
    clearAttempt(req,res);
    try {
      requireEnabled();
      const nonce=cookieValue(req);
      if(!validNonce(nonce))throw failure(403,'Cette demande Google a expiré. Réessayez.','GOOGLE_ATTEMPT_INVALID');
      // Deletion atomically consumes this browser-bound attempt across instances.
      attempt=await db.prepare('DELETE FROM google_oauth_attempts WHERE token_hash=? AND expires_at>CURRENT_TIMESTAMP RETURNING *').get(hash(nonce));
      if(!attempt)throw failure(403,'Cette demande Google a expiré. Réessayez.','GOOGLE_ATTEMPT_INVALID');
      if(req.query.error) {
        if(req.query.error==='account_not_linked')throw failure(403,'Connectez-vous avec votre mot de passe pour associer Google.','GOOGLE_LINK_REQUIRED');
        throw failure(403,'La connexion Google a été annulée ou refusée.','GOOGLE_OAUTH_FAILED');
      }
      const verifier=req.query.neon_auth_session_verifier;
      if(verifier!==undefined&&(typeof verifier!=='string'||!verifier.length||verifier.length>4096))throw failure(400,'Réponse Google invalide.','GOOGLE_OAUTH_FAILED');
      result=await auth.completeGoogle(req,res,{verifier,linkExpected:attempt.intent==='link'?{sessionId:attempt.expected_session_id,authUserId:attempt.expected_auth_user_id}:undefined});
      const {identity,google}=result,evidence=assertGoogleAcademicIdentity(identity,google,config);
      let target;
      await transaction(async()=>{
        await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('google-subject:'+identity.authUser.id);
        const mapped=await db.prepare('SELECT * FROM users WHERE auth_user_id=? FOR UPDATE').get(identity.authUser.id);
        const link=await db.prepare('SELECT * FROM google_auth_links WHERE auth_user_id=? OR google_sub=? OR user_id=? FOR UPDATE').get(identity.authUser.id,evidence.googleSub,mapped?.id??null);
        if(attempt.intent==='link') {
          if(!mapped||mapped.id!==attempt.expected_user_id||mapped.disabled||mapped.account_status==='deleted'||mapped.session_version!==attempt.expected_session_version||(mapped.auth_revoked_at??null)!==(attempt.expected_auth_revoked_at??null)||identity.sessionId!==attempt.expected_session_id)throw failure(403,'Votre compte a changé. Reconnectez-vous avant d’associer Google.','GOOGLE_SESSION_INVALID');
          if(mapped.email?.toLowerCase()!==evidence.email||link&&(link.user_id!==mapped.id||link.google_sub!==evidence.googleSub||link.auth_user_id!==identity.authUser.id))throw failure(409,'Ce compte Google est déjà associé à un autre profil.','GOOGLE_LINK_CONFLICT');
          if(!link)await db.prepare('INSERT INTO google_auth_links (user_id,auth_user_id,google_sub,email,hosted_domain) VALUES (?,?,?,?,?)').run(mapped.id,identity.authUser.id,evidence.googleSub,evidence.email,evidence.hostedDomain);
          target=mapped;
          // Linking preserves the initiating login method. It does not convert
          // an existing password session to a Google session.
          return;
        }
        if(mapped) {
          if(mapped.disabled||mapped.account_status==='deleted')throw failure(403,'Ce compte est désactivé.','GOOGLE_ACCOUNT_DISABLED');
          if(mapped.email?.toLowerCase()!==evidence.email||link&&(link.user_id!==mapped.id||link.google_sub!==evidence.googleSub||link.auth_user_id!==identity.authUser.id||link.email!==evidence.email))throw failure(409,'Ce compte Google est déjà associé à un autre profil.','GOOGLE_LINK_CONFLICT');
          if(!link) {
            // Record only a binding Neon has already authenticated for this
            // exact canonical subject. A verified local email and matching
            // authoritative Workspace domain are required for the first
            // automatic association; email equality never merges subjects.
            const domain=evidence.email.split('@')[1];
            if(identity.authUser.emailVerified!==true||evidence.hostedDomain!==domain)throw failure(403,'Cette adresse doit être confirmée avant d’associer Google.','GOOGLE_LINK_REQUIRED');
            await db.prepare('INSERT INTO google_auth_links (user_id,auth_user_id,google_sub,email,hosted_domain) VALUES (?,?,?,?,?)').run(mapped.id,identity.authUser.id,evidence.googleSub,evidence.email,evidence.hostedDomain);
          }
          target=mapped;
          await sessionPolicy.authorize(identity,{method:'google',...evidence,userId:mapped.id});
          return;
        }
        if(link||await db.prepare('SELECT id FROM users WHERE lower(email)=?').get(evidence.email))throw failure(409,'Connectez-vous avec votre mot de passe pour associer Google.','GOOGLE_LINK_REQUIRED');
        await sessionPolicy.authorize(identity,{method:'google_pending',...evidence});
      });
      await auth.commitGoogleSession(req,res,result);
      redirect(req,res,target?(attempt.intent==='link'?linkDestination(target):destination(target)):'/auth/google/complete');
    } catch(error) {
      if(result){if(result.newSession)await sessionPolicy.forget(result.identity).catch(()=>{});await auth.discardGoogleSession(req,res,result).catch(()=>{});}
      else await auth.discardGoogleSession(req,res,null).catch(()=>{});
      const code=callbackErrors.has(error.code)?error.code:'GOOGLE_OAUTH_FAILED';
      redirect(req,res,(attempt?.intent==='link'&&req.user?linkDestination(req.user):'/login')+'?google_error='+code);
    }
  });

  app.get('/api/auth/google/profile',async(req,res)=>{
    const {identity,user}=await completionIdentity(req);
    res.json({profile:{email:identity.authUser.email,name:identity.authUser.name||''},...(user?{completed:true,user:await selfUser(user)}:{})});
  });
  app.post('/api/auth/google/profile',async(req,res)=>{
    limiter.take(req.ip);
    const {identity,proof,user:completed}=await completionIdentity(req);
    // A lost HTTP response may cause a retry. Return the already created, linked
    // profile without accepting any new identity, academic scope, or role data.
    if(completed)return res.json({user:await selfUser(completed),authenticated:true});
    const username=string(req.body.username,'Nom d’utilisateur',40),name=string(req.body.name,'Nom',100);
    if(!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))throw failure(400,'Nom d’utilisateur invalide.','GOOGLE_PROFILE_INVALID');
    const faculty=string(req.body.faculty_id,'Faculté',30),filiere=string(req.body.filiere_id,'Filière',80),semester=semesterValue(req.body.current_semester);
    if(!filiereBelongsToFaculty(faculty,filiere)||!await db.prepare('SELECT 1 FROM faculties WHERE id=?').get(faculty))throw failure(400,'Choisissez une filière de votre faculté.','GOOGLE_PROFILE_INVALID');
    let createdNow=false;
    const user=await transaction(async()=>{
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('google-subject:'+identity.authUser.id);
      const current=await sessionPolicy.get(identity);
      if(current?.method==='google') {
        const existing=await db.prepare('SELECT * FROM users WHERE id=? AND auth_user_id=? FOR UPDATE').get(current.userId,identity.authUser.id);
        if(existing&&!existing.disabled&&existing.account_status!=='deleted'&&await sessionPolicy.allows(identity,existing))return existing;
      }
      if(current?.method!=='google_pending')throw failure(409,'Cette inscription a déjà été enregistrée.','GOOGLE_SESSION_INVALID');
      if(await db.prepare('SELECT id FROM users WHERE auth_user_id=? OR lower(email)=?').get(identity.authUser.id,proof.email))throw failure(409,'Connectez-vous avec votre compte existant pour associer Google.','GOOGLE_LINK_REQUIRED');
      if(await db.prepare('SELECT id FROM users WHERE lower(username)=lower(?)').get(username))throw failure(409,'Ce nom d’utilisateur est déjà utilisé.','GOOGLE_PROFILE_INVALID');
      const created=await db.prepare("INSERT INTO users (username,name,email,auth_user_id,role,faculty_id,filiere_id,current_semester,account_status,registered_at) VALUES (?,?,?,?,'student',?,?,?,'pending',?) RETURNING *").get(username,name,proof.email,identity.authUser.id,faculty,filiere,semester,new Date().toISOString());
      await db.prepare('INSERT INTO google_auth_links (user_id,auth_user_id,google_sub,email,hosted_domain) VALUES (?,?,?,?,?)').run(created.id,identity.authUser.id,proof.googleSub,proof.email,proof.hostedDomain);
      await sessionPolicy.authorize(identity,{...proof,method:'google',userId:created.id});
      await notifyRegistration(created.id,name);
      createdNow=true;
      return created;
    }).catch(error=>{
      if(error.code==='23505')throw failure(409,error.constraint==='users_username_lower'?'Ce nom d’utilisateur est déjà utilisé.':'Ce compte est déjà inscrit. Connectez-vous pour associer Google.',error.constraint==='users_username_lower'?'GOOGLE_PROFILE_INVALID':'GOOGLE_LINK_REQUIRED');
      throw error;
    });
    if(createdNow)await broadcastRegistrations();
    res.status(createdNow?201:200).json({user:await selfUser(user),authenticated:true});
  });
  app.get('/api/auth/google/link',async(req,res)=>{
    requireEnabled();
    if(!req.user)throw failure(401,'Connectez-vous avant de gérer Google.','GOOGLE_SESSION_INVALID');
    const link=await db.prepare('SELECT email FROM google_auth_links WHERE user_id=? AND auth_user_id=?').get(req.user.id,req.user.auth_user_id);
    res.json(link?{linked:true,email:link.email}:{linked:false});
  });
}
