import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPushTargetAuthorizer} from '../server/push-targets.js';
const viewer={id:1,faculty_id:'fsa',filiere_id:'data',account_status:'approved',preferences:'{}'};
function fixture() {
 const data={users:new Map([[2,{...viewer,id:2}]]),campus_questions:new Map([[10,{id:10,author_id:2,faculty_id:'fsa',filiere_id:'data',accepted_answer_id:20}]]),campus_answers:new Map([[20,{id:20,question_id:10,author_id:1}]]),resources:new Map([[30,{id:30,faculty_id:'fsa',filiere_id:'data',library_visible:1}]]),messages:new Map([[40,{id:40,author_id:2,faculty_id:'fsa',channel:'general',reply_to:41}],[41,{id:41,author_id:1}]])};
 let permitted=true;
 const db={prepare(sql){const table=/FROM (\w+)/.exec(sql)?.[1];return {get:async id=>data[table]?.get(id)};}};
 const allow=createPushTargetAuthorizer({db,authorizeNotificationTarget:async()=>permitted});
 const notice=(type,path,context)=>({user_id:1,faculty_id:'fsa',type,path,push_context:context});
 return {data,allow,notice,denyTarget:()=>{permitted=false;}};
}
test('new questions follow current programme and preference, and exclude author',async()=>{
 const {allow,notice,data}=fixture(),n=notice('questions','/app/campus?tab=forum&question=10',{kind:'forum-question',questionId:10,actorId:2});
 assert.equal(await allow(viewer,n),true);
 assert.equal(await allow({...viewer,preferences:'{"questions":false}'},n),false);
 assert.equal(await allow({...viewer,filiere_id:'math'},n),false);
 assert.equal(await allow({...viewer,id:2},{...n,user_id:2}),false);
 data.campus_questions.get(10).removed=true;assert.equal(await allow(viewer,n),false);
});
test('only actual directed forum replies and current acceptance are delivered',async()=>{
 const {allow,notice,data}=fixture(),context={kind:'forum-accepted',questionId:10,answerId:20,actorId:2},n=notice('campus','/app/campus?tab=forum&question=10&answer=20#answer-20',context);
 assert.equal(await allow(viewer,n),true);
 assert.equal(await allow(viewer,{...n,push_context:null}),false);
 assert.equal(await allow({...viewer,preferences:'{"mentions":false}'},n),false);
 data.campus_questions.get(10).accepted_answer_id=null;assert.equal(await allow(viewer,n),false);
 data.campus_questions.get(10).author_id=1;data.campus_answers.get(20).author_id=2;
 assert.equal(await allow(viewer,{...n,push_context:{...context,kind:'forum-answer'}}),true);
 data.users.get(2).disabled=1;assert.equal(await allow(viewer,{...n,push_context:{...context,kind:'forum-answer'}}),false);
});
test('resources and chat replies require fresh target access and actual recipients',async()=>{
 const {allow,notice,data,denyTarget}=fixture();
 const resource=notice('resources','/app/library#resource-30');assert.equal(await allow(viewer,resource),true);
 data.resources.get(30).filiere_id='math';assert.equal(await allow(viewer,resource),false);
 const reply=notice('mentions','/app/chat/general#message-40');assert.equal(await allow(viewer,reply),true);
 data.messages.get(41).author_id=2;assert.equal(await allow(viewer,reply),false);
 data.messages.get(41).author_id=1;denyTarget();assert.equal(await allow(viewer,reply),false);
});
test('cross-account, unsupported, password reset and scope changes never deliver',async()=>{
 const {allow,notice}=fixture(),n=notice('resources','/app/library#resource-30');
 for(const changed of [{...n,user_id:2},{...n,faculty_id:'fst'},{...n,type:'admin'},{...n,type:'important'}])assert.equal(await allow(viewer,changed),false);
 assert.equal(await allow({...viewer,password_change_required:1},n),false);
 assert.equal(await allow({...viewer,account_status:'pending'},n),false);
});
