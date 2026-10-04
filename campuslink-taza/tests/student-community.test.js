import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {openDatabase} from '../server/db.js';
import {makePdf} from '../server/seed.js';
import {createTestEnvironment} from './helpers.mjs';

let environment,app,server,base,student,admin,peer,foreign,moderator;
let retainedResource,deletedMessage;
async function request(path,{cookie,method='GET',body,form}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:form||(body?JSON.stringify(body):undefined)});
  const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function login(username,password='Campus2026!'){const result=await request('/login',{method:'POST',body:{username,password}});assert.equal(result.status,200);return result.cookie;}
async function start(db=environment.db){app=await createApp({db,auth:environment.auth,storage:environment.storage});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
async function stop(){app?.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await app?.locals.close();}
function document(title,content='Uploaded from a student account.'){
  const form=new FormData();
  for(const [key,value]of Object.entries({title,category:'courses',semester:'1',module:'Introduction aux données',filiere_id:'data_science',resource_type:'courses',channel:'general',content}))form.set(key,value);
  form.set('file',new Blob([makePdf(title,[content])],{type:'application/pdf'}),'community.pdf');return form;
}
before(async()=>{
  environment=await createTestEnvironment({legacyCommunity:false});
  const avatarKey='avatars/2/private-owner.png';
  await environment.storage.put(avatarKey,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),'image/png');
  await environment.db.prepare('UPDATE users SET avatar_object_key=? WHERE id=2').run(avatarKey);
  await start();
  student=await login('ismail');admin=await login('admin','Admin2026!');peer=await login('meryem');foreign=await login('hamza');moderator=await login('amina');
  assert.equal((await request('/faculty',{cookie:student,method:'POST',body:{faculty_id:'fsa',confirmed:true}})).status,200);
  assert.equal((await request('/studies',{cookie:student,method:'POST',body:{filiere_id:'data_science',current_semester:1}})).status,200);
});
after(async()=>{await stop();await environment?.close();});

test('canonical owner keeps private authorization while public profiles expose student identity only',async()=>{
  const session=await request('/session',{cookie:admin});assert.equal(session.data.user.role,'global_admin');assert.equal(session.data.user.name,'Issmail');assert.equal(session.data.user.faculty_id,'fsa');assert.equal(session.data.user.filiere_id,'data_science');
  const upload=await request('/uploads',{cookie:admin,method:'POST',form:document('Student community owner document')});assert.equal(upload.status,201);assert.equal(upload.data.message.author.role,'student');assert.equal(upload.data.message.author.username,'issmail');assert.equal(upload.data.message.author.name,'Issmail');assert.equal(upload.data.message.author.avatar,'/api/avatars/2');
  const bootstrap=(await request('/bootstrap',{cookie:student})).data;assert.ok(bootstrap.members.every(u=>u.role==='student'));assert.equal(bootstrap.members.find(u=>u.id===2).username,'issmail');assert.ok(bootstrap.messages.every(m=>m.author.role==='student'));assert.ok(bootstrap.resources.every(r=>r.author.role==='student'));
  const messageResult=await request(`/messages/${upload.data.message.id}`,{cookie:student});assert.equal(messageResult.data.message.author.username,'issmail');
  const search=(await request('/search?q=Issmail',{cookie:student})).data.results;assert.ok(search.some(r=>r.type==='member'));assert.ok(search.every(r=>r.author.role==='student'));assert.ok(search.every(r=>r.author.username!=='admin'));
  const fullSearch=(await request('/search',{cookie:student})).data.results;assert.ok(fullSearch.every(r=>r.author.role==='student'));assert.ok(fullSearch.every(r=>!/admin/i.test(r.author.avatar||'')));
  const avatar=await request('/avatars/2',{cookie:student});assert.equal(avatar.status,200);assert.ok(avatar.data.length>0);
  const management=await request('/admin',{cookie:admin});assert.equal(management.status,200);assert.equal(management.data.users.find(u=>u.id===2).role,'global_admin');assert.equal((await request('/admin',{cookie:student})).status,403);
});

test('authors delete their own messages with pin cleanup while academic resources and private files survive',async()=>{
  const uploaded=await request('/uploads',{cookie:student,method:'POST',form:document('Retained academic document','Author removal keeps this academic file.')});assert.equal(uploaded.status,201);
  retainedResource=uploaded.data.resource.id;deletedMessage=uploaded.data.message.id;
  assert.equal((await request(`/messages/${deletedMessage}`,{cookie:peer,method:'DELETE'})).status,403);
  assert.equal((await request(`/messages/${deletedMessage}`,{cookie:foreign,method:'DELETE'})).status,403);
  assert.equal((await request(`/messages/${deletedMessage}/pin`,{cookie:admin,method:'POST'})).status,200);
  const before=(await request('/bootstrap',{cookie:student})).data;const pin=before.announcements.find(a=>a.message_id===deletedMessage);assert.ok(pin);
  await request('/saved',{cookie:student,method:'POST',body:{type:'message',id:deletedMessage}});await request('/saved',{cookie:student,method:'POST',body:{type:'announcement',id:pin.id}});await request(`/messages/${deletedMessage}/reaction`,{cookie:peer,method:'POST',body:{reaction:'like'}});
  const objects=environment.storage.objects.size;
  assert.equal((await request(`/messages/${deletedMessage}`,{cookie:student,method:'DELETE'})).status,200);
  assert.equal(environment.storage.objects.size,objects);assert.equal((await request(`/messages/${deletedMessage}`,{cookie:student})).status,404);
  const after=(await request('/bootstrap',{cookie:student})).data;assert.ok(!after.messages.some(m=>m.id===deletedMessage));assert.ok(!after.announcements.some(a=>a.id===pin.id));assert.ok(!after.saved.some(s=>s.type==='message'&&s.id===deletedMessage||s.type==='announcement'&&s.id===pin.id));
  const retained=after.resources.find(r=>r.id===retainedResource);assert.ok(retained);assert.equal(retained.message_id,null);assert.equal((await request(`/files/${retainedResource}`,{cookie:student})).status,200);
  assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id=?').get(deletedMessage)).n,0);
  const otherMessage=await request('/messages',{cookie:peer,method:'POST',body:{channel:'general',content:'The owner can moderate this message.'}});assert.equal((await request(`/messages/${otherMessage.data.message.id}`,{cookie:admin,method:'DELETE'})).status,200);
});

test('blocking is global-admin only, faculty authoritative, and never disables a student account',async()=>{
  assert.equal((await request('/chat/blocks',{cookie:student,method:'POST',body:{user_id:12}})).status,403);assert.equal((await request('/chat/blocks',{cookie:moderator,method:'POST',body:{user_id:1}})).status,403);
  assert.equal((await request('/chat/blocks',{cookie:admin,method:'POST',body:{user_id:2}})).status,403);
  const blocked=await request('/chat/blocks',{cookie:admin,method:'POST',body:{user_id:1,faculty_id:'feg'}});assert.equal(blocked.status,200);assert.equal(blocked.data.faculty_id,'fsa');
  const session=(await request('/session',{cookie:student})).data.user;assert.equal(session.chat_blocked,true);assert.equal(session.disabled,false);
  const bootstrap=await request('/bootstrap',{cookie:student});assert.equal(bootstrap.status,200);assert.deepEqual(bootstrap.data.messages,[]);assert.equal(bootstrap.data.user.chat_blocked,true);assert.ok(bootstrap.data.resources.length>0);assert.ok(bootstrap.data.resources.every(r=>r.message_id===null));
  const sample=(await request('/bootstrap',{cookie:peer})).data.messages[0];assert.ok(sample);
  for(const path of ['/messages','/messages/'+sample.id,'/events/stream','/search?type=message'])assert.equal((await request(path,{cookie:student})).status,403);
  assert.equal((await request('/messages',{cookie:student,method:'POST',body:{channel:'general',content:'Blocked write'}})).status,403);assert.equal((await request(`/messages/${sample.id}/reaction`,{cookie:student,method:'POST',body:{reaction:'like'}})).status,403);assert.equal((await request(`/messages/${sample.id}`,{cookie:student,method:'DELETE'})).status,403);
  assert.equal((await request('/uploads',{cookie:student,method:'POST',form:document('Blocked chat upload')})).status,403);
  const search=await request('/search',{cookie:student});assert.equal(search.status,200);assert.ok(search.data.results.every(r=>r.type!=='message'));assert.equal((await request(`/files/${retainedResource}`,{cookie:student})).status,200);
  const profile=await request('/profile',{cookie:student,method:'PATCH',body:{language:'en'}});assert.equal(profile.status,200);assert.equal(profile.data.user.chat_blocked,true);
  assert.equal((await request('/chat/blocks/1',{cookie:student,method:'DELETE'})).status,403);
  assert.equal((await request('/chat/blocks/1',{cookie:admin,method:'DELETE'})).status,200);assert.equal((await request('/session',{cookie:student})).data.user.chat_blocked,false);assert.equal((await request('/messages',{cookie:student})).status,200);
  // Any other member can be blocked, including members whose private account
  // still has legacy moderation permissions.
  assert.equal((await request('/chat/blocks',{cookie:admin,method:'POST',body:{user_id:6}})).status,200);assert.equal((await request('/messages',{cookie:moderator})).status,403);assert.equal((await request('/chat/blocks/6',{cookie:admin,method:'DELETE'})).status,200);
  assert.equal((await request('/chat/blocks',{cookie:admin,method:'POST',body:{user_id:9}})).status,200);assert.equal((await request('/session',{cookie:foreign})).data.user.chat_blocked,true);assert.equal((await request('/bootstrap',{cookie:foreign})).status,200);await request('/chat/blocks/9',{cookie:admin,method:'DELETE'});
});

test('a ban closes live chat streams and persists across application restart',async()=>{
  const controller=new AbortController();
  const response=await fetch(base+'/api/events/stream',{headers:{cookie:student},signal:controller.signal});const reader=response.body.getReader();await reader.read();
  try{
    const pending=reader.read();assert.equal((await request('/chat/blocks',{cookie:admin,method:'POST',body:{user_id:1}})).status,200);const update=await pending;assert.match(Buffer.from(update.value).toString(),/event: update/);assert.equal((await reader.read()).done,true);
  }finally{controller.abort();}
  await stop();const db=await openDatabase({schema:environment.schema});environment.auth.useDatabase(db);await start(db);
  assert.equal((await request('/session',{cookie:student})).data.user.chat_blocked,true);assert.equal((await request('/messages',{cookie:student})).status,403);assert.equal((await request('/bootstrap',{cookie:student})).status,200);
  const blocks=await request('/chat/blocks',{cookie:admin});assert.equal(blocks.status,200);assert.ok(blocks.data.blocks.some(b=>b.user_id===1));assert.ok(blocks.data.blocks.every(b=>b.user.role==='student'));
  await request('/chat/blocks/1',{cookie:admin,method:'DELETE'});
});
