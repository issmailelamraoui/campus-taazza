import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
// This feature's write checks are restricted to an explicitly local database.
let local=false;try{const url=new URL(process.env.CAMPUS_TEST_DATABASE_URL);local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);}catch{}
const isolated={skip:!local&&'Requires an explicitly isolated local PostgreSQL URL.'};
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=';
let env,server,origin;const cookies={};
async function request(path,{user='yassine',method='GET',body}={}){
 const response=await fetch(origin+'/api'+path,{method,headers:{cookie:cookies[user]||'',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};
}
before(async()=>{
 if(!local)return;env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 for(const username of ['yassine','nour']){const response=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'Campus2026!'})});assert.equal(response.status,200);cookies[username]=response.headers.getSetCookie().find(value=>value.startsWith('campus_neon_test_session='))?.split(';')[0];}
});
after(async()=>{env?.app.locals.endStreams();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await env?.close();});
async function note(overrides={}){const response=await request('/knowledge',{method:'POST',body:{id:randomUUID(),kind:'excerpt',title:'Mathematical source',content:'',selectedText:'',anchor:[{x:.1,y:.2,width:.4,height:.1}],imageData:image,...overrides}});assert.equal(response.status,201,JSON.stringify(response.data));return response.data.item;}
test('notes round-trip mathematical Unicode and preserve visual originals without storage normalization',isolated,async()=>{
 const text='α β θ λ μ σ Ω Ω µ ∈ ∉ ⊂ ∪ ∩ ∅ ℝ ℕ ℤ ℚ P(A ∩ B) ∫₀¹ ∑ᵢ₌₁ⁿ √x x² xₙ 𝔼[X]';
 const item=await note({selectedText:text,content:'Français et العربية — x²'});
 const saved=(await request('/knowledge')).data.items.find(value=>value.id===item.id);
 assert.equal(saved.selectedText,text);assert.equal(saved.content,'Français et العربية — x²');assert.equal(saved.imageData,image);assert.deepEqual(saved.anchor,item.anchor);
});
test('image-only flashcards use owned canonical snapshots and survive source edits/deletion',isolated,async()=>{
 const source=await note(),id=randomUUID();
 let result=await request('/study-tools',{method:'POST',body:{id,kind:'flashcard',title:'A probability formula',data:{front:'What is the formula?',back:'',source:{knowledgeId:source.id,imageData:'forged-client-value',resourceId:999999}}}});
 assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.item.data.source.imageData,image);assert.equal(result.data.item.data.source.resourceId,null);assert.equal(result.data.item.data.back,'');
 const snapshot=result.data.item.data.source;
 const edited=await request('/knowledge/'+source.id,{method:'PATCH',body:{...source,imageData:'',content:'A later manual explanation',revision:source.revision}});assert.equal(edited.status,200);
 let card=result.data.item;
 result=await request('/study-tools/'+id,{method:'PATCH',body:{...card,data:{...card.data,back:'A handwritten answer'},revision:card.revision}});assert.equal(result.status,200);assert.deepEqual(result.data.item.data.source,snapshot);card=result.data.item;
 assert.equal((await request('/knowledge/'+source.id,{method:'DELETE'})).status,200);
 result=await request('/study-tools/'+id,{method:'PATCH',body:{...card,title:'Source deleted, own card retained',revision:card.revision}});assert.equal(result.status,200);assert.deepEqual(result.data.item.data.source,snapshot);
});
test('foreign or fabricated visual answers cannot bypass ownership and empty-answer validation',isolated,async()=>{
 const source=await note();const create=(user,data)=>request('/study-tools',{user,method:'POST',body:{id:randomUUID(),kind:'flashcard',title:'Ownership check',data:{front:'Question',back:'',...data}}});
 assert.equal((await create('nour',{source:{knowledgeId:source.id,imageData:image}})).status,404);
 assert.equal((await create('yassine',{})).status,400);
 const noImage=await note({imageData:'',selectedText:'An ordinary quote'});
 assert.equal((await create('yassine',{source:{knowledgeId:noImage.id,imageData:image}})).status,400);
 assert.equal((await request('/study-tools',{user:'nour'})).data.items.some(item=>item.data.source?.knowledgeId===source.id),false);
});
test('legacy corrupted text remains unchanged when a student edits another field',isolated,async()=>{
 const raw='\u001bଵ \uE100 \uFFFD',source=await note({selectedText:raw,content:raw});
 const updated=await request('/knowledge/'+source.id,{method:'PATCH',body:{...source,title:'Keep original student data',revision:source.revision}});assert.equal(updated.status,200);assert.equal(updated.data.item.selectedText,raw);assert.equal(updated.data.item.content,raw);
 const row=await env.db.prepare('SELECT selected_text,content FROM knowledge_items WHERE id=?').get(source.id);assert.equal(row.selected_text,raw);assert.equal(row.content,raw);
});
