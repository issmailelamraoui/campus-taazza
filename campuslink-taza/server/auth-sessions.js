const domainPattern=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const timestamp=value=>value instanceof Date?value.getTime():Date.parse(value);
const validIdentity=identity=>!!identity?.sessionId&&typeof identity.authUser?.id==='string'&&Number.isFinite(timestamp(identity.createdAt))&&timestamp(identity.expiresAt)>Date.now();
const accountAllowsIdentity=(identity,user)=>validIdentity(identity)&&!!user&&!user.disabled&&user.account_status!=='deleted'&&user.auth_user_id===identity.authUser.id&&String(user.email||'').toLowerCase()===identity.authUser.email&&!(user.auth_revoked_at&&timestamp(identity.createdAt)<=timestamp(user.auth_revoked_at));
const policyError=(message,code='GOOGLE_IDENTITY_REJECTED')=>Object.assign(new Error(message),{status:403,code});

// Domains are exact allow-list entries: listing example.edu never also admits
// student.example.edu. A missing/invalid list keeps the optional feature closed.
export function googleOAuthConfiguration(options={}) {
  const enabled=(options.enabled??process.env.GOOGLE_OAUTH_ENABLED)==='true'||options.enabled===true;
  const input=options.domains??process.env.ALLOWED_ACADEMIC_EMAIL_DOMAINS??'';
  const values=Array.isArray(input)?input:typeof input==='string'?input.split(/[\s,;]+/):[];
  const domains=[...new Set(values.filter(Boolean).map(value=>String(value).trim().toLowerCase()))];
  const workspaceInput=options.workspaceDomains??process.env.GOOGLE_WORKSPACE_DOMAINS??'';
  const workspaceValues=Array.isArray(workspaceInput)?workspaceInput:typeof workspaceInput==='string'?workspaceInput.split(/[\s,;]+/):[];
  const workspaceDomains=[...new Set(workspaceValues.filter(Boolean).map(value=>String(value).trim().toLowerCase()))];
  const configured=domains.length>0&&domains.every(domain=>domainPattern.test(domain))&&workspaceDomains.every(domain=>domainPattern.test(domain)&&domains.includes(domain));
  return Object.freeze({enabled:enabled&&configured,requested:enabled,configured,domains:Object.freeze(configured?domains:[]),workspaceDomains:Object.freeze(configured?workspaceDomains:[])});
}

export function assertGoogleAcademicIdentity(identity,google,config) {
  if(!config?.enabled)throw policyError('La connexion Google est actuellement indisponible.','GOOGLE_DISABLED');
  // Google proof is produced only by the server's strict raw + mapped provider
  // verification, or reloaded from an admission created after that check.
  // A legacy credential user's local Neon flag can stay false after linking.
  if(!identity?.authUser||google?.emailVerified!==true||typeof google.subject!=='string'||!google.subject||typeof google.email!=='string')throw policyError('Google doit confirmer votre adresse e-mail.','GOOGLE_EMAIL_UNVERIFIED');
  const email=google.email.trim().toLowerCase(),sessionEmail=String(identity.authUser.email||'').toLowerCase();
  const domain=email.split('@');
  if(domain.length!==2||email!==sessionEmail||!config.domains.includes(domain[1]))throw policyError('Utilisez une adresse académique autorisée.','GOOGLE_DOMAIN_REJECTED');
  const hostedDomain=google.hostedDomain===undefined||google.hostedDomain===null||google.hostedDomain===''?null:String(google.hostedDomain).toLowerCase();
  // A returned Workspace domain must agree with the verified email domain.
  // Non-Workspace academic accounts remain eligible for new registrations.
  if(hostedDomain&&hostedDomain!==domain[1]||config.workspaceDomains?.includes(domain[1])&&hostedDomain!==domain[1])throw policyError('Le domaine Google Workspace ne correspond pas à votre adresse académique.','GOOGLE_DOMAIN_REJECTED');
  return {email,googleSub:google.subject,googleEmailVerified:true,hostedDomain};
}

export function createAuthSessionPolicy({db,googleConfig=googleOAuthConfiguration()}={}) {
  async function get(identity) {
    if(!validIdentity(identity))return null;
    const row=await db.prepare('SELECT * FROM auth_session_admissions WHERE session_id=? AND auth_user_id=?').get(identity.sessionId,identity.authUser.id);
    // pg returns TIMESTAMPTZ as Date. Date.parse(Date) stringifies it without
    // milliseconds, which would reject almost every otherwise valid session.
    if(!row||timestamp(row.session_created_at)!==timestamp(identity.createdAt))return null;
    // Neon can roll the expiry of the same validated live session. Its original
    // admission remains valid for that session; only trusted provider identity
    // reads may extend it, never an expired identity or another creation time.
    if(timestamp(identity.expiresAt)>timestamp(row.expires_at))await db.prepare('UPDATE auth_session_admissions SET expires_at=GREATEST(expires_at,?::timestamptz) WHERE session_id=? AND auth_user_id=? AND session_created_at=?').run(identity.expiresAt,identity.sessionId,identity.authUser.id,identity.createdAt);
    // Only authorize() writes admissions. A Google method durably records that
    // strict server-side provider verification succeeded for this exact
    // session/subject/creation time; it is never inferred from a link row.
    return {method:row.method,googleSub:row.google_sub,googleEmailVerified:row.method==='google'||row.method==='google_pending',email:row.provider_email,hostedDomain:row.hosted_domain,userId:row.user_id};
  }
  async function linked(identity,proof,user) {
    if(!user||user.id!==Number(proof.userId))return false;
    const link=await db.prepare('SELECT * FROM google_auth_links WHERE user_id=? AND auth_user_id=? AND google_sub=?').get(user.id,identity.authUser.id,proof.googleSub);
    return !!link&&link.email===proof.email&&link.email===String(identity.authUser.email).toLowerCase();
  }
  async function authorize(identity,proof={}) {
    if(!validIdentity(identity)||!['password','google','google_pending'].includes(proof.method))throw policyError('La session de connexion est invalide.','GOOGLE_SESSION_INVALID');
    let evidence={googleSub:null,email:null,hostedDomain:null};
    if(proof.method!=='password') {
      evidence=assertGoogleAcademicIdentity(identity,{subject:proof.googleSub,email:proof.email,emailVerified:proof.googleEmailVerified,hostedDomain:proof.hostedDomain},googleConfig);
      if(proof.method==='google') {
        const user=await db.prepare('SELECT * FROM users WHERE id=? AND auth_user_id=?').get(proof.userId,identity.authUser.id);
        if(!accountAllowsIdentity(identity,user))throw policyError('Votre session a expiré. Reconnectez-vous.','GOOGLE_SESSION_INVALID');
        if(!await linked(identity,{...proof,...evidence},user))throw policyError('Connectez-vous avec votre mot de passe pour associer Google.','GOOGLE_LINK_REQUIRED');
      }
    }
    const result=await db.prepare(`INSERT INTO auth_session_admissions (session_id,auth_user_id,session_created_at,expires_at,method,google_sub,provider_email,hosted_domain,user_id)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (session_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,method=EXCLUDED.method,google_sub=EXCLUDED.google_sub,provider_email=EXCLUDED.provider_email,hosted_domain=EXCLUDED.hosted_domain,user_id=EXCLUDED.user_id
      WHERE auth_session_admissions.auth_user_id=EXCLUDED.auth_user_id AND auth_session_admissions.session_created_at=EXCLUDED.session_created_at`).run(identity.sessionId,identity.authUser.id,identity.createdAt,identity.expiresAt,proof.method,evidence.googleSub,evidence.email,evidence.hostedDomain,proof.userId??null);
    if(result.changes!==1)throw policyError('La session de connexion est invalide.','GOOGLE_SESSION_INVALID');
    return get(identity);
  }
  async function allows(identity,user) {
    if(!accountAllowsIdentity(identity,user))return false;
    const proof=await get(identity);
    if(proof) {
      if(proof.method==='password')return true;
      if(proof.method==='google_pending')return false;
      try{assertGoogleAcademicIdentity(identity,{subject:proof.googleSub,email:proof.email,emailVerified:proof.googleEmailVerified,hostedDomain:proof.hostedDomain},googleConfig);}catch{return false;}
      return linked(identity,proof,user);
    }
    // Snapshot only already mapped subjects. New sessions, including direct
    // public-Neon OAuth sessions, cannot claim the legacy exception.
    const legacy=await db.prepare('SELECT l.user_id,c.created_at FROM auth_legacy_subjects l CROSS JOIN auth_session_cutover c WHERE l.auth_user_id=? AND c.singleton=TRUE').get(identity.authUser.id);
    return !!legacy&&legacy.user_id===user.id&&timestamp(identity.createdAt)<=timestamp(legacy.created_at);
  }
  async function forget(identity) {if(identity?.sessionId&&identity?.authUser?.id)await db.prepare('DELETE FROM auth_session_admissions WHERE session_id=? AND auth_user_id=?').run(identity.sessionId,identity.authUser.id);}
  return {get,authorize,allows,forget};
}
