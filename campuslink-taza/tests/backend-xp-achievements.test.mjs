import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
import {validatedAchievements,xpLevel} from '../server/xp-achievements.js';
import {validateLabSource} from '../server/labs.js';

let env,server,origin,cookie,thirdRequester;const notes=[];
const achievement=(result,id)=>result.achievements.find(a=>a.id===id);
async function event(category,key,points,details={},actor=2,at=new Date().toISOString()){
  return env.db.prepare('INSERT INTO xp_events(user_id,category,event_key,points,details,actor_id,created_at) VALUES(3,?,?,?,?,?,?) RETURNING id').get(category,key,points,JSON.stringify(details),actor,at);
}
async function rewardHelp(requester,at,{duration=180000,messages=4}={}){
  const request=await env.db.prepare("INSERT INTO close_requests(faculty_id,filiere_id,requester_id,title,topic,created_at) VALUES('flaa','french_studies',?,'Achievement fixture','Study',?) RETURNING id").get(requester,at);
  const room=await env.db.prepare("INSERT INTO close_rooms(request_id,requester_id,helper_id,created_at,closed_at,help_rating) VALUES(?,?,3,?,?,'helpful') RETURNING id").get(request.id,requester,at,new Date(Date.parse(at)+duration).toISOString());
  for(let i=0;i<messages;i++)await env.db.prepare('INSERT INTO close_messages(room_id,author_id,body,client_id,created_at) VALUES(?,?,?,?,?)').run(room.id,i%2?3:requester,'Substantive fixture exchange '+i,randomUUID(),at);
  return event('help',`closeroom:${room.id}:help`,10,{room_id:room.id,rating:'helpful'},requester,at);
}
const paragraphs={
 0:'Historical evidence requires comparing original documents, understanding the context of their creation, identifying the perspective of each author, and supporting a careful interpretation with independently corroborated academic sources. The example belongs to chapter 1.',
 1:'Literary interpretation begins by identifying the narrative voice, recurring images, contrasts between characters, and the structure of the passage. An argument should connect these observations to specific quotations and explain their effect on the reader.',
 2:'Language development can be explained through interactions between individual speakers, social institutions, neighboring dialects, and changes in communication. Comparing concrete examples from different periods helps distinguish regular patterns from exceptional usages.',
 40:'A study plan divides the available preparation time into manageable sessions, reviews the difficult concepts regularly, and reserves opportunities to discuss uncertainties with classmates. Recording useful questions helps guide the next reading session.',
 41:'Reliable academic references identify their authors, publication context, relevant arguments, and the evidence supporting their conclusions. Comparing several independent sources makes disagreements visible and helps justify a carefully limited interpretation.',
};
const substantive=number=>paragraphs[number]||`A retained scholarly observation examines source ${number} using historical comparison, careful interpretation, independent research, literary evidence, language patterns, cultural context, explicit reasoning, detailed examples, and appropriate methodological limits.`;
async function note({content='',selected='',kind='note',source=null,user=3,at='2026-09-01T12:00:00.000Z',title=randomUUID()}={}){
 const id=randomUUID();await env.db.prepare('INSERT INTO knowledge_items(id,user_id,resource_id,document_version,page,kind,title,content,selected_text,created_at,updated_at) VALUES(?,?,?,1,1,?,?,?,?,?,?)').run(id,user,source,kind,title,content,selected,at,at);return id;
}
before(async()=>{
  env=await createTestApp();thirdRequester=(await env.db.prepare("INSERT INTO users(username,name,faculty_id,filiere_id) VALUES(?,'Third achievement requester','flaa','french_studies') RETURNING id").get('achievement_'+randomUUID().replaceAll('-',''))).id;
  server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  const response=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'yassine',password:'Campus2026!'})});assert.equal(response.status,200);cookie=response.headers.getSetCookie().find(v=>v.startsWith('campus_neon_test_session=')).split(';')[0];
});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await env?.close();});
test('levels disclose their thresholds and XP totals alone cannot invent specific activity achievements',async()=>{
  assert.deepEqual(xpLevel(0),{number:1,xp:0,threshold:0,next_threshold:100});assert.deepEqual(xpLevel(100),{number:2,xp:100,threshold:100,next_threshold:400});
  await event('help',randomUUID(),100);await event('reading',randomUUID(),100);await event('contribution',randomUUID(),100);await event('practice',randomUUID(),100);
  const result=await validatedAchievements(env.db,3);assert.equal(result.level.number,3);assert.equal(achievement(result,'first_steps').earned,true);
  for(const id of ['book_explorer','helping_hand','campus_mentor','community_hero'])assert.equal(achievement(result,id).earned,false,id+' requires its actual evidence');
});
test('reading achievements count unique qualifying indexed pages, disclose tiers and follow revocations',async()=>{
  const resource=await env.db.prepare("SELECT * FROM resources WHERE faculty_id='flaa' AND mime='application/pdf' LIMIT 1").get();
  // This fixture represents the authoritative metadata produced by the bounded
  // PDF worker, which has a separate real-file integration regression suite.
  await env.db.prepare("INSERT INTO document_text_indexes(resource_id,document_version,source_sha256,status,page_count,text_bytes,indexed_by,indexed_at) VALUES(?,?,?,'ready',20,10,3,?)").run(resource.id,resource.version,resource.sha256,new Date().toISOString());
  const events=[];for(let page=1;page<=10;page++)events.push(await event('reading',`reading:${resource.id}:v${resource.version}:p${page}`,1,{resource_id:resource.id,document_version:resource.version,page,qualified_seconds:60,evidence:'bounded_visible_reading_opportunity'}));
  await event('reading','malformed-reading:'+randomUUID(),1,{resource_id:resource.id,document_version:resource.version,page:99999,qualified_seconds:60,evidence:'bounded_visible_reading_opportunity'});
  let badge=achievement(await validatedAchievements(env.db,3),'book_explorer');assert.equal(badge.earned,true);assert.equal(badge.tier,'bronze');assert.deepEqual(badge.progress,{pages:10,documents:1});assert.deepEqual(badge.targets,{pages:50,documents:3});
  await env.db.prepare("UPDATE xp_events SET status='revoked' WHERE id=?").run(events[0].id);badge=achievement(await validatedAchievements(env.db,3),'book_explorer');assert.equal(badge.earned,false);assert.equal(badge.progress.pages,9);
});
test('Campus Mentor requires legitimate outcomes for distinct people across days and loses revoked evidence',async()=>{
  for(let week=0;week<5;week++)await rewardHelp(4,new Date(Date.UTC(2026,7,1+week*8,12)).toISOString());
  await rewardHelp(5,'2026-09-15T12:00:00.000Z',{duration:30000});await rewardHelp(thirdRequester,'2026-09-17T12:00:00.000Z',{messages:1});
  let result=await validatedAchievements(env.db,3);assert.equal(achievement(result,'helping_hand').tier,'silver');let mentor=achievement(result,'campus_mentor');assert.equal(mentor.earned,false);assert.deepEqual(mentor.progress,{rooms:5,requesters:1,days:5});
  const other=await rewardHelp(5,'2026-09-20T12:00:00.000Z');await rewardHelp(thirdRequester,'2026-09-22T12:00:00.000Z');
  mentor=achievement(await validatedAchievements(env.db,3),'campus_mentor');assert.equal(mentor.earned,true);assert.deepEqual(mentor.progress,{rooms:7,requesters:3,days:7});
  await env.db.prepare("UPDATE xp_events SET status='revoked' WHERE id=?").run(other.id);mentor=achievement(await validatedAchievements(env.db,3),'campus_mentor');assert.equal(mentor.earned,false);assert.equal(mentor.progress.requesters,2);
});
test('Forum achievements require the credible contribution event and /xp exposes only the viewer’s earned evidence',async()=>{
  const question=await env.db.prepare("INSERT INTO campus_questions(faculty_id,filiere_id,author_id,title,body,created_at) VALUES('flaa','french_studies',4,'Forum achievement fixture','Question with credible answer',?) RETURNING id").get(new Date().toISOString());
  const answer=await env.db.prepare('INSERT INTO campus_answers(question_id,author_id,body,created_at) VALUES(?,3,?,?) RETURNING id').get(question.id,'A validated useful response',new Date().toISOString());
  await env.db.prepare('UPDATE campus_questions SET accepted_answer_id=? WHERE id=?').run(answer.id,question.id);
  const credited=await event('contribution',`forum:question:${question.id}:accepted`,5,{question_id:question.id,answer_id:answer.id,requester_id:4,evidence:'accepted_answer_and_independent_feedback'},4);
  const response=await fetch(origin+'/api/xp',{headers:{cookie}});assert.equal(response.status,200);const data=await response.json();assert.equal(achievement(data,'community_hero').earned,true);assert.equal(achievement(data,'community_hero').progress.answers,1);assert.equal(data.level.xp,data.xp);
  assert.equal('actor_id' in data.events[0],false);assert.equal('requester_ids' in achievement(data,'campus_mentor'),false);
  await env.db.prepare("UPDATE xp_events SET status='revoked' WHERE id=?").run(credited.id);assert.equal(achievement(await validatedAchievements(env.db,3),'community_hero').earned,false);
});
test('Note Keeper counts retained substantive unique notes and rejects empty, repeated, recent and copied bodies',async()=>{
 const resources=await env.db.prepare("SELECT id FROM resources WHERE faculty_id='flaa' AND filiere_id='french_studies' LIMIT 3").all();assert.equal(resources.length,3);
 for(let i=0;i<3;i++)notes.push({id:await note({content:substantive(i),source:resources[i].id,at:new Date(Date.UTC(2026,8,1+i,12)).toISOString()}),resource:resources[i].id,content:substantive(i)});
 await note({title:'Empty note'});await note({content:'repeat '.repeat(100),source:resources[0].id});await note({content:substantive(99),at:new Date().toISOString()});
 await note({content:notes[0].content.toUpperCase().replaceAll(' ','\u00a0'),source:resources[2].id,title:'Copied with another title',at:'2026-09-08T12:00:00.000Z'});
 await note({content:notes[0].content.replace('chapter 1','chapter 9999'),source:resources[2].id,title:'Copied with only a number changed',at:'2026-09-09T12:00:00.000Z'});
 let badge=achievement(await validatedAchievements(env.db,3),'note_keeper');assert.equal(badge.tier,'bronze');assert.deepEqual(badge.progress,{notes:3,days:3});
 await env.db.prepare('DELETE FROM knowledge_items WHERE id=?').run(notes[1].id);badge=achievement(await validatedAchievements(env.db,3),'note_keeper');assert.equal(badge.earned,false);assert.equal(badge.progress.notes,2);
 notes[1].id=await note({content:notes[1].content,source:notes[1].resource,at:'2026-09-02T12:00:00.000Z'});
});
test('Knowledge Collector uses substantive distinct sources and deduplicates collections while excluding foreign private items',async()=>{
 await note({kind:'excerpt',selected:substantive(40),source:notes[1].resource});await note({kind:'reference',content:substantive(41),source:notes[2].resource});
 const insert=env.db.prepare("INSERT INTO study_tools(id,user_id,kind,title,data,created_at,updated_at) VALUES(?,3,'collection','Private collection',?,?,?)"),at='2026-09-04T12:00:00.000Z';
 for(let i=0;i<3;i++){const resources=notes.map(n=>n.resource).slice(i%2).concat(i%2?[notes[0].resource]:[]);await insert.run(randomUUID(),JSON.stringify({items:resources.map(id=>({type:'resource',id})),resourceIds:resources.concat(resources)}),at,at);}
 const foreign=[];for(let i=0;i<3;i++)foreign.push(await note({user:4,content:substantive(70+i),source:notes[i].resource}));
 await insert.run(randomUUID(),JSON.stringify({knowledgeIds:foreign}),at,at);await insert.run(randomUUID(),JSON.stringify({resourceIds:[notes[0].resource,notes[0].resource]}),at,at);
 let badge=achievement(await validatedAchievements(env.db,3),'knowledge_collector');assert.equal(badge.tier,'bronze');assert.deepEqual(badge.progress,{items:5,sources:3,collections:1});
 await env.db.prepare("DELETE FROM study_tools WHERE user_id=3 AND kind='collection'").run();badge=achievement(await validatedAchievements(env.db,3),'knowledge_collector');assert.equal(badge.earned,false);assert.equal(badge.progress.collections,0);
});
test('editing old empty notes and collections cannot skip retention for their current contents',async()=>{
 // Backdated creation fixtures represent drafts left empty for several days;
 // content changes go through the real authenticated CAS update routes.
 await env.db.prepare('DELETE FROM knowledge_items WHERE user_id=4').run();
 const retainedAt=new Date(Date.now()-3*86400000).toISOString(),ids=[];
 for(let i=0;i<3;i++)ids.push(await note({user:4,source:notes[i].resource,at:retainedAt}));
 const collectionId=randomUUID();
 await env.db.prepare("INSERT INTO study_tools(id,user_id,kind,title,data,created_at,updated_at) VALUES(?,4,'collection','An old empty collection',?,?,?)").run(collectionId,JSON.stringify({items:[]}),retainedAt,retainedAt);
 const viewer=await env.db.prepare('SELECT username FROM users WHERE id=4').get();
 const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:viewer.username,password:'Campus2026!'})});assert.equal(login.status,200);
 const viewerCookie=login.headers.getSetCookie().find(v=>v.startsWith('campus_neon_test_session=')).split(';')[0];
 const update=async(path,body)=>{
  const response=await fetch(origin+'/api'+path,{method:'PATCH',headers:{cookie:viewerCookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
 };
 const xpBefore=(await validatedAchievements(env.db,4)).level.xp;
 for(let i=0;i<3;i++)await update('/knowledge/'+ids[i],{revision:1,content:substantive(i)});
 await update('/study-tools/'+collectionId,{kind:'collection',title:'Newly populated collection',revision:1,data:{resourceIds:notes.map(n=>n.resource)}});
 let result=await validatedAchievements(env.db,4);
 assert.equal(achievement(result,'note_keeper').progress.notes,0,'Old creation does not establish retention of newly written content');
 assert.deepEqual(achievement(result,'knowledge_collector').progress,{items:0,sources:0,collections:0});
 assert.equal(result.level.xp,xpBefore,'Private note and collection edits award no XP');
 // Advance only the update timestamps to model keeping the same substantive
 // contents for more than a day, without changing creation or evidence.
 await env.db.prepare('UPDATE knowledge_items SET updated_at=? WHERE id=ANY(?)').run(retainedAt,ids);
 await env.db.prepare('UPDATE study_tools SET updated_at=? WHERE id=?').run(retainedAt,collectionId);
 result=await validatedAchievements(env.db,4);
 assert.equal(achievement(result,'note_keeper').progress.notes,3);
 assert.deepEqual(achievement(result,'knowledge_collector').progress,{items:3,sources:3,collections:1});
 assert.equal(result.level.xp,xpBefore);
});
test('Syntax Master requires distinct persisted server-validated voluntary Labs programs and revocation removes progress',async()=>{
 const sessions=[];
 const programs={
  0:'function summarize(values) { let total = 0; for (const value of values) { if (value > 0) { total += value; } } return total; }',
  1:'function summarize(values) { let index = 0, total = 0; while (index < values.length) { total += values[index]; index++; } return total; }',
  2:'function summarize(values) { const filtered = values.filter(value => value > 0); const doubled = filtered.map(value => value * 2); return doubled.reduce((total, value) => total + value, 0); }',
  4:'function summarize(values) { let minimum = Infinity, maximum = -Infinity; for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); } return { minimum, maximum }; }',
  5:'function summarize(values) { const copied = [...values]; copied.sort((a, b) => a - b); const middle = Math.floor(copied.length / 2); if (copied.length % 2) return copied[middle]; return (copied[middle - 1] + copied[middle]) / 2; }',
 };
 async function session(number,{registry=true,validEvidence=true}={}){
  const id=randomUUID(),source=programs[number],result=validateLabSource('javascript',source);assert.equal(result.eligiblePractice,true);
  const created=new Date(Date.UTC(2026,8,10+number,12)).toISOString(),closed=new Date(Date.parse(created)+120000).toISOString();
  await env.db.prepare("INSERT INTO labs_sessions(id,user_id,language,voluntary_xp,potential,source,last_result,successful_fingerprint,revisions,created_at,updated_at,completed_at,rewarded_points) VALUES(?,3,'javascript',TRUE,10,?,?,?,2,?,?,?,10)").run(id,source,JSON.stringify(result),result.fingerprint,created,closed,closed);
  if(registry)await env.db.prepare('INSERT INTO labs_rewarded_programs(user_id,fingerprint,session_id,created_at) VALUES(3,?,?,?)').run(result.fingerprint,id,closed);
  return event('practice','labs:'+id,10,validEvidence?{language:'javascript',validation:'syntax_only',source:'voluntary_practice'}:{},2,closed);
 }
 for(let i=0;i<3;i++)sessions.push(await session(i));await session(4,{registry:false});await session(5,{validEvidence:false});
 let badge=achievement(await validatedAchievements(env.db,3),'syntax_master');assert.equal(badge.tier,'bronze');assert.deepEqual(badge.progress,{programs:3,days:3});
 await env.db.prepare("UPDATE xp_events SET status='revoked' WHERE id=?").run(sessions[0].id);badge=achievement(await validatedAchievements(env.db,3),'syntax_master');assert.equal(badge.earned,false);assert.equal(badge.progress.programs,2);
});
test('ordinary public profiles disclose earned badge labels only within the authenticated faculty',async()=>{
 await rewardHelp(5,'2026-09-30T12:00:00.000Z');
 const badgeResponse=await fetch(origin+'/api/members/3/achievements',{headers:{cookie}});assert.equal(badgeResponse.status,200);const badges=(await badgeResponse.json()).achievements;assert.ok(badges.some(b=>b.id==='campus_mentor'));
 for(const badge of badges)assert.deepEqual(Object.keys(badge).sort(),['id','tier','title']);
 assert.equal((await fetch(origin+'/api/members/9/achievements',{headers:{cookie}})).status,404);assert.equal((await fetch(origin+'/api/members/3/achievements')).status,401);
 const bootstrap=await fetch(origin+'/api/bootstrap',{headers:{cookie}}),data=await bootstrap.json(),profile=data.members.find(m=>m.id===3);assert.equal(profile.role,'student');assert.deepEqual(profile.achievements,[{id:'campus_mentor',title:'Campus Mentor',tier:'bronze'}]);
 const message=await fetch(origin+'/api/messages',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({channel:'general',content:'Ordinary profile badge example'})});assert.equal(message.status,201);const author=(await message.json()).message.author;assert.equal(author.role,'student');assert.deepEqual(author.achievements,profile.achievements);assert.equal('requester_ids' in author,false);assert.equal('progress' in author.achievements[0],false);
});
