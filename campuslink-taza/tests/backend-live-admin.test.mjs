import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
let env,server,base,owner,student,delegate;
async function req(path,{cookie,body,method=body?'POST':'GET'}={}){
 const r=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
}
async function login(username,password='Campus2026!'){const r=await req('/login',{body:{username,password}});assert.equal(r.status,200,JSON.stringify(r.data));return {...r.data,cookie:r.cookie};}
async function register(faculty_id='feg',filiere_id='economics'){
 const username='live'+randomUUID().slice(0,8);const r=await req('/register',{body:{username,password:'Campus2026!',name:username,email:username+'@example.test',faculty_id,filiere_id,current_semester:1}});assert.equal(r.status,201,JSON.stringify(r.data));return {id:r.data.user.id,username};
}
before(async()=>{env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;owner=await login('admin','Admin2026!');student=await login('yassine');delegate=await login('sara');});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await env?.close();});

test('lightweight live snapshots and message deltas preserve faculty/program privacy and persistent unread cursors',async()=>{
 const inserted=await req('/messages',{cookie:student.cookie,body:{channel:'general',content:'Delta chat '+randomUUID(),client_id:randomUUID()}});assert.equal(inserted.status,201);const id=inserted.data.message.id;
 const delta=await req('/live?message_ids='+id,{cookie:delegate.cookie});assert.equal(delta.status,200);assert.equal(delta.data.messages_complete,false);assert.deepEqual(delta.data.messages.map(m=>m.id),[id]);assert.equal(delta.data.resources,undefined);assert.ok(delta.data.discussion_unread_counts.some(c=>c.channel==='general'&&c.count>0));
 const otherProgram=await env.db.prepare("SELECT id FROM filieres WHERE faculty_id='flaa' AND id<>'french_studies' LIMIT 1").get();
 const other=await env.db.prepare("INSERT INTO messages(faculty_id,channel,author_id,content,created_at,filiere_id,semester) VALUES('flaa','filiere',?,'Other programme',?,?,1) RETURNING id").get(student.user.id,new Date().toISOString(),otherProgram.id);
 assert.deepEqual((await req('/live?message_ids='+other.id,{cookie:delegate.cookie})).data.messages,[]);
 const remote=await env.db.prepare("INSERT INTO messages(faculty_id,channel,author_id,content,created_at) VALUES('feg','general',?,'Other faculty',?) RETURNING id").get(student.user.id,new Date().toISOString());
 assert.deepEqual((await req('/live?message_ids='+remote.id,{cookie:delegate.cookie})).data.messages,[]);
 await env.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(new Date(Date.now()-5*86400000).toISOString(),id);
 const unread=(await req('/live?inbox=1',{cookie:delegate.cookie})).data;assert.deepEqual(unread.messages,[]);assert.ok(unread.discussion_unread_counts.some(c=>c.channel==='general'));
 const read=await req('/messages/read',{cookie:delegate.cookie,body:{channel:'general',through_id:id}});assert.equal(read.status,200);assert.ok(!read.data.discussion_unread_counts.some(c=>c.channel==='general'));
 assert.equal((await req('/live?message_ids=invalid',{cookie:delegate.cookie})).status,400);
 assert.equal((await req('/live')).status,401);
});

test('owner atomically grants all faculties while admission, private support and owner authority remain independent',async()=>{
 const grant=await req('/admin/appointments',{cookie:owner.cookie,body:{user_id:delegate.user.id,role:'faculty_admin',faculty_id:'all',capabilities:['student.admit']}});assert.equal(grant.status,201,JSON.stringify(grant.data));
 const faculties=await env.db.prepare('SELECT id FROM faculties').all();assert.equal(grant.data.appointments.length,faculties.length);delegate=await login('sara');
 for(const faculty of faculties){const program=await env.db.prepare('SELECT id FROM filieres WHERE faculty_id=? ORDER BY id LIMIT 1').get(faculty.id);const target=await register(faculty.id,program.id);const list=await req('/admin/registrations',{cookie:delegate.cookie});assert.ok(list.data.requests.some(u=>u.id===target.id));assert.equal((await req('/admin/users/'+target.id+'/admission',{cookie:delegate.cookie,method:'PATCH',body:{status:faculty.id==='feg'?'rejected':'approved'}})).status,200);}
 assert.equal((await req('/admin/users/'+owner.user.id,{cookie:delegate.cookie,method:'PATCH',body:{disabled:true}})).status,403);
 assert.equal((await req('/admin/appointments',{cookie:delegate.cookie,body:{user_id:student.user.id,role:'faculty_admin',faculty_id:'all',capabilities:['student.admit']}})).status,403);
 assert.equal((await req('/admin/users/'+owner.user.id+'/appointments',{cookie:delegate.cookie,method:'DELETE'})).status,403);
 const guest=await req('/support/request',{body:{name:'Isolated guest',email:'guest@example.test',faculty_id:'feg',subject:'Cross faculty help',message:'Question',recovery_key:randomUUID().replaceAll('-','').repeat(2)}});assert.equal(guest.status,201,JSON.stringify(guest.data));
 assert.equal((await req('/admin/feedback/'+guest.data.ticket.id+'/accept',{cookie:delegate.cookie,body:{}})).status,403);
 const support=await req('/admin/appointments',{cookie:owner.cookie,body:{user_id:delegate.user.id,role:'faculty_admin',faculty_id:'all',capabilities:['feedback.manage','student.support']}});assert.equal(support.status,201);delegate=await login('sara');
 const overview=await req('/admin',{cookie:delegate.cookie});assert.ok(overview.data.contacts.some(t=>t.id===guest.data.ticket.id));assert.ok(!overview.data.users.some(u=>u.id===owner.user.id));assert.equal((await req('/admin/feedback/'+guest.data.ticket.id+'/accept',{cookie:delegate.cookie,body:{}})).status,200);
 const response=await req('/admin/feedback/'+guest.data.ticket.id+'/replies',{cookie:delegate.cookie,body:{content:'Answer across faculties',client_id:randomUUID()}});assert.equal(response.status,201,JSON.stringify(response.data));
 assert.equal((await req('/admin/users/'+owner.user.id,{cookie:delegate.cookie,method:'PATCH',body:{disabled:true}})).status,403);
 const target=await register();assert.equal((await req('/admin/users/'+target.id+'/admission',{cookie:owner.cookie,method:'PATCH',body:{status:'approved'}})).status,200);
 assert.equal((await req('/admin/users/'+target.id,{cookie:delegate.cookie,method:'PATCH',body:{disabled:true}})).status,200);
 assert.equal((await req('/admin/users/'+delegate.user.id+'/appointments',{cookie:owner.cookie,method:'DELETE'})).status,200);delegate=await login('sara');assert.equal(delegate.user.has_admin_access,false);assert.equal((await req('/admin/registrations',{cookie:delegate.cookie})).status,403);
});

test('explicit all-faculty content permissions work in administration while ordinary student spaces remain isolated',async()=>{
 const granted=await req('/admin/appointments',{cookie:owner.cookie,body:{user_id:delegate.user.id,role:'faculty_admin',faculty_id:'all',capabilities:['content.moderate','resource.manage','announcement.publish','channel.manage']}});assert.equal(granted.status,201);delegate=await login('sara');
 const remote=await env.db.prepare("SELECT * FROM messages WHERE faculty_id='feg' AND channel='general' AND removed=0 ORDER BY id DESC LIMIT 1").get();assert.ok(remote);
 const overview=(await req('/admin',{cookie:delegate.cookie})).data;assert.ok(overview.messages.some(m=>m.id===remote.id));assert.ok(overview.resources.some(r=>r.faculty_id==='feg'));
 assert.equal((await req('/messages/'+remote.id,{cookie:delegate.cookie})).status,403);assert.ok((await req('/bootstrap',{cookie:delegate.cookie})).data.messages.every(m=>m.faculty_id==='flaa'));
 const resource=overview.resources.find(r=>r.faculty_id==='feg');const file=await fetch(base+'/api/files/'+resource.id,{headers:{cookie:delegate.cookie}});assert.equal(file.status,200);await file.arrayBuffer();
 assert.equal((await req('/admin/resources/'+resource.id,{cookie:delegate.cookie,method:'PATCH',body:{status:'updated'}})).status,200);
 assert.equal((await req('/admin/channels/general',{cookie:delegate.cookie,method:'PATCH',body:{faculty_id:'feg',read_only:false}})).status,200);
 const publication=await req('/admin/announcements',{cookie:delegate.cookie,body:{faculty_id:'all',title:'Explicit all-faculty publication',content:'Isolated approved information',channel:'important'}});assert.equal(publication.status,201,JSON.stringify(publication.data));assert.equal(publication.data.announcements.length,granted.data.appointments.length);
 assert.equal((await req('/admin/messages/'+remote.id+'/remove',{cookie:delegate.cookie,body:{}})).status,200);
 assert.equal((await req('/admin/users/'+owner.user.id+'/appointments',{cookie:delegate.cookie,method:'DELETE'})).status,403);
});

test('public owner messages, uploads and member profiles disclose only student identity; support notice targets exact reply',async()=>{
 const post=await req('/messages',{cookie:owner.cookie,body:{channel:'general',content:'Owner public ordinary message',client_id:randomUUID()}});assert.equal(post.status,201);const profile=(await req('/messages/'+post.data.message.id,{cookie:student.cookie})).data.message.author;
 assert.equal(profile.name,owner.user.name);assert.equal(profile.role,'student');assert.equal(profile.administrative_capabilities,undefined);assert.equal(profile.has_admin_access,undefined);assert.equal(profile.email,undefined);
 const bootstrap=(await req('/bootstrap',{cookie:student.cookie})).data;assert.equal(bootstrap.members.find(u=>u.id===owner.user.id)?.role,'student');
 const form=new FormData();form.set('file',new Blob(['Isolated owner contribution'],{type:'text/plain'}),'owner-student.txt');for(const [k,v] of Object.entries({title:'Owner student upload',semester:'1',module:'Owner identity',category:'courses',part_number:'complete',filiere_id:'french_studies',academic_year:'2026/2027',resource_type:'courses'}))form.set(k,v);
 const upload=await fetch(base+'/api/uploads',{method:'POST',headers:{cookie:owner.cookie},body:form});const data=await upload.json();assert.equal(upload.status,201,JSON.stringify(data));assert.equal(data.resource.author.name,owner.user.name);assert.equal(data.resource.author.role,'student');
 const ticket=await req('/feedback',{cookie:student.cookie,body:{title:'Exact support reply',description:'Question for owner',category:'concern',client_id:randomUUID()}});assert.equal(ticket.status,201);const id=ticket.data.ticket.id;
 assert.equal((await req('/admin/feedback/'+id+'/accept',{cookie:owner.cookie,body:{}})).status,200);
 const reply=await req('/admin/feedback/'+id+'/replies',{cookie:owner.cookie,body:{content:'Precise answer target',client_id:randomUUID()}});assert.equal(reply.status,201);const replyId=reply.data.ticket.replies.at(-1).id;
 const publicTicket=(await req('/feedback/'+id,{cookie:student.cookie})).data.ticket;assert.equal((await req('/feedback',{cookie:student.cookie})).data.tickets.find(t=>t.id===id).assigned_to,'administration');assert.equal(publicTicket.assigned.name,'Administration');assert.equal(publicTicket.assigned.id,null);assert.equal(publicTicket.replies.at(-1).author.id,null);
 const notices=(await req('/notifications',{cookie:student.cookie})).data.notifications;assert.ok(notices.some(n=>n.path===`/app/feedback?ticket=${id}#reply-${replyId}`&&n.target_available));
});
