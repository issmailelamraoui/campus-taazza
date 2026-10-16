import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
import {academicYear,academicYears,compareAcademicYears} from '../server/academic-years.js';
import {detectFile,mayInlineFile} from '../server/files.js';

let env,server,origin;const cookies={};
async function request(path,{cookie,method='GET',body,form}={}){
 const response=await fetch(origin+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:form||(body===undefined?undefined:JSON.stringify(body))});
 const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
 return {status:response.status,data,headers:response.headers,cookie:response.headers.getSetCookie().find(c=>c.startsWith('campus_neon_test_session='))?.split(';')[0]};
}
async function login(name){const result=await request('/login',{method:'POST',body:{username:name,password:name==='admin'?'Admin2026!':'Campus2026!'}});assert.equal(result.status,200,JSON.stringify(result.data));return result.cookie;}
async function upload(cookie,{semester=3,filiere='french_studies',year='2026/2027',module=randomUUID(),filename='course.txt',content=randomUUID(),part='complete',faculty}={}){
 const form=new FormData();for(const [key,value]of Object.entries({title:module,category:'courses',channel:'general',filiere_id:filiere,semester:String(semester),module,resource_type:'courses',part_number:part,academic_year:year,library_visible:'true',publish_message:'false',...(faculty?{faculty_id:faculty}:{})}))form.set(key,value);
 form.set('file',new Blob([content]),filename);return request('/uploads',{cookie,method:'POST',form});
}
async function xp(user,points,key=randomUUID(),category='contribution'){return env.db.prepare('INSERT INTO xp_events(user_id,category,event_key,points,actor_id,created_at) VALUES(?,?,?,?,2,?) RETURNING *').get(user,category,key,points,new Date().toISOString());}
function pauseSlot(key){
 const prepare=env.db.prepare.bind(env.db);let signal,resume;const paused=new Promise(resolve=>{signal=resolve;}),released=new Promise(resolve=>{resume=resolve;});
 env.db.prepare=sql=>{const statement=prepare(sql);if(sql==='SELECT pg_advisory_xact_lock(hashtext(?))')return {...statement,get:async(...values)=>{if(values[0]===key){signal();await released;}return statement.get(...values);}};return statement;};
 return {paused,resume,restore:()=>{resume();env.db.prepare=prepare;}};
}
async function reached(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Request did not reach the authorization race boundary')),5000);})]);}finally{clearTimeout(timer);}}
before(async()=>{env=await createTestApp();await env.db.prepare('UPDATE users SET current_semester=3 WHERE id=3').run();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;for(const username of ['admin','yassine','sara','nour','professeure'])cookies[username]=await login(username);});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await env?.close();});

test('academic metadata validates consecutive years, preserves unknown, and orders current before past and unknown',()=>{
 assert.equal(academicYear('unknown'),null);assert.equal(academicYear(null),null);assert.throws(()=>academicYear('2026/2028'));assert.throws(()=>academicYear('2026-2027'));
 assert.deepEqual(academicYears('["2024/2025","2024/2025"]','2026/2027'),['2026/2027','2024/2025']);
 const docs=[{id:1,academic_year:null},{id:2,academic_year:'2025/2026'},{id:3,academic_year:'2024/2025'},{id:4,academic_year:'2026/2027'}];
 assert.deepEqual(docs.sort((a,b)=>compareAcademicYears(a,b,'2025/2026')).map(r=>r.id),[2,4,3,1]);
});
test('educational code is inert text, active types never inline, and binary impostors are rejected',()=>{
 for(const ext of ['py','cpp','js','html','svg','csv','sql','java','ipynb']){const filename='lesson.'+ext;assert.equal(detectFile(Buffer.from('<script>alert(1)</script>'),filename),'text/plain');assert.equal(mayInlineFile('text/plain',filename),false);}
 assert.throws(()=>detectFile(Buffer.from([0,1,2]),'lesson.py'));assert.throws(()=>detectFile(Buffer.from('fake png'),'lesson.png'));assert.throws(()=>detectFile(Buffer.from('binary'),'lesson.exe'));
 assert.equal(mayInlineFile('application/pdf','lesson.pdf'),true);assert.equal(mayInlineFile('application/pdf','lesson.html'),false);
});
test('one persisted existing owner remains protected and official announcements hide the authenticated actor',async()=>{
 assert.deepEqual(await env.db.prepare('SELECT user_id FROM platform_owner').all(),[{user_id:2}]);
 const denied=await request('/admin/users/2',{cookie:cookies.professeure,method:'PATCH',body:{disabled:true}});assert.equal(denied.status,403);
 assert.equal((await request('/admin/users/4',{cookie:cookies.admin,method:'PATCH',body:{role:'global_admin'}})).status,403);
 const published=await request('/admin/announcements',{cookie:cookies.admin,method:'POST',body:{content:'Official administrative notice',title:'Notice',channel:'important'}});
 assert.equal(published.status,201,JSON.stringify(published.data));assert.equal(published.data.announcement.author.name,'Administration');assert.equal(published.data.announcement.author.id,null);assert.equal('author_id' in published.data.announcement,false);
 const audit=await env.db.prepare("SELECT actor_id FROM administrative_audit WHERE action='announcement.publish' AND target_id=?").get(String(published.data.announcement.id));assert.equal(audit.actor_id,2);
 const bootstrap=await request('/bootstrap',{cookie:cookies.yassine});const owner=bootstrap.data.members.find(m=>m.id===2);assert.equal(owner.role,'student');const original=await env.db.prepare('SELECT name,username FROM users WHERE id=2').get();assert.equal(owner.name,original.name);assert.equal(owner.username,original.username);
 const personal=await request('/messages',{cookie:cookies.admin,method:'POST',body:{channel:'general',content:'My ordinary personal message'}});assert.equal(personal.status,201);assert.equal(personal.data.message.author.name,original.name);
 const search=await request('/search?type=announcement&q=Official',{cookie:cookies.yassine});assert.equal(search.data.results[0].author.name,'Administration');assert.equal(search.data.results[0].author.id,null);
 assert.equal((await request('/admin/audit',{cookie:cookies.professeure})).status,403);
});
test('ordinary S3 uploader can publish only S3/S4 within their actual filiere',async()=>{
 for(const semester of [3,4])assert.equal((await upload(cookies.yassine,{semester})).status,201);
 for(const semester of [1,2,5,6])assert.equal((await upload(cookies.yassine,{semester})).status,403);
 assert.equal((await upload(cookies.yassine,{filiere:'arabic_studies'})).status,403);
 assert.equal((await upload(cookies.yassine,{faculty:'feg'})).status,403);
 assert.equal((await request('/studies',{cookie:cookies.yassine,method:'POST',body:{filiere_id:'french_studies',current_semester:1}})).status,403);
 assert.equal((await request('/profile',{cookie:cookies.yassine,method:'PATCH',body:{role:'global_admin',xp:99999}})).status,403);
});
test('trusted positive filiere XP leaders and ties gain all six semesters; changes revoke privilege',async()=>{
 const uploaded=async()=>Number((await env.db.prepare("SELECT COALESCE(SUM(points),0) AS points FROM xp_events WHERE user_id=3 AND status='valid' AND details->>'evidence'='published_library_file'").get()).points);
 const priorUploads=await uploaded();
 const event=await xp(3,10);
 const session=await request('/session',{cookie:cookies.yassine});assert.equal(session.data.user.uploadCapabilities.source,'xp_leader');assert.equal(session.data.user.validated_xp,10+priorUploads);
 assert.equal((await upload(cookies.yassine,{semester:1})).status,201);assert.equal((await upload(cookies.yassine,{semester:6})).status,201);assert.equal((await upload(cookies.yassine,{semester:6,filiere:'arabic_studies'})).status,403);
 await xp(4,10);assert.equal((await upload(cookies.sara,{semester:6})).status,201,'Tied eligible leaders share this limited privilege');
 await xp(4,1);assert.equal((await upload(cookies.yassine,{semester:6})).status,403,'Ranking is recomputed without trusting the old session');
 assert.equal((await request('/admin/xp-events/'+event.id+'/revoke',{cookie:cookies.admin,method:'POST'})).status,200);
 const afterRevocation=(await request('/session',{cookie:cookies.yassine})).data.user;
 assert.equal(afterRevocation.validated_xp,await uploaded(),'Revoking study XP preserves separately credited file contributions');assert.equal(afterRevocation.uploadCapabilities.source,'study_year','File XP cannot retain cross-semester upload rights');
 await request('/profile',{cookie:cookies.sara,method:'PATCH',body:{preferences:{ranking:false}}});const ranking=await request('/xp',{cookie:cookies.yassine});assert.ok(!ranking.data.ranking.some(u=>u.id===4));assert.equal((await upload(cookies.sara,{semester:5})).status,201,'Display opt-out preserves validated filiere upload eligibility');
 await request('/profile',{cookie:cookies.sara,method:'PATCH',body:{preferences:{ranking:true}}});
});
test('upload finalization revalidates ranking after storing bytes and compensates revoked uploads',async()=>{
 await xp(3,20);const put=env.storage.put.bind(env.storage),before=env.storage.objects.size;
 env.storage.put=async(...args)=>{await put(...args);await xp(4,40);};
 try{const result=await upload(cookies.yassine,{semester:6});assert.equal(result.status,403,JSON.stringify(result.data));assert.equal(env.storage.objects.size,before,'Rejected finalization cleans up only its new private object');}finally{env.storage.put=put;}
});
test('explicit faculty appointment grants uploads only in authorized filiere and protected roles cannot control each other',async()=>{
 const grant=await request('/admin/appointments',{cookie:cookies.admin,method:'POST',body:{user_id:8,role:'faculty_admin',faculty_id:'flaa',filiere_id:'arabic_studies',capabilities:['resource.upload','student.support']}});assert.equal(grant.status,201,JSON.stringify(grant.data));cookies.nour=await login('nour');
 assert.equal((await upload(cookies.nour,{filiere:'arabic_studies',semester:6})).status,201);assert.equal((await upload(cookies.nour,{filiere:'french_studies',semester:6})).status,403);
 assert.equal((await request('/admin/users/2',{cookie:cookies.nour,method:'PATCH',body:{disabled:true}})).status,403);assert.equal((await request('/admin/users/7',{cookie:cookies.nour,method:'PATCH',body:{disabled:true}})).status,403);
 const lead=await request('/admin/appointments',{cookie:cookies.admin,method:'POST',body:{user_id:3,role:'faculty_leader',faculty_id:'flaa',filiere_id:'french_studies',capabilities:['student.support','content.moderate']}});assert.equal(lead.status,201,JSON.stringify(lead.data));cookies.yassine=await login('yassine');
 assert.equal((await request('/admin/users/3',{cookie:cookies.professeure,method:'PATCH',body:{disabled:true}})).status,403);assert.equal((await request('/admin/users/8',{cookie:cookies.yassine,method:'PATCH',body:{disabled:true}})).status,403);
 assert.equal((await request('/admin/appointments/'+grant.data.appointment.id,{cookie:cookies.admin,method:'DELETE'})).status,200);cookies.nour=await login('nour');assert.equal((await upload(cookies.nour,{filiere:'arabic_studies',semester:6})).status,403);
});
test('years separate material slots and one physical file can be reused across years without duplication',async()=>{
 const module='Year sorting '+randomUUID(),older=await upload(cookies.yassine,{module,year:'2024/2025'}),current=await upload(cookies.yassine,{module,year:'2026/2027'}),unknown=await upload(cookies.yassine,{module,year:'unknown'});
 for(const row of [older,current,unknown])assert.equal(row.status,201,JSON.stringify(row.data));
 assert.equal((await upload(cookies.yassine,{module,year:'2026/2027'})).status,409);
 const file=current.data.resource;assert.equal(file.can_manage_academic_years,true);const count=env.storage.objects.size;
 const corrected=await request('/resources/'+file.id+'/academic-years',{cookie:cookies.yassine,method:'PATCH',body:{academic_years:['2026/2027','2025/2026']}});assert.equal(corrected.status,200,JSON.stringify(corrected.data));assert.equal(env.storage.objects.size,count);assert.deepEqual(corrected.data.resource.academic_years,['2026/2027','2025/2026']);
 assert.equal((await request('/resources/'+older.data.resource.id+'/academic-years',{cookie:cookies.yassine,method:'PATCH',body:{academic_year:'2025/2026'}})).status,409);
 assert.equal((await request('/resources/'+file.id+'/academic-years',{cookie:cookies.sara,method:'PATCH',body:{academic_year:'2023/2024'}})).status,403);
 const result=await request('/search?q='+encodeURIComponent(module)+'&type=resource',{cookie:cookies.yassine});assert.deepEqual(result.data.results.map(r=>r.id),[file.id,older.data.resource.id,unknown.data.resource.id]);
 const stream=await request('/files/'+file.id,{cookie:cookies.yassine});assert.match(stream.headers.get('content-disposition'),/^attachment/);assert.equal(stream.headers.get('x-content-type-options'),'nosniff');
});
test('private feedback persists administrative replies and exact notifications remain unread until departure',async()=>{
 const created=await request('/feedback',{cookie:cookies.yassine,method:'POST',body:{category:'bug',title:'Reader concern',description:'My private report'}});assert.equal(created.status,201);const id=created.data.ticket.id;
 assert.equal((await request('/feedback/'+id,{cookie:cookies.sara})).status,403);
 const replied=await request('/admin/feedback/'+id+'/replies',{cookie:cookies.admin,method:'POST',body:{content:'Administration response',status:'reviewing'}});assert.equal(replied.status,201,JSON.stringify(replied.data));assert.equal(replied.data.ticket.replies[0].author.name,'Administration');assert.equal(replied.data.ticket.replies[0].author.id,null);
 const row=await env.db.prepare('SELECT * FROM notifications WHERE user_id=3 AND path LIKE ? ORDER BY id DESC').get('%#feedback-'+id);assert.equal(row.read,0);
 assert.equal((await request('/notifications/read',{cookie:cookies.yassine,method:'POST',body:{ids:[row.id]}})).status,400);
 await request('/bootstrap',{cookie:cookies.yassine});assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(row.id)).read,0);
 assert.equal((await request('/notifications/'+row.id+'/viewed',{cookie:cookies.yassine,method:'POST',body:{path:'/app'}})).status,400);
 const visit=await request('/notifications/'+row.id+'/viewed',{cookie:cookies.yassine,method:'POST',body:{path:row.path}});assert.equal(visit.status,200);assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(row.id)).read,0);
 assert.equal((await request('/notifications/'+row.id+'/departed',{cookie:cookies.sara,method:'POST',body:{visit_token:visit.data.visit_token}})).status,404);
 assert.equal((await request('/notifications/'+row.id+'/departed',{cookie:cookies.yassine,method:'POST',body:{visit_token:visit.data.visit_token}})).status,200);assert.equal((await env.db.prepare('SELECT read FROM notifications WHERE id=?').get(row.id)).read,1);
});
test('deleted notification targets preserve unread history and fail destination lifecycle authorization',async()=>{
 const created=await upload(cookies.yassine,{semester:3});assert.equal(created.status,201);const id=created.data.resource.id,path='/app/resources/courses/s3#resource-'+id;
 const notice=await env.db.prepare("INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at) VALUES(3,'flaa','resources','History','Retained',?,?) RETURNING *").get(path,new Date().toISOString());
 assert.equal((await request('/admin/resources/'+id,{cookie:cookies.admin,method:'DELETE'})).status,200);
 const row=await env.db.prepare('SELECT * FROM notifications WHERE id=?').get(notice.id);assert.equal(row.read,0);assert.equal(row.target_deleted,1);
 const boot=await request('/bootstrap',{cookie:cookies.yassine});const retained=boot.data.notifications.find(n=>n.id===notice.id);assert.ok(retained);assert.equal(retained.target_available,false);
 assert.equal((await request('/notifications/'+notice.id+'/viewed',{cookie:cookies.yassine,method:'POST',body:{path}})).status,403);
});
test('balanced faculty ranking gives ties the same rank and caps practice influence',async()=>{
 // This scenario isolates the academic/practice weighting from the file
 // rewards earned by earlier publication-permission fixtures.
 await env.db.prepare("DELETE FROM xp_events WHERE details->>'evidence'='published_library_file'").run();
 await xp(4,9);await xp(5,10);await xp(5,80,randomUUID(),'practice');
 const result=await request('/xp',{cookie:cookies.yassine});assert.equal(result.status,200);
 const first=result.data.ranking.find(r=>r.id===3),tied=result.data.ranking.find(r=>r.id===4),practice=result.data.ranking.find(r=>r.id===5);
 assert.equal(first.ranking_score,20);assert.equal(tied.ranking_score,20);assert.equal(first.rank,1);assert.equal(tied.rank,1);assert.equal(practice.rank,3);assert.equal(practice.xp,90);assert.equal(practice.ranking_score,12);
});
test('Faculty Leader support console shows exactly its granted student and moderation scopes',async()=>{
 const resource=await env.db.prepare('SELECT id FROM resources WHERE faculty_id=? AND filiere_id=? AND removed=0 LIMIT 1').get('flaa','french_studies');
 const report=await env.db.prepare("INSERT INTO reports(faculty_id,reporter_id,target_type,target_id,reason,created_at) VALUES('flaa',3,'resource',?,'Leader support case',?) RETURNING *").get(resource.id,new Date().toISOString());
 const result=await request('/admin',{cookie:cookies.yassine});assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(result.data.users.some(u=>u.id===4),'Explicit student.support must not disappear because the role is faculty_leader');
 assert.ok(result.data.users.every(u=>u.filiere_id==='french_studies'));assert.deepEqual(result.data.contacts,[]);assert.deepEqual(result.data.resources,[]);
 assert.equal(result.data.reports.find(r=>r.id===report.id).can_remove_target,false,'Content moderation alone cannot remove academic files');
});
test('feedback files stay private, validate duplicate uploads, and honor exact admin filiere grants',async()=>{
 const result=await request('/feedback',{cookie:cookies.yassine,method:'POST',body:{category:'bug',title:'Private file report',description:'A reproducible upload concern'}});assert.equal(result.status,201);const id=result.data.ticket.id;
 const form=()=>{const value=new FormData();value.set('file',new Blob(['const privateExample = 1;']),'example.js');return value;};
 const added=await request('/feedback/'+id+'/attachments',{cookie:cookies.yassine,method:'POST',form:form()});assert.equal(added.status,201,JSON.stringify(added.data));assert.equal('object_key' in added.data.attachment,false);
 const file='/feedback/attachments/'+added.data.attachment.id+'/file';assert.equal((await request(file,{cookie:cookies.sara})).status,403);const own=await request(file,{cookie:cookies.yassine});assert.equal(own.status,200);assert.match(own.headers.get('content-disposition'),/^attachment/);
 assert.equal((await request('/feedback/'+id+'/attachments',{cookie:cookies.yassine,method:'POST',form:form()})).status,409);
 const bad=new FormData();bad.set('file',new Blob(['false PNG header']),'shot.png');assert.equal((await request('/feedback/'+id+'/attachments',{cookie:cookies.yassine,method:'POST',form:bad})).status,400);
 const grant=await request('/admin/appointments',{cookie:cookies.admin,method:'POST',body:{user_id:8,role:'faculty_admin',faculty_id:'flaa',filiere_id:'french_studies',capabilities:['feedback.manage']}});assert.equal(grant.status,201);cookies.nour=await login('nour');
 assert.equal((await request('/admin/feedback/'+id,{cookie:cookies.nour})).status,200);assert.equal((await request(file,{cookie:cookies.nour})).status,200);
 const details=await request('/feedback/'+id,{cookie:cookies.yassine});assert.equal(details.data.ticket.attachments[0].id,added.data.attachment.id);
});
test('simultaneous ticket submissions cannot exceed hourly or daily limits',async()=>{
 const cookie=await login('omar'),fixture='Rate case '+randomUUID();
 const insert=env.db.prepare("INSERT INTO contacts(faculty_id,user_id,name,subject,message,created_at,filiere_id) VALUES('flaa',5,'Omar',?,?,?,'french_studies')");
 for(let i=0;i<9;i++)await insert.run(fixture+' '+i,'Rate fixture',new Date().toISOString());
 const post=()=>request('/feedback',{cookie,method:'POST',body:{category:'concern',title:fixture,description:'Concurrent rate cap'}});
 const hourly=await Promise.all([post(),post(),post()]);assert.deepEqual(hourly.map(r=>r.status).sort(),[201,429,429]);
 await env.db.prepare('UPDATE contacts SET created_at=? WHERE user_id=5 AND subject LIKE ?').run(new Date(Date.now()-2*3600000).toISOString(),fixture+'%');
 for(let i=10;i<29;i++)await insert.run(fixture+' '+i,'Daily rate fixture',new Date(Date.now()-2*3600000).toISOString());
 const daily=await Promise.all([post(),post(),post()]);assert.deepEqual(daily.map(r=>r.status).sort(),[201,429,429]);
 assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE user_id=5 AND subject LIKE ?').get(fixture+'%')).n),30);
});
test('academic year correction rechecks an appointment revoked while waiting for its material slot',async()=>{
 const uploaded=await upload(cookies.yassine),row=await env.db.prepare('SELECT * FROM resources WHERE id=?').get(uploaded.data.resource.id);
 const active=await env.db.prepare('SELECT id FROM scoped_appointments WHERE user_id=7 AND revoked_at IS NULL').all();assert.ok(active.length);
 const barrier=pauseSlot(JSON.stringify([row.faculty_id,row.filiere_id,row.semester,row.module.normalize('NFKC').toLocaleLowerCase(),'courses',row.part_number]));
 try{
  const correction=request('/resources/'+row.id+'/academic-years',{cookie:cookies.professeure,method:'PATCH',body:{academic_year:'2023/2024'}});await reached(barrier.paused);
  await env.db.prepare('UPDATE scoped_appointments SET revoked_at=? WHERE id=ANY(?)').run(new Date().toISOString(),active.map(a=>a.id));barrier.resume();const result=await correction;assert.equal(result.status,403,JSON.stringify(result.data));
  assert.equal((await env.db.prepare('SELECT academic_year FROM resources WHERE id=?').get(row.id)).academic_year,'2026/2027');
 }finally{barrier.restore();await env.db.prepare('UPDATE scoped_appointments SET revoked_at=NULL WHERE id=ANY(?)').run(active.map(a=>a.id));}
});
test('authors disabled while an academic correction waits cannot commit metadata',async()=>{
 const uploaded=await upload(cookies.yassine),row=await env.db.prepare('SELECT * FROM resources WHERE id=?').get(uploaded.data.resource.id);
 const barrier=pauseSlot(JSON.stringify([row.faculty_id,row.filiere_id,row.semester,row.module.normalize('NFKC').toLocaleLowerCase(),'courses',row.part_number]));
 try{
  const correction=request('/resources/'+row.id+'/academic-years',{cookie:cookies.yassine,method:'PATCH',body:{academic_year:'2023/2024'}});await reached(barrier.paused);await env.db.prepare('UPDATE users SET disabled=1 WHERE id=3').run();barrier.resume();
  assert.equal((await correction).status,403);assert.equal((await env.db.prepare('SELECT academic_year FROM resources WHERE id=?').get(row.id)).academic_year,'2026/2027');
 }finally{barrier.restore();await env.db.prepare('UPDATE users SET disabled=0 WHERE id=3').run();}
});
test('feedback storage finalization rechecks active ownership and compensates rejected private objects',async()=>{
 const created=await request('/feedback',{cookie:cookies.yassine,method:'POST',body:{category:'bug',title:'Feedback finalize race',description:'Private attachment race fixture'}});assert.equal(created.status,201);const id=created.data.ticket.id,put=env.storage.put.bind(env.storage),before=env.storage.objects.size;
 for(const change of ['UPDATE users SET disabled=1 WHERE id=3','UPDATE contacts SET user_id=4 WHERE id='+id]){
  env.storage.put=async(...args)=>{await put(...args);await env.db.prepare(change).run();};
  try{const form=new FormData();form.set('file',new Blob([randomUUID()]),'private-note.txt');const result=await request('/feedback/'+id+'/attachments',{cookie:cookies.yassine,method:'POST',form});assert.equal(result.status,403,JSON.stringify(result.data));assert.equal(env.storage.objects.size,before,'Only the rejected new object is removed');assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM contact_attachments WHERE contact_id=?').get(id)).n),0);}finally{env.storage.put=put;}
 }
 assert.equal((await env.db.prepare('SELECT user_id FROM contacts WHERE id=?').get(id)).user_id,3);assert.equal((await env.db.prepare('SELECT disabled FROM users WHERE id=3').get()).disabled,0);
});
test('XP revocation rejects a study-scope change while waiting and retries under the current ranking lock',async()=>{
 const event=await xp(5,8),barrier=pauseSlot('campuslink:xp-ranking:flaa:french_studies');
 try{
  const pending=request('/admin/xp-events/'+event.id+'/revoke',{cookie:cookies.admin,method:'POST'});await reached(barrier.paused);
  await env.db.prepare("UPDATE users SET filiere_id='arabic_studies' WHERE id=5").run();barrier.resume();const changed=await pending;
  assert.equal(changed.status,409,JSON.stringify(changed.data));assert.equal((await env.db.prepare('SELECT status FROM xp_events WHERE id=?').get(event.id)).status,'valid');
  assert.equal(Number((await env.db.prepare("SELECT COUNT(*) AS n FROM administrative_audit WHERE action='xp.revoke' AND target_id=?").get(String(event.id))).n),0);
 }finally{barrier.restore();}
 const prepare=env.db.prepare.bind(env.db),locks=[];
 env.db.prepare=sql=>{const statement=prepare(sql);return {...statement,get:async(...values)=>{if(sql==='SELECT pg_advisory_xact_lock(hashtext(?))'||sql==='SELECT faculty_id,filiere_id FROM users WHERE id=? FOR SHARE')locks.push({sql,values});return statement.get(...values);}};};
 try{
  const retry=await request('/admin/xp-events/'+event.id+'/revoke',{cookie:cookies.admin,method:'POST'});assert.equal(retry.status,200,JSON.stringify(retry.data));
  assert.deepEqual(locks.slice(0,2),[{sql:'SELECT pg_advisory_xact_lock(hashtext(?))',values:['campuslink:xp-ranking:flaa:arabic_studies']},{sql:'SELECT faculty_id,filiere_id FROM users WHERE id=? FOR SHARE',values:[5]}]);
  assert.equal((await env.db.prepare('SELECT status FROM xp_events WHERE id=?').get(event.id)).status,'revoked');
  assert.equal((await env.db.prepare("SELECT actor_id FROM administrative_audit WHERE action='xp.revoke' AND target_id=?").get(String(event.id))).actor_id,2);
 }finally{env.db.prepare=prepare;await env.db.prepare("UPDATE users SET filiere_id='french_studies' WHERE id=5").run();}
});
test('owner disabled after XP revocation admission cannot commit the event or audit',async()=>{
 const event=await xp(5,7),barrier=pauseSlot('campuslink:xp-ranking:flaa:french_studies');
 try{
  const pending=request('/admin/xp-events/'+event.id+'/revoke',{cookie:cookies.admin,method:'POST'});await reached(barrier.paused);
  await env.db.prepare('UPDATE users SET disabled=1 WHERE id=2').run();barrier.resume();const result=await pending;
  assert.equal(result.status,403,JSON.stringify(result.data));assert.equal((await env.db.prepare('SELECT status FROM xp_events WHERE id=?').get(event.id)).status,'valid');
  assert.equal(Number((await env.db.prepare("SELECT COUNT(*) AS n FROM administrative_audit WHERE action='xp.revoke' AND target_id=?").get(String(event.id))).n),0);
 }finally{barrier.restore();await env.db.prepare('UPDATE users SET disabled=0 WHERE id=2').run();}
});
