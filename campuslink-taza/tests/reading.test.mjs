import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePosition,validateAnchors,validateKnowledge,validateStudyTool} from '../server/reading.js';
import {parseCSV,sourcePath,referenceText,normalizeSelection,createPositionSync,beginStudySession,clearStudyCache,studyCache,writeStudyCache,loadKnowledge,loadStudyTools,saveKnowledge,syncStudyQueue,checklistItemsFromLines} from '../src/lib/reading.js';
const pos={page:18,version:2,scrollRatio:.6,zoom:1.2,expectedRevision:3,deviceId:'device-fixture',operationId:'operation-fixture',preferences:{tone:'night',brightness:.6}};
test('position validation rejects manipulated coordinates, revisions and viewer preferences',()=>{
 assert.deepEqual(validatePosition(pos),pos);
 for(const patch of [{page:0},{page:100001},{zoom:4},{zoom:NaN},{scrollRatio:1.01},{expectedRevision:-1},{expectedRevision:3.5},{preferences:{tone:'invert',brightness:1}},{preferences:{tone:'night',brightness:.1}},{deviceId:'x'}])assert.throws(()=>validatePosition({...pos,...patch}),error=>error.status===400);
});
test('highlights retain normalized page rectangles and reject out-of-bounds anchors',()=>{const rectangles=[{x:.1,y:.2,width:.3,height:.05}];assert.deepEqual(validateAnchors(rectangles),rectangles);assert.throws(()=>validateAnchors([{x:.9,y:0,width:.2,height:.1}]));assert.throws(()=>validateAnchors([{x:0,y:0,width:NaN,height:.1}]));const scaled=normalizeSelection([{left:20,top:60,width:80,height:20}],{left:0,top:20,right:200,bottom:420,width:200,height:400});assert.deepEqual(scaled,[{x:.1,y:.1,width:.4,height:.05}]);});
test('personal notes keep inert user text and only bounded raster crops',()=>{const note=validateKnowledge({kind:'highlight',title:'Definition',selectedText:'<script>alert(1)</script>',anchor:[{x:0,y:0,width:.1,height:.2}]});assert.equal(note.selectedText,'<script>alert(1)</script>');assert.throws(()=>validateKnowledge({kind:'region',title:'unsafe',imageData:'data:image/svg+xml;base64,AAAA'}));assert.throws(()=>validateKnowledge({kind:'reference',title:'x',tags:Array(13).fill('tag')}));});
test('checklists and collections enforce bounded, unique references',()=>{assert.deepEqual(validateStudyTool({kind:'collection',title:'Semester',data:{resourceIds:[2,2,4]}}).data.resourceIds,[2,4]);assert.throws(()=>validateStudyTool({kind:'checklist',title:'Plan',data:{items:[{id:'item-one',text:'Read'},{id:'item-one',text:'Repeat'}]}}));});
test('editing repeated checklist wording preserves each task identity and completion independently',()=>{
 const existing=[{id:'task-read-first',text:'Read',done:true},{id:'task-read-second',text:'Read',done:false},{id:'task-discussion',text:'Discuss',done:true}];
 const edited=checklistItemsFromLines(' Read\nDiscuss\nRead\nNew task\nRead\n',existing);
 assert.deepEqual(edited.slice(0,3),[existing[0],existing[2],existing[1]]);
 assert.deepEqual(edited.slice(3).map(item=>({text:item.text,done:item.done})),[{text:'New task',done:false},{text:'Read',done:false}]);
 assert.equal(new Set(edited.map(item=>item.id)).size,5);
 assert.doesNotThrow(()=>validateStudyTool({kind:'checklist',title:'Edited plan',data:{items:edited}}));
 assert.deepEqual(checklistItemsFromLines('Discuss\nRead',existing),[existing[2],existing[0]],'Removing or reordering a task keeps matching ids and completion states');
 assert.deepEqual(existing.map(item=>item.done),[true,false,true],'Editing leaves the original tasks intact');
});
test('CSV preserves commas, escaped quotes and multiline cells without evaluating formulas',()=>{assert.deepEqual(parseCSV('Name,Note\r\n"a,b","first\nsecond"\r\n"a""b",=cmd()'),[['Name','Note'],['a,b','first\nsecond'],['a"b','=cmd()']]);assert.equal(parseCSV('a\nb\nc',2).length,2);});
test('exact page references include version and never invent author or year',()=>{assert.equal(sourcePath(12,18,3),'/app/library?document=12&page=18&version=3#resource-12');const reference=referenceText({source:{title:'Lecture'},resourceId:12,page:18,version:3,selectedText:'Quote'});assert.match(reference,/Lecture — p\. 18/);assert.ok(!reference.includes('2026'));});
function localFixture(){const original=globalThis.localStorage;const values=new Map();globalThis.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),key:index=>[...values.keys()][index],get length(){return values.size;}};return{values,close(){clearStudyCache();if(original)globalThis.localStorage=original;else delete globalThis.localStorage;}};}
test('regular saves keep each document independent and update a pending revision after an in-flight save',async()=>{const fixture=localFixture();let resolve;const sent=[];try{beginStudySession(3);const first=createPositionSync({userId:3,resourceId:1,version:1,send:async(path,options)=>{sent.push({path,body:options.body});return new Promise(done=>resolve=done);}}),second=createPositionSync({userId:3,resourceId:2,version:1,send:async()=>({position:{revision:1}})});first.update({page:18});second.update({page:4});const saving=first.flush();first.update({scrollRatio:.7});resolve({position:{revision:1}});await saving;assert.equal(studyCache(3,'position:1:1').page,18);assert.equal(studyCache(3,'position:1:1').expectedRevision,1);assert.equal(studyCache(3,'position:2:1').page,4);const next=first.flush();resolve({position:{revision:2}});await next;await first.dispose();await second.dispose();assert.equal(sent[1].body.expectedRevision,1);}finally{fixture.close();}});
test('offline resume keeps its original revision so a newer device requires explicit recovery',async()=>{const fixture=localFixture();let state,body;try{beginStudySession(3);fixture.values.set('campuslink-private-study-v1:3:position:1:1',JSON.stringify({...pos,version:1,expectedRevision:3,pending:true}));const sync=createPositionSync({userId:3,resourceId:1,version:1,position:{page:20,revision:4},send:async(_path,options)=>{body=options.body;throw Object.assign(new Error('Conflict'),{status:409,data:{position:{page:20,revision:4,zoom:1,scrollRatio:0}}});},onState:value=>state=value});await sync.flush();assert.equal(body.expectedRevision,3);assert.equal(state,'conflict');assert.equal(studyCache(3,'position:1:1').page,18);await sync.dispose();}finally{fixture.close();}});
test('logout removes all account-scoped personal caches and late saves cannot recreate them',async()=>{const fixture=localFixture();let resolve;try{beginStudySession(3);const sync=createPositionSync({userId:3,resourceId:1,version:1,send:async()=>new Promise(done=>resolve=done)});sync.update({page:8});const saving=sync.flush();clearStudyCache();resolve({position:{revision:1}});await saving;assert.equal(fixture.values.size,0);await sync.dispose();}finally{fixture.close();}});
test('closing a reader drains the latest position after an in-flight save',async()=>{
 const fixture=localFixture(),pending=[],sent=[];let sync;
 try{
  sync=createPositionSync({userId:3,resourceId:1,version:1,send:async(_path,{body})=>{sent.push(body);return new Promise(resolve=>pending.push(resolve));}});
  sync.update({page:4});const saving=sync.flush();sync.update({page:9});const closing=sync.dispose();
  pending.shift()({position:{revision:1}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,2);assert.equal(sent[1].page,9);assert.equal(sent[1].expectedRevision,1);
  pending.shift()({position:{revision:2}});await Promise.all([saving,closing]);
  assert.equal(studyCache(3,'position:1:1').pending,false);assert.equal(studyCache(3,'position:1:1').page,9);
 }finally{clearStudyCache();await sync?.dispose();fixture.close();}
});
test('editing a queued offline update coalesces it before sending the latest revision',async()=>{
 const fixture=localFixture(),originalFetch=globalThis.fetch,navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),sent=[];
 const navigator={onLine:false};Object.defineProperty(globalThis,'navigator',{configurable:true,value:navigator});
 try{
  const item={id:'knowledge-fixture',revision:1,title:'Definition',content:'Offline draft'};
  await saveKnowledge(3,item);navigator.onLine=true;
  globalThis.fetch=async(_url,{body})=>{const value=JSON.parse(body);sent.push(value);return Response.json({item:{...value,revision:2}});};
  await saveKnowledge(3,{...item,content:'Latest edit'});
  assert.equal(sent.length,0);assert.equal(studyCache(3,'queue').length,1);
  await syncStudyQueue(3);
  assert.equal(sent.length,1);assert.equal(sent[0].content,'Latest edit');assert.equal(sent[0].revision,1);
  assert.deepEqual(studyCache(3,'queue'),[]);assert.equal(studyCache(3,'knowledge')[0].revision,2);
 }finally{globalThis.fetch=originalFetch;if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);else delete globalThis.navigator;fixture.close();}
});
test('a new account sync runs independently of a previous account request',async()=>{
 const fixture=localFixture(),originalFetch=globalThis.fetch,navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),pending=[];
 const navigator={onLine:false};Object.defineProperty(globalThis,'navigator',{configurable:true,value:navigator});
 try{
  globalThis.fetch=async(_url,{body})=>new Promise(resolve=>pending.push(()=>resolve(Response.json({item:{...JSON.parse(body),revision:2}}))));
  await saveKnowledge(3,{id:'previous-note',revision:1,title:'Previous'});navigator.onLine=true;
  const previous=syncStudyQueue(3);
  beginStudySession(4);navigator.onLine=false;await saveKnowledge(4,{id:'current-note',revision:1,title:'Current'});navigator.onLine=true;
  const current=syncStudyQueue(4);assert.equal(pending.length,2);
  pending[0]();await previous;assert.equal(syncStudyQueue(4),current);
  pending[1]();await current;assert.deepEqual(studyCache(4,'queue'),[]);assert.equal(studyCache(4,'knowledge')[0].id,'current-note');
 }finally{globalThis.fetch=originalFetch;if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);else delete globalThis.navigator;fixture.close();}
});
test('late study read failures cannot return caches from a newer login',async()=>{
 const fixture=localFixture(),originalFetch=globalThis.fetch,pending=[];
 try{
  globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve));
  const knowledge=loadKnowledge(3),tools=loadStudyTools(3);
  clearStudyCache();beginStudySession(3);
  writeStudyCache(3,'knowledge',[{id:'new-session-note',content:'Private note'}]);
  writeStudyCache(3,'tools',[{id:'new-session-tool',title:'Private plan'}]);
  pending.forEach(resolve=>resolve(Response.json({error:'Unavailable'},{status:503})));
  assert.deepEqual(await knowledge,[]);assert.deepEqual(await tools,[]);
  assert.equal(studyCache(3,'knowledge')[0].id,'new-session-note');assert.equal(studyCache(3,'tools')[0].id,'new-session-tool');
  // A current-session transport failure still uses its explicit private cache.
  globalThis.fetch=async()=>Response.json({error:'Unavailable'},{status:503});
  assert.equal((await loadKnowledge(3))[0].id,'new-session-note');assert.equal((await loadStudyTools(3))[0].id,'new-session-tool');
 }finally{globalThis.fetch=originalFetch;fixture.close();}
});
test('late conflicts from an earlier account cannot publish its private operation',async()=>{
 const fixture=localFixture(),originalFetch=globalThis.fetch,windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),events=[];
 Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});window.addEventListener('campus-study-conflict',event=>events.push(event.detail));
 let complete;
 try{
  beginStudySession(3);writeStudyCache(3,'queue',[{id:'previous-operation',entity:'knowledge',method:'PATCH',item:{id:'previous-note',revision:1,content:'Previous account private note'}}]);
  globalThis.fetch=()=>new Promise(resolve=>complete=resolve);
  const previous=syncStudyQueue(3);beginStudySession(4);
  complete(Response.json({error:'Conflict',item:{id:'previous-note',content:'Previous account remote note'}},{status:409}));
  await previous;assert.deepEqual(events,[]);
  writeStudyCache(4,'queue',[{id:'current-operation',entity:'knowledge',method:'PATCH',item:{id:'current-note',revision:1}}]);
  globalThis.fetch=async()=>Response.json({error:'Conflict',item:{id:'current-note',revision:2}},{status:409});
  await assert.rejects(syncStudyQueue(4),error=>error.status===409);
  assert.equal(events.length,1);assert.equal(events[0].operation.id,'current-operation');assert.equal(events[0].remote.id,'current-note');
 }finally{globalThis.fetch=originalFetch;if(windowDescriptor)Object.defineProperty(globalThis,'window',windowDescriptor);else delete globalThis.window;fixture.close();}
});
