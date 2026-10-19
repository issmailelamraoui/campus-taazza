import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,randomBytes} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
import {createApp} from '../server/app.js';
let env,server,base,second,secondServer,owner,student,admin,assistant;
async function req(path,{cookie,body,method=body?'POST':'GET',origin=base}={}){
 const res=await fetch(origin+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {status:res.status,data:await res.json(),cookie:res.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
}
async function login(username,password='Campus2026!'){const r=await req('/login',{body:{username,password}});assert.equal(r.status,200,JSON.stringify(r.data));return {...r.data,cookie:r.cookie};}
async function createStudent(faculty_id='flaa',filiere_id='french_studies'){
 const username='audit'+randomUUID().slice(0,8);
 const r=await req('/register',{body:{username,password:'Campus2026!',name:'Isolated audit '+username,email:username+'@example.test',faculty_id,filiere_id,current_semester:1}});
 assert.equal(r.status,201,JSON.stringify(r.data));return {id:r.data.user.id,username,cookie:r.cookie};
}
async function appoint(account,caps){return req('/admin/appointments',{cookie:owner.cookie,body:{user_id:account.user.id,role:'faculty_admin',faculty_id:'flaa',capabilities:caps}});}
before(async()=>{
 env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 owner=await login('admin','Admin2026!');student=await login('yassine');admin=await login('professeure');
 const created=await createStudent();assert.equal((await req('/admin/users/'+created.id+'/admission',{cookie:owner.cookie,method:'PATCH',body:{status:'approved'}})).status,200);
 assistant=await login(created.username);assert.equal((await appoint(assistant,['feedback.manage','student.admit'])).status,201);assistant=await login(created.username);
});
after(async()=>{env?.app.locals.endStreams();second?.locals.endStreams();server?.closeAllConnections();secondServer?.closeAllConnections();if(server)await new Promise(r=>server.close(r));if(secondServer)await new Promise(r=>secondServer.close(r));await second?.locals.close();await env?.close();});

test('explicit notification read works without destination; bulk read is scoped and persistent',async()=>{
 const insert=async(user,path)=>env.db.prepare('INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at,target_deleted) VALUES(?,?,?,?,?,?,?,1) RETURNING id').get(user,'flaa','admin','Unavailable','Audit fixture',path,new Date().toISOString());
 const a=await insert(student.user.id,'/app/library#resource-999999'),b=await insert(owner.user.id,'/app/library#resource-999998');
 assert.equal((await req('/notifications/'+a.id+'/read',{cookie:owner.cookie,body:{}})).status,404);
 assert.equal((await req('/notifications/'+a.id+'/read',{cookie:student.cookie,body:{}})).status,200);
 assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(a.id)).read,1);
 await insert(student.user.id,'/app/library#resource-999997');
 assert.equal((await req('/notifications/read',{cookie:student.cookie,body:{}})).status,200);
 assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(b.id)).read,0);
 const session=await login('yassine');const rows=await req('/notifications',{cookie:session.cookie});assert.ok(rows.data.notifications.filter(n=>n.title==='Unavailable').every(n=>Boolean(n.read)));
});

test('support acceptance is exclusive, replies private, retries idempotent and reactions persistent',async()=>{
 const r=await req('/feedback',{cookie:student.cookie,body:{title:'Private support',description:'Isolated fixture',category:'bug'}});assert.equal(r.status,201,JSON.stringify(r.data));const id=r.data.ticket.id;
 assert.equal((await req(`/feedback/${id}/replies`,{cookie:student.cookie,body:{content:'Before acceptance'}})).status,409);
 const claims=await Promise.all([admin,assistant].map(a=>req(`/admin/feedback/${id}/accept`,{cookie:a.cookie,body:{}})));
 assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);const winner=claims[0].status===200?admin:assistant,loser=winner===admin?assistant:admin;
 assert.equal((await req(`/admin/feedback/${id}/replies`,{cookie:loser.cookie,body:{content:'Forbidden'}})).status,403);
 assert.equal((await req(`/admin/contacts/${id}`,{cookie:loser.cookie,method:'PATCH',body:{status:'closed'}})).status,403);
 const body={content:'Persistent response',client_id:randomUUID()};const reply=await req(`/admin/feedback/${id}/replies`,{cookie:winner.cookie,body});assert.equal(reply.status,201,JSON.stringify(reply.data));
 const repeated=await req(`/admin/feedback/${id}/replies`,{cookie:winner.cookie,body});assert.equal(repeated.data.ticket.replies.length,1);
 const restricted=await req(`/admin/feedback/${id}`,{cookie:loser.cookie});assert.equal(restricted.data.ticket.restricted,true);assert.deepEqual(restricted.data.ticket.replies,[]);
 const replyId=reply.data.ticket.replies[0].id;
 assert.equal((await req(`/feedback/${id}/replies/${replyId}/reactions`,{cookie:student.cookie,body:{reaction:'heart',active:true}})).status,200);
 assert.equal((await req(`/feedback/${id}`,{cookie:student.cookie})).data.ticket.replies[0].reactions.heart,1);
 assert.equal((await req(`/admin/feedback/${id}/close`,{cookie:winner.cookie,body:{}})).status,200);
 const closedNoticeCount=Number((await env.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title='Conversation clôturée'").get(student.user.id)).n);
 assert.equal((await req(`/admin/feedback/${id}/close`,{cookie:winner.cookie,body:{}})).status,200);
 assert.equal(Number((await env.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title='Conversation clôturée'").get(student.user.id)).n),closedNoticeCount);
 assert.equal((await req(`/feedback/${id}/replies`,{cookie:student.cookie,body:{content:'After closing'}})).status,409);
 assert.equal((await req(`/feedback/${id}`,{cookie:student.cookie})).data.ticket.replies.length,1);
});

test('public support requires faculty and recovers without browser storage, not with an email alone',async()=>{
 const key=randomBytes(32).toString('hex'),body={name:'Guest student',email:'guest@example.test',subject:'Mot de passe oublié',message:'Access trouble',faculty_id:'flaa',recovery_key:key};
 assert.equal((await req('/support/request',{body:{...body,faculty_id:''}})).status,400);
 const created=await req('/support/request',{body});assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.ticket.recovery_hash,undefined);const id=created.data.ticket.id;
 const retry=await req('/support/request',{body});assert.equal(retry.data.ticket.id,id);
 assert.equal((await req('/support/recover',{body:{email:body.email}})).status,401);
 const recovered=await req('/support/recover',{body:{recovery_key:key}});assert.equal(recovered.status,200);
 assert.equal((await req('/support/session',{cookie:recovered.cookie})).data.ticket.id,id);
 assert.equal((await req('/support/session')).status,401);
 assert.equal((await req(`/admin/feedback/${id}/accept`,{cookie:admin.cookie,body:{}})).status,200);
 const reply=await req('/support/replies',{cookie:recovered.cookie,body:{content:'Back on another device',client_id:randomUUID()}});assert.equal(reply.status,200,JSON.stringify(reply.data));
 const overview=await req('/admin',{cookie:owner.cookie});assert.ok(overview.data.contacts.every(c=>c.recovery_hash===undefined));
});

test('signed-in access support retains verified identity and academic scope',async()=>{
 const result=await req('/support/request',{cookie:student.cookie,body:{name:'Unverified name',email:'another@example.test',faculty_id:'feg',subject:'Signed-in access support',message:'Isolated authenticated request',recovery_key:randomBytes(32).toString('hex')}});
 assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.ticket.user_id,student.user.id);assert.equal(result.data.ticket.name,student.user.name);assert.equal(result.data.ticket.faculty_id,student.user.faculty_id);
 const list=await req('/feedback',{cookie:student.cookie});assert.ok(list.data.tickets.some(t=>t.id===result.data.ticket.id));
});

test('admission permission is independent and scoped; it does not grant account editing',async()=>{
 const local=await createStudent(),other=await createStudent('feg','economics');
 const list=await req('/admin/registrations',{cookie:assistant.cookie});assert.equal(list.status,200);assert.ok(list.data.requests.some(u=>u.id===local.id));assert.ok(!list.data.requests.some(u=>u.id===other.id));
 assert.equal((await req(`/admin/users/${other.id}/admission`,{cookie:assistant.cookie,method:'PATCH',body:{status:'approved'}})).status,403);
 assert.equal((await req(`/admin/users/${local.id}/admission`,{cookie:assistant.cookie,method:'PATCH',body:{status:'approved'}})).status,200);
 assert.equal((await req(`/admin/users/${student.user.id}`,{cookie:assistant.cookie,method:'PATCH',body:{name:'Forbidden rename'}})).status,403);
 assert.equal((await req('/admin/registrations',{cookie:admin.cookie})).status,403);
});

test('presence uses live leases, deduplicates devices and excludes other faculties',async()=>{
 const a=randomUUID(),b=randomUUID();
 for(const client_id of [a,b])assert.equal((await req('/presence',{cookie:student.cookie,body:{channel:'general',client_id,arriving:true}})).status,200);
 let list=await req('/presence?channel=general',{cookie:admin.cookie});assert.equal(list.data.members.filter(u=>u.id===student.user.id).length,1);assert.equal(list.data.members.find(u=>u.id===student.user.id).username,student.user.username);
 await req('/presence/'+a,{cookie:student.cookie,method:'DELETE'});list=await req('/presence?channel=general',{cookie:admin.cookie});assert.ok(list.data.members.some(u=>u.id===student.user.id));
 await env.db.prepare("UPDATE chat_presence SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=?").run(b);
 list=await req('/presence?channel=general',{cookie:admin.cookie});assert.ok(!list.data.members.some(u=>u.id===student.user.id));
});

test('library grouping reports preserve exact owner/category scope and never remove content',async()=>{
 const resource=await env.db.prepare("SELECT * FROM resources WHERE faculty_id='flaa' AND filiere_id='french_studies' AND removed=0 AND library_visible=1 LIMIT 1").get();
 await env.db.prepare('UPDATE resources SET relative_path=? WHERE id=?').run('AuditFolder/nested/file.pdf',resource.id);
 for(const kind of ['folder','module','category']){
  const result=await req('/reports',{cookie:student.cookie,body:{target_type:kind,target_id:resource.id,folder_path:'AuditFolder',reason:'Incorrect grouping '+kind}});assert.equal(result.status,201,JSON.stringify(result.data));
  const report=await env.db.prepare('SELECT * FROM reports WHERE id=?').get(result.data.id);assert.equal(report.target_type,kind);if(kind==='module')assert.equal(report.target_context.category,undefined);if(kind==='category')assert.equal(report.target_context.module,undefined);assert.equal(report.target_context.filiere_id,resource.filiere_id);if(kind==='folder')assert.equal(report.target_context.owner_id,resource.author_id);
  assert.equal((await req('/admin/reports/'+report.id,{cookie:student.cookie,method:'PATCH',body:{status:'resolved'}})).status,403);
  const review=await req('/admin/reports/'+report.id,{cookie:owner.cookie,method:'PATCH',body:{status:'reviewed',note:'Review without removing content'}});assert.equal(review.status,200,JSON.stringify(review.data));
 }
 assert.equal((await env.db.prepare('SELECT removed FROM resources WHERE id=?').get(resource.id)).removed,0);
 assert.equal((await req('/reports',{cookie:student.cookie,body:{target_type:'folder',target_id:resource.id,folder_path:'SomebodyElse',reason:'Wrong target'}})).status,400);
});

test('removal deletes associated notice targets while preserving an independent notice',async()=>{
 const sent=await req('/messages',{cookie:owner.cookie,body:{channel:'general',content:'Removal fixture',client_id:randomUUID()}});assert.equal(sent.status,201);const id=sent.data.message.id;
 const add=path=>env.db.prepare("INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at) VALUES(?,'flaa','mentions','Removal fixture','',?,?) RETURNING id").get(student.user.id,path,new Date().toISOString());
 const exact=await add('/app/chat/general#message-'+id),modern=await add('/app/community?channel=general&message='+id),independent=await add('/app/chat/general#message-'+id+'0');
 assert.equal((await req('/messages/'+id,{cookie:owner.cookie,method:'DELETE'})).status,200);
 assert.equal(await env.db.prepare('SELECT id FROM notifications WHERE id=?').get(exact.id),undefined);assert.equal(await env.db.prepare('SELECT id FROM notifications WHERE id=?').get(modern.id),undefined);assert.ok(await env.db.prepare('SELECT id FROM notifications WHERE id=?').get(independent.id));
});

test('events cross independent server instances and reconnect fetches missed messages',async()=>{
 second=await createApp({db:env.db,auth:env.auth,storage:env.storage});secondServer=second.listen(0,'127.0.0.1');await once(secondServer,'listening');const origin='http://127.0.0.1:'+secondServer.address().port;
 const controller=new AbortController();const response=await fetch(origin+'/api/events/stream',{headers:{cookie:student.cookie},signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader();await reader.read();
 const event=(async()=>{let text='';while(!text.includes('event: update')){const result=await reader.read();if(result.done)throw Error('Stream ended');text+=new TextDecoder().decode(result.value);}return performance.now();})();
 const started=performance.now();const sent=await req('/messages',{cookie:admin.cookie,body:{channel:'general',content:'Cross instance '+randomUUID(),client_id:randomUUID()}});assert.equal(sent.status,201,JSON.stringify(sent.data));
 const received=await Promise.race([event,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('No shared invalidation')),8000);timer.unref();})]);
 console.log('Cross-instance message invalidation latency (ms):',Math.round(received-started));controller.abort();
 const snapshot=await req('/bootstrap',{cookie:student.cookie,origin});assert.ok(snapshot.data.messages.some(m=>m.id===sent.data.message.id));
});
