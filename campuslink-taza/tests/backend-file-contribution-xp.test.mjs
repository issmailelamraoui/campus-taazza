import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createTestApp} from './backend-helpers.mjs';
import {makePdf} from '../server/seed.js';
import {awardFileContribution,FILE_CONTRIBUTION_EVIDENCE} from '../server/file-contribution-xp.js';
import {validatedAchievements,publicMentorBadgesForUsers} from '../server/xp-achievements.js';
import {UPLOAD_CHUNK_BYTES} from '../shared/upload-transport.js';

const integration=process.env.CAMPUS_TEST_DATABASE_URL?test:test.skip;
let env,server,origin;
const cookies={};
const badge=result=>result.achievements.find(item=>item.id==='library_contributor');
const fields=(extra={})=>({title:'Contribution '+randomUUID(),module:'XP '+randomUUID(),category:'courses',resource_type:'courses',filiere_id:'french_studies',semester:'1',part_number:'complete',channel:'general',publish_message:'false',...extra});
async function request(path,{user='yassine',method='GET',body,bytes}={}){
  const response=await fetch(origin+'/api'+path,{method,headers:{cookie:cookies[user]||'',...(bytes?{'Content-Type':'application/octet-stream'}:body!==undefined&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:bytes||body===undefined?bytes:body instanceof FormData?body:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),headers:response.headers};
}
async function upload({bytes=makePdf('File '+randomUUID(),['A useful synthetic course document.']),metadata={},user='yassine'}={}){
  const body=new FormData();body.append('file',new Blob([bytes],{type:'application/pdf'}),'cours.pdf');
  for(const [key,value] of Object.entries(fields(metadata)))body.append(key,value);
  return request('/uploads',{user,method:'POST',body});
}
async function clearAwards(){await env.db.prepare('DELETE FROM xp_events WHERE user_id IN(3,4) AND details->>\'evidence\'=?').run(FILE_CONTRIBUTION_EVIDENCE);}
async function report(resourceId){const result=await request('/reports',{user:'sara',method:'POST',body:{target_type:'resource',target_id:resourceId,reason:'Review this file'}});assert.equal(result.status,201,JSON.stringify(result.data));return result.data.id;}
async function event(user,category,points,details={},at=new Date().toISOString()){
  return env.db.prepare('INSERT INTO xp_events(user_id,category,event_key,points,details,created_at) VALUES(?,?,?,?,?,?) RETURNING id').get(user,category,'fixture:'+randomUUID(),points,JSON.stringify(details),at);
}
async function fixtureResource(extra={}){
  const original=await env.db.prepare("SELECT * FROM resources WHERE author_id=3 AND removed=0 AND library_visible=1 ORDER BY id LIMIT 1").get();
  assert.ok(original,'An earlier real upload provides the resource shape');
  const values={...original,object_key:'fixture/'+randomUUID(),sha256:randomUUID().replaceAll('-','').repeat(2),created_at:new Date().toISOString(),...extra};
  return env.db.prepare(`INSERT INTO resources(faculty_id,filiere_id,semester,title,filename,object_key,sha256,category,module,author_id,created_at,size,mime,version,library_visible,removed)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(...['faculty_id','filiere_id','semester','title','filename','object_key','sha256','category','module','author_id','created_at','size','mime','version','library_visible','removed'].map(key=>values[key]));
}
before(async()=>{
  if(!process.env.CAMPUS_TEST_DATABASE_URL)return;
  env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  for(const username of ['yassine','sara','amina','admin','professeure','hamza']){
    const response=await request('/login',{method:'POST',body:{username,password:username==='admin'?'Admin2026!':'Campus2026!'}});
    assert.equal(response.status,200,JSON.stringify(response.data));cookies[username]=response.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session=')).split(';')[0];
  }
});
after(async()=>{if(!env)return;env.app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await env.close();});

integration('a real public upload atomically awards 5 XP and exposes a coherent level, policy, ranking and badge progress',async()=>{
  const result=await upload();assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.xp_awarded,5);
  const xp=await request('/xp');assert.equal(xp.status,200);assert.equal(xp.data.xp,5);assert.equal(xp.data.level.xp,5);assert.equal(xp.data.breakdown.contribution,5);
  assert.deepEqual(xp.data.upload_policy,{points_per_file:5,daily_cap:25,timezone:'Africa/Casablanca',confirmation_required_for_revocation:true});
  assert.deepEqual(xp.data.file_contributions,{files:1,points:5,today_awarded:5,today_remaining:20});
  assert.deepEqual(badge(xp.data).progress,{files:1});assert.equal(badge(xp.data).earned,false);
  assert.equal(xp.data.ranking.find(row=>row.id===3).xp,5);
  const ledger=await env.db.prepare('SELECT * FROM xp_events WHERE user_id=3 AND details->>\'resource_id\'=?').get(String(result.data.resource.id));
  assert.equal(ledger.event_key,'resource-upload:'+ledger.details.sha256);assert.equal(ledger.details.evidence,FILE_CONTRIBUTION_EVIDENCE);
  assert.equal((await request('/session')).data.user.validated_xp,5);
});

integration('only own-program approved public-library contributions qualify; private chat, administrators and foreign programs do not',async()=>{
  await clearAwards();
  for(const options of [{metadata:{library_visible:'false',publish_message:'true'}},{user:'admin'},{user:'professeure'}]){
    const result=await upload(options);assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.xp_awarded,0);
  }
  for(const override of [{author_id:6},{author_id:2},{author_id:7},{author_id:3,filiere_id:'arabic_studies'},{author_id:3,removed:1},{author_id:3,object_key:''},{author_id:3,library_visible:0}]){
    const resource=await fixtureResource(override);assert.equal(await env.db.transaction(()=>awardFileContribution(env.db,resource.id)),0,JSON.stringify(override));
  }
  for(const [column,value] of [['account_status','pending'],['disabled',1]]){
    const resource=await fixtureResource();const user=await env.db.prepare('SELECT * FROM users WHERE id=3').get();
    try{await env.db.prepare(`UPDATE users SET ${column}=? WHERE id=3`).run(value);assert.equal(await env.db.transaction(()=>awardFileContribution(env.db,resource.id)),0);}
    finally{await env.db.prepare(`UPDATE users SET ${column}=? WHERE id=3`).run(user[column]);}
  }
  const resource=await fixtureResource({author_id:4});await env.db.prepare("UPDATE users SET role='faculty_leader' WHERE id=4").run();
  try{assert.equal(await env.db.transaction(()=>awardFileContribution(env.db,resource.id)),5);}
  finally{await env.db.prepare("UPDATE users SET role='student' WHERE id=4").run();}
});

integration('concurrent publications share a Casablanca daily cap and badges add no second XP reward',async()=>{
  await clearAwards();
  const results=await Promise.all(Array.from({length:8},()=>upload()));
  for(const result of results)assert.equal(result.status,201,JSON.stringify(result.data));
  assert.equal(results.reduce((sum,result)=>sum+result.data.xp_awarded,0),25);
  let xp=(await request('/xp')).data;assert.equal(xp.xp,25);assert.deepEqual(xp.file_contributions,{files:5,points:25,today_awarded:25,today_remaining:0});assert.equal(badge(xp).tier,'bronze');
  assert.deepEqual((await publicMentorBadgesForUsers(env.db,[3])).get(3).find(item=>item.id==='library_contributor'),{id:'library_contributor',title:'Library Contributor',tier:'bronze'});
  await validatedAchievements(env.db,3);await request('/xp');xp=(await request('/xp')).data;assert.equal(xp.xp,25,'Badge projections never insert an extra XP event');
  const credited=results.find(result=>result.data.xp_awarded).data.resource;
  await request('/admin/resources/'+credited.id,{user:'admin',method:'DELETE'});
  const another=await upload();assert.equal(another.data.xp_awarded,0,'A revocation does not reopen the day’s anti-spam budget');
  xp=(await request('/xp')).data;assert.equal(xp.xp,20);assert.equal(xp.file_contributions.today_awarded,25);assert.equal(badge(xp).earned,false);
  const uncredited=results.find(result=>!result.data.xp_awarded).data.resource;
  const row=await env.db.prepare('SELECT object_key FROM resources WHERE id=?').get(uncredited.id);
  const oldBytes=env.storage.objects.get(row.object_key).buffer;
  assert.equal((await request('/admin/resources/'+uncredited.id,{user:'admin',method:'DELETE'})).data.xp_revoked,0);
  await env.db.prepare("UPDATE xp_events SET created_at=? WHERE user_id=3 AND details->>'evidence'=?").run(new Date(Date.now()-86400000).toISOString(),FILE_CONTRIBUTION_EVIDENCE);
  assert.equal((await upload({bytes:oldBytes})).data.xp_awarded,0,'A formerly capped file cannot be recycled into tomorrow’s allowance');
  assert.equal((await upload()).data.xp_awarded,5,'New bytes can use the new day’s allowance');
});

integration('a raw report, review or dismissal never penalizes XP; admin confirmation revokes exactly once and reopening cannot restore it',async()=>{
  await clearAwards();
  const added=await upload();assert.equal(added.data.xp_awarded,5);const id=added.data.resource.id,rid=await report(id);
  for(const status of ['reviewed','dismissed','open']){
    assert.equal((await request('/xp')).data.xp,5);
    const result=await request('/admin/reports/'+rid,{user:'admin',method:'PATCH',body:{status}});assert.equal(result.status,200);assert.equal(result.data.xp_revoked,0);
    assert.equal((await request('/xp')).data.xp,5,status);
  }
  const unauthorized=await request('/admin/reports/'+rid,{user:'amina',method:'PATCH',body:{status:'resolved'}});assert.equal(unauthorized.status,403);
  assert.equal((await request('/xp')).data.xp,5);
  for(const user of ['yassine','hamza'])assert.equal((await request('/admin/reports/'+rid,{user,method:'PATCH',body:{status:'resolved'}})).status,403);
  const [reading,help,practice,forum]=await Promise.all(['reading','help','practice','contribution'].map(category=>event(3,category,7,{evidence:'unrelated'})));
  const decisions=await Promise.all([1,2].map(()=>request('/admin/reports/'+rid,{user:'admin',method:'PATCH',body:{status:'resolved',note:'Confirmed by administration'}})));
  assert.deepEqual(decisions.map(result=>result.status),[200,200]);assert.equal(decisions.reduce((sum,result)=>sum+result.data.xp_revoked,0),5);
  let xp=(await request('/xp')).data;assert.equal(xp.xp,28);assert.equal(xp.level.xp,28);assert.equal(xp.file_contributions.files,0);
  await request('/admin/reports/'+rid,{user:'admin',method:'PATCH',body:{status:'dismissed'}});assert.equal((await request('/xp')).data.xp,28);
  const unaffected=await env.db.prepare('SELECT status FROM xp_events WHERE id=ANY(?)').all([reading.id,help.id,practice.id,forum.id]);assert.ok(unaffected.every(row=>row.status==='valid'));
  await env.db.prepare('DELETE FROM xp_events WHERE id=ANY(?)').run([reading.id,help.id,practice.id,forum.id]);
});

integration('permanent author/byte identity survives removal, replacement and reupload; admin target removal revokes the credited original resource',async()=>{
  await clearAwards();
  const bytes=makePdf('Permanent '+randomUUID(),['The same bytes must never receive a second award.']);
  const first=await upload({bytes});assert.equal(first.data.xp_awarded,5);const firstId=first.data.resource.id;
  assert.equal((await upload({bytes})).status,409);
  const replacement=new FormData();replacement.append('file',new Blob([makePdf('New version '+randomUUID(),['Corrected bytes.'])]),'corrected.pdf');
  assert.equal((await request('/admin/resources/'+firstId+'/replace',{user:'admin',method:'POST',body:replacement})).status,200);
  const duplicate=await upload({bytes});assert.equal(duplicate.status,201);assert.equal(duplicate.data.xp_awarded,0,'Replacing bytes cannot erase the original reward identity');
  const reportId=await report(firstId);
  assert.equal((await request('/admin/reports/'+reportId+'/remove-target',{user:'admin',method:'POST',body:{}})).status,200);
  let xp=(await request('/xp')).data;assert.equal(xp.xp,0);assert.equal(xp.file_contributions.files,0);
  assert.equal((await request('/admin/resources/'+duplicate.data.resource.id,{user:'admin',method:'DELETE'})).status,200);
  const reupload=await upload({bytes});assert.equal(reupload.status,201);assert.equal(reupload.data.xp_awarded,0,'Revoked byte fingerprints remain spent forever');
  xp=(await request('/xp')).data;assert.equal(xp.xp,0);assert.equal(xp.events.filter(row=>row.event_key.startsWith('resource-upload:')).length,1);
});

integration('chunked publication and completion receipts commit one file and one XP award, with no award after rollback',async()=>{
  await clearAwards();
  const bytes=Buffer.alloc(UPLOAD_CHUNK_BYTES+4000,32);makePdf('Chunk '+randomUUID(),['A resumable course upload.']).copy(bytes);Buffer.from('\n%%EOF\n').copy(bytes,bytes.length-7);
  const started=await request('/upload-sessions',{method:'POST',body:{path:'/uploads',file:{name:'chunked.pdf',type:'application/pdf',size:bytes.length},fields:Object.entries(fields())}});assert.equal(started.status,201);
  const id=started.data.id;
  for(let part=1;part<=Math.ceil(bytes.length/UPLOAD_CHUNK_BYTES);part++)assert.equal((await request(`/upload-sessions/${id}/parts/${part}`,{method:'PUT',bytes:bytes.subarray((part-1)*UPLOAD_CHUNK_BYTES,part*UPLOAD_CHUNK_BYTES)})).status,200);
  const receipts=await Promise.all([1,2].map(()=>request(`/upload-sessions/${id}/complete`,{method:'POST',body:{}})));
  for(const result of receipts){assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.xp_awarded,5);}
  assert.equal(receipts[0].data.resource.id,receipts[1].data.resource.id);assert.equal((await request('/xp')).data.xp,5);
  const existing=await fixtureResource();
  await assert.rejects(env.db.transaction(async()=>{assert.equal(await awardFileContribution(env.db,existing.id),5);throw new Error('Force rollback after award');}),/Force rollback/);
  assert.equal((await request('/xp')).data.xp,5);
});

integration('upload rewards count towards XP and ranking but cannot grant cross-semester publication rights',async()=>{
  await clearAwards();
  await env.db.prepare('DELETE FROM xp_events WHERE user_id IN(3,4)').run();
  for(let index=0;index<5;index++)assert.equal((await upload()).data.xp_awarded,5);
  const session=(await request('/session')).data.user;assert.equal(session.validated_xp,25);assert.equal(session.uploadCapabilities.source,'study_year');
  assert.deepEqual(session.uploadCapabilities.scopes.find(scope=>scope.filiereId==='french_studies').semesters,[1,2]);
  assert.equal((await upload({metadata:{semester:'3'}})).status,403);
  const study=await event(4,'reading',1,{evidence:'fixture-study'});
  assert.equal((await request('/session',{user:'sara'})).data.user.uploadCapabilities.source,'xp_leader');
  const xp=(await request('/xp')).data;assert.equal(xp.ranking[0].id,3);assert.equal(xp.ranking[0].xp,25);
  await env.db.prepare('DELETE FROM xp_events WHERE id=?').run(study.id);
});

integration('new Casablanca days have their own file allowance and the Forum contribution allowance stays independent',async()=>{
  await clearAwards();
  const yesterday=new Date(Date.now()-86400000).toISOString();
  for(let index=0;index<5;index++)await event(3,'contribution',5,{evidence:FILE_CONTRIBUTION_EVIDENCE},yesterday);
  await event(3,'contribution',10,{evidence:'accepted_answer_and_independent_feedback'});
  const result=await upload();assert.equal(result.status,201);assert.equal(result.data.xp_awarded,5);
  const summary=(await request('/xp')).data.file_contributions;assert.equal(summary.today_awarded,5);assert.equal(summary.today_remaining,20);
  await env.db.prepare("DELETE FROM xp_events WHERE user_id=3 AND event_key LIKE 'fixture:%'").run();
});

integration('contributor silver and gold tiers are ledger projections and admin-confirmed evidence immediately downgrades them',async()=>{
  await clearAwards();
  let last;
  for(let index=1;index<=50;index++){
    last=await fixtureResource();assert.equal(await env.db.transaction(()=>awardFileContribution(env.db,last.id)),5);
    if(index===20){const current=await validatedAchievements(env.db,3);assert.equal(badge(current).tier,'silver');assert.equal(current.level.xp,100);}
    if(index%5===0)await env.db.prepare("UPDATE xp_events SET created_at=? WHERE user_id=3 AND details->>'evidence'=? AND created_at::timestamptz>now()-INTERVAL '1 day'").run(new Date(Date.now()-(index/5+2)*86400000).toISOString(),FILE_CONTRIBUTION_EVIDENCE);
  }
  let xp=(await request('/xp')).data;assert.equal(badge(xp).tier,'gold');assert.equal(xp.xp,250);assert.equal(badge(xp).progress.files,50);
  const id=await report(last.id);assert.equal((await request('/admin/reports/'+id,{user:'admin',method:'PATCH',body:{status:'resolved'}})).data.xp_revoked,5);
  xp=(await request('/xp')).data;assert.equal(badge(xp).tier,'silver');assert.equal(xp.xp,245);assert.equal(badge(xp).progress.files,49);
  assert.equal((await publicMentorBadgesForUsers(env.db,[3])).get(3).find(item=>item.id==='library_contributor').tier,'silver');
});

integration('historical migration backfills eligible distinct original files with five-per-day budget and is replay-safe',async()=>{
  await clearAwards();
  await env.db.prepare('UPDATE resources SET removed=1 WHERE author_id IN(3,4)').run();
  const original=await upload();assert.equal(original.status,201);
  await clearAwards();
  const at='2025-10-01T08:00:00.000Z';
  const samples=[];for(let i=0;i<8;i++)samples.push(await fixtureResource({created_at:at}));
  await fixtureResource({created_at:at,sha256:samples[0].sha256});
  const replaced=await fixtureResource({created_at:at,version:2});
  const confirmed=await fixtureResource({created_at:at});
  await env.db.prepare("INSERT INTO reports(faculty_id,reporter_id,target_type,target_id,reason,details,created_at,status) VALUES('flaa',4,'resource',?,'Confirmed historical issue','',?,'resolved')").run(confirmed.id,at);
  const sql=await readFile(new URL('../server/migrations/031_file_contribution_xp.sql',import.meta.url),'utf8');
  await env.db.transaction(()=>env.db.exec(sql));
  const rows=await env.db.prepare('SELECT * FROM xp_events WHERE user_id=3 AND details->>\'evidence\'=?').all(FILE_CONTRIBUTION_EVIDENCE);
  const old=rows.filter(row=>row.created_at===at);assert.equal(old.length,5);assert.ok(old.every(row=>row.points===5&&row.details.historical_backfill));
  assert.ok(!rows.some(row=>[replaced.id,confirmed.id].includes(Number(row.details.resource_id))));
  await env.db.transaction(()=>env.db.exec(sql));
  assert.equal((await env.db.prepare('SELECT COUNT(*)::integer AS count FROM xp_events WHERE user_id=3 AND details->>\'evidence\'=?').get(FILE_CONTRIBUTION_EVIDENCE)).count,rows.length);
});
