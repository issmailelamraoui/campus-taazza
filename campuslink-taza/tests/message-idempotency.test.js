import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createTestApp} from './helpers.mjs';

let environment,server,base,student,admin;
async function request(path,{cookie,method='GET',body}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function login(username,password='Campus2026!'){
  const response=await request('/login',{method:'POST',body:{username,password}});
  assert.equal(response.status,200);return response.cookie;
}
before(async()=>{
  environment=await createTestApp({legacyCommunity:false});
  server=environment.app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  student=await login('meryem');admin=await login('admin','Admin2026!');
  assert.equal((await request('/studies',{cookie:student,method:'POST',body:{filiere_id:'data_science',current_semester:2}})).status,200);
  // General important notices include another major in the same faculty, but
  // private pins stay in their major and respect opted-out preferences.
  await environment.db.prepare('UPDATE users SET faculty_id=?,filiere_id=? WHERE id=?').run('fsa','physics',9);
  await environment.db.prepare('UPDATE users SET faculty_id=?,filiere_id=?,preferences=? WHERE id=?').run('fsa','data_science',JSON.stringify({resources:true,announcements:false,important:false,admin:true,calendar:true}),1);
});
after(async()=>{
  environment?.app.locals.endStreams();server?.closeAllConnections();
  if(server)await new Promise(resolve=>server.close(resolve));await environment?.close();
});

test('legacy sends remain valid and optional message keys must be UUIDs',async()=>{
  const body={channel:'general',content:'A send without a client key remains supported.'};
  const legacy=await request('/messages',{cookie:student,method:'POST',body});
  assert.equal(legacy.status,201);assert.equal(legacy.data.message.client_id,null);
  for(const client_id of ['invalid',null,{},12])assert.equal((await request('/messages',{cookie:student,method:'POST',body:{...body,client_id}})).status,400);
});

test('concurrent retry keys create one message and one set of important notifications',async()=>{
  const body={channel:'important',content:'One important message despite simultaneous retries.',client_id:randomUUID()};
  const replies=await Promise.all([request('/messages',{cookie:student,method:'POST',body}),request('/messages',{cookie:student,method:'POST',body})]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,201]);
  assert.equal(replies[0].data.message.id,replies[1].data.message.id);assert.equal(replies[0].data.message.client_id,body.client_id);
  const id=replies[0].data.message.id;
  assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id=? AND client_id=?').get(12,body.client_id)).n,1);
  const notices=await environment.db.prepare('SELECT user_id FROM notifications WHERE path=?').all(`/app/chat/important#message-${id}`);
  assert.deepEqual(notices.map(n=>n.user_id).sort((a,b)=>a-b),[2,9]);
  const retry=await request('/messages',{cookie:student,method:'POST',body});assert.equal(retry.status,200);assert.equal(retry.data.message.id,id);
  assert.equal((await request('/messages',{cookie:student,method:'POST',body:{...body,content:'A different payload cannot reuse that key.'}})).status,409);
  const sameKeyDifferentAuthor=await request('/messages',{cookie:admin,method:'POST',body});assert.equal(sameKeyDifferentAuthor.status,201);assert.notEqual(sameKeyDifferentAuthor.data.message.id,id);
  const bootstrap=(await request('/bootstrap',{cookie:student})).data;
  assert.equal(bootstrap.messages.find(m=>m.id===id).client_id,body.client_id);
});

test('retry never resurrects a deleted message and validation rolls back a new key',async()=>{
  const body={channel:'general',content:'A deleted send cannot be resurrected by retry.',client_id:randomUUID()};
  const sent=await request('/messages',{cookie:student,method:'POST',body});assert.equal(sent.status,201);
  assert.equal((await request(`/messages/${sent.data.message.id}`,{cookie:student,method:'DELETE'})).status,200);
  assert.equal((await request('/messages',{cookie:student,method:'POST',body})).status,409);
  assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id=? AND client_id=?').get(12,body.client_id)).n,1);
  const parent=await request('/messages',{cookie:admin,method:'POST',body:{channel:'important',content:'The reply must stay in its original channel.'}});
  const invalid={channel:'general',content:'Invalid cross-channel reply.',reply_to:parent.data.message.id,client_id:randomUUID()};
  assert.equal((await request('/messages',{cookie:student,method:'POST',body:invalid})).status,400);
  assert.equal((await environment.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id=? AND client_id=?').get(12,invalid.client_id)).n,0);
});

test('pin returns a real announcement with canonical study scope and unpin returns null',async()=>{
  const sent=await request('/messages',{cookie:admin,method:'POST',body:{channel:'filiere',semester:2,content:'Canonical announcement returned to optimistic clients.',client_id:randomUUID()}});assert.equal(sent.status,201);
  const pinned=await request(`/messages/${sent.data.message.id}/pin`,{cookie:admin,method:'POST'});
  assert.equal(pinned.status,200);assert.equal(pinned.data.pinned,true);
  assert.ok(Number.isSafeInteger(pinned.data.announcement.id));assert.equal(pinned.data.announcement.message_id,sent.data.message.id);
  assert.equal(pinned.data.announcement.semester,1);assert.equal(pinned.data.announcement.filiere_id,'data_science');assert.equal(pinned.data.announcement.author.role,'student');
  const notices=await environment.db.prepare('SELECT user_id FROM notifications WHERE path=?').all(`/app/announcements#announcement-${pinned.data.announcement.id}`);
  assert.deepEqual(notices.map(n=>n.user_id),[12]);
  const unpinned=await request(`/messages/${sent.data.message.id}/pin`,{cookie:admin,method:'POST'});
  assert.equal(unpinned.status,200);assert.equal(unpinned.data.pinned,false);assert.equal(unpinned.data.announcement,null);
});
