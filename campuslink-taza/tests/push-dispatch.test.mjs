import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPushDispatch} from '../server/push-dispatch.js';
test('publication dispatch retains background work, coalesces wakes and stops before database shutdown',async()=>{
 const previous=process.env.VERCEL;process.env.VERCEL='1';
 try{
  let calls=0,time=100000,release;const retained=[];
  const service={configured:true,dispatch:()=>{calls++;return new Promise(resolve=>{release=resolve;});}};
  const dispatch=installPushDispatch({get(){}},{service,clock:()=>time,retain:value=>retained.push(value)});
  dispatch.wake({force:true});dispatch.wake({force:true});await Promise.resolve();
  assert.equal(calls,1);assert.equal(retained.length,1);release({sent:1});await dispatch.settle();
  dispatch.wake();await Promise.resolve();assert.equal(calls,1);
  time+=15001;dispatch.wake();await Promise.resolve();assert.equal(calls,2);release({sent:0});await dispatch.settle();
  dispatch.stop();dispatch.wake({force:true});await Promise.resolve();assert.equal(calls,2);
 }finally{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous;}
});
test('fallback dispatcher requires its exact server secret before accessing the queue',async()=>{
 let handler,calls=0;installPushDispatch({get:(path,fn)=>{assert.equal(path,'/api/push/dispatch');handler=fn;}},{service:{configured:true,dispatch:async()=>{calls++;return {sent:1};}},secret:'a-long-isolated-test-secret'});
 const response=()=>({statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
 for(const supplied of ['', 'Bearer wrong', 'Basic a-long-isolated-test-secret']){const res=response();await handler({get:()=>supplied},res);assert.equal(res.statusCode,401);}
 assert.equal(calls,0);const res=response();await handler({get:()=> 'Bearer a-long-isolated-test-secret'},res);assert.equal(res.statusCode,200);assert.deepEqual(res.body,{sent:1});assert.equal(calls,1);
});

test('a publication after an empty queue read is replayed inside the original retained promise',async()=>{
 const previous=process.env.VERCEL;process.env.VERCEL='1';
 try{
  let calls=0,queued=0,delivered=0,release;const retained=[];
  const service={configured:true,dispatch:()=>{
   calls++;
   // The first drain has observed an empty queue but has not returned yet.
   if(calls===1)return new Promise(resolve=>{release=resolve;});
   delivered+=queued;queued=0;return Promise.resolve({sent:delivered});
  }};
  const dispatcher=installPushDispatch({get(){}},{service,retain:task=>retained.push(task)});
  dispatcher.wake();await Promise.resolve();assert.equal(calls,1);
  const pending=dispatcher.settle();queued=1;
  for(let index=0;index<20;index++)dispatcher.wake({force:true});
  assert.equal(dispatcher.settle(),pending);
  release({sent:0});await pending;
  assert.deepEqual({calls,queued,delivered,retained:retained.length},{calls:2,queued:0,delivered:1,retained:1});
  assert.equal(dispatcher.settle(),null);
 }finally{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous;}
});

test('follow-up passes share one deadline and repeated forced wakes have a finite pass budget',async()=>{
 let time=100000,release;const budgets=[];
 const service={configured:true,dispatch:options=>{
  budgets.push(options.budgetMs);
  if(budgets.length===1)return new Promise(resolve=>{release=resolve;});
  time+=5001;dispatcher.wake({force:true});return Promise.resolve({sent:1});
 }};
 const dispatcher=installPushDispatch({get(){}},{service,clock:()=>time});
 dispatcher.wake({force:true});await Promise.resolve();const pending=dispatcher.settle();
 time+=35000;dispatcher.wake({force:true});release({sent:0});await pending;
 assert.deepEqual(budgets,[40000,5000],'A second pass receives only the first pass’s remaining budget');
 let calls=0;
 const bounded=installPushDispatch({get(){}},{clock:()=>100000,service:{configured:true,dispatch:async()=>{calls++;bounded.wake({force:true});}}});
 bounded.wake({force:true});await bounded.settle();
 assert.equal(calls,4,'Even synchronous force wakes cannot spin indefinitely');
});

test('shutdown suppresses a requested follow-up while awaiting the current delivery',async()=>{
 let calls=0,release;
 const dispatcher=installPushDispatch({get(){}},{service:{configured:true,dispatch:()=>{calls++;return new Promise(resolve=>{release=resolve;});}}});
 dispatcher.wake({force:true});await Promise.resolve();const pending=dispatcher.settle();
 dispatcher.wake({force:true});dispatcher.stop();release({sent:1});await pending;
 dispatcher.wake({force:true});await Promise.resolve();
 assert.equal(calls,1);assert.equal(dispatcher.settle(),null);
});

test('upload wakes only affect a pump after their outer commit and are discarded on rollback',async()=>{
 let calls=0,inTransaction=true;const effects=[];
 const dispatcher=installPushDispatch({get(){}},{service:{configured:true,dispatch:async()=>{calls++;}},afterCommit:effect=>{
  if(inTransaction){effects.push(effect);return Promise.resolve();}
  return effect();
 }});
 dispatcher.wake({force:true});
 assert.equal(calls,0);assert.equal(dispatcher.settle(),null);
 effects.length=0; // A rollback discards its publication effects.
 inTransaction=false;await Promise.resolve();assert.equal(calls,0);
 inTransaction=true;dispatcher.wake({force:true});dispatcher.wake({force:true});
 inTransaction=false;for(const effect of effects.splice(0))effect();
 await dispatcher.settle();assert.equal(calls,1,'Committed callbacks coalesce before the queue is first read');
});

test('a failed initial drain still consumes a committed forced wake and can recover',async()=>{
 let calls=0,rejectFirst;
 const dispatcher=installPushDispatch({get(){}},{service:{configured:true,dispatch:()=>{
  calls++;return calls===1?new Promise((_resolve,reject)=>{rejectFirst=reject;}):Promise.resolve({sent:1});
 }}});
 dispatcher.wake({force:true});await Promise.resolve();const pending=dispatcher.settle();
 dispatcher.wake({force:true});rejectFirst(new Error('Isolated transient failure'));await pending;
 assert.equal(calls,2);assert.equal(dispatcher.settle(),null);
});
