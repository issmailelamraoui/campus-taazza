import {getFilieres} from '../shared/studies.js';
export const CAPABILITIES=['content.moderate','resource.manage','resource.upload','announcement.publish','student.support','student.admit','feedback.manage','channel.manage'];
const error=message=>Object.assign(new Error(message),{status:403});
export async function createPermissions(db) {
  let newlyBound=false;
  await db.transaction(async()=>{
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('campuslink:owner:'+db.schema);
    const existing=await db.prepare('SELECT user_id FROM platform_owner WHERE singleton=TRUE').get();
    if(!existing){
      const candidates=await db.prepare("SELECT id FROM users WHERE role='global_admin' AND account_status<>'deleted' ORDER BY id").all();
      if(candidates.length===1){newlyBound=true;await db.prepare('INSERT INTO platform_owner(singleton,user_id,established_at) VALUES(TRUE,?,?) ON CONFLICT DO NOTHING').run(candidates[0].id,new Date().toISOString());}
    }
    const owner=await db.prepare('SELECT user_id FROM platform_owner WHERE singleton=TRUE').get();
    if(owner&&newlyBound){
      // A fresh disposable/demo seed is inserted after migrations. Existing
      // installations were grandfathered by migration 012 exactly once.
      const users=await db.prepare("SELECT id,role,faculty_id FROM users WHERE role IN('faculty_admin','moderator') AND faculty_id IS NOT NULL").all();
      for(const user of users){
        if(await db.prepare('SELECT 1 FROM scoped_appointments WHERE user_id=? LIMIT 1').get(user.id))continue;
        // Only pre-existing legacy roles are converted during first owner binding.
        // Revoked appointments are deliberately never recreated.
        const caps=user.role==='moderator'?['content.moderate']:['content.moderate','resource.manage','announcement.publish','student.support','feedback.manage','channel.manage'];
        await db.prepare('INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,capabilities,created_at) VALUES(?,?,?,?,?)').run(user.id,owner.user_id,user.faculty_id,JSON.stringify(caps),new Date().toISOString());
      }
    }
  });
  const ownerRow=await db.prepare('SELECT user_id FROM platform_owner WHERE singleton=TRUE').get();
  const isOwner=user=>!!user&&user.id===ownerRow?.user_id;
  async function load(user){
    if(!user)return user;
    let passwordResetState=null;
    if(user.password_change_required){const operation=await db.prepare('SELECT status FROM password_reset_operations WHERE operation_id=?').get(user.password_reset_operation_id);passwordResetState=operation?.status==='issued'&&new Date(user.password_reset_expires_at).getTime()<=Date.now()?'expired':operation?.status==='changing'?'pending':operation?.status||'unknown';}
    const [appointments,standing]=await Promise.all([
      db.prepare('SELECT * FROM scoped_appointments WHERE user_id=? AND revoked_at IS NULL').all(user.id),
      // Return one summary instead of sending the entire programme ranking to
      // Node for every authenticated request. Ties and local revocations still
      // use the current ledger rather than a cached privilege decision.
      db.prepare(`WITH totals AS (
        SELECT u.id,COALESCE(SUM(e.points),0) AS xp,
          COALESCE(SUM(e.points) FILTER(WHERE e.details->>'evidence' IS DISTINCT FROM 'published_library_file'),0) AS upload_xp FROM users u
        LEFT JOIN xp_events e ON e.user_id=u.id AND e.status='valid'
        WHERE u.faculty_id=? AND u.filiere_id=? AND u.role IN('student','faculty_leader')
          AND u.disabled=0 AND u.account_status='approved' GROUP BY u.id
      ) SELECT COALESCE(MAX(upload_xp),0) AS highest,
        COALESCE(MAX(xp) FILTER(WHERE id=?),(SELECT SUM(points) FROM xp_events WHERE user_id=? AND status='valid'),0) AS xp,
        COALESCE(MAX(upload_xp) FILTER(WHERE id=?),0) AS upload_xp,
        COALESCE(BOOL_OR(id=?),FALSE) AS eligible FROM totals`).get(user.faculty_id,user.filiere_id,user.id,user.id,user.id,user.id),
    ]);
    const own=Number(standing.xp),highest=Number(standing.highest);
    // Publishing files counts towards XP and the ranking, while upload rights
    // remain based on the pre-existing independently validated activities.
    return {...user,password_reset_state:passwordResetState,appointments,validated_xp:own,xp_upload_leader:standing.eligible&&highest>0&&Number(standing.upload_xp)===highest,owner:isOwner(user)};
  }
  function can(user,capability,facultyId,filiereId=null){
    if(isOwner(user))return true;
    return !!user?.appointments?.some(a=>a.faculty_id===facultyId&&(!a.filiere_id||a.filiere_id===filiereId)&&a.capabilities.includes(capability));
  }
  function uploadCapabilities(user){
    const scopes=[];let source='study_year';
    if(isOwner(user)){source='owner';for(const f of [user.faculty_id])for(const p of getFilieres(f))scopes.push({facultyId:f,filiereId:p.id,semesters:[1,2,3,4,5,6]});}
    else {
      for(const appointment of user.appointments||[])if(appointment.capabilities.includes('resource.upload')&&appointment.filiere_id){source='appointment';scopes.push({facultyId:appointment.faculty_id,filiereId:appointment.filiere_id,semesters:[1,2,3,4,5,6]});}
      if(user.filiere_id){const first=Math.floor((Number(user.current_semester)-1)/2)*2+1;const leader=user.xp_upload_leader&&['student','faculty_leader'].includes(user.role);if(leader&&source==='study_year')source='xp_leader';scopes.push({facultyId:user.faculty_id,filiereId:user.filiere_id,semesters:leader?[1,2,3,4,5,6]:[first,first+1]});}
    }
    return {scopes,source};
  }
  async function facultyStanding(faculty){
    const rows=await db.prepare("SELECT u.id,u.name,u.username,u.avatar,u.filiere_id,u.preferences,COALESCE(SUM(e.points) FILTER(WHERE e.status='valid' AND e.category<>'practice'),0) AS academic_xp,COALESCE(SUM(e.points) FILTER(WHERE e.status='valid' AND e.category='practice'),0) AS practice_xp FROM users u LEFT JOIN xp_events e ON e.user_id=u.id WHERE u.faculty_id=? AND u.role IN('student','faculty_leader') AND u.disabled=0 AND u.account_status='approved' GROUP BY u.id").all(faculty);
    const ordered=rows.filter(r=>JSON.parse(r.preferences).ranking!==false).map(({preferences,...r})=>({...r,xp:Number(r.academic_xp)+Number(r.practice_xp),ranking_score:Number(r.academic_xp)+Math.min(Number(r.practice_xp),Math.floor(Number(r.academic_xp)/4))})).sort((a,b)=>b.ranking_score-a.ranking_score||a.id-b.id);
    let rank=0,previous=null;
    return ordered.map((row,index)=>{if(row.ranking_score!==previous){rank=index+1;previous=row.ranking_score;}return {...row,rank};});
  }
  async function assertUpload(user,faculty,filiere,semester){
    const snapshot=await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if(!snapshot)throw error('Votre compte ne peut plus publier.');
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${snapshot.faculty_id}:${snapshot.filiere_id}`);
    const current=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(user.id);
    if(!current||current.disabled||current.account_status!=='approved'||current.faculty_id!==snapshot.faculty_id||current.filiere_id!==snapshot.filiere_id)throw error('Votre compte ou votre filière a changé. Rechargez avant de publier.');
    const fresh=await load(current);
    if(!uploadCapabilities(fresh).scopes.some(s=>s.facultyId===faculty&&s.filiereId===filiere&&s.semesters.includes(semester)))throw error('Vous pouvez publier uniquement dans votre filière et les semestres de votre année autorisée.');
    return fresh;
  }
  async function assertManage(actor,target){
    if(isOwner(target)){if(!isOwner(actor)||actor.id!==target.id)throw error('Vous ne pouvez pas gérer ce compte.');return;}
    if(isOwner(actor))return;
    const protectedRole=['global_admin','faculty_admin','faculty_leader'].includes(target.role)||!!await db.prepare('SELECT 1 FROM scoped_appointments WHERE user_id=? AND revoked_at IS NULL').get(target.id);
    if(protectedRole||!can(actor,'student.support',target.faculty_id,target.filiere_id))throw error('Seul le propriétaire peut gérer les comptes protégés.');
  }
  async function audit(actor,action,targetType,targetId,details={}){
    await db.prepare('INSERT INTO administrative_audit(actor_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?)').run(actor.id,action,targetType,targetId===null?null:String(targetId),JSON.stringify(details),new Date().toISOString());
  }
  return {isOwner,load,can,uploadCapabilities,assertUpload,assertManage,audit,facultyStanding};
}
