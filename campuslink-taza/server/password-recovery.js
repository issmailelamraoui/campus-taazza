import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const derive=promisify(scrypt);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
const now=()=>new Date().toISOString();
const verifier=(password,salt)=>derive(password,salt,32,{N:16384,r:8,p:1,maxmem:32*1024*1024});
const receipt=op=>({ok:true,must_change_password:true,operation_id:op.operation_id,expires_at:op.expires_at});
const uncertain=()=>fail(503,'Le résultat du changement reste incertain. Vérifiez cette opération ou créez explicitement une nouvelle tentative.','PASSWORD_RESET_UNKNOWN');
const pending=()=>fail(409,'Un changement est déjà en cours. Vérifiez cette même opération dans un instant.','PASSWORD_RESET_PENDING');

export function basicResetEligibility(user,permissions){
  return !!user&&!permissions.isOwner(user)&&user.role==='student'&&!user.disabled&&user.account_status==='approved'&&uuid.test(user.auth_user_id||'')&&!!user.email;
}

export function installPasswordRecovery(app,{db,auth,permissions,requireUser,selfUser,endUserStreams}){
  async function lock(id){await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:password-reset:${db.schema}:${id}`);}
  async function owner(id){const user=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(id);if(!user||user.disabled||user.account_status!=='approved'||!permissions.isOwner(user))throw fail(403,'Seul le propriétaire actif peut réinitialiser un mot de passe.');return user;}
  async function eligible(user){return basicResetEligibility(user,permissions)&&!await db.prepare('SELECT 1 FROM scoped_appointments WHERE user_id=? AND revoked_at IS NULL LIMIT 1').get(user.id);}
  async function audit(actor,op,outcome){await permissions.audit(actor,'password-recovery.'+outcome,'user',op.target_user_id,{operation_id:op.operation_id,reason:op.reason,contact_id:op.contact_id||null,outcome});}
  async function expireStalled(op){
    if(op&&['pending','changing'].includes(op.status)&&Date.now()-new Date(op.updated_at).getTime()>120000){
      await db.prepare("UPDATE password_reset_operations SET status='unknown',failure_code='INTERRUPTED',updated_at=? WHERE operation_id=? AND status IN('pending','changing')").run(now(),op.operation_id);op.status='unknown';
    }
    return op;
  }

  app.post('/api/admin/users/:id/password-reset',requireUser,async(req,res)=>{
    // Authorization precedes body validation and hashing.
    if(!permissions.isOwner(req.user))throw fail(403,'Seul le propriétaire peut réinitialiser un mot de passe.');
    const id=Number(req.params.id),body=req.body;
    if(!Number.isSafeInteger(id)||id<1)throw fail(400,'Compte invalide.');
    const password=body.temporary_password,reason=typeof body.reason==='string'?body.reason.trim():'';
    if(typeof password!=='string'||password.length<16||password.length>128||/[\x00-\x1f\x7f]/.test(password)||password!==password.trim())throw fail(400,'Le mot de passe temporaire doit contenir entre 16 et 128 caractères.');
    if(reason.length<10||reason.length>500||/[\x00-\x1f\x7f]/.test(reason)||reason.includes(password))throw fail(400,'Indiquez un motif de 10 à 500 caractères sans mot de passe.');
    if(!uuid.test(body.operation_id||''))throw fail(400,'Identifiant de tentative invalide.');
    if(body.identity_verified!==true)throw fail(400,'Confirmez l’identité de la personne avant ce changement.');
    const contactId=body.contact_id??null;
    if(contactId!==null&&(!Number.isSafeInteger(contactId)||contactId<1))throw fail(400,'Demande d’assistance invalide.');
    const salt=randomBytes(16).toString('hex'),hash=(await verifier(password,salt)).toString('hex');
    const reservation=await db.transaction(async()=>{
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:password-reset-owner:${db.schema}:${req.user.id}`);
      await lock(id);const actor=await owner(req.user.id);
      const target=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(id);
      if(!target||actor.id===id||!await eligible(target))throw fail(403,'Ce compte est protégé ou ne peut pas recevoir de mot de passe temporaire.');
      if(contactId!==null){const contact=await db.prepare('SELECT user_id FROM contacts WHERE id=?').get(contactId);if(!contact||contact.user_id!==null&&contact.user_id!==id)throw fail(403,'Cette demande ne correspond pas au compte sélectionné.');}
      const existing=await expireStalled(await db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=?').get(body.operation_id));
      if(existing){
        const same=existing.actor_id===actor.id&&existing.target_user_id===id&&existing.reason===reason&&(existing.contact_id??null)===contactId&&timingSafeEqual(Buffer.from(existing.request_hash,'hex'),await verifier(password,existing.request_salt));
        if(!same)throw fail(409,'Cet identifiant appartient à une autre tentative.');
        if(existing.status==='issued'&&target.password_reset_operation_id===existing.operation_id&&target.auth_user_id===existing.auth_user_id){
          if(new Date(target.password_reset_expires_at).getTime()<=Date.now())return {error:fail(403,'Le mot de passe temporaire a expiré. Créez une nouvelle tentative.','PASSWORD_RESET_EXPIRED')};
          return {receipt:receipt(existing)};
        }
        if(['pending','changing'].includes(existing.status))return {error:pending()};
        if(existing.status==='unknown')return {error:uncertain()};
        throw fail(409,'Cette tentative est terminée. Créez une nouvelle tentative.');
      }
      const previous=target.password_reset_operation_id?await expireStalled(await db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=?').get(target.password_reset_operation_id)):null;
      if(previous&&['pending','changing'].includes(previous.status))return {error:pending()};
      const counts=await db.prepare("SELECT COUNT(*) FILTER(WHERE target_user_id=?) AS target_count,COUNT(*) FILTER(WHERE actor_id=?) AS actor_count FROM password_reset_operations WHERE created_at>CURRENT_TIMESTAMP-INTERVAL '1 hour'").get(id,actor.id);
      if(Number(counts.target_count)>=3||Number(counts.actor_count)>=10)throw Object.assign(fail(429,'Trop de changements récents. Réessayez plus tard.'),{retryAfter:3600});
      const op=await db.prepare("INSERT INTO password_reset_operations(operation_id,actor_id,target_user_id,auth_user_id,contact_id,reason,request_salt,request_hash,status,previous_operation_id,previous_required,previous_expiry) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?) RETURNING *").get(body.operation_id,actor.id,id,target.auth_user_id,contactId,reason,salt,hash,target.password_reset_operation_id,target.password_change_required,target.password_reset_expires_at);
      await db.prepare('UPDATE users SET password_change_required=TRUE,password_reset_operation_id=?,password_reset_expires_at=NULL,auth_revoked_at=?,session_version=session_version+1 WHERE id=?').run(op.operation_id,now(),id);
      await audit(actor,op,'pending');return {op};
    });
    if(reservation.error)throw reservation.error;
    if(reservation.receipt)return res.json(reservation.receipt);
    endUserStreams(id);
    const op=reservation.op;
    let result,providerError;
    try{result=await auth.resetUserPassword(req,{authUserId:op.auth_user_id,newPassword:password});if(result?.confirmed!==true)providerError=uncertain();}
    catch(error){providerError=error;}
    const outcome=await db.transaction(async()=>{
      await lock(id);
      const actor=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(req.user.id);
      const target=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(id);
      const current=await db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=? FOR UPDATE').get(op.operation_id);
      if(!current||current.status!=='pending'||target?.password_reset_operation_id!==op.operation_id)return {error:uncertain()};
      const authorized=actor&&!actor.disabled&&actor.account_status==='approved'&&permissions.isOwner(actor)&&target.auth_user_id===op.auth_user_id&&await eligible(target);
      const definite=providerError&&['AUTH_ADMIN_CONFIGURATION','AUTH_ADMIN_SESSION_EXPIRED','AUTH_OPERATION_FAILED'].includes(providerError.code)||providerError&&[400,401,403,429].includes(providerError.status);
      if(providerError||!authorized){
        const status=definite?'failed':'unknown';
        await db.prepare('UPDATE password_reset_operations SET status=?,failure_code=?,updated_at=? WHERE operation_id=?').run(status,definite?(providerError.code||'REJECTED'):'UNCONFIRMED',now(),op.operation_id);
        if(definite)await db.prepare('UPDATE users SET password_change_required=?,password_reset_operation_id=?,password_reset_expires_at=? WHERE id=? AND password_reset_operation_id=?').run(op.previous_required,op.previous_operation_id,op.previous_expiry,id,op.operation_id);
        if(actor)await audit(actor,op,status);
        return {error:definite?fail(providerError.status||503,'Le serveur d’authentification a refusé le changement. Aucun mot de passe temporaire n’est confirmé.',providerError.code):uncertain()};
      }
      const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
      await db.prepare("UPDATE password_reset_operations SET status='issued',updated_at=?,expires_at=? WHERE operation_id=?").run(now(),expiresAt,op.operation_id);
      await db.prepare('UPDATE users SET password_reset_expires_at=?,auth_revoked_at=?,session_version=session_version+1 WHERE id=?').run(expiresAt,now(),id);
      if(op.previous_operation_id)await db.prepare("UPDATE password_reset_operations SET status='superseded',updated_at=? WHERE operation_id=? AND status IN('issued','unknown')").run(now(),op.previous_operation_id);
      await audit(actor,op,'issued');return {receipt:receipt({...op,expires_at:expiresAt})};
    });
    endUserStreams(id);
    if(outcome.error)throw outcome.error;
    res.json(outcome.receipt);
  });

  app.post('/api/password-reset/complete',requireUser,async(req,res)=>{
    const {currentPassword,newPassword}=req.body;
    if(typeof currentPassword!=='string'||!currentPassword.length||currentPassword.length>128||typeof newPassword!=='string'||newPassword.length<10||newPassword.length>128||newPassword===currentPassword)throw fail(400,'Choisissez un nouveau mot de passe de 10 à 128 caractères différent du mot de passe temporaire.');
    const op=await db.transaction(async()=>{
      await lock(req.user.id);const user=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(req.user.id);
      if(!user?.password_change_required||!user.password_reset_operation_id)throw fail(409,'Aucun changement obligatoire en cours.');
      const current=await db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=? FOR UPDATE').get(user.password_reset_operation_id);
      if(current?.status!=='issued')throw current?.status==='unknown'?uncertain():pending();
      if(!user.password_reset_expires_at||new Date(user.password_reset_expires_at).getTime()<=Date.now())throw fail(403,'Le mot de passe temporaire a expiré. Contactez le propriétaire.','PASSWORD_RESET_EXPIRED');
      if(current.auth_user_id!==user.auth_user_id)throw fail(409,'Le compte a changé. Contactez le propriétaire.');
      await db.prepare("UPDATE password_reset_operations SET status='changing',updated_at=? WHERE operation_id=?").run(now(),current.operation_id);return current;
    });
    try{await auth.changePassword(req,res,{currentPassword,newPassword});}
    catch(error){
      // A failure validating a rotated provider session can follow a committed
      // change. Only explicit validation/current-password rejections are safe
      // to restore to issued; all other outcomes keep the account restricted.
      const ambiguous=![400,403].includes(error.status);
      await db.transaction(async()=>{await lock(req.user.id);await db.prepare("UPDATE password_reset_operations SET status=?,updated_at=? WHERE operation_id=? AND status='changing'").run(ambiguous?'unknown':'issued',now(),op.operation_id);});
      throw ambiguous?uncertain():error;
    }
    const completed=await db.transaction(async()=>{
      await lock(req.user.id);const user=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(req.user.id);
      const current=await db.prepare('SELECT * FROM password_reset_operations WHERE operation_id=? FOR UPDATE').get(op.operation_id);
      if(!user||user.disabled||user.account_status!=='approved'||user.auth_user_id!==op.auth_user_id||user.password_reset_operation_id!==op.operation_id||current?.status!=='changing')return false;
      await db.prepare('UPDATE users SET password_change_required=FALSE,password_reset_operation_id=NULL,password_reset_expires_at=NULL WHERE id=?').run(user.id);
      await db.prepare("UPDATE password_reset_operations SET status='completed',updated_at=? WHERE operation_id=?").run(now(),op.operation_id);
      await permissions.audit(user,'password-recovery.completed','user',user.id,{operation_id:op.operation_id});return true;
    });
    if(!completed){
      // changePassword may have rotated the cookie; revoking only the original
      // request cookie would leave the newly created provider session usable.
      await db.prepare('UPDATE users SET auth_revoked_at=?,session_version=session_version+1 WHERE id=?').run(now(),req.user.id);
      endUserStreams(req.user.id);
      try{await auth.revokeUserSessions(req,op.auth_user_id);}catch{/* Durable local cutoff independently revokes every application session. */}
      await auth.signOut(req,res);throw uncertain();
    }
    endUserStreams(req.user.id);
    res.json({ok:true,user:await selfUser(await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))});
  });
}
