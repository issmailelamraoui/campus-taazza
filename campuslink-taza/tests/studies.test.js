import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createTestApp } from './helpers.mjs';
import { makePdf } from '../server/seed.js';
import { getFilieres, getFiliere, filiereBelongsToFaculty, getChatSemester, SEMESTER_CHAT_GROUPS } from '../shared/studies.js';

let environment,app,server,base,admin,science,sciencePeer,otherMajor,french,arabic,uploadedResource;
const created=[];
async function request(path,{cookie,method='GET',body,form}={}) {
  const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:form||(body?JSON.stringify(body):undefined)});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function login(username,password='Campus2026!') { const response=await request('/login',{method:'POST',body:{username,password}});assert.equal(response.status,200);return response.cookie; }
async function newStudent(username,faculty='fsa') {
  const response=await request('/admin/users',{cookie:admin,method:'POST',body:{username,email:`${username}@campuslink.test`,name:username,password:'Campus2026!',faculty_id:faculty}});
  assert.equal(response.status,201);return {cookie:await login(username),user:response.data.user};
}
function form(overrides={}) {
  const result=new FormData();
  const fields={filiere_id:'data_science',semester:'3',module:'Statistiques',resource_type:'td',title:'TD de statistiques',category:'exercises',channel:'filiere',chat_semester:'5',...overrides};
  for(const [key,value]of Object.entries(fields))if(value!==undefined)result.set(key,value);
  result.set('file',new Blob([makePdf(fields.title||'Missing title',[`Unique document ${fields.title||'Missing title'}.`])],{type:'application/pdf'}),'statistiques.pdf');
  return result;
}
before(async()=>{
  environment=await createTestApp();app=environment.app;server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  admin=await login('admin','Admin2026!');french=await login('sara');arabic=await login('nour');
  science=(await newStudent('science.setup')).cookie;sciencePeer=(await newStudent('science.peer')).cookie;otherMajor=(await newStudent('science.physics')).cookie;
  assert.equal((await request('/studies',{cookie:sciencePeer,method:'POST',body:{filiere_id:'data_science',current_semester:1}})).status,200);
  assert.equal((await request('/studies',{cookie:otherMajor,method:'POST',body:{filiere_id:'physics',current_semester:3}})).status,200);
});
after(async()=>{app?.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await environment?.close();});

test('each existing faculty exposes exactly its specified filières, with unchanged labels',async()=>{
  assert.deepEqual(getFilieres('fsa').map(f=>f.name),[
    'Filière Ingénierie des Systèmes d’Information','Filière Sciences de Données','Filière Sciences Mathématiques','Filière Géologie','Filière Biologie','Filière Physique','Filière Mécanique','Filière Chimie',
  ]);
  assert.deepEqual(getFilieres('flaa').map(f=>f.name),['مسلك الدراسات الفرنسية (S1, S3, S5)','شعبة اللغة العربية والآداب والفنون','شعبة التاريخ والحضارة','شعبة الجغرافيا']);
  assert.deepEqual(getFilieres('feg').map(f=>f.name),['Filière Économie','Filière Gestion']);
  assert.deepEqual(getFilieres('fsjp').map(f=>f.name),['شعبة القانون العام','شعبة القانون الخاص','مسار التميز في الدراسات السياسية والدولية (S5)']);
  for(const [username,faculty]of [['science.setup','fsa'],['sara','flaa'],['hamza','feg'],['soufiane','fsjp']]) {
    const cookie=await login(username),response=await request('/studies',{cookie});
    assert.deepEqual(response.data.filieres,getFilieres(faculty));
    assert.equal(response.data.user.faculty_id,faculty);
  }
  assert.equal(getFiliere('data_science').name,'Filière Sciences de Données');
  assert.equal(filiereBelongsToFaculty('feg','data_science'),false);
  assert.deepEqual(SEMESTER_CHAT_GROUPS.map(g=>g.semesters),[[1,2],[3,4],[5,6]]);
  assert.deepEqual(SEMESTER_CHAT_GROUPS.map(g=>g.label),['S1 / S2','S3 / S4','S5 / S6']);
  assert.deepEqual([1,2,3,4,5,6].map(getChatSemester),[1,1,3,3,5,5]);
  assert.equal(getChatSemester('S6'),5);assert.equal(getChatSemester(7),null);
});

test('general chat is faculty-wide without requiring a major or semester and remains silent',async()=>{
  const before=(await request('/bootstrap',{cookie:otherMajor})).data.notifications.length;
  assert.equal((await request('/session',{cookie:science})).data.user.filiere_id,null);
  const posted=await request('/messages',{cookie:science,method:'POST',body:{channel:'general',content:'Faculty-wide general conversation',filiere_id:'physics',semester:6}});
  assert.equal(posted.status,201);assert.equal(posted.data.message.filiere_id,null);assert.equal(posted.data.message.semester,null);
  const shared=(await request('/messages',{cookie:otherMajor})).data.messages;
  assert.ok(shared.some(m=>m.id===posted.data.message.id));assert.ok(shared.some(m=>m.content==='Bienvenue aux nouveaux étudiants des sciences appliquées.'));
  assert.equal((await request(`/messages/${posted.data.message.id}`,{cookie:otherMajor})).status,200);
  assert.equal((await request('/messages',{cookie:otherMajor,method:'POST',body:{channel:'general',reply_to:posted.data.message.id,content:'Reply from another major'}})).status,201);
  assert.equal((await request('/bootstrap',{cookie:otherMajor})).data.notifications.length,before);
  assert.match((await request('/search?q=Faculty-wide%20general&type=message',{cookie:otherMajor})).data.results[0].path,/\/general#message-/);
  assert.equal((await request(`/messages/${posted.data.message.id}`,{cookie:french})).status,403);
});

test('account setup uses the assigned faculty, validates major and semester, and persists them',async()=>{
  const previous=(await request('/session',{cookie:science})).data.user;
  assert.equal(previous.faculty_id,'fsa');assert.equal(previous.filiere_id,null);
  assert.equal((await request('/bootstrap',{cookie:science})).data.faculty.chat_online,0);
  assert.equal((await request('/messages?channel=filiere&semester=1',{cookie:science})).status,403);
  assert.equal((await request('/messages',{cookie:science,method:'POST',body:{channel:'filiere',semester:1,content:'Not yet set up'}})).status,403);
  assert.equal((await request('/studies',{cookie:science,method:'POST',body:{filiere_id:'management'}})).status,400);
  for(const semester of [0,7,1.5,'invalid'])assert.equal((await request('/studies',{cookie:science,method:'POST',body:{filiere_id:'data_science',current_semester:semester}})).status,400);
  const setup=await request('/studies',{cookie:science,method:'POST',body:{filiere_id:'data_science',current_semester:5}});
  assert.equal(setup.status,200);assert.equal(setup.data.user.faculty_id,'fsa');assert.equal(setup.data.user.filiere_id,'data_science');assert.equal(setup.data.user.current_semester,5);
  const session=(await request('/session',{cookie:await login('science.setup')})).data.user;
  assert.equal(session.filiere_id,'data_science');assert.equal(session.current_semester,5);
  assert.deepEqual((await request('/bootstrap',{cookie:science})).data.filieres,getFilieres('fsa'));
  const fresh=(await newStudent('science.default')).cookie;
  assert.equal((await request('/studies',{cookie:fresh,method:'POST',body:{filiere_id:'biology'}})).data.user.current_semester,1);
});

test('each study-year chat combines its two semesters and stays inside the account major',async()=>{
  for(let semester=1;semester<=6;semester++) {
    const response=await request('/messages',{cookie:science,method:'POST',body:{channel:'filiere',semester,content:`Science isolated semester ${semester}`}});
    assert.equal(response.status,201);assert.equal(response.data.message.filiere_id,'data_science');assert.equal(response.data.message.semester,getChatSemester(semester));created.push(response.data.message);
  }
  for(let semester=1;semester<=6;semester++) {
    const chat=await request(`/messages?channel=filiere&semester=${semester}`,{cookie:sciencePeer});
    assert.equal(chat.status,200);assert.equal(chat.data.messages.length,2);assert.deepEqual(chat.data.messages.map(m=>m.id),created.filter(m=>m.semester===getChatSemester(semester)).map(m=>m.id));
    assert.equal((await request(`/messages?channel=filiere&semester=${semester}`,{cookie:otherMajor})).data.messages.some(m=>m.filiere_id==='data_science'),false);
  }
  assert.equal((await request('/messages?channel=filiere&semester=1&filiere_id=data_science',{cookie:otherMajor})).status,403);
  assert.equal((await request('/messages',{cookie:science,method:'POST',body:{channel:'filiere',filiere_id:'physics',semester:1,content:'Spoofed major'}})).status,403);
  assert.equal((await request('/messages',{cookie:science,method:'POST',body:{channel:'filiere',content:'No semester'}})).status,400);
  assert.equal((await request('/messages',{cookie:science,method:'POST',body:{channel:'filiere',semester:7,content:'Invalid semester'}})).status,400);
  assert.equal((await request('/messages',{cookie:science,method:'POST',body:{channel:'filiere',semester:3,reply_to:created[0].id,content:'Wrong semester reply'}})).status,400);
  assert.equal((await request('/messages',{cookie:sciencePeer,method:'POST',body:{channel:'filiere',semester:2,reply_to:created[0].id,content:'S2 reply to S1 in the same study year'}})).status,201);
  const data=(await request('/bootstrap',{cookie:sciencePeer})).data;
  assert.ok(data.messages.every(m=>m.channel!=='filiere'||m.filiere_id==='data_science'));
  assert.equal(new Set(data.messages.filter(m=>m.channel==='filiere').map(m=>m.semester)).size,3);
  assert.equal(data.faculty.chat_online,2); // S1 and S5 peers share the same major.
  assert.ok(data.faculty.online>data.faculty.chat_online);
  assert.equal((await request('/bootstrap',{cookie:otherMajor})).data.faculty.chat_online,1);
});

test('foreign-major chat IDs cannot be read, replied to, reacted to, saved, reported or searched',async()=>{
  const id=created[0].id;
  assert.equal((await request(`/messages/${id}`,{cookie:otherMajor})).status,403);
  assert.equal((await request(`/messages/${id}/reaction`,{cookie:otherMajor,method:'POST',body:{reaction:'like'}})).status,403);
  assert.equal((await request('/messages',{cookie:otherMajor,method:'POST',body:{channel:'filiere',semester:1,reply_to:id,content:'Foreign-major reply'}})).status,403);
  assert.equal((await request('/saved',{cookie:otherMajor,method:'POST',body:{type:'message',id}})).status,403);
  assert.equal((await request('/reports',{cookie:otherMajor,method:'POST',body:{target_type:'message',target_id:id,reason:'other'}})).status,403);
  assert.equal((await request('/search?q=Science%20isolated&type=message',{cookie:otherMajor})).data.results.length,0);
  const ownSearch=(await request('/search?q=Science%20isolated&type=message&semester=5',{cookie:sciencePeer})).data.results;
  assert.equal(ownSearch.length,2);assert.ok(ownSearch.every(r=>/filiere\?semester=5#message-/.test(r.path)));
  assert.ok(ownSearch.every(r=>r.context.includes('S5 / S6')));
  assert.deepEqual((await request('/search?q=Science%20isolated&type=message&semester=6',{cookie:sciencePeer})).data.results,ownSearch);
});

test('pin provenance, announcements, notifications and saved content do not leak another major',async()=>{
  const posted=await request('/messages',{cookie:admin,method:'POST',body:{channel:'filiere',semester:5,content:'French-major private pinned test'}});
  assert.equal(posted.status,201);
  assert.equal((await request(`/messages/${posted.data.message.id}/pin`,{cookie:admin,method:'POST',body:{}})).status,200);
  const own=(await request('/bootstrap',{cookie:french})).data;
  const pinned=own.announcements.find(a=>a.message_id===posted.data.message.id);assert.ok(pinned);
  assert.ok(own.notifications.some(n=>n.path===`/app/announcements#announcement-${pinned.id}`));
  const foreign=(await request('/bootstrap',{cookie:arabic})).data;
  assert.equal(foreign.announcements.some(a=>a.id===pinned.id),false);
  assert.equal(foreign.notifications.some(n=>n.path===`/app/announcements#announcement-${pinned.id}`),false);
  assert.equal((await request('/search?q=French-major%20private',{cookie:arabic})).data.results.length,0);
  assert.equal((await request('/saved',{cookie:arabic,method:'POST',body:{type:'announcement',id:pinned.id}})).status,403);
  assert.equal((await request(`/messages/${posted.data.message.id}/pin`,{cookie:arabic,method:'POST',body:{}})).status,403);
  // Previously saved faculty-wide rows are also filtered after a major selection.
  await app.locals.db.prepare('INSERT INTO saved VALUES (?,?,?)').run(8,'message',posted.data.message.id);
  await app.locals.db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)').run(8,'flaa','announcements','Legacy notice','Private text',`/app/announcements#announcement-${pinned.id}`,new Date().toISOString());
  const legacyFiltered=(await request('/bootstrap',{cookie:arabic})).data;
  assert.equal(legacyFiltered.saved.some(s=>s.id===posted.data.message.id&&s.type==='message'),false);
  assert.equal(legacyFiltered.notifications.some(n=>n.path===`/app/announcements#announcement-${pinned.id}`),false);
});

test('general pins remain visible and notify students from other majors in the same faculty',async()=>{
  const posted=await request('/messages',{cookie:admin,method:'POST',body:{channel:'general',content:'Faculty-wide pinned announcement'}});
  assert.equal((await request(`/messages/${posted.data.message.id}/pin`,{cookie:admin,method:'POST',body:{}})).status,200);
  const other=(await request('/bootstrap',{cookie:arabic})).data;
  const pinned=other.announcements.find(a=>a.message_id===posted.data.message.id);assert.ok(pinned);
  assert.equal(pinned.channel,'general');assert.equal(pinned.semester,null);
  assert.ok(other.notifications.some(n=>n.path===`/app/announcements#announcement-${pinned.id}`));
  assert.equal((await request(`/messages/${posted.data.message.id}`,{cookie:arabic})).status,200);
});

test('upload requires all classification fields and separates library classification from private chat scope',async()=>{
  const initial=environment.storage.objects.size;
  for(const field of ['filiere_id','semester','module','resource_type','title','chat_semester']) {
    const response=await request('/uploads',{cookie:science,method:'POST',form:form({[field]:undefined,title:field==='title'?undefined:`Missing ${field}`})});
    assert.equal(response.status,400,field);
  }
  assert.equal((await request('/uploads',{cookie:science,method:'POST',form:form({filiere_id:'management'})})).status,400);
  assert.equal(environment.storage.objects.size,initial);
  const uploaded=await request('/uploads',{cookie:science,method:'POST',form:form({filiere_id:'physics',semester:'3',chat_semester:'6'})});
  assert.equal(uploaded.status,201);
  assert.equal(uploaded.data.resource.filiere_id,'physics');assert.equal(uploaded.data.resource.semester,3);assert.equal(uploaded.data.resource.resource_type,'td');
  assert.equal(uploaded.data.message.filiere_id,'data_science');assert.equal(uploaded.data.message.semester,5);
  assert.equal(uploaded.data.resource.chat_semester,5);
  assert.equal(uploaded.data.resource.message_id,uploaded.data.message.id);assert.equal(uploaded.data.message.resource_id,uploaded.data.resource.id);
  uploadedResource=uploaded.data.resource;
  const ownChat=(await request('/messages?channel=filiere&semester=5',{cookie:sciencePeer})).data.messages;
  assert.ok(ownChat.some(m=>m.id===uploaded.data.message.id));
  const foreignLibrary=(await request('/bootstrap',{cookie:otherMajor})).data;
  const shared=foreignLibrary.resources.find(r=>r.id===uploaded.data.resource.id);assert.ok(shared);assert.equal(shared.message_id,null);
  assert.equal(foreignLibrary.messages.some(m=>m.id===uploaded.data.message.id),false);
  assert.equal((await request(`/messages/${uploaded.data.message.id}`,{cookie:otherMajor})).status,403);
  const duplicate=await request('/uploads',{cookie:otherMajor,method:'POST',form:form({filiere_id:'physics',semester:'3',chat_semester:'3'})});
  assert.equal(duplicate.status,409);assert.equal(duplicate.data.resource.message_id,null);
  // Ordinary faculty chat uploads need no private chat semester or account major.
  const unassigned=(await newStudent('science.upload.general')).cookie;
  const generalUpload=await request('/uploads',{cookie:unassigned,method:'POST',form:form({channel:'general',chat_semester:undefined,title:'General faculty upload without chat semester'})});
  assert.equal(generalUpload.status,201);assert.equal(generalUpload.data.message.filiere_id,null);assert.equal(generalUpload.data.message.semester,null);
  assert.equal(generalUpload.data.resource.chat_semester,null);assert.equal(generalUpload.data.resource.semester,3);
  assert.ok((await request('/messages',{cookie:otherMajor})).data.messages.some(m=>m.id===generalUpload.data.message.id));
});

test('legacy even-semester chats merge while preserving message relationships and academic semesters',async()=>{
  const db=app.locals.db;
  for(const [index,semester]of [[1,2],[3,4],[5,6]])await db.prepare('UPDATE messages SET semester=? WHERE id=?').run(semester,created[index].id);
  await db.prepare('UPDATE messages SET semester=6,reply_to=?,pinned=1 WHERE id=?').run(created[5].id,uploadedResource.message_id);
  assert.equal((await request(`/messages/${uploadedResource.message_id}/reaction`,{cookie:sciencePeer,method:'POST',body:{reaction:'like'}})).status,200);
  // DTOs and old S2/S4/S6 links work even for legacy data imported after startup.
  for(const semester of [2,4,6]) {
    const chat=(await request(`/messages?channel=filiere&semester=${semester}`,{cookie:sciencePeer})).data.messages;
    assert.ok(chat.some(m=>m.id===created[semester-1].id));
    assert.ok(chat.every(m=>m.semester===getChatSemester(semester)));
  }
  const before={
    messages:await db.prepare('SELECT * FROM messages ORDER BY id').all(),
    resources:await db.prepare('SELECT * FROM resources ORDER BY id').all(),
    users:await db.prepare('SELECT id,current_semester FROM users ORDER BY id').all(),
    reactions:await db.prepare('SELECT * FROM reactions ORDER BY message_id,user_id,reaction').all(),
    modules:await db.prepare('SELECT * FROM modules ORDER BY id').all(),
  };
  const migration=await readFile(new URL('../server/migrations/004_semester_chat_pairs.sql',import.meta.url),'utf8');
  await db.transaction(async()=>{await db.exec(migration);});
  assert.deepEqual(await db.prepare('SELECT * FROM messages ORDER BY id').all(),before.messages.map(m=>({...m,semester:m.channel==='filiere'?getChatSemester(m.semester):m.semester})));
  assert.deepEqual(await db.prepare('SELECT * FROM resources ORDER BY id').all(),before.resources);
  assert.deepEqual(await db.prepare('SELECT id,current_semester FROM users ORDER BY id').all(),before.users);
  assert.deepEqual(await db.prepare('SELECT * FROM reactions ORDER BY message_id,user_id,reaction').all(),before.reactions);
  assert.deepEqual(await db.prepare('SELECT * FROM modules ORDER BY id').all(),before.modules);
  await db.transaction(async()=>{await db.exec(migration);});
  const source=(await request(`/messages/${uploadedResource.message_id}`,{cookie:sciencePeer})).data.message;
  assert.equal(source.semester,5);assert.equal(source.reply_to,created[5].id);assert.equal(source.pinned,true);assert.equal(source.reactions.like,1);
  const shared=(await request('/bootstrap',{cookie:sciencePeer})).data.resources.find(r=>r.id===uploadedResource.id);
  assert.equal(shared.semester,3);assert.equal(shared.chat_semester,5);assert.equal(shared.message_id,source.id);
  const evenSearch=(await request('/search?q=Science%20isolated&type=message&semester=6',{cookie:sciencePeer})).data.results;
  assert.ok(evenSearch.every(r=>/filiere\?semester=5#message-/.test(r.path)));
});

test('private Filière SSE changes reach the same major and never another major in the same faculty',async()=>{
  const controllers=[new AbortController(),new AbortController()];
  const responses=await Promise.all([sciencePeer,otherMajor].map((cookie,i)=>fetch(base+'/api/events/stream',{headers:{cookie},signal:controllers[i].signal})));
  const readers=responses.map(r=>r.body.getReader());await Promise.all(readers.map(r=>r.read()));
  const same=readers[0].read(),foreign=readers[1].read().catch(()=>null);
  try {
    assert.equal((await request('/messages',{cookie:science,method:'POST',body:{channel:'filiere',semester:4,content:'Live same-major event'}})).status,201);
    const update=await Promise.race([same,new Promise((_,reject)=>setTimeout(()=>reject(Error('Missing own-major live update')),2000))]);
    assert.match(Buffer.from(update.value).toString(),/event: update/);
    assert.equal(await Promise.race([foreign,new Promise(resolve=>setTimeout(()=>resolve(null),120))]),null);
  } finally {controllers.forEach(c=>c.abort());await foreign;}
});

test('general SSE updates reach different majors inside the faculty',async()=>{
  const controllers=[new AbortController(),new AbortController()];
  const responses=await Promise.all([sciencePeer,otherMajor].map((cookie,i)=>fetch(base+'/api/events/stream',{headers:{cookie},signal:controllers[i].signal})));
  const readers=responses.map(r=>r.body.getReader());await Promise.all(readers.map(r=>r.read()));
  const updates=readers.map(r=>r.read());
  try {
    assert.equal((await request('/messages',{cookie:science,method:'POST',body:{channel:'general',content:'Live general faculty event'}})).status,201);
    for(const pending of updates) {
      const update=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('Missing faculty-wide update')),2000))]);
      assert.match(Buffer.from(update.value).toString(),/event: update/);
    }
  } finally {controllers.forEach(c=>c.abort());await Promise.all(updates);}
});

test('faculty reassignment resets an incompatible major and keeps account setup separate',async()=>{
  const user=(await request('/session',{cookie:science})).data.user;
  const change=await request(`/admin/users/${user.id}`,{cookie:admin,method:'PATCH',body:{faculty_id:'feg'}});
  assert.equal(change.status,200);assert.equal(change.data.user.filiere_id,null);assert.equal(change.data.user.current_semester,1);
  assert.equal((await request('/session',{cookie:science})).data.user,null);
  const cookie=await login('science.setup');
  assert.deepEqual((await request('/studies',{cookie})).data.filieres,getFilieres('feg'));
  assert.equal((await request('/messages?channel=filiere&semester=1',{cookie})).status,403);
  assert.equal((await request('/studies',{cookie,method:'POST',body:{filiere_id:'management'}})).status,200);
});
