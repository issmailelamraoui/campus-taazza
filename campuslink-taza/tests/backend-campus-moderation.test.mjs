import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';

let env,server,origin,appointment;const cookies=new Map(),reports={},secret='Private CloseRoom exchange '+randomUUID();
async function request(path,{user=6,method='GET',body}={}){const response=await fetch(origin+'/api'+path,{method,headers:{cookie:cookies.get(user)||'',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};}
async function report(type,target,faculty='flaa'){return env.db.prepare("INSERT INTO campus_reports(faculty_id,reporter_id,target_type,target_id,reason,created_at) VALUES(?,3,?,?,'Moderation metadata fixture',?) RETURNING *").get(faculty,type,target,new Date().toISOString());}
async function forum(filiere='french_studies',faculty='flaa',asker=3){const q=await env.db.prepare('INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,created_at) VALUES(?,?,?, ?,?,?) RETURNING *').get(faculty,filiere,asker,'Source question '+randomUUID(),'Question fixture',new Date(Date.now()-180000).toISOString());const a=await env.db.prepare('INSERT INTO campus_answers(question_id,author_id,body,created_at) VALUES(?,4,?,?) RETURNING id').get(q.id,'A concrete source explanation',new Date().toISOString());await env.db.prepare('UPDATE campus_questions SET accepted_answer_id=? WHERE id=?').run(a.id,q.id);return{q,a};}
async function credited(f){return env.db.prepare("INSERT INTO xp_events(user_id,category,event_key,points,details,created_at) VALUES(4,'contribution',?,5,?,?) RETURNING id").get(`forum:question:${f.q.id}:accepted`,JSON.stringify({question_id:f.q.id,answer_id:f.a.id,requester_id:f.q.author_id,evidence:'accepted_answer_and_independent_feedback'}),new Date().toISOString());}
before(async()=>{
 env=await createTestApp();await env.db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE user_id=6').run(new Date().toISOString());appointment=await env.db.prepare("INSERT INTO scoped_appointments(user_id,appointed_by,faculty_id,filiere_id,capabilities,created_at) VALUES(6,2,'flaa','french_studies',?,?) RETURNING id").get(JSON.stringify(['content.moderate']),new Date().toISOString());
 server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;for(const user of [2,3,4,6,8]){const row=await env.db.prepare('SELECT username FROM users WHERE id=?').get(user);const response=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:row.username,password:user===2?'Admin2026!':'Campus2026!'})});assert.equal(response.status,200);cookies.set(user,response.headers.getSetCookie().find(c=>c.startsWith('campus_neon_test_session=')).split(';')[0]);}
 const french=await forum(),arabic=await forum('arabic_studies','flaa',8),foreign=await forum('economics','feg',9);
 reports.question=await report('question',french.q.id);reports.answer=await report('answer',french.a.id);reports.arabic=await report('question',arabic.q.id);reports.spoof=await report('question',foreign.q.id);
 const roomRequest=await env.db.prepare("INSERT INTO close_requests(faculty_id,filiere_id,requester_id,title,topic,excerpt,created_at) VALUES('flaa','french_studies',3,'Private help','Topic',?,?) RETURNING id").get(secret,new Date().toISOString());
 const room=await env.db.prepare('INSERT INTO close_rooms(request_id,requester_id,helper_id,created_at) VALUES(?,3,4,?) RETURNING id').get(roomRequest.id,new Date().toISOString());await env.db.prepare('INSERT INTO close_messages(room_id,author_id,body,client_id,created_at) VALUES(?,3,?,?,?)').run(room.id,secret,randomUUID(),new Date().toISOString());reports.room=await report('room',room.id);
 for(const [name,seller]of [['listing',3],['arabicListing',8]]){const listing=await env.db.prepare("INSERT INTO market_listings(faculty_id,seller_id,title,body,category,created_at) VALUES('flaa',?,'Textbook','Public listing','books',?) RETURNING id").get(seller,new Date().toISOString());reports[name]=await report('listing',listing.id);}
});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await env?.close();});
test('filiere moderation sees only authorized Forum, room metadata and seller scopes while ordinary students cannot list reports',async()=>{
 const response=await request('/campus/reports');assert.equal(response.status,200,JSON.stringify(response.data));assert.deepEqual(response.data.reports.map(r=>r.id).sort((a,b)=>a-b),[reports.question.id,reports.answer.id,reports.room.id,reports.listing.id].sort((a,b)=>a-b));
 assert.equal((await request('/campus/reports',{user:4})).status,403);const owner=await request('/campus/reports',{user:2});assert.equal(owner.status,200);assert.ok(owner.data.reports.some(r=>r.id===reports.arabic.id));assert.ok(!owner.data.reports.some(r=>r.id===reports.spoof.id));
 for(const r of [reports.arabic,reports.arabicListing,reports.spoof])assert.equal((await request('/campus/reports/'+r.id,{method:'PATCH',body:{status:'resolved'}})).status,403);
 assert.equal((await request('/campus/reports/'+reports.question.id,{method:'PATCH',body:{status:'resolved'}})).status,200);
});
test('CloseRoom moderation remains metadata-only and a report never grants private room access or removal',async()=>{
 const response=await request('/campus/reports');assert.equal(JSON.stringify(response.data).includes(secret),false);const room=response.data.reports.find(r=>r.id===reports.room.id);for(const field of ['body','excerpt','participants','board','messages'])assert.equal(field in room,false);
 for(const user of [2,6])for(const suffix of ['','/replay'])assert.equal((await request('/campus/rooms/'+reports.room.target_id+suffix,{user})).status,404);
 assert.equal((await request('/campus/reports/'+reports.room.id,{method:'PATCH',body:{status:'resolved',remove:true}})).status,400);assert.equal((await request('/campus/reports/'+reports.room.id,{method:'PATCH',body:{status:'resolved',remove:'false'}})).status,400);
 assert.equal((await request('/campus/reports/'+reports.room.id,{method:'PATCH',body:{status:'dismissed'}})).status,200);
});
test('moderation permissions revoked after admission are rechecked inside the report transaction',async()=>{
 const prepare=env.db.prepare.bind(env.db);let signal,resume,timer;const paused=new Promise(resolve=>{signal=resolve;}),released=new Promise(resolve=>{resume=resolve;});
 env.db.prepare=sql=>{const statement=prepare(sql);return sql==='SELECT * FROM campus_reports WHERE id=? FOR UPDATE'?{...statement,get:async(...values)=>{signal();await released;return statement.get(...values);}}:statement;};
 try{const pending=request('/campus/reports/'+reports.listing.id,{method:'PATCH',body:{status:'resolved',remove:true}});await Promise.race([paused,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('No moderation boundary reached')),5000);})]);await env.db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE id=?').run(new Date().toISOString(),appointment.id);resume();assert.equal((await pending).status,403);assert.equal((await env.db.prepare('SELECT status FROM market_listings WHERE id=?').get(reports.listing.target_id)).status,'available');assert.equal((await env.db.prepare('SELECT status FROM campus_reports WHERE id=?').get(reports.listing.id)).status,'open');}
 finally{clearTimeout(timer);resume();env.db.prepare=prepare;await env.db.prepare('UPDATE scoped_appointments SET revoked_at=NULL WHERE id=?').run(appointment.id);}
});
test('removing a credited Forum question or answer revokes associated XP under the ranking lock and records the actual moderator',async()=>{
 for(const type of ['question','answer']){
  const f=await forum(),event=await credited(f),r=await report(type,type==='question'?f.q.id:f.a.id),prepare=env.db.prepare.bind(env.db),locks=[];
  env.db.prepare=sql=>{const statement=prepare(sql);return {...statement,get:async(...values)=>{if(sql==='SELECT pg_advisory_xact_lock(hashtext(?))'||/FOR UPDATE/.test(sql))locks.push({sql,value:values[0]});return statement.get(...values);}};};
  try{const response=await request('/campus/reports/'+r.id,{method:'PATCH',body:{status:'resolved',remove:true}});assert.equal(response.status,200,JSON.stringify(response.data));}finally{env.db.prepare=prepare;}
  assert.equal(locks[0].sql,'SELECT pg_advisory_xact_lock(hashtext(?))');assert.equal(locks[0].value,'campuslink:xp-ranking:flaa:french_studies');assert.equal((await env.db.prepare('SELECT status FROM xp_events WHERE id=?').get(event.id)).status,'revoked');
  const audit=await env.db.prepare("SELECT actor_id,details FROM administrative_audit WHERE action='campus.report-moderate' AND details->>'report_id'=?").get(String(r.id));assert.equal(audit.actor_id,6);assert.deepEqual(audit.details.revoked_xp_event_ids,[event.id]);
  if(type==='answer')assert.equal((await env.db.prepare('SELECT accepted_answer_id FROM campus_questions WHERE id=?').get(f.q.id)).accepted_answer_id,null);
  assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM xp_events WHERE event_key=?').get(`forum:question:${f.q.id}:accepted`)).n),1,'Revoked event keys survive and cannot be earned again');
 }
 const xp=await request('/xp',{user:4});assert.equal(xp.status,200);assert.equal(xp.data.achievements.find(a=>a.id==='community_hero').earned,false);
});
