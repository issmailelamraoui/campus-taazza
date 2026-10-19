import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,randomBytes} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
let env,server,origin,owner,student,admin,other;
async function req(path,{actor,body,form,method=form||body?'POST':'GET',cookie=actor?.cookie}={}){
 const response=await fetch(origin+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:form||(body?JSON.stringify(body):undefined)});
 const data=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.arrayBuffer();
 return {status:response.status,data,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
}
async function login(username,password='Campus2026!'){const r=await req('/login',{body:{username,password}});assert.equal(r.status,200,JSON.stringify(r.data));return {user:r.data.user,cookie:r.cookie};}
async function conversation({accept=true}={}){const r=await req('/feedback',{actor:student,body:{title:'Deletion fixture '+randomUUID(),description:'Private test conversation',category:'concern',client_id:randomUUID()}});assert.equal(r.status,201);const id=r.data.ticket.id;if(accept)assert.equal((await req(`/admin/feedback/${id}/accept`,{actor:admin,body:{}})).status,200);return id;}
async function attach(id,filename){const form=new FormData();form.set('file',new Blob(['Isolated private attachment '+filename],{type:'text/plain'}),filename);const r=await req(`/feedback/${id}/attachments`,{actor:student,form});assert.equal(r.status,201,JSON.stringify(r.data));return env.db.prepare('SELECT * FROM contact_attachments WHERE id=?').get(r.data.attachment.id);}
async function remove(id,actor=admin){return req('/admin/feedback/'+id,{actor,method:'DELETE'});}
before(async()=>{env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;owner=await login('admin','Admin2026!');student=await login('yassine');admin=await login('professeure');other=await login('nour');});
after(async()=>{env?.app.locals.endStreams();if(server)await new Promise(resolve=>server.close(resolve));await env?.close();});

test('closing preserves a conversation; deleting removes messages, reactions, attachments, visits and exact notifications',async()=>{
 const id=await conversation(),attachment=await attach(id,'resolved.txt');
 const reply=await req(`/admin/feedback/${id}/replies`,{actor:admin,body:{content:'Private solved response',client_id:randomUUID()}});assert.equal(reply.status,201);const replyId=reply.data.ticket.replies[0].id;
 assert.equal((await req(`/feedback/${id}/replies/${replyId}/reactions`,{actor:student,body:{reaction:'heart',active:true}})).status,200);
 const add=async(path,user=student.user.id)=>(await env.db.prepare("INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at) VALUES(?,'flaa','admin','Delete target','Private fixture',?,?) RETURNING id").get(user,path,new Date().toISOString())).id;
 const notice=await add('/app/feedback?ticket='+id+'#reply-'+replyId),legacy=await add('/app/admin?tab=contacts&contact='+id,owner.user.id),unrelated=await add('/app/feedback?ticket='+id+'0');
 const visited=await req(`/notifications/${notice}/viewed`,{actor:student,body:{path:'/app/feedback?ticket='+id+'#reply-'+replyId}});assert.equal(visited.status,200);
 assert.equal((await req(`/admin/feedback/${id}/close`,{actor:admin,body:{}})).status,200);
 assert.ok(await env.db.prepare('SELECT id FROM contacts WHERE id=?').get(id));assert.ok(await env.db.prepare('SELECT id FROM contact_replies WHERE id=?').get(replyId));assert.ok(env.storage.objects.has(attachment.object_key));
 assert.equal((await req(`/admin/feedback/${id}`,{actor:admin})).data.ticket.can_delete,true);
 assert.equal((await remove(id)).status,200);
 for(const table of ['contacts','contact_replies','contact_attachments'])assert.equal(Number((await env.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table==='contacts'?'id':'contact_id'}=?`).get(id)).n),0,table);
 assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM contact_reactions WHERE reply_id=?').get(replyId)).n),0);
 assert.equal(await env.db.prepare('SELECT token FROM notification_visits WHERE token=?').get(visited.data.visit_token),undefined);
 for(const key of [notice,legacy])assert.equal(await env.db.prepare('SELECT id FROM notifications WHERE id=?').get(key),undefined);
 assert.ok(await env.db.prepare('SELECT id FROM notifications WHERE id=?').get(unrelated));assert.equal(env.storage.objects.has(attachment.object_key),false);
 assert.equal((await req('/feedback/'+id,{actor:student})).status,404);assert.equal((await req('/feedback/attachments/'+attachment.id+'/file',{actor:student})).status,404);
 assert.equal((await req('/feedback',{actor:student})).data.tickets.some(ticket=>ticket.id===id),false);
 const audit=await env.db.prepare("SELECT * FROM administrative_audit WHERE target_type='contact' AND target_id=?").all(String(id));assert.equal(audit.length,1);assert.equal(audit[0].action,'feedback.delete');assert.deepEqual(audit[0].details,{messages:1,attachments:1});
 assert.equal((await remove(id)).status,404);assert.equal((await req('/session',{actor:student})).data.user.id,student.user.id);
});

test('only the assigned authorized administrator or owner can delete; other scopes and students cannot close or erase it',async()=>{
 const id=await conversation();const file=await attach(id,'protected.txt'),deletions=env.storage.deleteCount;
 assert.equal((await remove(id,student)).status,403);assert.equal((await remove(id,owner)).status,200);
 const guarded=await conversation();
 assert.equal((await req('/admin/feedback/'+guarded,{method:'DELETE'})).status,401);
 const grant=await req('/admin/appointments',{actor:owner,body:{user_id:other.user.id,role:'faculty_admin',faculty_id:'feg',capabilities:['feedback.manage']}});assert.equal(grant.status,201);other=await login('nour');
 assert.equal((await remove(guarded,other)).status,403);
 assert.equal((await req('/admin/feedback/'+guarded,{actor:owner})).data.ticket.can_delete,true);
 const secondAdmin=await login('sara');const sameFaculty=await req('/admin/appointments',{actor:owner,body:{user_id:secondAdmin.user.id,role:'faculty_admin',faculty_id:'flaa',capabilities:['feedback.manage']}});assert.equal(sameFaculty.status,201);const delegate=await login('sara');
 assert.equal((await req('/admin/feedback/'+guarded,{actor:delegate})).data.ticket.can_delete,false);assert.equal((await remove(guarded,delegate)).status,403);
 assert.equal((await env.db.prepare('SELECT closed_at FROM contacts WHERE id=?').get(guarded)).closed_at,null);
 assert.equal(env.storage.deleteCount,deletions+1);assert.equal(env.storage.objects.has(file.object_key),false);
 const unassigned=await conversation({accept:false});await env.db.prepare("UPDATE contacts SET status='resolved' WHERE id=?").run(unassigned);assert.equal((await remove(unassigned,admin)).status,409);assert.equal((await req('/admin/feedback/'+unassigned,{actor:owner})).data.ticket.can_delete,true);assert.equal((await remove(unassigned,owner)).status,200);
});

test('storage failures retain closed retryable metadata; partial file deletion can be safely retried',async()=>{
 const id=await conversation(),a=await attach(id,'first.txt'),b=await attach(id,'second.txt');const original=env.storage.delete.bind(env.storage);let attempted=0;
 env.storage.delete=async key=>{if(++attempted===2)throw Object.assign(new Error('Isolated storage failure'),{status:502});await original(key);};
 let failed;try{failed=await remove(id);}finally{env.storage.delete=original;}
 assert.equal(failed.status,502);assert.match(failed.data.error,/réessayez/);
 assert.equal((await env.db.prepare('SELECT status FROM contacts WHERE id=?').get(id)).status,'closed');assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM contact_attachments WHERE contact_id=?').get(id)).n),2);
 assert.equal(env.storage.objects.has(a.object_key),false);assert.equal(env.storage.objects.has(b.object_key),true);
 assert.equal((await req('/feedback/'+id+'/replies',{actor:student,body:{content:'Cannot append during cleanup',client_id:randomUUID()}})).status,409);
 assert.equal((await remove(id)).status,200);assert.equal(env.storage.objects.has(b.object_key),false);assert.equal(await env.db.prepare('SELECT id FROM contacts WHERE id=?').get(id),undefined);
});

test('owner can remove a delegated conversation in another faculty without granting student access to that faculty',async()=>{
 const key=randomBytes(32).toString('hex');const created=await req('/support/request',{body:{name:'Cross faculty guest',email:'guest-delete@example.test',faculty_id:'feg',subject:'Resolved access problem',message:'Temporary help',recovery_key:key}});assert.equal(created.status,201);const id=created.data.ticket.id;
 assert.equal((await req('/admin/feedback/'+id+'/accept',{actor:other,body:{}})).status,200);
 assert.equal((await remove(id,admin)).status,403);assert.equal((await remove(id,owner)).status,200);
 assert.equal((await req('/support/session',{cookie:created.cookie})).status,401);assert.equal((await req('/support/recover',{body:{recovery_key:key}})).status,401);
});

test('anonymous messages and reactions are removed and the existing recovery cookie cannot reopen the deleted session',async()=>{
 const key=randomBytes(32).toString('hex');const created=await req('/support/request',{body:{name:'Guest deletion fixture',email:'anonymous-delete@example.test',faculty_id:'flaa',subject:'Resolved guest request',message:'Temporary private issue',recovery_key:key}});assert.equal(created.status,201);const id=created.data.ticket.id;
 assert.equal((await req('/admin/feedback/'+id+'/accept',{actor:admin,body:{}})).status,200);
 const posted=await req('/support/replies',{cookie:created.cookie,body:{content:'Private guest follow-up',client_id:randomUUID()}});assert.equal(posted.status,200);const reply=posted.data.ticket.replies[0].id;
 assert.equal((await req('/support/reactions',{cookie:created.cookie,body:{reply_id:reply,reaction:'like',active:true}})).status,200);
 assert.equal((await remove(id)).status,200);assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM contact_reactions WHERE reply_id=?').get(reply)).n),0);
 assert.equal((await req('/support/session',{cookie:created.cookie})).status,401);assert.equal((await req('/support/replies',{cookie:created.cookie,body:{content:'No resurrection',client_id:randomUUID()}})).status,401);
});

test('a racing reply and deletion cannot leave orphaned messages or return an internal foreign-key error',async()=>{
 const id=await conversation();const [sent,deleted]=await Promise.all([req('/feedback/'+id+'/replies',{actor:student,body:{content:'Concurrent clarification',client_id:randomUUID()}}),remove(id)]);
 assert.ok([201,404,409].includes(sent.status),JSON.stringify(sent));assert.equal(deleted.status,200);assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM contact_replies WHERE contact_id=?').get(id)).n),0);
});
