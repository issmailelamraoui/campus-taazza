import {randomUUID} from 'node:crypto';
import {verifiedIndexedPageCount} from './document-search.js';

export const READING_ACTIVITY_RULES=Object.freeze({heartbeatSeconds:15,minimumSeconds:60,dailyCap:10,pointsPerPage:1,minHeartbeatSeconds:10,maxHeartbeatSeconds:30,sessionMinutes:15});
const failure=(status,message,code)=>Object.assign(new Error(message),{status,...(code?{code}:{})});
const integer=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw failure(400,'Page ou version invalide.');return n;};
const iso=milliseconds=>new Date(milliseconds).toISOString();
const day=milliseconds=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Casablanca',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(milliseconds));
const eligible=user=>user&&!user.disabled&&user.account_status==='approved'&&['student','faculty_leader'].includes(user.role);
const educational=row=>row.mime==='application/pdf'&&row.library_visible!==0&&(['courses','td','exercises'].includes(row.resource_type||row.category)||['cours','exercise'].includes(row.resource_type));

export function installReadingActivityRoutes(app,{db,requireFaculty,assertResource,broadcast}) {
  const rules=READING_ACTIVITY_RULES;
  const activityLock=user=>db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:reading-activity:${user.id}`);
  async function resource(req){
    if(!eligible(req.user))throw failure(403,'Les petites récompenses de lecture sont réservées aux comptes étudiants actifs.');
    const row=await assertResource(req.params.resourceId,req);
    if(!educational(row))throw failure(400,'Seuls les PDF de cours ou TD partagés dans la bibliothèque sont éligibles.');
    const pageCount=await verifiedIndexedPageCount(db,row);
    if(!pageCount)throw failure(409,'Préparez explicitement l’index du PDF pour vérifier ses pages avant d’activer les petites récompenses.','DOCUMENT_INDEX_REQUIRED');
    return {row,pageCount};
  }
  async function daily(userId,timestamp){
    const result=await db.prepare("SELECT COALESCE(SUM(points),0) AS points FROM xp_events WHERE user_id=? AND category='reading' AND status='valid' AND (created_at::timestamptz AT TIME ZONE 'Africa/Casablanca')::date=?::date").get(userId,day(timestamp));
    return Number(result.points);
  }
  app.post('/api/reading-activity/:resourceId/start',requireFaculty,async(req,res)=>{
    const {row,pageCount}=await resource(req),page=integer(req.body.page),version=integer(req.body.version);
    if(version!==row.version)throw failure(409,'Le document a changé. Rouvrez sa version actuelle.');
    if(page>pageCount)throw failure(400,'Cette page n’existe pas dans le PDF vérifié.');
    const timestamp=Date.now(),token=randomUUID(),expires=iso(timestamp+rules.sessionMinutes*60000);
    await db.transaction(async()=>{
      await activityLock(req.user);
      await db.prepare('INSERT INTO reading_activity_sessions(user_id,token,resource_id,document_version,page,page_count,qualified_seconds,started_at,last_ping,expires_at) VALUES(?,?,?,?,?,?,0,?,?,?) ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,resource_id=excluded.resource_id,document_version=excluded.document_version,page=excluded.page,page_count=excluded.page_count,qualified_seconds=0,started_at=excluded.started_at,last_ping=excluded.last_ping,expires_at=excluded.expires_at').run(req.user.id,token,row.id,version,page,pageCount,iso(timestamp),iso(timestamp),expires);
    });
    res.status(201).json({session_token:token,heartbeat_seconds:rules.heartbeatSeconds,minimum_seconds:rules.minimumSeconds,page_count:pageCount,expires_at:expires,daily_cap:rules.dailyCap,points_per_page:rules.pointsPerPage});
  });
  app.post('/api/reading-activity/:resourceId/heartbeat',requireFaculty,async(req,res)=>{
    const {row,pageCount}=await resource(req),page=integer(req.body.page),token=req.body.session_token;
    if(typeof token!=='string'||token.length!==36||typeof req.body.visible!=='boolean'||typeof req.body.recent_interaction!=='boolean')throw failure(400,'Signal de lecture invalide.');
    if(page>pageCount)throw failure(400,'Cette page n’existe pas dans le PDF vérifié.');
    const outcome=await db.transaction(async()=>{
      await activityLock(req.user);
      const session=await db.prepare('SELECT * FROM reading_activity_sessions WHERE user_id=? FOR UPDATE').get(req.user.id),timestamp=Date.now();
      if(!session||session.token!==token||session.resource_id!==row.id)throw failure(409,'Cette session de lecture a été remplacée.','READING_SESSION_REPLACED');
      if(session.document_version!==row.version||session.page_count!==pageCount)throw failure(409,'Le document a changé. Rouvrez sa version actuelle.');
      if(Date.parse(session.expires_at)<timestamp)throw failure(410,'La session de lecture a expiré. Rouvrez le document.');
      const elapsed=(timestamp-Date.parse(session.last_ping))/1000;
      const active=req.body.visible&&req.body.recent_interaction,pageChanged=page!==session.page;
      if(active&&!pageChanged&&elapsed<rules.minHeartbeatSeconds)throw Object.assign(failure(429,'Attendez le prochain point de lecture.'),{retryAfter:Math.ceil(rules.minHeartbeatSeconds-elapsed)});
      let seconds=active&&!pageChanged&&elapsed<=rules.maxHeartbeatSeconds?Math.min(rules.minimumSeconds,session.qualified_seconds+Math.floor(Math.max(0,elapsed))):0;
      let status=pageChanged?'page_changed':!active?'paused':elapsed>rules.maxHeartbeatSeconds?'restarted':'active',awarded=0;
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${req.user.faculty_id}:${req.user.filiere_id}`);
      const actor=await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(req.user.id);
      if(!eligible(actor)||actor.faculty_id!==req.user.faculty_id||actor.filiere_id!==req.user.filiere_id)throw failure(403,'Votre compte ou votre filière a changé.');
      // Scope is rechecked after obtaining the ranking/account locks as well.
      await db.prepare('SELECT id FROM resources WHERE id=? AND removed=0 FOR SHARE').get(row.id);
      const locked=await assertResource(row.id,{...req,user:actor});
      if(!educational(locked)||locked.version!==row.version||locked.sha256!==row.sha256)throw failure(409,'Le document a changé. Rouvrez sa version actuelle.');
      let today=await daily(actor.id,timestamp);
      const eventKey=`reading:${row.id}:v${row.version}:p${page}`;
      const previous=await db.prepare('SELECT id FROM xp_events WHERE user_id=? AND event_key=?').get(actor.id,eventKey);
      if(previous){status='already_rewarded';seconds=0;}
      else if(today>=rules.dailyCap){status='daily_cap';seconds=0;}
      else if(seconds>=rules.minimumSeconds){
        const event=await db.prepare("INSERT INTO xp_events(user_id,category,event_key,points,details,created_at) VALUES(?,'reading',?,?,?,?) ON CONFLICT(user_id,event_key) DO NOTHING RETURNING id").get(actor.id,eventKey,rules.pointsPerPage,JSON.stringify({resource_id:row.id,document_version:row.version,page,qualified_seconds:rules.minimumSeconds,evidence:'bounded_visible_reading_opportunity',not_comprehension_proof:true}),iso(timestamp));
        awarded=event?rules.pointsPerPage:0;today+=awarded;status=awarded?'rewarded':'already_rewarded';seconds=0;
      }
      await db.prepare('UPDATE reading_activity_sessions SET page=?,qualified_seconds=?,last_ping=?,expires_at=? WHERE user_id=? AND token=?').run(page,seconds,iso(timestamp),iso(timestamp+rules.sessionMinutes*60000),actor.id,token);
      return {qualified_seconds:seconds,awarded,status,page,page_count:pageCount,daily_remaining:Math.max(0,rules.dailyCap-today)};
    });
    if(outcome.awarded)await broadcast(req.user.faculty_id,req.user.filiere_id);
    res.json(outcome);
  });
  app.post('/api/reading-activity/:resourceId/end',requireFaculty,async(req,res)=>{
    // An old device's departure must never cancel a newer device's session.
    const token=req.body.session_token;
    if(typeof token!=='string'||token.length!==36)throw failure(400,'Session invalide.');
    await assertResource(req.params.resourceId,req);
    await db.prepare('DELETE FROM reading_activity_sessions WHERE user_id=? AND token=? AND resource_id=?').run(req.user.id,token,integer(req.params.resourceId));
    res.json({ok:true});
  });
}
