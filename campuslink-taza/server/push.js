import {createHash,createECDH,ECDH,randomUUID} from 'node:crypto';
import {createRateLimiter} from './rate-limit.js';

const failure=(status,message,code)=>Object.assign(new Error(message),{status,...(code?{code}:{})});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const iso=value=>new Date(value).toISOString();
const eligible=user=>!!user&&!user.disabled&&user.account_status==='approved'&&!!user.faculty_id;
const version=user=>Number(user.session_version??0);
const integer=(value,fallback,min,max)=>Number.isSafeInteger(value)?Math.max(min,Math.min(max,value)):fallback;

function keyBytes(value,length){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(value))return null;
  const bytes=Buffer.from(value,'base64url');
  return bytes.length===length&&bytes.toString('base64url')===value.replace(/=+$/,'')?bytes:null;
}
function publicPoint(value){
  const bytes=keyBytes(value,65);
  if(!bytes||bytes[0]!==4)return null;
  try{return ECDH.convertKey(bytes,'prime256v1',undefined,undefined,'uncompressed');}catch{return null;}
}

export function webPushConfiguration(input={}){
  const publicKey=input.publicKey??process.env.WEB_PUSH_PUBLIC_KEY??'';
  const privateKey=input.privateKey??process.env.WEB_PUSH_PRIVATE_KEY??'';
  const subject=input.subject??process.env.WEB_PUSH_SUBJECT??'';
  let enabled=false;
  if(input.enabled!==false&&publicPoint(publicKey)&&keyBytes(privateKey,32)&&typeof subject==='string'&&subject.length<=240){
    let subjectValid=/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject);
    try{const url=new URL(subject);subjectValid ||= url.protocol==='https:'&&!url.username&&!url.password&&!url.hash;}catch{}
    if(subjectValid)try{const pair=createECDH('prime256v1');pair.setPrivateKey(Buffer.from(privateKey,'base64url'));enabled=pair.getPublicKey().equals(Buffer.from(publicKey,'base64url'));}catch{}
  }
  return {enabled,publicKey:enabled?publicKey:null,privateKey:enabled?privateKey:null,subject:enabled?subject:null};
}

export function validatePushSubscription(value){
  const bad=()=>{throw failure(400,'Abonnement aux notifications invalide.','PUSH_SUBSCRIPTION_INVALID');};
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.endpoint!=='string'||value.endpoint.length>4096)return bad();
  let endpoint;
  try{endpoint=new URL(value.endpoint);}catch{return bad();}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.port||endpoint.search||endpoint.hash)return bad();
  const paths={
    'fcm.googleapis.com':/^\/fcm\/send\/[A-Za-z0-9_:~.+%=-]+$/,
    'updates.push.services.mozilla.com':/^\/wpush\/v[12]\/[A-Za-z0-9_:~.+%=-]+$/,
    'web.push.apple.com':/^\/[A-Za-z0-9_~.+%=-]+$/,
  };
  if(!Object.hasOwn(paths,endpoint.hostname)||!paths[endpoint.hostname].test(endpoint.pathname))return bad();
  if(!value.keys||!publicPoint(value.keys.p256dh)||!keyBytes(value.keys.auth,16))return bad();
  return {endpoint:endpoint.href,keys:{p256dh:value.keys.p256dh.replace(/=+$/,''),auth:value.keys.auth.replace(/=+$/,'')}};
}

async function defaultTransport(subscription,payload,options){
  const {default:webPush}=await import('web-push');
  return webPush.sendNotification(subscription,JSON.stringify(payload),{
    vapidDetails:options.vapidDetails,TTL:options.TTL,urgency:'normal',timeout:options.timeout,
  });
}

export function createWebPushService({db,configuration,transport=defaultTransport,loadUser,canDeliver,authorizeNotificationTarget,permissions,clock=Date.now,timeoutMs=5000,maxAttempts=5,types=['resources','questions','mentions','campus']}={}){
  if(!db||!/^[a-z][a-z0-9_]{0,62}$/.test(db.schema))throw new Error('A scoped application database is required.');
  const config=webPushConfiguration(configuration),subscriptions=`"${db.schema}"."push_subscriptions"`,outbox=`"${db.schema}"."push_outbox"`;
  const freshUser=loadUser||(async(id)=>{const user=await db.prepare('SELECT * FROM users WHERE id=?').get(id);return user&&permissions?permissions.load(user):user;});
  const authorize=canDeliver||authorizeNotificationTarget&&((user,notice)=>authorizeNotificationTarget(user,notice.path));
  const allowedTypes=new Set(types),attemptLimit=integer(maxAttempts,5,1,10),sendTimeout=integer(timeoutMs,5000,10,10000);
  let running;
  function expected(user,body){
    if(body?.expectedUserId!==undefined&&String(body.expectedUserId)!==String(user.id))throw failure(409,'Le compte actif a changé. Actualisez cette page.','PUSH_ACCOUNT_CHANGED');
  }
  function device(value){if(!uuid(value))throw failure(400,'Identifiant de cet appareil invalide.');return value.toLowerCase();}
  async function subscribe(user,body={}){
    expected(user,body);
    if(!config.enabled)throw failure(503,'Les notifications sur cet appareil ne sont pas encore configurées.','PUSH_NOT_CONFIGURED');
    const deviceId=device(body.deviceId),subscription=validatePushSubscription(body.subscription),endpointHash=digest(subscription.endpoint);
    return db.transaction(async()=>{
      const current=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(user.id);
      if(!eligible(current)||version(current)!==version(user))throw failure(403,'Votre accès au compte a changé.');
      // Stable lock ordering covers first inserts as well as endpoint rotation.
      for(const key of [`push:device:${current.id}:${deviceId}`,`push:endpoint:${endpointHash}`].sort())await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`${db.schema}:${key}`);
      const rows=await db.prepare(`SELECT * FROM ${subscriptions} WHERE (user_id=? AND device_id=?) OR endpoint_hash=? FOR UPDATE`).all(user.id,deviceId,endpointHash);
      if(rows.some(row=>row.user_id!==current.id||row.device_id!==deviceId))throw failure(409,'Cet abonnement appartient à un autre appareil ou compte. Désactivez-le puis réactivez-le.','PUSH_SUBSCRIPTION_BOUND');
      const prior=rows[0];
      if(prior&&prior.endpoint===subscription.endpoint&&prior.p256dh===subscription.keys.p256dh&&prior.auth===subscription.keys.auth&&prior.session_version===version(current)){
        await db.prepare(`UPDATE ${subscriptions} SET updated_at=?::timestamptz WHERE id=?`).run(iso(clock()),prior.id);
        return {ok:true,bindingId:prior.id};
      }
      if(!prior){const count=await db.prepare(`SELECT COUNT(*) AS total FROM ${subscriptions} WHERE user_id=?`).get(current.id);if(Number(count.total)>=20)throw failure(429,'Trop d’appareils sont déjà associés à ce compte.');}
      if(prior)await db.prepare(`DELETE FROM ${subscriptions} WHERE id=? AND user_id=?`).run(prior.id,current.id);
      const bindingId=randomUUID();
      await db.prepare(`INSERT INTO ${subscriptions}(id,user_id,device_id,endpoint,endpoint_hash,p256dh,auth,session_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?::timestamptz,?::timestamptz)`)
        .run(bindingId,current.id,deviceId,subscription.endpoint,endpointHash,subscription.keys.p256dh,subscription.keys.auth,version(current),iso(clock()),iso(clock()));
      return {ok:true,bindingId};
    });
  }
  async function status(user,body={}){
    expected(user,body);const deviceId=device(body.deviceId);
    const current=await freshUser(user.id);
    if(!config.enabled||!eligible(current)||version(current)!==version(user))return {enabled:config.enabled,active:false,bindingId:null};
    const row=await db.prepare(`SELECT id,endpoint,p256dh,auth,session_version FROM ${subscriptions} WHERE user_id=? AND device_id=?`).get(current.id,deviceId);
    let active=!!row&&row.session_version===version(current)&&(!body.bindingId||body.bindingId===row.id);
    if(body.subscription){const sub=validatePushSubscription(body.subscription);active &&= row.endpoint===sub.endpoint&&row.p256dh===sub.keys.p256dh&&row.auth===sub.keys.auth;}
    return {enabled:config.enabled,active,bindingId:active?row.id:null};
  }
  async function revokeDevice(userId,deviceId,bindingId){
    deviceId=device(deviceId);
    if(bindingId!==undefined&&!uuid(bindingId))throw failure(400,'Association de cet appareil invalide.');
    return db.prepare(`DELETE FROM ${subscriptions} WHERE user_id=? AND device_id=?${bindingId===undefined?'':' AND id=?'}`).run(userId,deviceId,...(bindingId===undefined?[]:[bindingId]));
  }
  async function revokeUser(userId){return db.prepare(`DELETE FROM ${subscriptions} WHERE user_id=?`).run(userId);}
  async function unsubscribe(user,body={}){expected(user,body);if(!uuid(body.bindingId))throw failure(400,'Association de cet appareil invalide.');await revokeDevice(user.id,body.deviceId,body.bindingId);return {ok:true};}
  async function complete(job,state,error=null,retryAt=null){
    await db.prepare(`UPDATE ${outbox} SET state=?,last_error=?,available_at=COALESCE(?::timestamptz,available_at),lease_until=NULL,lease_token=NULL,completed_at=?::timestamptz WHERE id=? AND lease_token=?`)
      .run(state,error,retryAt,state==='pending'?null:iso(clock()),job.id,job.lease_token);
  }
  async function claim(){
    const stamp=iso(clock()),lease=randomUUID();
    return db.transaction(async()=>{
      // Subscription first, then its job: unsubscribe uses the same ordering
      // through its cascading foreign key. Never hold a job while waiting for
      // a subscription being removed in another request.
      const target=await db.prepare(`SELECT device.id FROM ${subscriptions} device JOIN ${outbox} candidate ON candidate.subscription_id=device.id
        WHERE candidate.expires_at>?::timestamptz AND candidate.attempts<? AND candidate.available_at<=?::timestamptz
          AND (candidate.state='pending' OR (candidate.state='sending' AND candidate.lease_until<=?::timestamptz))
          AND NOT EXISTS (SELECT 1 FROM ${outbox} busy WHERE busy.subscription_id=candidate.subscription_id AND busy.state='sending' AND busy.lease_until>?::timestamptz)
        ORDER BY candidate.available_at,candidate.id FOR UPDATE OF device SKIP LOCKED LIMIT 1`).get(stamp,attemptLimit,stamp,stamp,stamp);
      if(!target)return;
      // A second statement sees any lease committed just before the device
      // lock was acquired, rather than relying on the first query's snapshot.
      return db.prepare(`WITH next AS (SELECT candidate.id FROM ${outbox} candidate
        WHERE candidate.subscription_id=? AND candidate.expires_at>?::timestamptz AND candidate.attempts<? AND candidate.available_at<=?::timestamptz
          AND (candidate.state='pending' OR (candidate.state='sending' AND candidate.lease_until<=?::timestamptz))
          AND NOT EXISTS (SELECT 1 FROM ${outbox} busy WHERE busy.subscription_id=candidate.subscription_id AND busy.state='sending' AND busy.lease_until>?::timestamptz)
        ORDER BY candidate.available_at,candidate.id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE ${outbox} job SET state='sending',attempts=job.attempts+1,lease_token=?,lease_until=?::timestamptz FROM next WHERE job.id=next.id RETURNING job.*`)
        .get(target.id,stamp,attemptLimit,stamp,stamp,stamp,lease,iso(clock()+30000));
    });
  }
  async function deliver(job){
    const row=await db.prepare(`SELECT s.*,n.id AS notification_id,n.user_id AS notification_user_id,n.faculty_id,n.type,n.title,n.body,n.path,n.read,n.target_deleted,n.push_eligible,n.push_context FROM ${subscriptions} s JOIN notifications n ON n.id=? WHERE s.id=?`).get(job.notification_id,job.subscription_id);
    const user=row?await freshUser(row.user_id):null;
    let allowed=!!row&&eligible(user)&&row.notification_user_id===user.id&&row.faculty_id===user.faculty_id&&row.session_version===version(user)&&!row.read&&!row.target_deleted&&row.push_eligible&&allowedTypes.has(row.type);
    if(allowed){
      let prefs;
      try{prefs=typeof user.preferences==='string'?JSON.parse(user.preferences):user.preferences||{};}catch{allowed=false;}
      if(allowed)allowed=prefs[row.type]!==false&&!!authorize&&await authorize(user,{...row,id:row.notification_id});
    }
    if(!allowed){await complete(job,'skipped','not_eligible');return 'skipped';}
    let subscription;
    try{subscription=validatePushSubscription({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}});}catch{await db.prepare(`DELETE FROM ${subscriptions} WHERE id=?`).run(row.id);return 'expired';}
    const payload={notificationId:row.notification_id,bindingId:row.id,type:row.type,title:String(row.title).slice(0,160),body:String(row.body).slice(0,240),path:row.path};
    if(typeof payload.path!=='string'||payload.path.length>2000||!payload.path.startsWith('/app')||payload.path.startsWith('//')){await complete(job,'skipped','invalid_target');return 'skipped';}
    let timer;
    try{
      await Promise.race([Promise.resolve().then(()=>transport(subscription,payload,{
        vapidDetails:{subject:config.subject,publicKey:config.publicKey,privateKey:config.privateKey},
        TTL:Math.max(1,Math.min(86400,Math.ceil((new Date(job.expires_at).getTime()-clock())/1000))),timeout:sendTimeout,
      })),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Push transport timeout.'),{code:'PUSH_TIMEOUT'})),sendTimeout);})]);
      await complete(job,'sent');return 'sent';
    }catch(error){
      const status=Number(error?.statusCode||error?.status);
      if(status===404||status===410){await db.prepare(`DELETE FROM ${subscriptions} WHERE id=?`).run(row.id);return 'expired';}
      const transient=!Number.isFinite(status)||status===408||status===425||status===429||status>=500;
      const reason=Number.isFinite(status)?`http_${status}`:error?.code==='PUSH_TIMEOUT'?'timeout':'transport';
      if(transient&&job.attempts<attemptLimit){
        const header=error?.headers?.['retry-after'];let delay=Number(header)*1000;
        if(!Number.isFinite(delay)||delay<1000)delay=Math.min(3600000,30000*2**(job.attempts-1));
        await complete(job,'pending',reason,iso(clock()+Math.min(3600000,delay)));return 'retried';
      }
      await complete(job,'failed',reason);return 'failed';
    }finally{clearTimeout(timer);}
  }
  async function drain({limit=20,budgetMs=8000}={}){
    const counts={processed:0,sent:0,skipped:0,failed:0,retried:0,expired:0};
    if(!config.enabled)return counts;
    // This cleanup is its own statement: no job lock crosses into the
    // subscription-first claim transaction below.
    const stamp=iso(clock());
    // Keep this delivery journal bounded even when an unread inbox notice is
    // retained indefinitely. Small batches avoid turning a wake into a sweep.
    await db.prepare(`WITH stale AS (SELECT id FROM ${outbox} WHERE state IN ('sent','skipped','failed') AND completed_at<?::timestamptz ORDER BY completed_at,id FOR UPDATE SKIP LOCKED LIMIT 500)
      DELETE FROM ${outbox} job USING stale WHERE job.id=stale.id`).run(iso(clock()-7*86400000));
    await db.prepare(`WITH stale AS (SELECT s.id FROM ${subscriptions} s JOIN users u ON u.id=s.user_id WHERE u.disabled<>0 OR u.account_status<>'approved' OR u.session_version<>s.session_version FOR UPDATE OF s SKIP LOCKED LIMIT 500)
      DELETE FROM ${subscriptions} device USING stale WHERE device.id=stale.id`).run();
    await db.prepare(`UPDATE ${outbox} SET state='failed',last_error='expired',completed_at=?::timestamptz,lease_until=NULL,lease_token=NULL WHERE state IN ('pending','sending') AND (expires_at<=?::timestamptz OR attempts>=?) AND (lease_until IS NULL OR lease_until<=?::timestamptz)`)
      .run(stamp,stamp,attemptLimit,stamp);
    const deadline=Date.now()+integer(budgetMs,8000,10,45000),bound=integer(limit,20,1,200);
    let reserved=0;
    async function worker(){
      while(reserved<bound&&Date.now()<deadline){
        reserved++;
        const job=await claim();if(!job)break;
        // Network work happens after the claim transaction commits; another
        // instance can claim a different device while this request is in flight.
        let result;
        try{result=await deliver(job);}catch{
          const retry=job.attempts<attemptLimit;
          await complete(job,retry?'pending':'failed','delivery',retry?iso(clock()+30000):null);
          result=retry?'retried':'failed';
        }
        counts.processed++;counts[result]++;
      }
    }
    await Promise.all(Array.from({length:Math.min(4,bound)},worker));
    return counts;
  }
  function dispatch(options){if(running)return running;running=drain(options).finally(()=>{running=undefined;});return running;}
  return {configured:config.enabled,publicKey:config.publicKey,subscribe,status,unsubscribe,revokeDevice,revokeUser,dispatch};
}

export function installWebPush(app,options){
  const service=createWebPushService(options),limiter=createRateLimiter({limit:60,windowMs:60000,message:'Trop de demandes de notifications. Réessayez dans un instant.'});
  const guard=(req,_res,next)=>{if(req.body?.expectedUserId===undefined)return next(failure(400,'Le compte attendu est requis.'));limiter.take(req.user.id);next();};
  app.get('/api/push/config',options.requireFaculty,(_req,res)=>res.json({enabled:service.configured,publicKey:service.publicKey}));
  app.post('/api/push/subscriptions',options.requireFaculty,guard,async(req,res)=>res.json(await service.subscribe(req.user,req.body)));
  app.post('/api/push/subscriptions/status',options.requireFaculty,guard,async(req,res)=>res.json(await service.status(req.user,req.body)));
  app.delete('/api/push/subscriptions',options.requireFaculty,guard,async(req,res)=>res.json(await service.unsubscribe(req.user,req.body)));
  return service;
}
