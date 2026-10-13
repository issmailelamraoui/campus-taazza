import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';

let env,server,origin,document;const cookies={};
async function request(path,{cookie,method='GET',body,form}={}){
 const response=await fetch(origin+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:form||(body===undefined?undefined:JSON.stringify(body))});
 return {status:response.status,data:await response.json(),cookie:response.headers.getSetCookie().find(c=>c.startsWith('campus_neon_test_session='))?.split(';')[0]};
}
function pdf(pages){
 const font=3+2*pages,objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>(3+2*i)+' 0 R').join(' ')}] /Count ${pages} >>`];
 for(let i=0;i<pages;i++){const contents=`BT /F1 12 Tf 50 700 Td (CampusLink test course chapter ${i+1}) Tj ET`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4+2*i} 0 R >>`,`<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`);}
 objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');let data='%PDF-1.4\n';const offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const xref=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return data;
}
async function login(username){const result=await request('/login',{method:'POST',body:{username,password:'Campus2026!'}});assert.equal(result.status,200);return result.cookie;}
async function start(cookie,page=1){return request('/reading-activity/'+document.id+'/start',{cookie,method:'POST',body:{page,version:document.version,page_count:99999}});}
async function heartbeat(cookie,token,page=1,extra={}){return request('/reading-activity/'+document.id+'/heartbeat',{cookie,method:'POST',body:{session_token:token,page,visible:true,recent_interaction:true,...extra}});}
async function elapse(user=3,seconds=15,qualified){await env.db.prepare(`UPDATE reading_activity_sessions SET last_ping=?${qualified===undefined?'':',qualified_seconds=?'} WHERE user_id=?`).run(new Date(Date.now()-seconds*1000).toISOString(),...(qualified===undefined?[]:[qualified]),user);}
before(async()=>{
 env=await createTestApp();await env.db.prepare('UPDATE users SET current_semester=3 WHERE id=3').run();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;for(const name of ['yassine','sara','omar','nour','hamza'])cookies[name]=await login(name);
 const form=new FormData(),module='Reading activity '+randomUUID();for(const[key,value]of Object.entries({title:module,category:'courses',channel:'general',filiere_id:'french_studies',semester:'3',module,resource_type:'courses',part_number:'complete',library_visible:'true',publish_message:'false'}))form.set(key,value);form.set('file',new Blob([pdf(12)],{type:'application/pdf'}),'reading.pdf');
 const uploaded=await request('/uploads',{cookie:cookies.yassine,method:'POST',form});assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));document=uploaded.data.resource;
});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await env?.close();});
test('reading XP uses a verified PDF page count and preserves optional ordinary reading without indexing',async()=>{
 const missing=await start(cookies.yassine);assert.equal(missing.status,409,JSON.stringify(missing.data));
 assert.equal((await request('/reading/'+document.id,{cookie:cookies.yassine})).status,200,'Reading progress remains available without an XP index');
 const indexed=await request('/document-index/'+document.id,{cookie:cookies.yassine,method:'POST'});assert.equal(indexed.status,201,JSON.stringify(indexed.data));
 const began=await start(cookies.yassine);assert.equal(began.status,201);assert.equal(began.data.page_count,12);assert.equal(began.data.minimum_seconds,60);assert.equal(began.data.daily_cap,10);
 assert.equal((await start(cookies.yassine,13)).status,400,'Claiming more pages cannot bypass verified metadata');assert.equal((await start(cookies.nour)).status,403);assert.equal((await start(cookies.hamza)).status,403);
 const nonPdf=await env.db.prepare("SELECT id FROM resources WHERE faculty_id='flaa' AND mime<>'application/pdf' LIMIT 1").get();if(nonPdf)assert.equal((await request('/reading-activity/'+nonPdf.id+'/start',{cookie:cookies.yassine,method:'POST',body:{page:1,version:1}})).status,400);
});
test('client XP/time claims and rapid heartbeats cannot manufacture reading opportunity',async()=>{
 const session=await start(cookies.yassine),token=session.data.session_token;
 const fast=await heartbeat(cookies.yassine,token,1,{points:100000,elapsed_seconds:60000,qualified_seconds:60000});assert.equal(fast.status,429);
 assert.equal(Number((await env.db.prepare("SELECT COUNT(*) AS n FROM xp_events WHERE user_id=3 AND category='reading'").get()).n),0);
 const statuses=[];for(let i=0;i<4;i++){await elapse();const result=await heartbeat(cookies.yassine,token);assert.equal(result.status,200,JSON.stringify(result.data));statuses.push(result.data.awarded);}
 assert.deepEqual(statuses,[0,0,0,1]);const event=await env.db.prepare("SELECT points,details FROM xp_events WHERE user_id=3 AND event_key=?").get(`reading:${document.id}:v1:p1`);assert.equal(event.points,1);assert.equal(event.details.not_comprehension_proof,true);
 await elapse();assert.equal((await heartbeat(cookies.yassine,token)).data.awarded,0);assert.equal((await start(cookies.yassine)).status,201);await elapse();const repeated=await heartbeat(cookies.yassine,(await env.db.prepare('SELECT token FROM reading_activity_sessions WHERE user_id=3').get()).token);assert.equal(repeated.data.status,'already_rewarded');
});
test('hidden/inactive reading, long gaps and quick page changes reset only pending opportunity',async()=>{
 const began=await start(cookies.yassine,2),token=began.data.session_token;await elapse(3,15,45);
 const hidden=await heartbeat(cookies.yassine,token,2,{visible:false});assert.equal(hidden.status,200);assert.equal(hidden.data.qualified_seconds,0);assert.equal(hidden.data.awarded,0);
 await elapse(3,15,45);const inactive=await heartbeat(cookies.yassine,token,2,{recent_interaction:false});assert.equal(inactive.data.qualified_seconds,0);
 await elapse(3,90,45);const gap=await heartbeat(cookies.yassine,token,2);assert.equal(gap.data.status,'restarted');assert.equal(gap.data.awarded,0);
 await elapse(3,15,45);const changed=await heartbeat(cookies.yassine,token,3);assert.equal(changed.data.status,'page_changed');assert.equal(changed.data.qualified_seconds,0);assert.equal(changed.data.awarded,0);
 assert.equal(Number((await env.db.prepare("SELECT SUM(points) AS n FROM xp_events WHERE user_id=3 AND category='reading' AND status='valid'").get()).n),1,'Inactivity never deducts previously earned XP');
});
test('a second device replaces the first token and old departure cannot cancel the new session',async()=>{
 const old=await start(cookies.yassine,2),fresh=await start(cookies.yassine,3);assert.notEqual(old.data.session_token,fresh.data.session_token);
 await elapse();assert.equal((await heartbeat(cookies.yassine,old.data.session_token,2)).status,409);
 assert.equal((await request('/reading-activity/'+document.id+'/end',{cookie:cookies.yassine,method:'POST',body:{session_token:old.data.session_token}})).status,200);
 const newer=await heartbeat(cookies.yassine,fresh.data.session_token,3);assert.equal(newer.status,200);
 await elapse();assert.equal((await heartbeat(cookies.sara,fresh.data.session_token,3)).status,409);
});
test('concurrent heartbeats issue one reward and a revoked page cannot be replayed for another event',async()=>{
 const token=(await start(cookies.omar)).data.session_token;await elapse(5,15,45);
 const results=await Promise.all([heartbeat(cookies.omar,token),heartbeat(cookies.omar,token)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);assert.equal(results.find(r=>r.status===200).data.awarded,1);
 const key=`reading:${document.id}:v1:p1`;assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM xp_events WHERE user_id=5 AND event_key=?').get(key)).n),1);
 await env.db.prepare("UPDATE xp_events SET status='revoked' WHERE user_id=5 AND event_key=?").run(key);
 const newer=(await start(cookies.omar)).data.session_token;await elapse(5,15,45);const replay=await heartbeat(cookies.omar,newer);assert.equal(replay.data.awarded,0);assert.equal(replay.data.status,'already_rewarded');
 assert.equal(Number((await env.db.prepare("SELECT COUNT(*) AS n FROM xp_events WHERE user_id=5 AND event_key=? AND status='valid'").get(key)).n),0);
});
test('reading XP daily cap is enforced across pages and duplicate/offline replay remains ineligible',async()=>{
 let token=(await start(cookies.sara)).data.session_token;const rewards=[];
 for(let page=1;page<=12;page++){
  await env.db.prepare('UPDATE reading_activity_sessions SET page=?,qualified_seconds=45,last_ping=? WHERE user_id=4').run(page,new Date(Date.now()-15000).toISOString());
  const result=await heartbeat(cookies.sara,token,page);assert.equal(result.status,200,JSON.stringify(result.data));rewards.push(result.data.awarded);if(page>10)assert.equal(result.data.status,'daily_cap');
 }
 assert.deepEqual(rewards,[1,1,1,1,1,1,1,1,1,1,0,0]);assert.equal(Number((await env.db.prepare("SELECT SUM(points) AS n FROM xp_events WHERE user_id=4 AND category='reading'").get()).n),10);
 await env.db.prepare('UPDATE reading_activity_sessions SET expires_at=? WHERE user_id=4').run(new Date(Date.now()-1000).toISOString());assert.equal((await heartbeat(cookies.sara,token,12,{offline:true,elapsed_seconds:600000})).status,410);
});
test('lost resource access, stale version and stale indexed hashes prevent reading rewards',async()=>{
 const token=(await start(cookies.yassine,4)).data.session_token;await elapse();await env.db.prepare("UPDATE users SET filiere_id='arabic_studies' WHERE id=3").run();assert.equal((await heartbeat(cookies.yassine,token,4)).status,403);await env.db.prepare("UPDATE users SET filiere_id='french_studies' WHERE id=3").run();
 await env.db.prepare('UPDATE resources SET version=2 WHERE id=?').run(document.id);assert.equal((await heartbeat(cookies.yassine,token,4)).status,409);await env.db.prepare('UPDATE resources SET version=1 WHERE id=?').run(document.id);
 const row=await env.db.prepare('SELECT sha256 FROM resources WHERE id=?').get(document.id);await env.db.prepare('UPDATE resources SET sha256=? WHERE id=?').run('a'.repeat(64),document.id);assert.equal((await heartbeat(cookies.yassine,token,4)).status,409);await env.db.prepare('UPDATE resources SET sha256=? WHERE id=?').run(row.sha256,document.id);
 await env.db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(document.id);assert.equal((await heartbeat(cookies.yassine,token,4)).status,404);
 assert.equal(Number((await env.db.prepare("SELECT SUM(points) AS n FROM xp_events WHERE user_id=3 AND category='reading' AND status='valid'").get()).n),1);
});
