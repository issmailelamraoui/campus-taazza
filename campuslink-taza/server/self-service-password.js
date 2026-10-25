import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRateLimiter} from './rate-limit.js';

const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
const invalid=()=>fail(400,'Vérifiez votre adresse universitaire et le code reçu.','PASSWORD_RECOVERY_INVALID');
const unavailable=()=>fail(503,'La récupération est momentanément indisponible. Réessayez plus tard.','PASSWORD_RECOVERY_UNAVAILABLE');
const unknown=()=>fail(503,'Le résultat du changement n’a pas pu être confirmé. Essayez de vous connecter ou demandez un nouveau code.','PASSWORD_RECOVERY_UNKNOWN');
const hash=value=>createHash('sha256').update(value).digest('hex');

// Only the identity provider sends, validates and consumes OTPs. No code,
// password, provider token or authenticated session is stored by these routes.
export function installSelfServicePassword(app,{db,auth,domains,permissions,endUserStreams}) {
  const limits={
    sendIP:createRateLimiter({limit:12,windowMs:900000,message:'Trop de demandes.'}),
    sendEmail:createRateLimiter({limit:3,windowMs:900000,message:'Trop de demandes.'}),
    completeIP:createRateLimiter({limit:30,windowMs:900000,message:'Trop de tentatives.'}),
    completeEmail:createRateLimiter({limit:8,windowMs:900000,message:'Trop de tentatives.'}),
  };
  function address(req) {
    if(!domains?.length||['requestPasswordRecovery','checkPasswordRecoveryCode','completePasswordRecovery'].some(name=>typeof auth[name]!=='function'))throw unavailable();
    const email=typeof req.body.email==='string'&&req.body.email.length<=160?req.body.email.trim().toLowerCase():'';
    if(!/^[^\s@]+@[^\s@]+$/.test(email)||!domains.includes(email.split('@')[1])||req.user&&req.user.email?.toLowerCase()!==email)throw invalid();
    return email;
  }
  function take(kind,req,email) {
    try{limits[kind+'IP'].take(req.ip);limits[kind+'Email'].take(hash(email));}
    catch(error){throw Object.assign(fail(429,'Trop de tentatives. Patientez avant de réessayer.','PASSWORD_RECOVERY_RATE_LIMITED'),{retryAfter:error.retryAfter||60});}
  }
  const eligible=user=>user&&!user.disabled&&user.account_status!=='deleted'&&!!user.auth_user_id;
  app.post('/api/auth/password-recovery/start',async(req,res)=>{
    const email=address(req);take('send',req,email);
    const user=await db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
    // Unknown/disabled accounts have the same public response, without sending
    // mail or creating an identity at the managed provider.
    if(eligible(user))await auth.requestPasswordRecovery(req,{email});
    res.json({success:true});
  });
  app.post('/api/auth/password-recovery/complete',async(req,res)=>{
    const email=address(req);take('complete',req,email);
    const {code,newPassword}=req.body;
    if(typeof code!=='string'||!/^\d{6}$/.test(code)||typeof newPassword!=='string'||newPassword.length<8||newPassword.length>128)throw invalid();
    const candidate=await db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
    if(!eligible(candidate))throw invalid();
    // Check email ownership before persisting a restriction. A forged request
    // or invalid OTP cannot lock an account out. The reset endpoint validates
    // and consumes this OTP again; this check alone never changes a password.
    const checked=await auth.checkPasswordRecoveryCode(req,{email,code});
    if(checked?.success!==true)throw invalid();
    const operation=await db.transaction(async()=>{
      // Share the administrator-reset lock so a reset cannot overwrite a
      // concurrently issued temporary password or apply to a reassigned user.
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:password-reset:${db.schema}:${candidate.id}`);
      const user=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(candidate.id);
      if(!eligible(user)||user.email?.toLowerCase()!==email||user.auth_user_id!==candidate.auth_user_id)throw invalid();
      if(user.password_reset_operation_id){
        const prior=await db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=? FOR UPDATE').get(user.password_reset_operation_id);
        if(['pending','changing'].includes(prior?.status)&&Date.now()-new Date(prior.updated_at).getTime()<120000)throw unavailable();
        // A worker interrupted after reservation leaves a durable restriction.
        // A fresh valid OTP may recover a stalled attempt after its timeout.
        if(['pending','changing'].includes(prior?.status))await db.prepare("UPDATE password_reset_operations SET status='unknown',failure_code='INTERRUPTED',updated_at=? WHERE operation_id=?").run(new Date().toISOString(),prior.operation_id);
      }
      const op=await db.prepare("INSERT INTO password_reset_operations(operation_id,actor_id,target_user_id,auth_user_id,reason,request_salt,request_hash,status,previous_operation_id,previous_required,previous_expiry) VALUES(?,?,?,?,?,?,?,'changing',?,?,?) RETURNING *").get(randomUUID(),user.id,user.id,user.auth_user_id,'Self-service academic email OTP',randomBytes(16).toString('hex'),hash(randomBytes(32)),user.password_reset_operation_id,user.password_change_required,user.password_reset_expires_at);
      // Commit this cutoff BEFORE calling the remote mutation. Even a worker
      // crash or database failure after remote success keeps old sessions out.
      await db.prepare('UPDATE users SET password_change_required=TRUE,password_reset_operation_id=?,password_reset_expires_at=NULL,auth_revoked_at=?,session_version=session_version+1 WHERE id=?').run(op.operation_id,new Date().toISOString(),user.id);
      return op;
    });
    endUserStreams(candidate.id);
    auth.clearCookie?.(req,res);
    let providerError;
    try{if((await auth.completePasswordRecovery(req,{email,code,newPassword}))?.success!==true)providerError=unknown();}
    catch(error){providerError=error;}
    try{
      await db.transaction(async()=>{
        await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:password-reset:${db.schema}:${candidate.id}`);
        const user=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(candidate.id);
        const current=await db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=? FOR UPDATE').get(operation.operation_id);
        if(!eligible(user)||user.auth_user_id!==operation.auth_user_id||user.password_reset_operation_id!==operation.operation_id||current?.status!=='changing')throw unknown();
        const ambiguous=providerError?.code==='PASSWORD_RECOVERY_UNKNOWN';
        await db.prepare('UPDATE password_reset_operations SET status=?,updated_at=? WHERE operation_id=?').run(providerError?ambiguous?'unknown':'failed':'completed',new Date().toISOString(),operation.operation_id);
        if(!providerError){
          await db.prepare('UPDATE users SET password_change_required=FALSE,password_reset_operation_id=NULL,password_reset_expires_at=NULL WHERE id=?').run(user.id);
          if(operation.previous_operation_id)await db.prepare("UPDATE password_reset_operations SET status='superseded',updated_at=? WHERE operation_id=? AND status IN('issued','unknown')").run(new Date().toISOString(),operation.previous_operation_id);
        }else if(!ambiguous){
          await db.prepare('UPDATE users SET password_change_required=?,password_reset_operation_id=?,password_reset_expires_at=? WHERE id=?').run(operation.previous_required,operation.previous_operation_id,operation.previous_expiry,user.id);
        }
        await permissions.audit(user,providerError?ambiguous?'password-recovery.self-service-unknown':'password-recovery.self-service-failed':'password-recovery.self-service-completed','user',user.id,{method:'academic-email-otp',operation_id:operation.operation_id});
      });
    }catch{throw unknown();}
    if(providerError)throw providerError;
    res.json({success:true});
  });
}
