import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';

let env,server,origin;const cookies={};
async function request(path,{user='yassine',method='GET',body}={}){
 const response=await fetch(origin+'/api'+path,{method,headers:{cookie:cookies[user]||'',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json(),cookie:response.headers.getSetCookie().find(c=>c.startsWith('campus_neon_test_session='))?.split(';')[0]};
}
async function pending({expired=false,requester=3}={}){return env.db.prepare("INSERT INTO close_requests(faculty_id,filiere_id,requester_id,title,topic,created_at,expires_at) VALUES('flaa','french_studies',?,'Private help','Explain the citation',?,?) RETURNING *").get(requester,new Date().toISOString(),new Date(Date.now()+(expired?-1:7)*86400000).toISOString());}
async function room(){const q=await pending();const r=await request('/campus/close-requests/'+q.id+'/accept',{user:'sara',method:'POST',body:{}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.room;}
const block=(user='yassine',peer=4)=>request('/campus/blocks/'+peer,{user,method:'POST',body:{}});
before(async()=>{env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;for(const user of ['yassine','sara','omar','nour','admin']){const r=await request('/login',{method:'POST',body:{username:user,password:user==='admin'?'Admin2026!':'Campus2026!'}});assert.equal(r.status,200,JSON.stringify(r.data));cookies[user]=r.cookie;}});
beforeEach(async()=>{await env.db.prepare('DELETE FROM campus_blocks').run();});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await env?.close();});

test('blocks are directional, private, owner-controlled, and remain effective until both owners unblock',async()=>{
 assert.equal((await block('yassine',3)).status,403);
 assert.equal((await block('yassine',6)).status,404,'foreign filiere cannot be targeted without a previous private room');
 assert.equal((await block('admin',3)).status,403);
 for(let i=0;i<2;i++)assert.equal((await block()).status,200);
 const own=(await request('/campus/blocks')).data.blocks;assert.equal(own.length,1);assert.equal(own[0].blocked_id,4);assert.equal('email' in own[0].user,false);
 for(const user of ['sara','omar','admin'])assert.deepEqual((await request('/campus/blocks',{user})).data.blocks,[]);
 assert.equal((await request('/campus/blocks/3',{user:'sara',method:'DELETE'})).status,200,'cannot remove the other participant’s direction');
 assert.equal((await request('/campus/blocks')).data.blocks.length,1);
 assert.equal((await block('sara',3)).status,200);
 assert.equal((await request('/campus/blocks/4',{method:'DELETE'})).status,200);
 const q=await pending();assert.equal((await request('/campus/close-requests/'+q.id+'/accept',{user:'sara',method:'POST',body:{}})).status,403,'reverse direction still prevents accepting');
 await request('/campus/blocks/3',{user:'sara',method:'DELETE'});
 assert.equal((await request('/campus/close-requests/'+q.id+'/accept',{user:'sara',method:'POST',body:{}})).status,201);
});

test('pending CloseRoom requests are available only to eligible students in their current study scope',async()=>{
 const q=await pending();assert.equal((await request('/campus/close-requests',{user:'admin'})).status,403);
 assert.ok((await request('/campus/close-requests',{user:'sara'})).data.requests.some(row=>row.id===q.id));
 assert.ok(!(await request('/campus/close-requests',{user:'nour'})).data.requests.some(row=>row.id===q.id));
 await env.db.prepare("UPDATE users SET role='faculty_admin' WHERE id=4").run();
 try{assert.equal((await request('/campus/close-requests',{user:'sara'})).status,403,'a changed institutional role no longer participates');}finally{await env.db.prepare("UPDATE users SET role='student' WHERE id=4").run();}
});

test('blocking closes pair rooms, revokes recordings, preserves history and participant reports, and denies new exchanges',async()=>{
 const r=await room(),base='/campus/rooms/'+r.id;
 for(const user of ['yassine','sara'])assert.equal((await request(base+'/consent',{user,method:'POST',body:{consent:true}})).status,200);
 assert.equal((await request(base+'/recording',{method:'POST',body:{recording:true}})).status,200);
 assert.equal((await request(base+'/board',{method:'POST',body:{revision:0,operation:{type:'text',text:'Retain the study evidence',x:.2,y:.2}}})).status,201);
 assert.equal((await request(base+'/messages',{method:'POST',body:{body:'A retained discussion',client_id:randomUUID()}})).status,200);
 assert.equal((await block()).status,200);
 const stored=await env.db.prepare('SELECT * FROM close_rooms WHERE id=?').get(r.id);assert.ok(stored.closed_at);assert.equal(stored.recording,false);assert.equal(stored.requester_consent,false);assert.equal(stored.helper_consent,false);assert.equal(stored.recording_expires_at,null);
 assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS n FROM close_board WHERE room_id=? AND recorded=TRUE').get(r.id)).n,0);
 assert.equal((await env.db.prepare('SELECT close_reason FROM close_requests WHERE id=?').get(r.request_id)).close_reason,'blocked');
 for(const user of ['yassine','sara']){const history=await request(base,{user});assert.equal(history.status,200);assert.equal(history.data.messages.length,1);assert.equal(history.data.safety.blocked,true);assert.equal(history.data.safety.blocked_by_me,user==='yassine');assert.equal(history.data.board.length,1);
  assert.equal((await request(base+'/messages',{user,method:'POST',body:{body:'Blocked new message',client_id:randomUUID()}})).status,403);
  assert.equal((await request(base+'/board',{user,method:'POST',body:{revision:1,operation:{type:'clear'}}})).status,403);
  assert.equal((await request(base+'/consent',{user,method:'POST',body:{consent:true}})).status,403);
  assert.equal((await request(base+'/replay',{user})).status,403);
  assert.equal((await request('/campus/reports',{user,method:'POST',body:{target_type:'room',target_id:r.id,reason:'Please review the abusive conduct'}})).status,201);
 }
 assert.equal((await request(base+'/recording',{method:'POST',body:{recording:true}})).status,403);
 assert.equal((await request(base+'/rating',{method:'POST',body:{rating:'helpful'}})).status,403);
 for(const user of ['omar','admin'])assert.equal((await request(base,{user})).status,404);
 await request('/campus/blocks/4',{method:'DELETE'});
 assert.equal((await request(base+'/messages',{method:'POST',body:{body:'Old room remains closed',client_id:randomUUID()}})).status,409);
 assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS n FROM campus_reports WHERE target_type=\'room\' AND target_id=?').get(r.id)).n,2);
});

test('either-direction blocks hide pending help and study offers and decline match requests without notifying the blocked peer',async()=>{
 const q=await pending();await env.db.prepare("INSERT INTO study_matches(user_id,module,topic,availability,updated_at) VALUES(4,'Reading','Interpret a chapter','Afternoons',?)").run(new Date().toISOString());
 const match=await env.db.prepare('INSERT INTO study_match_requests(requester_id,recipient_id,created_at) VALUES(3,4,?) RETURNING id').get(new Date(Date.now()-60000).toISOString());
 const notices=(await env.db.prepare('SELECT COUNT(*)::integer AS n FROM notifications WHERE user_id=4').get()).n;
 assert.equal((await block('sara',3)).status,200);
 assert.ok(!(await request('/campus/close-requests',{user:'sara'})).data.requests.some(r=>r.id===q.id));
 assert.ok(!(await request('/campus/match')).data.offers.some(r=>r.user_id===4));
 assert.deepEqual((await request('/campus/match')).data.requests,[]);
 assert.equal((await request('/campus/match/4/request',{method:'POST',body:{}})).status,403);
 assert.equal((await request('/campus/match-requests/'+match.id,{user:'sara',method:'PATCH',body:{status:'accepted'}})).status,403);
 assert.equal((await env.db.prepare('SELECT status FROM study_match_requests WHERE id=?').get(match.id)).status,'declined');
 assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS n FROM notifications WHERE user_id=4').get()).n,notices);
});

test('seven-day cleanup durably expires abandoned open requests, never an accepted room, with private own expired history',async()=>{
 const expired=await pending({expired:true}),direct=await pending({expired:true}),live=await pending();
 const accepted=await room();await env.db.prepare('UPDATE close_requests SET expires_at=? WHERE id=?').run(new Date(Date.now()-86400000).toISOString(),accepted.request_id);
 const listing=await request('/campus/close-requests');assert.equal(listing.data.expiryDays,7);assert.ok(!listing.data.requests.some(r=>r.id===expired.id));assert.ok(listing.data.requests.some(r=>r.id===live.id));assert.ok(listing.data.expiredRequests.some(r=>r.id===expired.id));
 const row=await env.db.prepare('SELECT * FROM close_requests WHERE id=?').get(expired.id);assert.equal(row.status,'closed');assert.equal(row.close_reason,'expired');assert.equal(row.topic,'Explain the citation');
 assert.equal((await request('/campus/close-requests/'+direct.id+'/accept',{user:'sara',method:'POST',body:{}})).status,409);
 assert.equal((await env.db.prepare('SELECT status FROM close_requests WHERE id=?').get(accepted.request_id)).status,'accepted');
 assert.equal((await request('/campus/rooms/'+accepted.id)).status,200);
 assert.deepEqual((await request('/campus/close-requests',{user:'sara'})).data.expiredRequests,[]);
 await env.db.prepare('UPDATE close_requests SET created_at=? WHERE requester_id=3').run(new Date(Date.now()-120000).toISOString());
 const created=await request('/campus/close-requests',{method:'POST',body:{title:'New seven day request',topic:'Please explain this new citation'}});assert.equal(created.status,201,JSON.stringify(created.data));assert.ok(Math.abs(Date.parse(created.data.request.expires_at)-Date.parse(created.data.request.created_at)-7*86400000)<10000);
});

test('a committed block serializes against simultaneous acceptance and message writes',async()=>{
 const r=await room(),q=await pending(),base='/campus/rooms/'+r.id;
 const prepare=env.db.prepare;let release,inserted,attempted;const held=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{inserted=resolve}),queued=new Promise(resolve=>{attempted=resolve});let holding=false,waiters=0;
 // Authentication updates last_seen before handlers. The block holds peer rows
 // through commit, so concurrent authenticated requests first queue there.
 env.db.prepare=statement=>{const p=prepare(statement);if(statement.startsWith('INSERT INTO campus_blocks')){const run=p.run;p.run=async(...args)=>{const result=await run(...args);holding=true;inserted();await held;return result;};}else if(statement.startsWith('UPDATE users SET last_seen')){const run=p.run;p.run=async(...args)=>{if(holding&&++waiters===2)attempted();return run(...args);};}return p;};
 let blocked,accepting,sending;
 let timer;try{blocked=block();await ready;accepting=request('/campus/close-requests/'+q.id+'/accept',{user:'sara',method:'POST',body:{}});sending=request(base+'/messages',{user:'sara',method:'POST',body:{body:'Cannot race a block',client_id:randomUUID()}});await Promise.race([queued,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Concurrent requests did not reach the serialization point.')),5000);})]);release();const results=await Promise.all([blocked,accepting,sending]);assert.deepEqual(results.map(r=>r.status),[200,403,403]);}finally{clearTimeout(timer);release();env.db.prepare=prepare;await Promise.allSettled([blocked,accepting,sending].filter(Boolean));}
 assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS n FROM close_rooms WHERE request_id=?').get(q.id)).n,0);
 assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS n FROM close_messages WHERE room_id=?').get(r.id)).n,0);
});

test('blocking remains possible for a former participant after their filiere or eligibility changes',async()=>{
 const r=await room();await env.db.prepare("UPDATE users SET filiere_id='arabic_studies' WHERE id=4").run();
 try{assert.equal((await block()).status,200);assert.equal((await env.db.prepare('SELECT recording FROM close_rooms WHERE id=?').get(r.id)).recording,false);assert.equal((await request('/campus/blocks/4',{method:'DELETE'})).status,200);}finally{await env.db.prepare("UPDATE users SET filiere_id='french_studies' WHERE id=4").run();}
});

test('Help XP takes its scope lock before the pair and rechecks a block committed while it waited',async()=>{
 const r=await room(),earlier=new Date(Date.now()-180000).toISOString();await env.db.prepare('UPDATE close_rooms SET created_at=?,closed_at=? WHERE id=?').run(earlier,new Date().toISOString(),r.id);
 for(let i=0;i<4;i++)await env.db.prepare('INSERT INTO close_messages(room_id,author_id,body,client_id,created_at) VALUES(?,?,?,?,?)').run(r.id,i%2?4:3,'A substantive retained explanation '+i,randomUUID(),earlier);
 const prepare=env.db.prepare;let release,locked;const held=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{locked=resolve});let intercepted=false;const order=[];
 env.db.prepare=statement=>{const p=prepare(statement);if(statement.includes('pg_advisory_xact_lock')){const get=p.get;p.get=async(...args)=>{order.push(args[0]);const result=await get(...args);if(!intercepted&&args[0]==='campuslink:xp-ranking:flaa:french_studies'){intercepted=true;locked();await held;}return result;};}return p;};
 let rating;try{rating=request('/campus/rooms/'+r.id+'/rating',{method:'POST',body:{rating:'helpful'}});await ready;assert.equal((await block('sara',3)).status,200,'block must not wait on a pair held below the XP lock');release();assert.equal((await rating).status,403);assert.equal(order[0],'campuslink:xp-ranking:flaa:french_studies');}finally{release();env.db.prepare=prepare;if(rating)await Promise.allSettled([rating]);}
 assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS n FROM xp_events WHERE event_key=?').get('closeroom:'+r.id+':help')).n,0);
});

test('Forum searches and filters apply before the bounded result limit, with percent and underscore treated literally',async()=>{
 const older=new Date(Date.now()-2*86400000).toISOString();
 const special=await env.db.prepare("INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,created_at) VALUES('flaa','french_studies',3,'Literal 40%_ marker','Source interpretation',?) RETURNING id").get(older);
 const resolved=await env.db.prepare("INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,created_at) VALUES('flaa','french_studies',3,'Older resolved question','Source explanation',?) RETURNING id").get(older);
 const a=await env.db.prepare('INSERT INTO campus_answers(question_id,author_id,body,created_at) VALUES(?,4,?,?) RETURNING id').get(resolved.id,'Source-backed response',older);await env.db.prepare('UPDATE campus_questions SET accepted_answer_id=? WHERE id=?').run(a.id,resolved.id);
 const recent=await env.db.prepare("INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,created_at) SELECT 'flaa','french_studies',3,'Recent noise '||n,'Literal 40AX marker',? FROM generate_series(1,205) n RETURNING id").all(new Date().toISOString());
 for(const row of recent)await env.db.prepare('INSERT INTO campus_answers(question_id,author_id,body,created_at) VALUES(?,4,?,?)').run(row.id,'A response exists',new Date().toISOString());
 assert.deepEqual((await request('/campus/forum?q='+encodeURIComponent('40%_'))).data.questions.map(q=>q.id),[special.id]);
 assert.ok((await request('/campus/forum?filter=unanswered')).data.questions.some(q=>q.id===special.id));
 assert.ok((await request('/campus/forum?filter=resolved')).data.questions.some(q=>q.id===resolved.id));
 assert.equal((await request('/campus/forum')).data.questions.length,200);
});
